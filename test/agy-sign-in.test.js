import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import agySignIn, { checkSignedIn, signIn, stripAnsi } from "../server/extensions/agy-sign-in.js";

// Like agy: `models` fails until signed in; bare, it draws a login menu, prints a URL, and reads the code.
const FAKE_AGY = `#!/usr/bin/env node
const fs = require("node:fs");
const token = process.env.FAKE_AGY_TOKEN;
const mode = process.env.FAKE_AGY_MODE || "";
if (process.argv[2] === "models") {
  if (fs.existsSync(token)) { console.log("gemini-3-8-flash"); process.exit(0); }
  console.error("Authentication required: run agy and sign in"); process.exit(1);
}
if (mode === "app") { process.stdout.write("\\x1b[2JWelcome to Antigravity\\n> "); setInterval(() => {}, 1000); return; }
const rl = require("node:readline").createInterface({ input: process.stdin });
process.stdout.write("\\x1b[1mSelect login\\x1b[0m \\x1b[1mmethod\\x1b[0m\\n\\x1b[36m> Google\\x1b[0m\\n  Other\\n");
let step = 0;
rl.on("line", line => {
  if (step++ === 0) {
    process.stdout.write("Open https://accounts.goo");
    setTimeout(() => process.stdout.write("gle.com/o/oauth2/auth?client_id=x&cols=" + process.stdout.columns + "\\nEnter code: "), 50);
    return;
  }
  if (line.trim() !== "good-code") { console.log("Invalid code"); process.exit(2); }
  fs.writeFileSync(token, "ok");
  console.log("Signed in");
  if (mode === "linger") setInterval(() => {}, 1000); else process.exit(0);
});
`;

function fixture(t, mode = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-agy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "agy");
  fs.writeFileSync(bin, FAKE_AGY, { mode: 0o755 });
  const saved = { FAKE_AGY_TOKEN: process.env.FAKE_AGY_TOKEN, FAKE_AGY_MODE: process.env.FAKE_AGY_MODE };
  process.env.FAKE_AGY_TOKEN = path.join(dir, "token");
  process.env.FAKE_AGY_MODE = mode;
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  return bin;
}

function fakeUi(code) {
  const ui = { notes: [], prompts: [] };
  ui.notify = (message, level) => ui.notes.push([message, level]);
  ui.input = async (title, placeholder, options) => { ui.prompts.push({ title, timeout: options?.timeout }); return code; };
  return ui;
}

test("ANSI escapes are stripped", () => {
  assert.equal(stripAnsi("\x1b[1mSelect\x1b[0m \x1b]0;title\x07login\x1b7\x1b(B"), "Select login");
});

test("agy models tells signed in, signed out, and missing apart", async t => {
  const bin = fixture(t);
  assert.equal(await checkSignedIn({ bin }), false);
  fs.writeFileSync(process.env.FAKE_AGY_TOKEN, "ok");
  assert.equal(await checkSignedIn({ bin }), true);
  assert.equal(await checkSignedIn({ bin: path.join(path.dirname(bin), "missing") }), null);
});

test("sign-in picks Google, relays the URL and the code, and waits for agy", async t => {
  const bin = fixture(t);
  const ui = fakeUi("good-code");
  const result = await signIn(ui, { bin });
  assert.deepEqual(result, { ok: true, message: "Antigravity is signed in." });
  assert.equal(ui.notes.length, 1);
  assert.match(ui.notes[0][0], /open https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?client_id=x&cols=4000 and copy/);
  assert.equal(ui.prompts.length, 1);
  assert.equal(ui.prompts[0].timeout, 10 * 60_000);
  assert.equal(await checkSignedIn({ bin }), true);
});

test("an agy that stays open after the code is stopped and the sign-in checked", async t => {
  const bin = fixture(t, "linger");
  const result = await signIn(fakeUi("good-code"), { bin, settleMs: 300 });
  assert.equal(result.ok, true);
});

test("a wrong code, a cancel, and no sign-in prompt are reported", async t => {
  const bin = fixture(t);
  const wrong = await signIn(fakeUi("bad"), { bin });
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /did not complete.*Invalid code/);
  const cancelled = await signIn(fakeUi(undefined), { bin });
  assert.deepEqual(cancelled, { ok: false, message: "Antigravity sign-in was cancelled." });
  process.env.FAKE_AGY_MODE = "app";
  const silent = await signIn(fakeUi("good-code"), { bin, promptMs: 500 });
  assert.equal(silent.ok, false);
  assert.match(silent.message, /did not offer a Google sign-in.*Welcome to Antigravity/);
  assert.equal(fs.existsSync(process.env.FAKE_AGY_TOKEN), false);
});

test("the extension signs in once, before the first turn on a bridge model", async t => {
  delete globalThis.__piWebAgySignIn;
  t.after(() => { delete globalThis.__piWebAgySignIn; });
  let handler;
  let checks = 0;
  const runs = [];
  let signedIn = false;
  agySignIn({ on: (event, fn) => { assert.equal(event, "before_agent_start"); handler = fn; } }, {
    check: async () => { checks++; return signedIn; },
    run: async ui => { runs.push(ui); signedIn = true; return { ok: true, message: "Antigravity is signed in." }; },
  });
  const ui = fakeUi();
  const ctx = model => ({ model, hasUI: true, ui });
  await handler({}, ctx({ provider: "anthropic", api: "anthropic-messages" }));
  await handler({}, ctx({ provider: "antigravity", api: "antigravity" })); // pi-antigravity's provider
  assert.equal(checks, 0);
  await Promise.all([1, 2].map(() => handler({}, ctx({ provider: "antigravity", api: "agy-bridge" }))));
  await handler({}, ctx({ provider: "antigravity", api: "agy-bridge" }));
  assert.equal(checks, 1);
  assert.equal(runs.length, 1);
  assert.deepEqual(ui.notes, [["Antigravity is signed in.", "info"]]);
});
