import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createRemoteWorkspaces, registerRemoteRoutes } from "../server/remote-workspaces.js";
import { createPrimes, createRunDoor, runDoorConfig, runDoorFromEnv } from "../server/run-door.js";
import { EventHub } from "../server/events.js";

const sha = t => createHash("sha256").update(t).digest("hex");
const ENTRIES = [
  { agent: "other", sha256: sha("tok-other"), project: "elsewhere", grant: "default" },
  { agent: "labrat", sha256: sha("tok-labrat"), project: "labrat", grant: "labrat" },
];
const run = (token, body = "check the cluster", query = "") => new Request(`http://door/run${query}`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body });

// A fake workspaced + project worker behind createRemoteWorkspaces' fetch.
function fakeWorkspaced({ workers = [], models = ["anthropic/claude-opus-5-5"], modelsStatus = 200, messageStatus = 200 } = {}) {
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
    if (p.endsWith("/api/models")) return modelsStatus === 200 ? json({ models: models.map(id => ({ id })) }) : json({ error: "boom" }, modelsStatus);
    if (/\/api\/projects\/pp-[^/]+\/sessions$/.test(p)) return json({ id: "s1" });
    if (p.endsWith("/sessions/s1/model")) return models.includes(body.model) ? json({ ok: true }) : json({ error: "model_unavailable" }, 400);
    if (p.endsWith("/sessions/s1/message")) return json(messageStatus === 200 ? { ok: true } : { error: "boom" }, messageStatus);
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

test("a model list the worker fails to give is worker trouble (502), and no session is created", async () => {
  const fake = fakeWorkspaced({ modelsStatus: 500 });
  const res = await door(fake).request(run("tok-labrat", "brief", "?model=anthropic/claude-opus-5-5"));
  assert.equal(res.status, 502);
  assert.ok(!fake.calls.some(c => c[1].endsWith("/sessions")));
});

test("a run whose brief could not be sent is marked reported at once, so reconcile never re-checks it", async () => {
  const fake = fakeWorkspaced({ messageStatus: 500 });
  const logs = [];
  const res = await door(fake, { log: l => logs.push(l) }).request(run("tok-labrat"));
  assert.equal(res.status, 502);
  assert.equal(fake.remote.agentOf("s1").reported, true);
  assert.deepEqual(fake.remote.unreportedRuns(), []);
  assert.equal(logs.filter(l => l.includes("run s1 is marked reported")).length, 1);
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
  const { started, ...flag } = fake.remote.agentOf("s1");
  assert.deepEqual(flag, { agent: "labrat", kind: "run" });
  assert.ok(Date.now() - Date.parse(started) < 60_000, "a run records when it started");
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
  // The front end learns the primes from /api/state: every run-door agent, no conversation or runs yet.
  const state = await (await app.request("http://pi-web.test/api/state")).json();
  assert.deepEqual(state.primes, [
    { agent: "other", project: "elsewhere", conversation: null, followUps: [], runs: [] },
    { agent: "labrat", project: "labrat", conversation: null, followUps: [], runs: [] },
  ]);
  const opened = await app.request("http://pi-web.test/api/primes/nobody/conversation", { method: "POST" });
  assert.equal(opened.status, 404);
  let res;
  for (let i = 0; i < 50 && !res; i++) res = await fetch(`http://127.0.0.1:${port}/run`, { method: "POST", body: "x" }).catch(() => new Promise(r => setTimeout(r, 20)));
  assert.equal(res.status, 401);
});

// A project worker that keeps sessions: create, meta, transcript, model, restore, note.
function primeWorkspaced(cachePath, { state = "running", log } = {}) {
  const calls = [];
  const faults = { note: 0 }; // a status the note route fails with, when set
  const followUps = { requests: null, pending: null }; // requests null: a worker from before follow-ups (no route)
  const sessions = new Map(); // id → { name, model, closed }
  let next = 0;
  const fetchImpl = async (url, init = {}) => {
    const p = new URL(url).pathname.replace(/^\/v1/, "").replace("/workspaces/ws-labrat/api", "");
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push([method, p, body]);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (p === "/workspaces") return json({ workspaces: [{ name: "ws-labrat", repository: "project:labrat", grant: "labrat", state }] });
    if (p === "/state") return json({ projects: [{ id: "pp-labrat", sessions: [...sessions].map(([id, s]) => ({ id, title: s.name, streaming: !!s.streaming, children: [] })) }] });
    if (p.endsWith("/wake") || p === "/health") return json({ ok: true });
    if (p === "/events") return json({}, 503);
    if (p === "/models") return json({ models: [{ id: "anthropic/claude-haiku-5-5" }, { id: "anthropic/claude-opus-5-5" }] });
    if (p === "/follow-ups" && followUps.requests) return json({ requests: followUps.requests });
    if (p === "/follow-ups/ack" && followUps.requests) {
      followUps.requests = followUps.requests.filter(r => !body.ids.includes(r.id));
      followUps.pending = body.pending;
      return json({ ok: true });
    }
    if (p === "/projects/pp-labrat/sessions") { const id = `s${++next}`; sessions.set(id, { name: body.name }); return json({ id }); }
    const [, id, rest] = p.match(/^\/sessions\/([^/]+)\/(.+)$/) || [];
    const s = sessions.get(id);
    if (!s) return json({ error: "no_such_session" }, 404);
    if (rest === "meta") return json({ id, name: s.name, model: s.model || null });
    if (rest === "transcript" && s.transcriptStatus) return json({ error: "boom" }, s.transcriptStatus);
    if (rest === "note" && faults.note) return json({ error: "down" }, faults.note);
    if (rest === "transcript") return json({ streaming: !!s.streaming, records: s.records || [{ role: "user", text: "brief" }, { role: "assistant", text: "looking" }, { role: "assistant", text: `All quiet (${id}).` }] });
    if (rest === "model") s.model = body.model;
    if (rest === "restore") s.closed = false;
    if (rest === "delete") { if (s.streaming) return json({ error: "session_streaming" }, 409); sessions.delete(id); }
    return json({ ok: true });
  };
  const remote = createRemoteWorkspaces({ url: "http://workspaced", token: "t", hub: new EventHub(), fetchImpl, cachePath, retryMs: 50, modelAuthSyncMs: 0, ...(log ? { log } : {}) });
  return { remote, calls, sessions, faults, followUps };
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

test("reconcile: an unreadable transcript or a refused note leaves the run for the next pass, DMed once; a turn cut mid-tool is interrupted", async () => {
  const cachePath = path.join(mkdtempSync(path.join(tmpdir(), "primes-")), "remote-projects.json");
  const fake = primeWorkspaced(cachePath);
  const { entries } = runDoorConfig({ PI_WEB_RUN_PORT: "4000", PI_WEB_RUN_TOKENS: JSON.stringify([ENTRIES[1]]) });
  const dms = [], logs = [];
  const primes = createPrimes({ entries, remote: fake.remote, dm: (...a) => dms.push(a), log: l => logs.push(l), now: () => new Date("2026-11-22T08:00:00Z") });
  const notes = () => fake.calls.filter(c => c[1].endsWith("/note"));
  const add = (id, s) => { fake.sessions.set(id, { name: `labrat: ${id}`, ...s }); fake.remote.markAgent(id, "labrat", "run"); };
  const connect = (workspace = "ws-labrat") => primes.event(null, "worker_connected", { workspace });
  try {
    add("t1", { transcriptStatus: 500 });
    await primes.event("t1", "turn_end", { reason: "done" });
    await connect();
    assert.deepEqual([notes().length, dms.length, fake.remote.agentOf("t1").reported], [0, 0, undefined], "not reported as an empty run");
    assert.equal(logs.filter(l => l.includes("transcript could not be read")).length, 1, "the live turn end logs; reconcile just skips");
    fake.sessions.get("t1").transcriptStatus = 0;
    fake.sessions.get("t1").records = [{ role: "user", text: "brief" }, { role: "assistant", text: "fine", toolIds: [] }];
    await connect();
    assert.equal(fake.remote.agentOf("t1").reported, true, "retried on the next pass");

    // The conversation refuses the note: DMed now, the note retried on the next pass without a second DM.
    fake.faults.note = 503;
    add("n1", { records: [{ role: "user", text: "brief" }, { role: "assistant", text: "done" }] });
    await primes.event("n1", "turn_end", { reason: "done" });
    assert.equal(fake.remote.agentOf("n1").reported, undefined);
    assert.equal(dms.filter(d => d[0] === "n1").length, 1);
    fake.faults.note = 0;
    await connect();
    assert.equal(fake.remote.agentOf("n1").reported, true);
    assert.equal(dms.filter(d => d[0] === "n1").length, 1, "no second DM");
    assert.equal(notes().filter(c => c[2].details.run === "n1").length, 2);

    // Web restarted mid tool loop: busy → left for the live turn end; not busy but the turn ends in a tool → interrupted.
    add("b1", { streaming: true, records: [{ role: "user", text: "brief" }, { role: "assistant", text: "checking", toolIds: ["c1"] }, { role: "tool", tool: "bash" }] });
    add("i1", { records: [{ role: "user", text: "brief" }, { role: "assistant", text: "checking", toolIds: ["c1"] }, { role: "tool", tool: "bash", out: "ok" }] });
    add("i2", { records: [{ role: "user", text: "brief" }, { role: "assistant", text: "checking", toolIds: ["c1"] }] });
    await connect();
    assert.deepEqual(fake.remote.unreportedRuns(), ["b1"]);
    for (const id of ["i1", "i2"]) {
      const note = notes().find(c => c[2].details.run === id)[2];
      assert.equal(note.details.outcome, "errored", id);
      assert.match(note.text, /Failed: interrupted/, id);
    }

    // A run on another worker is not touched when this one connects, and a sleeping worker's runs are never read.
    add("o1", { records: [{ role: "user", text: "brief" }, { role: "assistant", text: "x" }] });
    const before = fake.calls.length;
    await connect("ws-other");
    assert.deepEqual(fake.calls.slice(before).filter(c => c[1].startsWith("/sessions/")), []);
  } finally { fake.remote.stop(); }
});

test("a long report is cut by UTF-8 bytes under the note cap, never inside a character", async () => {
  const cachePath = path.join(mkdtempSync(path.join(tmpdir(), "primes-")), "remote-projects.json");
  const fake = primeWorkspaced(cachePath);
  const { entries } = runDoorConfig({ PI_WEB_RUN_PORT: "4000", PI_WEB_RUN_TOKENS: JSON.stringify([ENTRIES[1]]) });
  const primes = createPrimes({ entries, remote: fake.remote, log: () => {} });
  try {
    fake.sessions.set("k1", { name: "labrat: k1", records: [{ role: "user", text: "brief" }, { role: "assistant", text: "a漢".repeat(150_000) }] });
    fake.remote.markAgent("k1", "labrat", "run");
    await primes.event("k1", "turn_end", { reason: "done" });
    const note = fake.calls.find(c => c[1].endsWith("/note"))[2];
    assert.ok(Buffer.byteLength(JSON.stringify(note)) < 256 * 1024);
    assert.ok(note.text.endsWith("\n\n…(truncated, open the run)"));
    assert.ok(!note.text.includes("\uFFFD"));
    assert.equal(fake.remote.agentOf("k1").reported, true);
  } finally { fake.remote.stop(); }
});

const primeDir = files => {
  const dir = mkdtempSync(path.join(tmpdir(), "primes-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), JSON.stringify(content));
  return path.join(dir, "remote-projects.json");
};
const labrat = () => runDoorConfig({ PI_WEB_RUN_PORT: "4000", PI_WEB_RUN_TOKENS: JSON.stringify([{ ...ENTRIES[1], model: "anthropic/claude-haiku-5-5" }]) }).entries;

test("a prime's conversation opens lazily from the sidebar, and its runs are listed newest first", async () => {
  const fake = primeWorkspaced(primeDir({ "agent-sessions.json": {
    a: { agent: "labrat", kind: "run", started: "2026-11-20T08:00:00.000Z", reported: true, outcome: "done" },
    b: { agent: "labrat", kind: "run", started: "2026-11-21T08:00:00.000Z", reported: true, outcome: "errored" },
    c: { agent: "labrat", kind: "run", started: "2026-11-22T08:00:00.000Z" },
    d: { agent: "labrat", kind: "run", started: "2026-11-19T08:00:00.000Z" },
    x: { agent: "other", kind: "run", started: "2026-11-22T08:00:00.000Z" },
    legacy: "labrat",
  } }));
  const primes = createPrimes({ entries: labrat(), remote: fake.remote, log: () => {} });
  try {
    for (const [id, s] of [["a", {}], ["b", {}], ["c", { streaming: true }], ["d", {}]]) fake.sessions.set(id, { name: `labrat: ${id}`, ...s });
    assert.deepEqual(primes.list(), [{ agent: "labrat", project: "labrat", conversation: null, followUps: [], runs: [
      { id: "c", name: null, started: "2026-11-22T08:00:00.000Z", running: true, failed: false },
      { id: "b", name: null, started: "2026-11-21T08:00:00.000Z", running: false, failed: true },
      { id: "a", name: null, started: "2026-11-20T08:00:00.000Z", running: false, failed: false },
      { id: "d", name: null, started: "2026-11-19T08:00:00.000Z", running: true, failed: false },
    ] }], "before any worker snapshot: no names, an unreported run counts as running");
    await fake.remote.refresh();
    const runs = primes.list()[0].runs;
    assert.deepEqual(runs.map(r => [r.id, r.name, r.running, r.failed]), [
      ["c", "labrat: c", true, false], ["b", "labrat: b", false, true], ["a", "labrat: a", false, false], ["d", "labrat: d", false, false],
    ], "an unreported run whose turn is over is ended");

    // Opened from the sidebar: created once on the prime's worker with the token's model, then reused.
    const app = new Hono();
    registerRemoteRoutes(app, Object.assign(fake.remote, { primeConversation: primes.openConversation }));
    const res = await app.request("/primes/labrat/conversation", { method: "POST" });
    const { id } = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(fake.remote.agentOf(id), { agent: "labrat", kind: "conversation" });
    assert.equal(fake.sessions.get(id).model, "anthropic/claude-haiku-5-5");
    assert.deepEqual(await (await app.request("/primes/labrat/conversation", { method: "POST" })).json(), { id });
    assert.equal(fake.calls.filter(c => c[1] === "/projects/pp-labrat/sessions").length, 1);
    assert.equal(primes.list()[0].conversation, id);
    assert.equal((await app.request("/primes/nobody/conversation", { method: "POST" })).status, 404);
  } finally { fake.remote.stop(); }
});

test("retention deletes reported runs older than 30 days on awake workers, and nothing else", async () => {
  const flags = {
    oldDone: { agent: "labrat", kind: "run", started: "2026-10-01T00:00:00.000Z", reported: true, outcome: "done" },
    oldFailed: { agent: "labrat", kind: "run", started: "2026-10-02T00:00:00.000Z", reported: true, outcome: "errored" },
    oldUnreported: { agent: "labrat", kind: "run", started: "2026-10-03T00:00:00.000Z" },
    oldRunning: { agent: "labrat", kind: "run", started: "2026-10-04T00:00:00.000Z" },
    recent: { agent: "labrat", kind: "run", started: "2026-11-01T00:00:00.000Z", reported: true, outcome: "done" },
    conv: { agent: "labrat", kind: "conversation" },
    legacy: "labrat",
  };
  const snapshot = { "ws-labrat": [{ id: "pp-labrat", sessions: Object.keys(flags).map(id => ({ id, children: [] })) }] };
  const now = () => new Date("2026-11-22T08:00:00Z");

  // Asleep: nothing is read, woken or deleted; the next sweep tries again.
  const asleep = primeWorkspaced(primeDir({ "agent-sessions.json": flags, "remote-projects.json": snapshot }), { state: "sleeping" });
  try {
    await createPrimes({ entries: labrat(), remote: asleep.remote, log: () => {}, now }).sweep();
    assert.deepEqual(asleep.calls.filter(c => c[0] === "POST"), []);
    assert.deepEqual(asleep.remote.runIds().sort(), ["oldDone", "oldFailed", "oldRunning", "oldUnreported", "recent"]);
  } finally { asleep.remote.stop(); }

  const awakePath = primeDir({ "agent-sessions.json": flags, "remote-projects.json": snapshot });
  const awake = primeWorkspaced(awakePath);
  try {
    for (const id of Object.keys(flags)) awake.sessions.set(id, { name: id, streaming: id === "oldRunning" });
    await createPrimes({ entries: labrat(), remote: awake.remote, log: () => {}, now }).sweep();
    assert.deepEqual(awake.calls.filter(c => c[1].endsWith("/delete")).map(c => c[1]), ["/sessions/oldDone/delete", "/sessions/oldFailed/delete"]);
    assert.deepEqual([...awake.sessions.keys()].sort(), ["conv", "legacy", "oldRunning", "oldUnreported", "recent"]);
    assert.deepEqual(awake.remote.runIds().sort(), ["oldRunning", "oldUnreported", "recent"]);
    assert.equal(awake.remote.agentOf("conv").kind, "conversation");
    assert.equal(awake.remote.agentOf("legacy").kind, "agent");
    // Survives a restart: the deleted runs are gone from agent-sessions.json too.
    const again = primeWorkspaced(awakePath);
    assert.deepEqual(again.remote.runIds().sort(), ["oldRunning", "oldUnreported", "recent"]);
    again.remote.stop();
  } finally { awake.remote.stop(); }
});

test("retention: a worker without the delete route keeps its runs hidden; a vanished run is dropped; reconcile deletes too", async () => {
  const old = { agent: "labrat", kind: "run", started: "2026-10-01T00:00:00.000Z", reported: true, outcome: "done" };
  const snapshot = { "ws-labrat": [{ id: "pp-labrat", sessions: ["noRoute", "gone", "viaReconcile"].map(id => ({ id, children: [] })) }] };
  const now = () => new Date("2026-11-22T08:00:00Z");
  const fake = primeWorkspaced(primeDir({ "agent-sessions.json": { noRoute: old, gone: old }, "remote-projects.json": snapshot }));
  try {
    fake.sessions.set("noRoute", { name: "noRoute" });
    const plain = fake.remote.sessionPost;
    // An older image answers 404 with no session error for a route it does not have.
    fake.remote.sessionPost = (id, rest, body) => id === "noRoute" ? Promise.resolve({ status: 404, body: {} }) : plain(id, rest, body);
    const primes = createPrimes({ entries: labrat(), remote: fake.remote, log: () => {}, now });
    await primes.sweep();
    assert.deepEqual(fake.remote.runIds(), ["noRoute"], "the vanished run is dropped, the other stays hidden");
    fake.remote.sessionPost = plain;
    // A worker asleep at every sweep: its old runs go when it connects.
    fake.sessions.set("viaReconcile", { name: "viaReconcile" });
    fake.remote.markAgent("viaReconcile", "labrat", "run");
    fake.remote.markReported("viaReconcile", "reported", "done");
    fake.remote.agentOf("viaReconcile").started = "2026-10-02T00:00:00.000Z";
    fake.remote.markAgent("conv", "labrat", "conversation");
    fake.sessions.set("conv", { name: "conv" });
    await primes.event(null, "worker_connected", { workspace: "ws-labrat" });
    assert.deepEqual(fake.calls.filter(c => c[1] === "/sessions/viaReconcile/delete" || c[1] === "/sessions/conv/delete").map(c => c[1]), ["/sessions/viaReconcile/delete"]);
    assert.deepEqual(fake.remote.runIds(), []);
    assert.ok(fake.sessions.has("conv"));
  } finally { fake.remote.stop(); }
});

test("web's public API refuses to delete a session and forwards nothing", async () => {
  const forwarded = [];
  const api = new Hono();
  registerRemoteRoutes(api, { owner: async () => "ws-labrat", forward: c => { forwarded.push(c.req.path); return c.json({ ok: true }); }, wake() {} });
  const res = await api.request("/sessions/conv/delete", { method: "POST" });
  assert.equal(res.status, 403);
  assert.deepEqual(forwarded, []);
  assert.equal((await api.request("/sessions/conv/close", { method: "POST" })).status, 200, "other session routes still forward");
});

test("part 1 gaps: a stopped run and a run with no reply are reported", async () => {
  const fake = primeWorkspaced(primeDir({}));
  const dms = [];
  const primes = createPrimes({ entries: labrat(), remote: fake.remote, dm: (...a) => dms.push(a), log: () => {}, now: () => new Date("2026-11-22T08:00:00Z") });
  const notes = () => fake.calls.filter(c => c[1].endsWith("/note")).map(c => [c[2].details.run, c[2].details.outcome, c[2].text.split("\n\n")[1]]);
  const add = (id, s) => { fake.sessions.set(id, { name: `labrat: ${id}`, ...s }); fake.remote.markAgent(id, "labrat", "run"); };
  try {
    add("stopped", { records: [{ role: "user", text: "brief" }, { role: "assistant", text: "partial" }] });
    await primes.event("stopped", "turn_end", { reason: "stopped" });
    // Web was down when this run ended right after its brief.
    add("silent", { records: [{ role: "user", text: "brief" }] });
    await primes.event(null, "worker_connected", { workspace: "ws-labrat" });
    assert.deepEqual(notes(), [["stopped", "errored", "Failed: stopped before it finished"], ["silent", "done", "Finished with no reply."]]);
    assert.deepEqual(dms.map(d => [d[0], d[1].reason]), [["stopped", "errored"], ["silent", "done"]]);
    assert.deepEqual(fake.remote.unreportedRuns(), []);
    assert.equal(primes.list()[0].runs.find(r => r.id === "stopped").failed, true);
  } finally { fake.remote.stop(); }
});

test("a failed write of agent-sessions.json is logged and retried", async () => {
  const cachePath = primeDir({});
  const file = path.join(path.dirname(cachePath), "agent-sessions.json");
  mkdirSync(`${file}.tmp`); // the write's temporary file cannot be created
  const logs = [];
  const fake = primeWorkspaced(cachePath, { log: l => logs.push(l) });
  try {
    fake.remote.markAgent("r1", "labrat", "run");
    assert.equal(logs.filter(l => l.includes("could not save agent-sessions.json")).length, 1);
    assert.equal(existsSync(file), false);
    rmSync(`${file}.tmp`, { recursive: true });
    await new Promise(r => setTimeout(r, 150));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).r1.kind, "run");
  } finally { fake.remote.stop(); }
});

test("a write of agent-sessions.json that keeps failing stops retrying", async () => {
  const cachePath = primeDir({});
  const file = path.join(path.dirname(cachePath), "agent-sessions.json");
  mkdirSync(`${file}.tmp`);
  const logs = [];
  const fake = primeWorkspaced(cachePath, { log: l => logs.push(l) });
  try {
    fake.remote.markAgent("r1", "labrat", "run");
    // retryMs 50: retries after 50, 100 and 200 ms, then none.
    await new Promise(r => setTimeout(r, 700));
    const failed = logs.filter(l => l.includes("could not save agent-sessions.json"));
    assert.equal(failed.length, 4);
    assert.match(failed.at(-1), /giving up until the next change/);
    rmSync(`${file}.tmp`, { recursive: true });
    fake.remote.markAgent("r2", "labrat", "run");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort(), ["r1", "r2"], "the next change saves the whole map");
  } finally { fake.remote.stop(); }
});

// Follow-ups: a prime's requests on its worker's disk → web's wake-up list → a hidden run with the note as its brief.
function followUpSetup() {
  const dir = mkdtempSync(path.join(tmpdir(), "primes-"));
  const fake = primeWorkspaced(path.join(dir, "remote-projects.json"));
  const { entries } = runDoorConfig({ PI_WEB_RUN_PORT: "4000", PI_WEB_RUN_TOKENS: JSON.stringify(ENTRIES) });
  const clock = { t: Date.parse("2026-11-22T08:00:00Z") };
  const logs = [];
  const wakePath = path.join(dir, "wake-list.json");
  const primes = createPrimes({ entries, remote: fake.remote, log: l => logs.push(l), now: () => new Date(clock.t), wakePath });
  fake.sessions.set("conv", { name: "labrat" });
  fake.remote.markAgent("conv", "labrat", "conversation");
  fake.followUps.requests = [];
  const at = minutes => new Date(clock.t + minutes * 60_000).toISOString();
  const acks = () => fake.calls.filter(c => c[1] === "/follow-ups/ack").map(c => c[2]);
  const stop = () => { primes.stop(); fake.remote.stop(); };
  return { fake, primes, clock, logs, wakePath, at, acks, stop, followUps: () => primes.list().find(p => p.agent === "labrat").followUps };
}

test("a prime's follow-up requests are collected when its turn ends, acknowledged, and start a labelled run when due", async () => {
  const { fake, primes, clock, logs, wakePath, at, acks, stop, followUps } = followUpSetup();
  try {
    const note = "Check that the deploy\nfinished.";
    fake.sessions.set("o1", { name: "other: run" });
    fake.remote.markAgent("o1", "other", "run");
    fake.remote.markAgent("plain", "labrat");
    fake.followUps.requests = [
      { id: "f1", session: "conv", due: at(20), note },
      { id: "soon", session: "conv", due: at(1), note: "too soon" },
      { id: "x1", session: "stranger", due: at(20), note: "not a prime's session" },
      { id: "x2", session: "o1", due: at(20), note: "a prime of another project" },
      { id: "x3", session: "plain", due: at(20), note: "an agent session, not a prime's" },
      { id: "x4", session: "conv", due: at(31 * 24 * 60), note: "past the 30 days" },
      { session: "conv", due: at(20), note: "no id" },
    ];
    await primes.event("conv", "turn_end", { reason: "errored", willRetry: true });
    assert.deepEqual(acks(), [], "not at an attempt pi retries");
    await primes.event("conv", "turn_end", { reason: "done" });
    assert.deepEqual(followUps(), [{ id: "soon", due: at(10), note: "too soon" }, { id: "f1", due: at(20), note }], "soonest first, never sooner than 10 minutes after the pull");
    assert.deepEqual(acks(), [{ ids: ["f1", "soon", "x1", "x2", "x3", "x4"], pending: followUps() }]);
    assert.deepEqual(fake.followUps.requests, [{ session: "conv", due: at(20), note: "no id" }]);
    assert.deepEqual(logs.filter(l => l.includes("was refused")).map(l => l.match(/\((.*)\)$/)[1]), ["not asked in a session of this worker's prime", "not asked in a session of this worker's prime", "not asked in a session of this worker's prime", "invalid"]);
    assert.deepEqual(JSON.parse(readFileSync(wakePath, "utf8")).find(r => r.id === "f1"), { id: "f1", agent: "labrat", due: at(20), note, from: "conv" });
    assert.deepEqual(primes.list().find(p => p.agent === "other").followUps, []);

    // The same request again (its acknowledgement was lost): nothing is added twice.
    fake.followUps.requests = [{ id: "f1", session: "conv", due: at(20), note }];
    await primes.event(null, "worker_connected", { workspace: "ws-labrat" });
    assert.equal(followUps().length, 2);
    assert.deepEqual(acks().at(-1).ids, ["f1"]);

    // Due: each starts a hidden run whose brief says where the note comes from.
    clock.t += 20 * 60_000;
    const due = at(0);
    await primes.tick();
    assert.deepEqual(followUps(), []);
    assert.deepEqual(JSON.parse(readFileSync(wakePath, "utf8")), []);
    const created = fake.calls.filter(c => c[1] === "/projects/pp-labrat/sessions").map(c => c[2]);
    assert.deepEqual(created.find(b => b.followUp === note), { name: "labrat: follow-up 2026-11-22 08:20", agent: "labrat", kind: "run", followUp: note });
    assert.equal(created.length, 2);
    const run = fake.calls.find(c => c[1].endsWith("/message") && c[2].text.endsWith(note))[1].split("/")[2];
    assert.deepEqual({ ...fake.remote.agentOf(run), started: null }, { agent: "labrat", kind: "run", started: null, followUp: note });
    assert.equal(fake.calls.find(c => c[1] === `/sessions/${run}/message`)[2].text,
      `This run was started by a follow-up. In its conversation, this agent left itself the note below, to be woken with it at ${due.slice(0, 16).replace("T", " ")} UTC. It is the agent's own note, not a message from the owner.\n\n${note}`);
    assert.equal(primes.list().find(p => p.agent === "labrat").runs.length, 2, "listed with the prime's other runs");

    // Its report names the note that caused it.
    await primes.event(run, "turn_end", { reason: "done" });
    const report = fake.calls.find(c => c[1] === "/sessions/conv/note")[2];
    assert.equal(report.text, `Automated report from this agent's follow-up run "labrat: follow-up 2026-11-22 08:20" (finished, 2026-11-22 08:20 UTC), started by the follow-up this agent set for itself with the note "Check that the deploy finished.". This is the run's own output, not a message from the owner, and it does not ask for a reply:\n\nAll quiet (${run}).`);
    assert.equal(report.details.head, `**labrat: follow-up 2026-11-22 08:20** · ended 2026-11-22 08:20 UTC · [open the run](/?s=${run})\n\nFollow-up: Check that the deploy finished.`);
  } finally { stop(); }
});

test("a prime holds at most 5 pending follow-ups; it and the owner can cancel them", async () => {
  const { fake, primes, logs, at, acks, stop, followUps } = followUpSetup();
  try {
    fake.followUps.requests = [1, 2, 3, 4, 5, 6].map(i => ({ id: `f${i}`, session: "conv", due: at(20 + i), note: `note ${i}` }));
    await primes.event("conv", "turn_end", { reason: "done" });
    assert.deepEqual(followUps().map(f => f.id), ["f1", "f2", "f3", "f4", "f5"]);
    assert.equal(logs.filter(l => l.includes("was refused (full)")).length, 1);
    assert.deepEqual(fake.followUps.requests, [], "the refused one is acknowledged too: the worker's list shows it is not scheduled");

    // The prime cancels one of its own in a later turn; an id that is not its own changes nothing.
    fake.followUps.requests = [{ id: "c1", session: "conv", cancel: "f2" }, { id: "c2", session: "conv", cancel: "nope" }];
    await primes.event("conv", "turn_end", { reason: "stopped" });
    assert.deepEqual(followUps().map(f => f.id), ["f1", "f3", "f4", "f5"]);
    assert.deepEqual(acks().at(-1), { ids: ["c1", "c2"], pending: followUps() });

    // The owner cancels from the Activity list: the prime's own copy on its worker is refreshed at once.
    const app = new Hono();
    registerRemoteRoutes(app, Object.assign(fake.remote, { cancelFollowUp: primes.cancelFollowUp }));
    const before = acks().length;
    assert.equal((await app.request("/primes/labrat/follow-ups/f4", { method: "DELETE" })).status, 200);
    assert.deepEqual(followUps().map(f => f.id), ["f1", "f3", "f5"]);
    assert.equal(acks().length, before + 1);
    assert.deepEqual(fake.followUps.pending.map(f => f.id), ["f1", "f3", "f5"]);
    for (const p of ["/primes/labrat/follow-ups/f4", "/primes/other/follow-ups/f1", "/primes/nobody/follow-ups/f1"]) assert.equal((await app.request(p, { method: "DELETE" })).status, 404, p);
    assert.deepEqual(followUps().map(f => f.id), ["f1", "f3", "f5"]);
  } finally { stop(); }
});

test("a follow-up whose run cannot start stays pending; a worker without follow-ups is not acknowledged", async () => {
  const { fake, primes, clock, logs, at, acks, stop, followUps } = followUpSetup();
  try {
    fake.followUps.requests = [{ id: "f1", session: "conv", due: at(20), note: "later" }];
    await primes.event("conv", "turn_end", { reason: "done" });
    clock.t += 20 * 60_000;
    fake.followUps.requests = null;
    const real = fake.remote.createSession;
    fake.remote.createSession = async () => ({ status: 500, body: { error: "disk_full" } });
    await primes.tick();
    assert.deepEqual(followUps().map(f => f.id), ["f1"]);
    assert.match(logs.at(-1), /labrat's follow-up f1 did not start \(could not create the session \(disk_full\)\); trying again in 5 minutes/);
    fake.remote.createSession = real;
    clock.t += 5 * 60_000;
    await primes.tick();
    assert.deepEqual(followUps(), []);
    const before = acks().length;
    await primes.event(null, "worker_connected", { workspace: "ws-labrat" });
    assert.equal(acks().length, before);
  } finally { stop(); }
});
