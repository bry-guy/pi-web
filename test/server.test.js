import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import * as ws from "../server/workspaces.js";
import { chatsDir, loadConfig, saveConfig } from "../server/config.js";
import {
  base,
  get,
  home,
  J,
  post,
  SSE,
  supervisor,
  setupServerFixture,
} from "./helpers/server-fixture.js";

setupServerFixture();

test("unknown API failures return structured JSON with a request id", async () => {
  const response = await fetch(base + "/api/projects", {
    method: "POST",
    headers: J,
    body: "{",
  });
  assert.equal(response.status, 500);
  assert.match(response.headers.get("x-request-id") || "", /^[0-9a-f-]{36}$/);
  const body = await response.json();
  assert.equal(body.error, "internal_error");
  assert.equal(body.requestId, response.headers.get("x-request-id"));
});

test("removed 1Password endpoints and state leave legacy files untouched", async () => {
  const credential = path.join(home, "credentials", "onepassword-service-account-token");
  const bytes = Buffer.from("synthetic-legacy-value\n");
  fs.mkdirSync(path.dirname(credential), { recursive: true, mode: 0o700 });
  fs.writeFileSync(credential, bytes, { mode: 0o600 });
  fs.chmodSync(credential, 0o600);
  const mode = fs.statSync(credential).mode & 0o777;

  const responses = [
    await get("/api/onepassword/status"),
    await post("/api/onepassword/connect", { token: "synthetic-token" }),
    await post("/api/onepassword/disconnect", {}),
  ];
  for (const response of responses) assert.equal(response.status, 404);

  const stateResponse = await get("/api/state");
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.settings.onepassword, undefined);
  const settingsResponse = await post("/api/settings", {});
  assert.equal(settingsResponse.status, 200);
  const settings = await settingsResponse.json();
  assert.equal(settings.settings.onepassword, undefined);
  assert.deepEqual(fs.readFileSync(credential), bytes);
  assert.equal(fs.statSync(credential).mode & 0o777, mode);
});

