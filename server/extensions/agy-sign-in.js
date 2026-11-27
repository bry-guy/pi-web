// Loaded by supervisor/real.js only when the worker uses @estebanforge/pi-antigravity-bridge. agy signs in to Google
// only interactively (bare `agy` in a terminal: a login menu, a URL, then a pasted code). pi-web has no terminal, so
// before the first Antigravity turn this checks the sign-in and, when it is missing, runs agy under script(1) for a
// pseudo-terminal and relays the URL and the code through the chat's dialogs.
import { spawn } from "node:child_process";

// Whitespace after the URL: output arrives in chunks, and a chunk may end inside it.
const URL_PATTERN = /https:\/\/accounts\.google\.com\/\S+(?=\s)/;
const MENU_PATTERN = /select login method/i;
// CSI, OSC, charset and two-byte escapes; agy's terminal UI draws its menu with them.
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[0-_]/g;
const SIGN_IN_REQUIRED = /authenticat|sign[ -]?in|log[ -]?in/i;

export const stripAnsi = text => String(text).replace(ANSI_PATTERN, "");
const shellQuote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const tail = text => stripAnsi(text).replace(/\s+/g, " ").trim().slice(-300);

/** true when `agy models` lists models, false when agy wants a sign-in or fails, null when agy is not installed. */
export function checkSignedIn({ bin = process.env.AGY_BIN || "agy", timeoutMs = 30_000 } = {}) {
  return new Promise(resolve => {
    let output = "";
    let child;
    try { child = spawn(bin, ["models"], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch { return resolve(null); }
    // `agy models` waits on a prompt or the network when it is not signed in.
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const append = chunk => { output = (output + chunk).slice(-16_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", error => { clearTimeout(timer); resolve(error.code === "ENOENT" ? null : false); });
    child.on("close", code => {
      clearTimeout(timer);
      const text = stripAnsi(output).trim();
      resolve(code === 0 && !!text && !SIGN_IN_REQUIRED.test(text));
    });
  });
}

/**
 * Runs bare agy under a pseudo-terminal: picks the Google login, shows the URL, asks for the code. agy may stay in its
 * interactive app after the code instead of exiting, so it gets settleMs to exit before it is stopped and the
 * sign-in checked with `agy models`. Resolves { ok, message }.
 */
export function signIn(ui, {
  bin = process.env.AGY_BIN || "agy",
  timeoutMs = 10 * 60_000,
  promptMs = 60_000,
  settleMs = 30_000,
  signal,
  check = () => checkSignedIn({ bin }),
} = {}) {
  return new Promise(resolve => {
    // A wide terminal, so agy does not wrap the URL across lines.
    const command = `stty cols 4000 rows 50 2>/dev/null; exec ${shellQuote(bin)}`;
    const child = spawn("script", ["-qfec", command, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let output = "";
    let menuAnswered = false;
    let asked = false;
    let codeSent = false;
    let done = false;
    const timers = [];
    const later = (ms, fn) => { const timer = setTimeout(fn, ms); timer.unref?.(); timers.push(timer); };
    const stop = () => {
      // script(1) leads its own process group; agy is in it.
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
    };
    const finish = result => {
      if (done) return;
      done = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      stop();
      resolve(result);
    };
    const onAbort = () => finish({ ok: false, message: "Antigravity sign-in was cancelled." });
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const verify = async () => {
      if (done) return;
      const ok = await check();
      finish(ok
        ? { ok: true, message: "Antigravity is signed in." }
        : { ok: false, message: `Antigravity sign-in did not complete. ${tail(output)}`.trim() });
    };
    const onOutput = chunk => {
      output = (output + chunk).slice(-64_000);
      if (done || asked) return;
      const text = stripAnsi(output);
      if (!menuAnswered && MENU_PATTERN.test(text)) {
        menuAnswered = true;
        child.stdin.write("\r"); // the first entry, Google
      }
      const url = text.match(URL_PATTERN)?.[0];
      if (!url) return;
      asked = true;
      ui.notify(`Sign in to Google for Antigravity: open ${url} and copy the authorization code it shows.`, "info");
      ui.input("Antigravity sign-in: paste the authorization code from Google", "authorization code", { timeout: timeoutMs, signal })
        .then(code => {
          if (done) return;
          if (!code?.trim()) return finish({ ok: false, message: "Antigravity sign-in was cancelled." });
          codeSent = true;
          child.stdin.write(`${code.trim()}\r`);
          later(settleMs, () => { stop(); });
        });
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.stdin.on("error", () => {});
    child.on("error", error => finish({ ok: false, message: `Could not start agy for sign-in: ${error.message}` }));
    child.on("close", () => {
      if (codeSent) return void verify();
      finish({ ok: false, message: `agy exited without a Google sign-in prompt. ${tail(output)}`.trim() });
    });
    later(promptMs, () => { if (!asked) finish({ ok: false, message: `agy did not offer a Google sign-in. ${tail(output)}`.trim() }); });
    later(timeoutMs, () => { if (!codeSent) finish({ ok: false, message: "Antigravity sign-in timed out." }); });
  });
}

export default function agySignIn(pi, { check = checkSignedIn, run = signIn } = {}) {
  pi.on("before_agent_start", async (_event, ctx) => {
    const model = ctx.model;
    if (model?.provider !== "antigravity" || model.api !== "agy-bridge" || !ctx.hasUI) return;
    // One check and one sign-in per process, shared by every session that starts a turn meanwhile.
    const state = globalThis.__piWebAgySignIn ||= { signedIn: false, pending: null };
    if (state.signedIn) return;
    state.pending ||= (async () => {
      const status = await check();
      if (status !== false) return status; // null: agy is missing, which the bridge reports itself
      const result = await run(ctx.ui, { signal: ctx.signal });
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
      return result.ok;
    })().finally(() => { state.pending = null; });
    if (await state.pending === true) state.signedIn = true;
  });
}
