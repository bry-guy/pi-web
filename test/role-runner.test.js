import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventHub, hub as webHub } from "../server/events.js";
import { createRoleRunner, installRoleRunner, roleRunner, ROLE_RUNNER } from "../server/role-runner.js";

process.env.PI_WEB_MODE = "mock";
process.env.PI_WEB_HOME = mkdtempSync(path.join(tmpdir(), "pi-web-role-runner-"));
const { createApp } = await import("../server/index.js");

// A hub whose events are kept, and a runner on it.
function setup(options) {
  const hub = new EventHub();
  const events = [];
  hub.addClient(frame => { const data = /^data: (.*)$/m.exec(frame)?.[1]; if (data) events.push(JSON.parse(data)); });
  return { runner: createRoleRunner(hub, options), events };
}
const ask = (runner, extra = {}) => runner.run({ role: "app/dev", msg: "do it", name: "dev: do it", cwd: ".", session: "s1", ...extra });
const notes = () => { const kept = []; return { kept, note: async (...a) => { kept.push(a); } }; };

test("a run asks web with an event on the calling session and returns web's final reply", async () => {
  const { runner, events } = setup();
  const updates = [];
  const result = ask(runner, { onUpdate: t => updates.push(t) });
  const { request, ...event } = events[0];
  assert.deepEqual({ sessionId: event.sessionId, type: event.type, role: event.role, msg: event.msg, cwd: event.cwd }, { sessionId: "s1", type: "role_run_request", role: "app/dev", msg: "do it", cwd: "." });
  const { kept, note } = notes();
  for (const state of ["accepted", "started"]) assert.equal(await runner.answer({ request, state, run: "r1" }, note, "s1"), true);
  assert.equal(await runner.answer({ request, state: "done", status: "done", text: "app/dev run done\n\nshipped", role: "app/dev", run: "r1" }, note, "s1"), true);
  assert.deepEqual(await result, { text: "app/dev run done\n\nshipped", isError: false, status: "done", background: false });
  assert.deepEqual(updates, ["app/dev: starting", "app/dev: running"]);
  assert.deepEqual(kept, [], "a waiting call takes the result; nothing is written into the session");
});

