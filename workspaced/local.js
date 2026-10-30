import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectEnvironment, projectOf } from "./manifests.js";

const SERVER = fileURLToPath(new URL("../server/index.js", import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function writeAtomic(file, data) {
  writeFileSync(`${file}.tmp`, data, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

// Workers as child processes of workspaced in the same container (Compose).
// One trust boundary: workers share HOME and tools; only state dirs differ.
// A worker that dies on its own is restarted, at most maxRestarts times within
// restartWindowMs; after that it stays down and reports the problem.
// env: extra variables for every worker (web's embedded gateway uses it to skip its prestart).
export function localProvider({ root, env: extraEnv = {}, spawnImpl = spawn, server = SERVER, maxRestarts = 3, restartWindowMs = 10 * 60_000, restartDelayMs = 1_000, log = console.log } = {}) {
  mkdirSync(root, { recursive: true });
  const registry = path.join(root, "workspaces.json");
  const authFile = path.join(root, "github-auth.json");
  const modelAuthFile = path.join(root, "model-auth.json");
  const procs = new Map();
  const crashes = new Map(); // name → { times: [ms], last: {reason, exitCode, signal, at}, fatal }
  const read = () => { try { return JSON.parse(readFileSync(registry, "utf8")); } catch { return {}; } };

  function describe(code, signal) {
    // SIGKILL nobody asked for is almost always the kernel's OOM killer.
    if (signal === "SIGKILL" || code === 137) return { reason: "OOMKilled", message: "It was killed, most likely out of memory." };
    return { reason: signal || `exit ${code}`, message: `It crashed (${signal || `exit ${code}`}).` };
  }

  function onExit(name, child, code, signal) {
    if (procs.get(name) !== child) return; // stopped on purpose (sleep, remove)
    procs.delete(name);
    const now = Date.now();
    const c = crashes.get(name) || { times: [] };
    c.times = [...c.times.filter(t => now - t < restartWindowMs), now];
    c.last = { ...describe(code, signal), exitCode: code, signal, at: new Date(now).toISOString() };
    c.fatal = c.times.length > maxRestarts;
    crashes.set(name, c);
    log(`workspaced: worker ${name} died (${c.last.reason})${c.fatal ? "; not restarting" : "; restarting"}`);
    if (!c.fatal) setTimeout(() => {
      const w = read()[name];
      if (w && !w.sleeping && !procs.has(name)) start(name, w).catch(e => log(`workspaced: restart ${name} failed: ${e.message}`));
    }, restartDelayMs).unref?.();
  }

  function problem(name) {
    const c = crashes.get(name);
    if (!c?.last) return null;
    const message = c.fatal ? `${c.last.message} It kept crashing, so it was not restarted again.` : `${c.last.message} It was restarted; the turn that was running was lost.`;
    return { reason: c.last.reason, message, fatal: !!c.fatal, restarts: c.times.length, last: c.last };
  }

  async function start(name, { repository }) {
    if (procs.get(name)?.exitCode === null) return;
    const dir = path.join(root, name);
    const port = await freePort();
    const child = spawnImpl(process.execPath, [server], {
      stdio: "inherit",
      env: { ...process.env, PORT: String(port), PI_WEB_MODE: process.env.PI_WEB_MODE || "real",
        PI_WEB_HOME: path.join(dir, "pi-ez-web"), PI_CODING_AGENT_DIR: path.join(dir, "pi-ez-agent"),
        PI_WEB_REPOS_ROOT: path.join(dir, "repos"), PI_WEB_GITHUB_AUTH_FILE: authFile, PI_WEB_MODEL_AUTH_FILE: modelAuthFile,
        WORKSPACED_TOKEN: "", PI_WEB_WORKSPACED_URL: "", ...projectEnvironment(projectOf(repository), dir), ...extraEnv },
    });
    child.port = port;
    procs.set(name, child);
    child.on?.("exit", (code, signal) => onExit(name, child, code, signal));
  }

  // Stops the worker and starts it again; reset also wipes its data first.
  async function respawn(name, { wipe = false } = {}) {
    const all = read();
    if (!all[name]) throw Object.assign(new Error("no such workspace"), { status: 404, code: "no_such_workspace" });
    const child = procs.get(name);
    procs.delete(name); // before kill, so onExit treats it as intended
    child?.kill("SIGTERM");
    crashes.delete(name); // a restart clears a failed worker's history
    if (wipe) rmSync(path.join(root, name), { recursive: true, force: true });
    await start(name, all[name]);
  }

  return {
    async init() { for (const [name, w] of Object.entries(read())) if (!w.sleeping) await start(name, w); },
    async list() {
      return Object.entries(read()).map(([name, w]) => {
        const alive = procs.get(name)?.exitCode === null;
        const p = w.sleeping ? null : problem(name);
        const state = alive ? "running" : w.sleeping ? "sleeping" : p?.fatal ? "failed" : "starting";
        return { name, repository: w.repository, grant: w.grant || "default", ready: alive, state, problem: p, pinned: !!w.pinned };
      });
    },
    async scale(name, replicas) {
      const all = read();
      if (!all[name]) throw Object.assign(new Error("no such workspace"), { status: 404, code: "no_such_workspace" });
      all[name].sleeping = replicas === 0;
      writeAtomic(registry, JSON.stringify(all, null, 2));
      const child = procs.get(name);
      procs.delete(name); // before kill, so onExit treats it as intended
      if (replicas === 0) child?.kill("SIGTERM");
      else await start(name, all[name]);
    },
    restart: name => respawn(name),
    reset: name => respawn(name, { wipe: true }),
    // ps reports this process only (not its children) and %cpu averaged over its life.
    async usage() {
      const live = [...procs].filter(([, c]) => c.pid && c.exitCode === null);
      if (!live.length) return {};
      const out = await new Promise(resolve => execFile("ps", ["-o", "pid=,rss=,pcpu=", "-p", live.map(([, c]) => c.pid).join(",")], { timeout: 2_000 }, (err, stdout) => resolve(err && err.code !== 1 ? null : stdout)));
      if (out === null) return null;
      const byPid = new Map(out.trim().split("\n").map(line => line.trim().split(/\s+/)).map(([pid, rss, pcpu]) => [Number(pid), { cpuMillicores: Math.round(Number(pcpu) * 10), memoryBytes: Number(rss) * 1024 }]));
      return Object.fromEntries(live.filter(([, c]) => byPid.has(c.pid)).map(([name, c]) => [name, byPid.get(c.pid)]));
    },
    async setPinned(name, pinned) {
      const all = read();
      if (!all[name]) throw Object.assign(new Error("no such workspace"), { status: 404, code: "no_such_workspace" });
      all[name].pinned = !!pinned;
      writeAtomic(registry, JSON.stringify(all, null, 2));
    },
    // Local workers share this machine's trust zone; a grant is recorded, not enforced.
    async create({ name, repository, grant }) {
      const all = read();
      if (all[name] && (all[name].repository ?? null) !== (repository ?? null)) throw Object.assign(new Error("workspace name taken"), { status: 409, code: "workspace_name_taken" });
      all[name] = { ...all[name], repository, grant: grant?.name || "default" };
      writeAtomic(registry, JSON.stringify(all, null, 2));
      await start(name, all[name]);
    },
    async remove(name, { purge = false } = {}) {
      const child = procs.get(name);
      procs.delete(name);
      child?.kill("SIGTERM");
      crashes.delete(name);
      const all = read();
      delete all[name];
      writeAtomic(registry, JSON.stringify(all, null, 2));
      if (purge) rmSync(path.join(root, name), { recursive: true, force: true });
    },
    upstream(name) {
      const child = procs.get(name);
      return child ? `http://127.0.0.1:${child.port}` : null;
    },
    async setGitHubAuth(auth) {
      if (auth) writeAtomic(authFile, JSON.stringify(auth));
      else rmSync(authFile, { force: true });
    },
    async setModelAuth(content) {
      if (content === null) rmSync(modelAuthFile, { force: true });
      else writeAtomic(modelAuthFile, content);
    },
    stop() { const all = [...procs.values()]; procs.clear(); for (const child of all) child.kill("SIGTERM"); },
  };
}
