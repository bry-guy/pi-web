import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createRemoteWorkspaces, registerRemoteRoutes } from "../server/remote-workspaces.js";
import { createRoleRuns } from "../server/role-runs.js";
import { createNotifier } from "../server/discord.js";
import { EventHub } from "../server/events.js";
import { createRoleRunner } from "../server/role-runner.js";

const MODEL = "anthropic/claude-opus-5-5";
const DEV = { name: "dev", role: "app/dev", provider: "openshell", repos: ["project:p-dev"] };
const DEFAULT = { name: "default", anyProject: true, repos: [], provider: null };
const caller = (extra = {}) => ({ name: "p", repository: "project:p", grant: "default", state: "running", ...extra });

// A fake workspaced with the calling project's worker (session c1) and, once created, the role's worker (run r1).
function fake({ workers = [caller()], grants = [DEFAULT, DEV], records = [], streaming = false, answerStatus = 200, allowed = true, route = () => null, onEvent = null, home = mkdtempSync(path.join(tmpdir(), "pi-web-role-runs-")) } = {}) {
  const calls = [];
  const state = { records, streaming, answerStatus };
  const fetchImpl = async (url, init = {}) => {
    const p = new URL(url).pathname.replace(/^\/v1/, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push([init.method || "GET", p, body]);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    const special = await route(init.method || "GET", p, body);
    if (special) return special;
    if (p === "/workspaces" && !init.method) return json({ workspaces: workers });
    if (p === "/grants") return json({ grants });
    if (p === "/workspaces" && init.method === "POST") {
      if (!allowed) return json({ error: "grant_not_allowed" }, 403);
      workers.push({ name: body.project, repository: `project:${body.project}`, grant: body.grant, provider: grants.find(g => g.name === body.grant)?.provider || undefined, state: "running" });
      return json({ name: body.project }, 201);
    }
    if (/^\/(github-auth|model-auth)$/.test(p) || p.endsWith("/wake") || p.endsWith("/api/health")) return json({ ok: true });
    if (p.endsWith("/api/events")) return json({}, 503);
    if (p === "/workspaces/p/api/state") return json({ projects: [{ id: "pp-p", sessions: [{ id: "c1" }] }] });
    if (p === "/workspaces/p-dev/api/state") return json({ projects: [{ id: "pp-p-dev", sessions: [{ id: "r1" }] }] });
    if (p.endsWith("/sessions/c1/meta")) return json({ id: "c1", model: MODEL });
    if (p.endsWith("/sessions/c1/role-run")) return json(state.answerStatus === 200 ? { ok: true } : { error: "boom" }, state.answerStatus);
    if (p.endsWith("/api/models")) return json({ models: [{ id: MODEL }] });
    if (p === "/workspaces/p-dev/api/projects/pp-p-dev/sessions") return json({ id: "r1" });
    if (/\/sessions\/r1\/(model|message|stop|name)$/.test(p)) return json({ ok: true });
    if (p.endsWith("/sessions/r1/transcript")) return json({ sessionId: "r1", streaming: state.streaming, records: state.records });
    return json({ error: "unexpected" }, 500);
  };
  const remote = createRemoteWorkspaces({ url: "http://workspaced", token: "t", hub: new EventHub(), fetchImpl, retryMs: 50, modelAuthSyncMs: 0, onEvent, cachePath: path.join(home, "remote-projects.json") });
  const file = path.join(home, "role-runs.json");
  const logs = [];
  const runs = () => createRoleRuns({ remote, path: file, log: m => logs.push(m) });
  const answers = () => calls.filter(([m, p]) => m === "POST" && p.endsWith("/sessions/c1/role-run")).map(([, , b]) => b);
  return { remote, calls, workers, state, file, logs, runs, answers, open: () => JSON.parse(readFileSync(file, "utf8")) };
}
const REQUEST = { request: "q1", role: "app/dev", msg: "You are running as role app/dev…\n\nTask:\nship it", name: "dev: ship it", cwd: "." };
const REPLY = [{ role: "user", text: "ship it" }, { role: "assistant", text: "thinking aloud", toolIds: ["t1"] }, { role: "tool" }, { role: "assistant", text: "Shipped: PR #7." }];

test("a granted role runs hidden on its own worker under the role's grant, and the reply goes back to the caller", async () => {
  const f = fake({ streaming: true });
  const runs = f.runs();
  await runs.event("c1", "role_run_request", REQUEST);
  assert.deepEqual(f.answers(), [{ request: "q1", state: "accepted" }, { request: "q1", state: "started", run: "r1" }]);
  assert.deepEqual(f.calls.find(([m, p]) => m === "POST" && p === "/workspaces")[2], { project: "p-dev", grant: "dev" });
  assert.deepEqual(f.workers.map(w => [w.name, w.grant]), [["p", "default"], ["p-dev", "dev"]], "never the calling worker");
  const created = f.calls.find(([m, p]) => m === "POST" && p === "/workspaces/p-dev/api/projects/pp-p-dev/sessions")[2];
  assert.deepEqual([created.agent, created.kind], ["app/dev", "run"]);
  assert.deepEqual(f.remote.agentOf("r1"), { agent: "app/dev", kind: "run" }, "hidden like a prime's run");
  assert.deepEqual(f.calls.find(([, p]) => p.endsWith("/sessions/r1/model"))[2], { model: MODEL }, "the calling session's model");
  assert.deepEqual(f.calls.find(([, p]) => p.endsWith("/sessions/r1/message"))[2], { text: REQUEST.msg });
  assert.deepEqual(Object.keys(f.open()), ["r1"]);
  assert.deepEqual(f.calls.find(([, p]) => p.endsWith("/sessions/r1/name"))[2], { name: "dev: ship it" });

  // A failed attempt pi retries is not the end; another session's turn end is nobody's run.
  await runs.event("r1", "turn_end", { reason: "errored", error: "overloaded", willRetry: true });
  await runs.event("c1", "turn_end", { reason: "done" });
  assert.equal(f.answers().length, 2);

  f.state.records = REPLY;
  await runs.event("r1", "turn_end", { reason: "done" });
  assert.deepEqual(f.answers()[2], { request: "q1", state: "done", status: "done", isError: false, text: "app/dev run done (run: r1)\n\nShipped: PR #7.", role: "app/dev", run: "r1" });
  assert.equal(f.remote.agentOf("r1").reported, true);
  assert.deepEqual(f.open(), {});
  await runs.event("r1", "turn_end", { reason: "done" });
  assert.equal(f.answers().length, 3, "delivered once");
});

test("a role run is not DMed at each turn end, and its question is DMed at once", async () => {
  const f = fake({ streaming: true });
  await f.runs().event("c1", "role_run_request", REQUEST);
  const sent = [];
  const discord = createNotifier({ userId: "u", baseUrl: "http://web", transport: { send: async content => (sent.push(content), { id: String(sent.length) }) }, post: async () => ({ status: 200, body: {} }), agentOf: f.remote.agentOf, log: () => {} });
  discord.event("r1", "message_start", { role: "assistant" });
  discord.event("r1", "turn_end", { reason: "done" });
  discord.event("r1", "extension_ui_request", { method: "confirm", requestId: "x", title: "Push?" });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Push\?/);
});