test("scope errors from a session command preserve their HTTP status", async () => {
  const { createApp } = await import("../server/index.js");
  const failure = Object.assign(new Error("conversation belongs to a different Git repository"), {
    code: "workspace_mismatch",
    status: 409,
  });
  const { app, sup } = createApp({});
  sup.message = async () => { throw failure; };
  const created = await app.request("http://pi-web.test/api/chats", { method: "POST" });
  assert.equal(created.status, 200);
  const { id } = await created.json();
  const response = await app.request(`http://pi-web.test/api/sessions/${id}/message`, {
    method: "POST",
    headers: J,
    body: JSON.stringify({ text: "hello" }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "workspace_mismatch");
});

test("serves the UI", async () => {
  const html = await (await get("/")).text();
  assert.match(html, /<pi-app>/);
  assert.match(html, /\/vendor\/marked\.umd\.js/);
  assert.match(html, /\/vendor\/dompurify\.min\.js/);
  const markedAsset = await (await get("/vendor/marked.umd.js")).text();
  const purifierAsset = await (await get("/vendor/dompurify.min.js")).text();
  assert.match(markedAsset, /marked/);
  assert.match(purifierAsset, /DOMPurify/);
  assert.equal((await get("/node_modules/marked/package.json")).status, 404, "node_modules is not generally web-accessible");
  const css = await (await get("/app.css")).text();
  assert.match(css, /--pi-orange/);
  // Custom elements default to display:inline; without this rule the sidebar,
  // header, composer, and file panel are not flex items and collapse.
  assert.match(css, /pi-sidebar[\s\S]{0,200}display:\s*contents/);
  // On a phone the file tree covers the whole screen.
  assert.match(css, /aside\.files\s*\{\s*position: fixed; inset: 0; width: 100%;/);
});

test("state exposes the API contract and health marker", async () => {
  const state = await (await get("/api/state")).json();
  assert.equal(state.apiContractVersion, 5);
  assert.ok(state.capabilities.includes("provider-auth"));
  assert.ok(state.capabilities.includes("workspace-contexts"));
  assert.ok(state.capabilities.includes("workspace-branches"));
  assert.ok(state.capabilities.includes("slash-commands"));
  assert.ok(state.capabilities.includes("project-hooks"));
  assert.ok(state.capabilities.includes("pi-resources"));
  assert.ok(state.capabilities.includes("extension-activity"));
  assert.ok(state.capabilities.includes("subagent-activity"));
  assert.equal(state.piConfiguration.profile.status, "none");
  assert.equal(state.settings.githubClientId, undefined);
  assert.ok(state.projects.every(project => Array.isArray(project.contexts)));
  const health = await (await get("/api/health")).json();
  assert.equal(health.ok, true);
  assert.equal(health.apiContractVersion, 5);
});

test("repository-owner changes do not reload Pi configuration", async () => {
  const originalConfig = loadConfig();
  const originalGithubOwner = process.env.PI_WEB_GITHUB_OWNER;
  delete process.env.PI_WEB_GITHUB_OWNER;
  const originalReload = supervisor.reloadPiConfiguration;
  const originalAssertReloadable = supervisor.assertPiConfigurationReloadable;
  let reloads = 0;
  supervisor.assertPiConfigurationReloadable = () => {
    throw Object.assign(new Error("configuration is busy"), { code: "pi_configuration_busy" });
  };
  supervisor.reloadPiConfiguration = async (...args) => {
    reloads++;
    return originalReload.call(supervisor, ...args);
  };
  try {
    const response = await post("/api/settings", { githubOwner: "alice" });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(reloads, 0);
    assert.equal(body.operation, undefined);
    assert.equal(body.settings.githubOwner.value, "alice");

    const piResponse = await post("/api/settings", { pi: { profile: null, profileSource: "auto", packages: [], extensions: [] } });
    const piBody = await piResponse.json();
    assert.equal(piResponse.status, 409, JSON.stringify(piBody));
    assert.equal(piBody.error, "pi_configuration_busy");
  } finally {
    supervisor.reloadPiConfiguration = originalReload;
    supervisor.assertPiConfigurationReloadable = originalAssertReloadable;
    if (originalGithubOwner === undefined) delete process.env.PI_WEB_GITHUB_OWNER;
    else process.env.PI_WEB_GITHUB_OWNER = originalGithubOwner;
    saveConfig(originalConfig);
  }
});

test("plain chats use isolated scratch workspaces and retain legacy discovery", async () => {
  const sse = new SSE(base + "/api/events");
  const a = await (await post("/api/chats")).json();
  const b = await (await post("/api/chats")).json();
  const metaA = await (await get(`/api/sessions/${a.id}/meta`)).json();
  const metaB = await (await get(`/api/sessions/${b.id}/meta`)).json();
  const chatRoot = path.resolve(chatsDir());
  assert.notEqual(metaA.cwd, metaB.cwd);
  for (const cwd of [metaA.cwd, metaB.cwd]) {
    assert.ok(fs.existsSync(cwd));
    assert.ok(path.relative(chatRoot, cwd) && !path.relative(chatRoot, cwd).startsWith(".."));
  }

  let state = await (await get("/api/state")).json();
  assert.ok(state.chats.some(chat => chat.id === a.id));
  assert.ok(state.chats.some(chat => chat.id === b.id));

  const legacy = await supervisor.createSession({ cwd: chatsDir() });
  state = await (await get("/api/state")).json();
  assert.ok(state.chats.some(chat => chat.id === legacy.id));

  await post(`/api/sessions/${b.id}/message`, { text: "stream in chat B" });
  await sse.wait(e => e.sessionId === b.id && e.type === "message_start");
  const aResponse = await post(`/api/sessions/${a.id}/message`, { text: "chat A is independent" });
  assert.equal(aResponse.status, 200);
  await sse.wait(e => e.sessionId === a.id && e.type === "turn_end");
  await sse.wait(e => e.sessionId === b.id && e.type === "turn_end");

  const branchResponse = await post(`/api/sessions/${a.id}/branch`, { branch: "not-a-chat-branch", create: true });
  assert.equal(branchResponse.status, 404);
  const forkResponse = await post(`/api/sessions/${b.id}/fork`, {});
  assert.equal(forkResponse.status, 200);
  const forkedChat = await forkResponse.json();
  const forkedMeta = await (await get(`/api/sessions/${forkedChat.id}/meta`)).json();
  assert.equal(forkedMeta.cwd, metaB.cwd);
  const mergeResponse = await post(`/api/sessions/${b.id}/merge-local`, {});
  assert.equal(mergeResponse.status, 404);
  assert.equal((await mergeResponse.json()).error, "no_project_for_session");

  await post(`/api/sessions/${a.id}/bang`, { cmd: "pwd" });
  const bang = await sse.wait(e => e.sessionId === a.id && e.type === "bang_end");
  assert.equal(fs.realpathSync(bang.stdout.trim()), fs.realpathSync(metaA.cwd));

  const closeResponse = await post(`/api/sessions/${a.id}/close`, {});
  assert.equal(closeResponse.status, 200);
  const closeBody = await closeResponse.json();
  assert.ok(closeBody.operation.events.some(event => /archived/i.test(event.message)));
  assert.equal(closeBody.operation.events.some(event => /pi close/i.test(event.message || event.command || "")), false);
  assert.ok(fs.existsSync(metaA.cwd));
  state = await (await get("/api/state")).json();
  assert.ok(!state.chats.some(chat => chat.id === a.id));
});

test("operation diagnostics are persisted and exposed through the logs endpoint", async () => {
  const { id } = await (await post("/api/chats")).json();
  const close = await post(`/api/sessions/${id}/close`, { operationId: "log-test" });
  assert.equal(close.status, 200, await close.clone().text());
  const result = await (await get("/api/logs?limit=100")).json();
  assert.equal(result.file, "logs/pi-ez-web.log");
  assert.ok(result.logs.some(entry => entry.operationId === "log-test" && /archived|close/i.test(entry.message)));
  assert.ok(fs.existsSync(path.join(home, "logs", "pi-ez-web.log")));
});

test("plain chat: full turn lifecycle over SSE (thinking -> deltas -> done)", async () => {
  const sse = new SSE(base + "/api/events");
  const { id } = await (await post("/api/chats")).json();
  assert.ok(id);
  const models = await (await get("/api/models")).json();
  assert.deepEqual(models.models.map(m => m.id), ["mock/fast", "mock/smart"]);

  await post(`/api/sessions/${id}/message`, { text: "hello there" });
  const ur = await sse.wait(e => e.sessionId === id && e.type === "user_record");
  assert.equal(ur.record.text, "hello there");
  const ts = await sse.wait(e => e.sessionId === id && e.type === "turn_start");
  assert.ok(ts.turnId);
  assert.equal(sse.events.filter(e => e.sessionId === id && e.type === "user_record").length, 1);
  const ms = await sse.wait(e => e.sessionId === id && e.type === "message_start");
  assert.equal(ms.role, "assistant");
  // thinking gap: no text_delta may precede message_start
  const firstDelta = await sse.wait(e => e.sessionId === id && e.type === "text_delta");
  assert.ok(firstDelta.seq > ms.seq);
  const te = await sse.wait(e => e.sessionId === id && e.type === "turn_end");
  assert.equal(te.reason, "done");

  // snapshot equals streamed result
  const snap = await (await get(`/api/sessions/${id}/transcript`)).json();
  assert.equal(snap.streaming, false);
  assert.equal(typeof snap.seq, "number");
  const roles = snap.records.map(r => r.role);
  assert.deepEqual(roles, ["user", "assistant"]);
  const streamedText = sse.events.filter(e => e.sessionId === id && e.type === "text_delta").map(e => e.delta).join("");
  assert.equal(snap.records[1].text, streamedText);
});

test("stop during thinking removes the empty assistant turn", async () => {
  const sse = new SSE(base + "/api/events");
  const { id } = await (await post("/api/chats")).json();
  await post(`/api/sessions/${id}/message`, { text: "slow one" });
  await sse.wait(e => e.sessionId === id && e.type === "message_start");
  await post(`/api/sessions/${id}/stop`);
  const te = await sse.wait(e => e.sessionId === id && e.type === "turn_end");
  assert.equal(te.reason, "stopped");
  const snap = await (await get(`/api/sessions/${id}/transcript`)).json();
  assert.deepEqual(snap.records.map(r => r.role), ["user"]); // empty assistant removed
});

test("tool + diff events produce structured records", async () => {
  const sse = new SSE(base + "/api/events");
  const { id } = await (await post("/api/chats")).json();
  await post(`/api/sessions/${id}/message`, { text: "please edit the sessions file" });
  const tool = await sse.wait(e => e.sessionId === id && e.type === "tool_start");
  assert.equal(tool.name, "grep");
  await sse.wait(e => e.sessionId === id && e.type === "tool_end" && e.ok);
  const diff = await sse.wait(e => e.sessionId === id && e.type === "diff");
  assert.ok(diff.hunks[0].lines.some(l => l.sign === "+"));
  await sse.wait(e => e.sessionId === id && e.type === "turn_end");
  const snap = await (await get(`/api/sessions/${id}/transcript`)).json();
  assert.deepEqual(snap.records.map(r => r.role), ["user", "tool", "diff", "assistant"]);
});

test("activity records stream and persist across transcript snapshots", async () => {
  const sse = new SSE(base + "/api/events");
  const { id } = await (await post("/api/chats")).json();
  await post(`/api/sessions/${id}/message`, { text: "track todo and a background agent" });
  const todo = await sse.wait(e => e.sessionId === id && e.type === "activity" && e.record?.kind === "todo");
  const agent = await sse.wait(e => e.sessionId === id && e.type === "activity" && e.record?.kind === "agent");
  assert.equal(todo.record.key, "todo");
  assert.match(agent.record.key, /^agent:mock-/);
  assert.equal(agent.record.groupId, "mock:parallel");
  const running = await sse.wait(e => e.sessionId === id && e.type === "activity" && e.record?.kind === "agent" && e.record?.status === "running" && e.record?.revision > 1);
  assert.equal(running.record.groupId, "mock:parallel");
  await sse.wait(e => e.sessionId === id && e.type === "turn_end");
  await Promise.all(["mock-explore", "mock-tests", "mock-package"].map(runId =>
    sse.wait(e => e.sessionId === id && e.type === "activity" && e.record?.runId === runId && e.record?.status === "completed")
  ));
  const snap = await (await get(`/api/sessions/${id}/transcript`)).json();
  const agents = snap.records.filter(r => r.role === "activity" && r.kind === "agent");
  assert.equal(agents.length, 3);
  assert.ok(agents.every(record => record.status === "completed"));
});

test("Pi built-in commands are discoverable and web-adapted", async () => {
  const { id } = await (await post("/api/chats")).json();
  const commands = await (await get(`/api/sessions/${id}/commands`)).json();
  for (const name of ["model", "export", "copy", "compact", "reload", "new", "resume", "quit"]) {
    assert.ok(commands.commands.some(command => command.name === name), `missing /${name}`);
  }
  const session = await (await post(`/api/sessions/${id}/command`, { text: "/session" })).json();
  assert.equal(session.action, "notice");
  const compact = await (await post(`/api/sessions/${id}/command`, { text: "/compact keep it short" })).json();
  assert.equal(compact.action, "refresh");
  const exported = await (await post(`/api/sessions/${id}/command`, { text: "/export jsonl" })).json();
  assert.deepEqual(exported, { ok: true, action: "download", format: "jsonl" });
  const file = await get(`/api/sessions/${id}/export?format=jsonl`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-type") || "", /application\/jsonl/);
  assert.match(await file.text(), /\"type\":\"session\"/);
});

test("followUp queues; steer interrupts", async () => {
  const sse = new SSE(base + "/api/events");
  const { id } = await (await post("/api/chats")).json();
  await post(`/api/sessions/${id}/message`, { text: "first prompt" });
  await sse.wait(e => e.sessionId === id && e.type === "text_delta");
  await post(`/api/sessions/${id}/message`, { text: "queued follow-up", mode: "followUp" });
  await sse.wait(e => e.sessionId === id && e.type === "queue_update");
  // first turn ends, queued follow-up starts a second turn automatically
  await sse.wait(e => e.sessionId === id && e.type === "turn_end");
  const ur2 = await sse.wait(e => e.sessionId === id && e.type === "user_record" && e.record?.text === "queued follow-up");
  assert.ok(ur2);
  const ts2 = await sse.wait(e => e.sessionId === id && e.type === "turn_start" && e.seq > ur2.seq);
  // steer the second turn
  await sse.wait(e => e.sessionId === id && e.type === "text_delta" && e.seq > ts2.seq);
  await post(`/api/sessions/${id}/message`, { text: "actually do this", mode: "steer" });
  const ur3 = await sse.wait(e => e.sessionId === id && e.type === "user_record" && e.record?.text === "actually do this");
  assert.ok(ur3);
  const ts3 = await sse.wait(e => e.sessionId === id && e.type === "turn_start" && e.seq > ur3.seq);
  await sse.wait(e => e.sessionId === id && e.type === "turn_end" && e.seq > ts3.seq);
});

test("bang runs in the workspace and lands in the transcript", async () => {
  const sse = new SSE(base + "/api/events");
  const { id } = await (await post("/api/chats")).json();
  await post(`/api/sessions/${id}/bang`, { cmd: "echo bang-ok" });
  const be = await sse.wait(e => e.sessionId === id && e.type === "bang_end");
  assert.equal(be.exit, 0);
  assert.match(be.stdout, /bang-ok/);
  const snap = await (await get(`/api/sessions/${id}/transcript`)).json();
  const bang = snap.records.find(r => r.role === "bang");
  assert.ok(bang && /bang-ok/.test(bang.out));
});

test("the extension compile cache survives restarts via a link into the cache dir", async () => {
  const { linkJitiCache } = await import("../server/index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jiti-"));
  fs.mkdirSync(path.join(dir, "tmp", "jiti"), { recursive: true });
  linkJitiCache({ XDG_CACHE_HOME: path.join(dir, "cache") }, path.join(dir, "tmp"));
  linkJitiCache({ XDG_CACHE_HOME: path.join(dir, "cache") }, path.join(dir, "tmp"));
  assert.equal(fs.readlinkSync(path.join(dir, "tmp", "jiti")), path.join(dir, "cache", "pi-ez-web", "jiti"));
  fs.rmSync(dir, { recursive: true, force: true });
});
