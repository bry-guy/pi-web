import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRemoteWorkspaces } from "../server/remote-workspaces.js";
import { createPrimes, createRunDoor, runDoorConfig, runDoorFromEnv } from "../server/run-door.js";
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
    if (p.endsWith("/api/models")) return json({ models: models.map(id => ({ id })) });
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

test("an unknown model fails the run before any session is created", async () => {
  const fake = fakeWorkspaced();
  const res = await door(fake).request(run("tok-labrat", "brief", "?model=nope/nope"));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "model_unavailable");
  assert.ok(fake.calls.some(c => c[1].endsWith("/api/models")));
  assert.ok(!fake.calls.some(c => c[1].endsWith("/sessions") || c[1].endsWith("/message")));
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
    ["/workspaces/ws-labrat/api/projects/pp-labrat/sessions", { name: "labrat: 2026-11-12 06:05", agent: "labrat", kind: "run" }],
    ["/workspaces/ws-labrat/api/sessions/s1/model", { model: "anthropic/claude-opus-5-5" }],
    ["/workspaces/ws-labrat/api/sessions/s1/message", { text: brief }],
  ]);
  assert.deepEqual(fake.remote.agentOf("s1"), { agent: "labrat", kind: "run" });
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

// A project worker that keeps sessions: create, meta, transcript, model, restore, note.
function primeWorkspaced(cachePath) {
  const calls = [];
  const sessions = new Map(); // id → { name, model, closed }
  let next = 0;
  const fetchImpl = async (url, init = {}) => {
    const p = new URL(url).pathname.replace(/^\/v1/, "").replace("/workspaces/ws-labrat/api", "");
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push([method, p, body]);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (p === "/workspaces") return json({ workspaces: [{ name: "ws-labrat", repository: "project:labrat", grant: "labrat", state: "running" }] });
    if (p === "/state") return json({ projects: [{ id: "pp-labrat", sessions: [...sessions.keys()].map(id => ({ id, children: [] })) }] });
    if (p.endsWith("/wake") || p === "/health") return json({ ok: true });
    if (p === "/events") return json({}, 503);
    if (p === "/models") return json({ models: [{ id: "anthropic/claude-haiku-5-5" }, { id: "anthropic/claude-opus-5-5" }] });
    if (p === "/projects/pp-labrat/sessions") { const id = `s${++next}`; sessions.set(id, { name: body.name }); return json({ id }); }
    const [, id, rest] = p.match(/^\/sessions\/([^/]+)\/(.+)$/) || [];
    const s = sessions.get(id);
    if (!s) return json({ error: "no_such_session" }, 404);
    if (rest === "meta") return json({ id, name: s.name, model: s.model || null });
    if (rest === "transcript") return json({ streaming: !!s.streaming, records: s.records || [{ role: "user", text: "brief" }, { role: "assistant", text: "looking" }, { role: "assistant", text: `All quiet (${id}).` }] });
    if (rest === "model") s.model = body.model;
    if (rest === "restore") s.closed = false;
    return json({ ok: true });
  };
  const remote = createRemoteWorkspaces({ url: "http://workspaced", token: "t", hub: new EventHub(), fetchImpl, cachePath, retryMs: 50, modelAuthSyncMs: 0 });
  return { remote, calls, sessions };
}

const label = (name, outcome) => `Automated report from this agent's scheduled run "${name}" (${outcome}, 2026-11-22 08:00 UTC). This is the run's own output, not a message from the owner, and it does not ask for a reply:`;

