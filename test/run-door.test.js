import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRemoteWorkspaces } from "../server/remote-workspaces.js";
import { createRunDoor, runDoorConfig, runDoorFromEnv } from "../server/run-door.js";
import { EventHub } from "../server/events.js";

const sha = t => createHash("sha256").update(t).digest("hex");
const ENTRIES = [
  { agent: "other", sha256: sha("tok-other"), project: "elsewhere", grant: "default" },
  { agent: "labrat", sha256: sha("tok-labrat"), project: "labrat", grant: "labrat" },
];
const run = (token, body = "check the cluster", query = "") => new Request(`http://door/run${query}`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body });

// A fake workspaced + project worker behind createRemoteWorkspaces' fetch.
function fakeWorkspaced({ workers = [], models = ["anthropic/claude-opus-5-5"] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const p = new URL(url).pathname.replace(/^\/v1/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push([init.method || "GET", p, body]);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (p === "/workspaces" && !init.method) return json({ workspaces: workers });
    if (p === "/workspaces" && init.method === "POST") { workers.push({ name: `ws-${body.project}`, repository: `project:${body.project}`, grant: body.grant, state: "running" }); return json({ name: `ws-${body.project}` }, 201); }
    if (/^\/(github-auth|model-auth)$/.test(p) || p.endsWith("/wake") || p.endsWith("/api/health")) return json({ ok: true });
    if (p.endsWith("/api/events")) return json({}, 503);
    if (/\/api\/projects\/pp-[^/]+\/sessions$/.test(p)) return json({ id: "s1" });
    if (p.endsWith("/sessions/s1/model")) return models.includes(body.model) ? json({ ok: true }) : json({ error: "model_unavailable" }, 400);
    if (p.endsWith("/sessions/s1/message")) return json({ ok: true });
    return json({ error: "unexpected" }, 500);
  };
  const remote = createRemoteWorkspaces({ url: "http://workspaced", token: "t", hub: new EventHub(), fetchImpl, retryMs: 50, modelAuthSyncMs: 0 });
  return { remote, calls, workers };
}

function door(fake, opts = {}) {
  const { entries } = runDoorConfig({ PI_WEB_RUN_PORT: "4000", PI_WEB_RUN_TOKENS: JSON.stringify(ENTRIES) });
  return createRunDoor({ entries, remote: fake.remote, log: () => {}, now: () => new Date("2026-11-12T06:05:09Z"), ...opts });
}

test("the door is off without both settings and with bad ones", () => {
  const logs = [];
  const log = m => logs.push(m);
  assert.equal(runDoorFromEnv({}, {}, { log }), null);
  assert.deepEqual(logs, [], "unset is silent");
  const tokens = JSON.stringify(ENTRIES);
  for (const env of [
    { PI_WEB_RUN_PORT: "4000" },
    { PI_WEB_RUN_TOKENS: tokens },
    { PI_WEB_RUN_PORT: "door", PI_WEB_RUN_TOKENS: tokens },
    { PI_WEB_RUN_PORT: "4000", PI_WEB_RUN_TOKENS: "{" },
    { PI_WEB_RUN_PORT: "4000", PI_WEB_RUN_TOKENS: "[]" },
    { PI_WEB_RUN_PORT: "4000", PI_WEB_RUN_TOKENS: JSON.stringify([{ ...ENTRIES[0], sha256: "abc" }]) },
    { PI_WEB_RUN_PORT: "4000", PI_WEB_RUN_TOKENS: JSON.stringify([{ ...ENTRIES[0], grant: "" }]) },
  ]) assert.equal(runDoorFromEnv(env, {}, { log }), null, JSON.stringify(env));
  assert.equal(logs.length, 7);
  assert.ok(logs.every(l => l.startsWith("pi-ez-web: run door off:") && !l.includes("tok-")));
});

test("missing, malformed and unknown tokens get the same 401", async () => {
  const fake = fakeWorkspaced();
  const app = door(fake);
  const answers = [];
  for (const req of [run(null), new Request("http://door/run", { method: "POST", headers: { authorization: "Basic abc" }, body: "x" }), run(""), run("tok-wrong")]) {
    const res = await app.request(req);
    answers.push([res.status, await res.text()]);
  }
  assert.ok(answers.every(a => a[0] === 401 && a[1] === answers[0][1]));
  assert.deepEqual(fake.calls, []);
});

test("other paths on the door are 404; the brief is required and capped", async () => {
  const fake = fakeWorkspaced();
  const app = door(fake);
  assert.equal((await app.request(new Request("http://door/run", { headers: { authorization: "Bearer tok-labrat" } }))).status, 404);
  assert.equal((await app.request(new Request("http://door/api/state"))).status, 404);
  assert.equal((await app.request(new Request("http://door/api/projects", { method: "POST", headers: { authorization: "Bearer tok-labrat" }, body: "{}" }))).status, 404);
  assert.equal((await app.request(run("tok-labrat", "   "))).status, 400);
  assert.equal((await app.request(run("tok-labrat", ""))).status, 400);
  assert.equal((await app.request(run("tok-labrat", "x".repeat(64 * 1024 + 1)))).status, 413);
  assert.deepEqual(fake.calls, []);
});

test("a worker under another grant is refused and nothing is started", async () => {
  const fake = fakeWorkspaced({ workers: [{ name: "ws-labrat", repository: "project:labrat", grant: "admin", state: "running" }] });
  const res = await door(fake).request(run("tok-labrat"));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "grant_mismatch");
  assert.deepEqual(fake.calls.map(c => c[0] + " " + c[1]), ["GET /workspaces"]);
});