test("a role the project is not granted, a caller that is no project worker, and a role's own worker are refused; nothing starts", async () => {
  const refused = async (options, pattern) => {
    const f = fake(options);
    await f.runs().event("c1", "role_run_request", REQUEST);
    assert.equal(f.answers().at(-1).state, "failed");
    assert.match(f.answers().at(-1).message, pattern);
    assert.equal(f.calls.some(([m, p]) => m === "POST" && (p === "/workspaces" || p.endsWith("/sessions") || p.endsWith("/message"))), false, "no worker, session or brief");
  };
  await refused({ grants: [DEFAULT] }, /^Can't start app\/dev: app\/dev is not granted to p on pi-web\. Role grants are in/);
  await refused({ grants: [DEFAULT, { ...DEV, repos: ["project:other-dev"] }] }, /not granted to p on pi-web/);
  await refused({ grants: [DEFAULT, { ...DEV, provider: null }] }, /not granted to p on pi-web/);
  await refused({ grants: [DEFAULT, { ...DEV, role: "app/ops", name: "ops", repos: ["project:p-ops"] }] }, /not granted to p on pi-web \(granted: app\/ops\)/);
  await refused({ workers: [caller({ repository: "o/app" })] }, /needs a pi project session/);
  await refused({ workers: [caller({ grant: "dev" })] }, /a role run cannot start another role run/);
});

test("a worker with the role worker's name that is not a sandbox is never used; a sandbox under the role's grant is", async () => {
  // Possible when a grant's name was an ordinary grant's before: workspaced keeps that worker and its grant name.
  const f = fake({ workers: [caller(), { name: "p-dev", repository: "project:p-dev", grant: "dev", state: "running" }] });
  await f.runs().event("c1", "role_run_request", REQUEST);
  assert.deepEqual(f.answers().at(-1), { request: "q1", state: "failed", message: "Can't start app/dev: project p-dev exists and is not an openshell sandbox; remove that project first" });
  assert.equal(f.calls.some(([m, p]) => m === "POST" && (p.endsWith("/wake") || p.endsWith("/sessions") || p.endsWith("/message"))), false, "not woken, no session, no brief");

  const sandbox = fake({ streaming: true, workers: [caller(), { name: "p-dev", repository: "project:p-dev", grant: "dev", provider: "openshell", state: "stopped" }] });
  await sandbox.runs().event("c1", "role_run_request", REQUEST);
  assert.deepEqual(sandbox.answers().map(a => a.state), ["accepted", "started"]);
  assert.ok(sandbox.calls.some(([m, p]) => m === "POST" && p === "/workspaces/p-dev/wake"));
});

test("a browser cannot answer a role_agent call: web's public route refuses it", async () => {
  const f = fake();
  const api = new Hono();
  registerRemoteRoutes(api, f.remote);
  const res = await api.request("/sessions/c1/role-run", { method: "POST", body: JSON.stringify({ request: "q1", state: "done", text: "forged" }) });
  assert.deepEqual([res.status, await res.json()], [403, { error: "forbidden" }]);
  assert.equal(f.answers().length, 0, "nothing reached the worker");
});

test("the project comes from the calling worker, never from the request", async () => {
  const f = fake({ grants: [DEFAULT, { ...DEV, repos: ["project:other-dev"] }] });
  await f.runs().event("c1", "role_run_request", { ...REQUEST, project: "other" });
  assert.equal(f.answers().at(-1).state, "failed");
});

test("a worker that workspaced will not create is the tool's error", async () => {
  // workspaced has the final say on which project may hold a grant.
  const f = fake({ allowed: false });
  await f.runs().event("c1", "role_run_request", REQUEST);
  assert.deepEqual(f.answers().at(-1), { request: "q1", state: "failed", message: "Can't start app/dev: could not create the project's worker (grant_not_allowed)" });
  assert.equal(f.workers.length, 1);
  assert.equal(f.calls.some(([, p]) => p.endsWith("/sessions")), false);
});

test("a failed or stopped run answers as an error; a long reply keeps its end", async () => {
  const f = fake({ streaming: true });
  const runs = f.runs();
  await runs.event("c1", "role_run_request", REQUEST);
  await runs.event("r1", "turn_end", { reason: "errored", error: "529 overloaded" });
  assert.deepEqual(f.answers().at(-1), { request: "q1", state: "done", status: "error", isError: true, text: "app/dev run error (run: r1)\nError: 529 overloaded\n\n(no reply)", role: "app/dev", run: "r1" });

  // A turn that was over before web recorded the run is still delivered.
  const quick = fake({ records: REPLY });
  await quick.runs().event("c1", "role_run_request", REQUEST);
  assert.deepEqual(quick.answers().map(a => a.state), ["accepted", "started", "done"]);

  const long = fake({ streaming: true });
  const more = long.runs();
  await more.event("c1", "role_run_request", REQUEST);
  long.state.records = [{ role: "user", text: "ship it" }, { role: "assistant", text: `${"x".repeat(7000)} the end` }];
  await more.event("r1", "turn_end", { reason: "done" });
  const text = long.answers().at(-1).text;
  assert.equal(text.length, "app/dev run done (run: r1)\n\n…".length + 6000);
  assert.ok(text.endsWith(" the end"));
});

test("a run whose caller could not be told it started is not reported as a failed start", async () => {
  const f = fake({ streaming: true, route: (m, p, body) => { if (p.endsWith("/sessions/c1/role-run") && body?.state === "started") throw new Error("socket hang up"); return null; } });
  const runs = f.runs();
  await runs.event("c1", "role_run_request", REQUEST);
  assert.deepEqual(f.answers().map(a => a.state), ["accepted", "started"], "no \"failed\": the run is live, and a retry would start a second one");
  assert.match(f.logs.at(-1), /role run r1 \(app\/dev\) started, but its caller was not told: socket hang up/);
  assert.deepEqual(Object.keys(f.open()), ["r1"]);
  f.state.records = REPLY;
  await runs.event("r1", "turn_end", { reason: "done" });
  assert.equal(f.answers().at(-1).state, "done");
});

test("a caller that aborts before the run exists: the run is stopped once it does, and nothing is delivered", async () => {
  let runs = null, stop = null;
  // The stop arrives while web is still creating the role's worker.
  const f = fake({ streaming: true, route: (m, p) => { if (m === "POST" && p === "/workspaces") stop = runs.event("c1", "role_run_stop", { request: "q1" }); return null; } });
  runs = f.runs();
  await runs.event("c1", "role_run_request", REQUEST);
  await stop;
  assert.ok(f.calls.some(([m, p]) => m === "POST" && p.endsWith("/sessions/r1/stop")));
  assert.deepEqual(f.answers().map(a => a.state), ["accepted"], "neither started nor failed: the caller already gave up");
  assert.equal(f.remote.agentOf("r1").reported, true);
  assert.equal(existsSync(f.file), false, "never recorded as open");
  await runs.event("r1", "turn_end", { reason: "stopped" });
  assert.equal(f.answers().length, 1);
});

test("a caller that aborts stops the run, and nothing is delivered", async () => {
  const f = fake({ streaming: true });
  const runs = f.runs();
  await runs.event("c1", "role_run_request", REQUEST);
  await runs.event("c1", "role_run_stop", { request: "q1" });
  assert.ok(f.calls.some(([m, p]) => m === "POST" && p.endsWith("/sessions/r1/stop")));
  await runs.event("r1", "turn_end", { reason: "stopped" });
  assert.equal(f.answers().length, 2);
  assert.deepEqual(f.open(), {});
  assert.equal(f.remote.agentOf("r1").reported, true);
});

test("a run that ended while web was down is delivered when web connects to its worker; a failed delivery is kept", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "pi-web-role-runs-"));
  writeFileSync(path.join(home, "role-runs.json"), JSON.stringify({ r1: { parent: "c1", request: "q1", role: "app/dev", at: Date.now() } }));
  const f = fake({ home, workers: [caller(), { name: "p-dev", repository: "project:p-dev", grant: "dev", state: "running" }], records: REPLY, streaming: true, answerStatus: 500 });
  f.remote.markAgent("r1", "app/dev", "run");
  const runs = f.runs();
  await runs.event(null, "worker_connected", { workspace: "p-dev" });
  assert.equal(f.answers().length, 0, "still running");
  f.state.streaming = false;
  await runs.event(null, "worker_connected", { workspace: "p" });
  assert.equal(f.answers().length, 0, "another worker's connect does not read this run");
  await runs.event(null, "worker_connected", { workspace: "p-dev" });
  assert.equal(f.answers().length, 1);
  assert.deepEqual(Object.keys(f.open()), ["r1"], "the caller did not take it: kept for the next connect");
  assert.match(f.logs.at(-1), /was not delivered: the calling session did not take it \(boom\)/);
  f.state.answerStatus = 200;
  await runs.event(null, "worker_connected", { workspace: "p-dev" });
  assert.equal(f.answers().at(-1).text, "app/dev run done (run: r1)\n\nShipped: PR #7.");
  assert.deepEqual(f.open(), {});
});

