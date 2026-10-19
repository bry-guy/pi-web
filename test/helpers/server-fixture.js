import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before } from "node:test";

export let base;
export let home;
export let supervisor;
export let tmp;
export let repo;

let server;
const streams = new Set();

export const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

export function makeRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}

export const J = { "content-type": "application/json" };
export const post = (p, body) => fetch(base + p, { method: "POST", headers: J, body: JSON.stringify(body ?? {}) });
export const get = p => fetch(base + p);

export class SSE {
  constructor(url) {
    this.events = [];
    this.waiters = [];
    this.controller = new AbortController();
    streams.add(this);
    let ready;
    this.ready = new Promise(resolve => { ready = resolve; });
    this.done = fetch(url, { signal: this.controller.signal }).then(async res => {
      ready();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = frame.split("\n").find(line => line.startsWith("data: "));
          if (!data) continue;
          try {
            const evt = JSON.parse(data.slice(6));
            this.events.push(evt);
            this.waiters = this.waiters.filter(waiter => !waiter(evt));
          } catch {}
        }
      }
    }).catch(() => undefined);
  }
  wait(pred, ms = 8000) {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SSE wait timeout")), ms);
      this.waiters.push(evt => {
        if (pred(evt)) { clearTimeout(timer); resolve(evt); return true; }
        return false;
      });
    });
  }
  close() {
    this.controller.abort();
    streams.delete(this);
  }
}

export function setupServerFixture() {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-srv-"));
    home = path.join(tmp, "home");
    const reposRoot = path.join(tmp, "local-repositories");
    repo = path.join(reposRoot, "repo");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "init");

    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ reposRoot, worktreeRoot: path.join(home, "worktrees") }));
    delete process.env.PI_WEB_REPOS_ROOT;
    process.env.PI_WEB_HOME = home;
    process.env.PI_WEB_MODE = "mock";
    process.env.PI_WEB_MOCK_THINK_MS = "120";
    process.env.PI_WEB_MOCK_DELTA_MS = "5";

    const { startServer } = await import("../../server/index.js");
    ({ server, sup: supervisor } = startServer(0));
    const addr = server.address();
    base = `http://127.0.0.1:${addr.port}`;
  });
  after(async () => {
    const openStreams = [...streams];
    openStreams.forEach(stream => stream.close());
    server?.closeAllConnections?.();
    await new Promise(resolve => {
      if (!server?.listening) return resolve();
      server.close(() => resolve());
    });
    await Promise.allSettled(openStreams.map(stream => stream.done));
    streams.clear();
    supervisor?.stopAll?.();
    fs.rmSync(tmp, { recursive: true, force: true });
    server = undefined;
    supervisor = undefined;
    base = undefined;
    home = undefined;
    repo = undefined;
    tmp = undefined;
  });
}