test("a prime's runs are hidden runs reporting into one conversation, created once, restored and replaced", async () => {
  const cachePath = path.join(mkdtempSync(path.join(tmpdir(), "primes-")), "remote-projects.json");
  const fake = primeWorkspaced(cachePath);
  const entries = runDoorConfig({ PI_WEB_RUN_PORT: "4000", PI_WEB_RUN_TOKENS: JSON.stringify([{ ...ENTRIES[1], model: "anthropic/claude-haiku-5-5" }]) }).entries;
  const logs = [];
  const app = createRunDoor({ entries, remote: fake.remote, log: () => {} });
  const dms = [];
  const primes = createPrimes({ entries, remote: fake.remote, dm: (...a) => dms.push(a), log: l => logs.push(l), now: () => new Date("2026-11-22T08:00:00Z") });
  const notes = () => fake.calls.filter(c => c[1].endsWith("/note"));
  const creates = () => fake.calls.filter(c => c[1] === "/projects/pp-labrat/sessions").map(c => c[2]);
  try {
    // Run 1 (token model, no ?model=): its final reply goes into a new conversation that gets the run's model.
    assert.equal((await app.request(run("tok-labrat"))).status, 202);
    assert.equal(fake.sessions.get("s1").model, "anthropic/claude-haiku-5-5", "the token's model is the default");
    await primes.event("s1", "turn_end", { reason: "errored", willRetry: true });
    await primes.event("s1", "turn_end", { reason: "stopped" });
    await Promise.all([primes.event("s1", "turn_end", { reason: "done" }), primes.event("s1", "turn_end", { reason: "done" })]);
    await primes.event("s1", "turn_end", { reason: "done" });
    assert.deepEqual(creates().at(-1), { name: "labrat", agent: "labrat", kind: "conversation" });
    assert.deepEqual(fake.remote.agentOf("s2"), { agent: "labrat", kind: "conversation" });
    assert.equal(fake.sessions.get("s2").model, "anthropic/claude-haiku-5-5");
    assert.deepEqual(notes().map(c => c[0] + " " + c[1]), ["POST /sessions/s2/note"]);
    const s1 = fake.sessions.get("s1").name;
    assert.deepEqual(notes()[0][2], {
      text: `${label(s1, "finished")}\n\nAll quiet (s1).`,
      details: { agent: "labrat", run: "s1", outcome: "done", head: `**${s1}** · ended 2026-11-22 08:00 UTC · [open the run](/?s=s1)` },
    });
    assert.deepEqual(dms, [["s1", { reason: "done", error: undefined, text: "All quiet (s1).", target: "s2" }]], "DMed once, linked to the conversation");
    assert.equal(fake.remote.agentOf("s1").reported, true);

    // Run 2 (?model=) failed: same conversation, which End idle had archived, so it is restored first.
    fake.sessions.get("s2").closed = true;
    assert.equal((await app.request(run("tok-labrat", "brief", "?model=anthropic/claude-opus-5-5"))).status, 202);
    assert.equal(fake.sessions.get("s3").model, "anthropic/claude-opus-5-5");
    await primes.event("s3", "turn_end", { reason: "errored", error: "529 overloaded" });
    assert.equal(creates().length, 3, "two runs, one conversation");
    assert.equal(fake.sessions.get("s2").closed, false);
    assert.equal(notes()[1][2].text, `${label(fake.sessions.get("s3").name, "failed")}\n\nFailed: 529 overloaded`);
    assert.equal(notes()[1][1], "/sessions/s2/note");

    // After a restart web still knows the conversation; after a disk reset the worker does not, so it is replaced.
    const again = primeWorkspaced(cachePath);
    assert.equal(again.remote.conversationOf("labrat"), "s2");
    again.sessions.set("s9", { name: "labrat: later" });
    again.remote.markAgent("s9", "labrat", "run");
    const primes2 = createPrimes({ entries, remote: again.remote, log: () => {} });
    assert.equal(await primes2.conversationFor("s9"), "s1", "a new conversation on the empty disk");
    assert.equal(again.remote.conversationOf("labrat"), "s1");
    assert.equal(again.remote.agentOf("s2"), null);
    assert.equal(await primes2.conversationFor("nope"), null, "not a prime's run");
    again.remote.stop();
    assert.deepEqual(logs.filter(l => l.includes("not reported")), []);
  } finally { fake.remote.stop(); }
});

test("a run that ended while web was not listening is reported once when web connects to its worker", async () => {
  const cachePath = path.join(mkdtempSync(path.join(tmpdir(), "primes-")), "remote-projects.json");
  const fake = primeWorkspaced(cachePath);
  const { entries } = runDoorConfig({ PI_WEB_RUN_PORT: "4000", PI_WEB_RUN_TOKENS: JSON.stringify([ENTRIES[1]]) });
  const dms = [], logs = [];
  const primes = createPrimes({ entries, remote: fake.remote, dm: (...a) => dms.push(a), log: l => logs.push(l), now: () => new Date("2026-11-22T08:00:00Z") });
  const notes = () => fake.calls.filter(c => c[1].endsWith("/note"));
  const add = (id, s) => { fake.sessions.set(id, { name: `labrat: ${id}`, ...s }); fake.remote.markAgent(id, "labrat", "run"); };
  try {
    add("r1", { records: [{ role: "user", text: "brief" }, { role: "assistant", text: "x".repeat(300 * 1024) }] });
    add("r2", { records: [{ role: "user", text: "brief" }, { role: "error", text: "529 overloaded" }] });
    add("r3", { streaming: true });
    add("r4", { records: [] });
    // The live turn end and the reconcile race: one report.
    await Promise.all([primes.event(null, "worker_connected", { workspace: "ws-labrat" }), primes.event("r1", "turn_end", { reason: "done" })]);
    await primes.event(null, "worker_connected", { workspace: "ws-labrat" });
    const conv = fake.remote.conversationOf("labrat");
    assert.deepEqual(notes().map(c => [c[1], c[2].details.run, c[2].details.outcome]), [[`/sessions/${conv}/note`, "r1", "done"], [`/sessions/${conv}/note`, "r2", "errored"]]);
    assert.ok(notes()[0][2].text.endsWith("x\n\n…(truncated, open the run)") && notes()[0][2].text.length < 210 * 1024, "a long reply is cut, not refused");
    assert.match(notes()[1][2].text, /\n\nFailed: 529 overloaded$/);
    assert.deepEqual(dms.map(d => [d[0], d[1].reason, d[1].target]), [["r1", "done", conv], ["r2", "errored", conv]]);
    assert.deepEqual(fake.remote.unreportedRuns(), ["r3", "r4"], "still running, or no brief yet");
    assert.equal(logs.filter(l => l.includes("not listening")).length, 2);
  } finally { fake.remote.stop(); }
});