test("a result the caller's worker did not take is kept and retried when that worker connects, once", async () => {
  const f = fake({ streaming: true, answerStatus: 200 });
  const runs = f.runs();
  await runs.event("c1", "role_run_request", REQUEST);
  // The calling worker restarts as the run ends.
  f.state.answerStatus = 503;
  f.state.records = REPLY;
  await runs.event("r1", "turn_end", { reason: "done" });
  assert.deepEqual(f.open().r1.result, { status: "done", text: "app/dev run done (run: r1)\n\nShipped: PR #7." });
  const reads = () => f.calls.filter(([, p]) => p.endsWith("/sessions/r1/transcript")).length;
  const sent = () => f.answers().filter(a => a.state === "done").length;
  const [before, read] = [sent(), reads()];
  f.state.answerStatus = 200;
  // Web restarted too: the kept result is all it needs. Both workers connect at once.
  const again = f.runs();
  await Promise.all([again.event(null, "worker_connected", { workspace: "p" }), again.event(null, "worker_connected", { workspace: "p-dev" })]);
  assert.equal(sent(), before + 1, "delivered once");
  assert.deepEqual(f.answers().at(-1), { request: "q1", state: "done", status: "done", isError: false, text: "app/dev run done (run: r1)\n\nShipped: PR #7.", role: "app/dev", run: "r1" });
  assert.deepEqual(f.open(), {});
  await again.event(null, "worker_connected", { workspace: "p" });
  await again.event(null, "worker_connected", { workspace: "p-dev" });
  assert.equal(sent(), before + 1);

  // The caller's connect alone delivers, without the role's worker.
  const alone = fake({ streaming: true });
  const more = alone.runs();
  await more.event("c1", "role_run_request", REQUEST);
  alone.state.answerStatus = 503;
  await more.event("r1", "turn_end", { reason: "errored", error: "529 overloaded" });
  alone.state.answerStatus = 200;
  const seen = alone.calls.length;
  await more.event(null, "worker_connected", { workspace: "p" });
  assert.equal(alone.answers().at(-1).status, "error");
  assert.equal(alone.calls.slice(seen).some(([, p]) => p.includes("/workspaces/p-dev/")), false, "the role's worker is not asked again");
  assert.deepEqual(alone.open(), {});
});