test("an unknown model fails the run before any message is sent", async () => {
  const fake = fakeWorkspaced();
  const res = await door(fake).request(run("tok-labrat", "brief", "?model=nope/nope"));
  assert.equal(res.status, 400);
  assert.ok(!fake.calls.some(c => c[1].endsWith("/message")));
});

test("a run creates the worker with the entry's grant, marks an agent session, sets the model and sends the brief", async () => {
  const fake = fakeWorkspaced();
  const brief = "  Check the cluster.\n\nReport problems.\n";
  const res = await door(fake, { publicUrl: "https://web.example/" }).request(run("tok-labrat", brief, "?model=anthropic/claude-opus-5-5"));
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { session: "s1", url: "https://web.example/?s=s1" });
  const posts = fake.calls.filter(c => c[0] === "POST" && !/(wake|events)$/.test(c[1]));
  assert.deepEqual(posts.map(c => [c[1], c[2]]), [
    ["/workspaces", { project: "labrat", grant: "labrat" }],
    ["/workspaces/ws-labrat/api/projects/pp-labrat/sessions", { name: "labrat: 2026-11-12 06:05", agent: "labrat" }],
    ["/workspaces/ws-labrat/api/sessions/s1/model", { model: "anthropic/claude-opus-5-5" }],
    ["/workspaces/ws-labrat/api/sessions/s1/message", { text: brief }],
  ]);
  assert.equal(fake.remote.agentOf("s1"), "labrat");
});

test("an existing worker on the same grant is woken and reused; no public URL, no url", async () => {
  const fake = fakeWorkspaced({ workers: [{ name: "ws-labrat", repository: "project:labrat", grant: "labrat", state: "sleeping" }] });
  const res = await door(fake).request(run("tok-labrat"));
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { session: "s1" });
  assert.ok(fake.calls.some(c => c[1] === "/workspaces/ws-labrat/wake"));
  assert.ok(!fake.calls.some(c => c[0] === "POST" && c[1] === "/workspaces"));
});

test("the main app has no /run; the door listens on its own port", async () => {
  const port = await new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const home = mkdtempSync(path.join(tmpdir(), "run-door-"));
  Object.assign(process.env, { PI_WEB_MODE: "mock", PI_WEB_HOME: home, PI_CODING_AGENT_DIR: path.join(home, "agent"), PI_WEB_WORKSPACED_URL: "http://127.0.0.1:9", PI_WEB_RUN_PORT: String(port), PI_WEB_RUN_TOKENS: JSON.stringify(ENTRIES) });
  const { createApp } = await import("../server/index.js");
  const { app } = createApp({});
  for (const p of ["/run", "/api/run", "/run/"]) {
    const res = await app.request(`http://pi-web.test${p}`, { method: "POST", headers: { authorization: "Bearer tok-labrat" }, body: "brief" });
    assert.equal(res.status, 404, p);
  }
  let res;
  for (let i = 0; i < 50 && !res; i++) res = await fetch(`http://127.0.0.1:${port}/run`, { method: "POST", body: "x" }).catch(() => new Promise(r => setTimeout(r, 20)));
  assert.equal(res.status, 401);
});
