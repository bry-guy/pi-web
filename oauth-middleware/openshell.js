// The middleware's gateway side, through the `openshell` CLI (configured like workspaced: OPENSHELL_GATEWAY_ENDPOINT and
// friends). Reads a sandbox's placeholders and stores real tokens in a provider.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// A placeholder the supervisor resolves; anything else means the credential is not attached to that sandbox.
const PLACEHOLDER = /^openshell:resolve:[\w:.-]+$/;

export function openshellGateway({ bin = process.env.OPENSHELL_BIN || "openshell", exec = promisify(execFile), ttlMs = 10 * 60_000, now = Date.now } = {}) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|HOME|XDG_CONFIG_HOME|OPENSHELL_.*)$/.test(k))), OPENSHELL_COLOR: "never" };
  async function run(args, secrets = {}) {
    try {
      return (await exec(bin, args, { env: { ...env, ...secrets }, timeout: 60_000, maxBuffer: 1 << 20 })).stdout;
    } catch (e) {
      let detail = String(e.stderr || (e.killed ? "timed out" : `exit ${e.code ?? "unknown"}`)).replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").filter(Boolean).pop();
      for (const v of Object.values(secrets)) detail = String(detail).replaceAll(v, "[redacted]");
      throw new Error(`openshell ${args.slice(0, 2).join(" ")} failed: ${detail}`);
    }
  }

  // sandbox_id -> {at, placeholders: {[login]: {access, refresh}}}. Placeholders are stable per sandbox and provider.
  const cache = new Map();
  async function placeholders(context, login) {
    const { sandbox_id: id, sandbox: name } = context;
    if (!id || !name) throw new Error("request has no sandbox identity");
    const hit = cache.get(id);
    if (hit && now() - hit.at < ttlMs && hit.placeholders[login.name]) return hit.placeholders[login.name];
    // The name is display-only and may be reused: confirm it is still this sandbox before reading its env.
    const info = JSON.parse(await run(["sandbox", "get", name, "--output", "json"]));
    const sid = info?.id ?? info?.sandbox?.id ?? info?.metadata?.id;
    if (sid !== id) throw new Error(`sandbox ${name} is not ${id}`);
    const keys = [login.access, ...(login.refresh ? [login.refresh] : [])];
    const out = (await run(["sandbox", "exec", "-n", name, "--no-login-shell", "--timeout", "20", "--", "printenv", ...keys])).trim().split("\n");
    const [access, refresh = null] = out;
    if (out.length !== keys.length || !out.every(v => PLACEHOLDER.test(v))) throw new Error(`${keys.join("/")} are not provider placeholders in ${name} (is ${login.provider} attached?)`);
    const entry = hit && now() - hit.at < ttlMs ? hit : { at: now(), placeholders: {} };
    entry.placeholders[login.name] = { access, refresh };
    cache.set(id, entry);
    return entry.placeholders[login.name];
  }

  // One update at a time per provider, so a refresh can't overwrite a newer sign-in out of order.
  const queues = new Map();
  function store(login, real) {
    const secrets = { ...(real.access ? { [login.access]: real.access } : {}), ...(real.refresh ? { [login.refresh]: real.refresh } : {}) };
    const args = ["provider", "update", login.provider, ...Object.keys(secrets).flatMap(k => ["--credential", k]), "--wait", "--timeout", "25"];
    const next = (queues.get(login.provider) || Promise.resolve()).catch(() => {}).then(() => run(args, secrets).catch(e => {
      // As in workspaced: the gateway stored it; only some attached sandbox (a stopped one) did not confirm in time.
      if (!e.message.includes("inspect the reported outcomes")) throw e;
    }));
    queues.set(login.provider, next);
    return next;
  }
  return { placeholders, store };
}