test("end to end: the worker's runner and web agree on the wire, through the worker's event stream", async () => {
  const workerHub = new EventHub(); // the calling worker's own hub
  const runner = createRoleRunner(workerHub);
  const noted = [];
  let roleRuns = null, started = null;
  const f = fake({
    streaming: true,
    onEvent: (...a) => { const work = roleRuns?.event(...a); if (a[1] === "role_run_request") started = work; },
    route: async (method, p, body) => {
      if (p === "/workspaces/p/api/events") return new Response(new ReadableStream({ start(c) { workerHub.addClient(frame => c.enqueue(new TextEncoder().encode(frame))); } }));
      if (method === "POST" && p === "/workspaces/p/api/sessions/c1/role-run") return Response.json({ ok: await runner.answer(body, async (...n) => { noted.push(n); }, "c1") });
      return null;
    },
  });
  roleRuns = f.runs();
  try {
    await f.remote.refresh(); // web listens to the calling worker, as it does once a browser or a message reached it
    await new Promise(r => setTimeout(r, 20));
    const result = runner.run({ project: "p", role: "app/dev", msg: REQUEST.msg, name: "dev: ship it", cwd: "worktrees/app/x", session: "c1", background: false });
    await new Promise(r => setTimeout(r, 20));
    await started;
    assert.match(f.calls.find(([, p]) => p.endsWith("/sessions/r1/message"))[2].text, /Task:\nship it\n\n\(The caller asked for worktrees\/app\/x\. This run starts in the project folder of a separate worker with its own disk\.\)$/);
    f.state.records = REPLY;
    await roleRuns.event("r1", "turn_end", { reason: "done" });
    assert.deepEqual(await result, { text: "app/dev run done (run: r1)\n\nShipped: PR #7.", isError: false, status: "done", background: false });
    assert.deepEqual(noted, []);
  } finally { f.remote.stop(); }
});