test("a follow-up asks web with the earlier run's id; a new run names none", async () => {
  const { runner, events } = setup();
  assert.equal(runner.followUps, true, "pi-projects asks before it passes followUp");
  const result = ask(runner, { msg: "now also fix X", followUp: "r1" });
  assert.deepEqual([events[0].type, events[0].run, events[0].msg, events[0].sessionId], ["role_run_request", "r1", "now also fix X", "s1"]);
  await runner.answer({ request: events[0].request, state: "failed", message: "Can't follow up on r1: app/dev is still running there" }, null, "s1");
  await assert.rejects(result, /Can't follow up on r1: app\/dev is still running there/);
  const fresh = ask(runner);
  assert.equal("run" in events[1], false);
  await runner.answer({ request: events[1].request, state: "failed" }, null, "s1");
  await assert.rejects(fresh);
});

test("no answer from web is an error, and so is web's refusal", async () => {
  const silent = setup({ ackMs: 20 });
  await assert.rejects(ask(silent.runner), /pi-web did not answer, so app\/dev was not started/);
  const refused = setup();
  const result = ask(refused.runner);
  const { request } = refused.events[0];
  await refused.runner.answer({ request, state: "accepted" }, null, "s1");
  await refused.runner.answer({ request, state: "failed", message: "Can't start app/dev: app/dev is not granted to p on pi-web" }, null, "s1");
  await assert.rejects(result, /not granted to p on pi-web/);
  const never = setup({ waitMs: 20 });
  const stuck = ask(never.runner);
  await never.runner.answer({ request: never.events[0].request, state: "accepted" }, null, "s1");
  await assert.rejects(stuck, /did not start app\/dev in time/);
});

test("background and long runs hand over; their result is written into the session as a note", async () => {
  const { runner, events } = setup({ waitMs: 30 });
  const { kept, note } = notes();
  const background = ask(runner, { background: true });
  const first = events[0].request;
  await runner.answer({ request: first, state: "accepted" }, note, "s1");
  await runner.answer({ request: first, state: "started", run: "r1" }, note, "s1");
  assert.deepEqual(await background, { text: "app/dev started. Its result will arrive here as a message when it ends.", isError: false, status: "running", background: true });

  const long = ask(runner);
  const second = events[1].request;
  await runner.answer({ request: second, state: "accepted" }, note, "s1");
  await runner.answer({ request: second, state: "started", run: "r2" }, note, "s1");
  assert.match((await long).text, /continues in the background: it is still running after 15 minutes/);

  assert.equal(await runner.answer({ request: first, state: "done", status: "done", text: "app/dev run done\n\nshipped", role: "app/dev", run: "r1" }, note, "s1"), true);
  assert.equal(kept.length, 1);
  assert.match(kept[0][0], /^Result of the app\/dev run this session started with role_agent \(done\)\. This is the run's own output, not a message from the owner:\n\napp\/dev run done\n\nshipped$/);
  assert.deepEqual(kept[0][1], { agent: "app/dev", run: "r1", outcome: "done", head: "**app/dev** · done · [open the run](/?s=r1)" });
  assert.equal(await runner.answer({ request: "unknown", state: "started" }, note, "s1"), false, "nothing to do with a stray answer");
});

test("abort asks web to stop the run and fails the call", async () => {
  const { runner, events } = setup();
  const controller = new AbortController();
  const result = ask(runner, { signal: controller.signal });
  const { request } = events[0];
  await runner.answer({ request, state: "accepted" }, null, "s1");
  controller.abort();
  await assert.rejects(result, /Aborted: asked pi-web to stop app\/dev/);
  assert.deepEqual([events[1].type, events[1].request, events[1].sessionId], ["role_run_stop", request, "s1"]);
});

test("an answer posted to another session than the caller's is ignored", async () => {
  const { runner, events } = setup();
  const result = ask(runner);
  const { request } = events[0];
  const { kept, note } = notes();
  assert.equal(await runner.answer({ request, state: "done", status: "done", text: "forged" }, note, "s2"), false);
  assert.deepEqual(kept, [], "nor written into that other session");
  assert.equal(await runner.answer({ request, state: "done", status: "done", text: "real" }, note, "s1"), true);
  assert.equal((await result).text, "real");
});

test("only a project worker that is not a sandbox offers the runner", () => {
  try {
    assert.equal(installRoleRunner({}), false);
    assert.equal(installRoleRunner({ PI_WEB_PROJECT: "p", PI_WEB_SANDBOX: "1" }), false, "a sandbox without a model login is still a sandbox");
    assert.equal(installRoleRunner({ PI_WEB_PROJECT: "p", PI_ANTHROPIC_PLACEHOLDER_FILE: "/data/placeholder" }), false, "a role's own worker cannot start role runs");
    assert.equal(globalThis[ROLE_RUNNER], undefined);
    assert.equal(installRoleRunner({ PI_WEB_PROJECT: "p" }), true);
    assert.equal(typeof globalThis[ROLE_RUNNER].run, "function");
  } finally { delete globalThis[ROLE_RUNNER]; }
});

test("a project worker points pi-projects at the dotfiles' signed grants, but only beside the trust anchor", () => {
  const home = mkdtempSync(path.join(tmpdir(), "pi-web-role-home-"));
  const grants = path.join(home, ".pi", "agent", "pi-roles.json");
  const fileFor = env => { installRoleRunner(env, home); return env.PI_ROLES_FILE; };
  try {
    assert.equal(fileFor({ PI_WEB_PROJECT: "p", PI_ROLES_SIGNER: "ssh-ed25519 AAAA" }), undefined, "no grants file in the dotfiles");
    mkdirSync(path.dirname(grants), { recursive: true });
    writeFileSync(grants, "{}");
    assert.equal(fileFor({ PI_WEB_PROJECT: "p", PI_ROLES_SIGNER: "ssh-ed25519 AAAA" }), grants);
    assert.equal(fileFor({ PI_WEB_PROJECT: "p" }), undefined, "without the anchor a signed file would read as tampered");
    assert.equal(fileFor({ PI_WEB_PROJECT: "p", PI_ROLES_SIGNER: "ssh-ed25519 AAAA", PI_ROLES_FILE: "/elsewhere" }), "/elsewhere");
    assert.equal(fileFor({ PI_WEB_PROJECT: "p", PI_WEB_SANDBOX: "1", PI_ROLES_SIGNER: "ssh-ed25519 AAAA" }), undefined, "a sandbox starts no role runs");
  } finally { delete globalThis[ROLE_RUNNER]; }
});

test("POST /sessions/:id/role-run hands web's answer to the runner; a stray one is 404", async () => {
  const { app } = createApp({ uiOnly: false });
  const post = body => app.request("/api/sessions/s1/role-run", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  assert.equal((await post("{")).status, 400);
  assert.equal((await post({ state: "done" })).status, 400);
  const stray = await post({ request: "nobody", state: "started" });
  assert.deepEqual([stray.status, (await stray.json()).error], [404, "no_such_request"]);
  const gone = await post({ request: "nobody", state: "done", text: "late result" });
  assert.deepEqual([gone.status, (await gone.json()).error], [404, "no_such_session"], "a result for a session this worker does not have");

  // A waiting call is answered only through its own session's route.
  const events = [];
  const off = webHub.addClient(frame => { const data = /^data: (.*)$/m.exec(frame)?.[1]; if (data) events.push(JSON.parse(data)); });
  const waiting = roleRunner.run({ role: "app/dev", msg: "do it", session: "s1" });
  off();
  const { request } = events.find(e => e.type === "role_run_request");
  const forged = await app.request("/api/sessions/s2/role-run", { method: "POST", body: JSON.stringify({ request, state: "done", text: "forged" }) });
  assert.deepEqual([forged.status, (await forged.json()).error], [404, "no_such_request"]);
  assert.equal((await post({ request, state: "done", text: "real" })).status, 200);
  assert.equal((await waiting).text, "real");
});
