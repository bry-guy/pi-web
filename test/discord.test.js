import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createNotifier, discordFromEnv, questionText, replyAction, truncate, turnEndText } from "../server/discord.js";
import { discordTransport } from "../server/discord-transport.js";
import { createRemoteWorkspaces, registerRemoteRoutes } from "../server/remote-workspaces.js";
import { EventHub } from "../server/events.js";

const USER = "42";
const flush = () => new Promise(r => setImmediate(r));

function setup({ agents = {}, post } = {}) {
  const sent = [];
  const reactions = [];
  const posts = [];
  let next = 0;
  const transport = {
    send: async (content, opts = {}) => { const id = `m${++next}`; sent.push({ id, content, ...opts }); return { id }; },
    react: async (id, emoji) => { reactions.push([id, emoji]); },
  };
  const notifier = createNotifier({
    userId: USER, baseUrl: "https://pi.example/", transport,
    post: post || (async (...args) => { posts.push(args); return { status: 200, body: { ok: true } }; }),
    titleOf: id => `Title ${id}`, agentOf: id => agents[id] || null, log: () => {},
  });
  return { notifier, sent, reactions, posts };
}
const select = { requestId: "r1", method: "select", title: "Pick one", options: ["red", "green"] };
const dm = (content, extra = {}) => ({ id: `u${Math.random()}`, author: { id: USER }, content, ...extra });

test("a question waits 5 minutes and is dropped if answered first", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { notifier, sent } = setup();
  notifier.event("s1", "extension_ui_request", select);
  notifier.event("s2", "extension_ui_request", { ...select, requestId: "r2" });
  t.mock.timers.tick(4 * 60_000);
  notifier.event("s2", "extension_ui_resolved", { requestId: "r2" });
  notifier.event("s1", "extension_ui_request", select); // a replay does not restart the clock
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, "**Title s1** needs an answer\nPick one\n1. red\n2. green\n_Reply with a number or an option._\nhttps://pi.example/?s=s1");
  t.mock.timers.tick(10 * 60_000);
  await flush();
  assert.equal(sent.length, 1, "nothing for the resolved question, no repeat for the sent one");
  notifier.stop();
});

test("agent runs get questions at once and turn-end notices; other sessions get no turn-end notice", async () => {
  const { notifier, sent } = setup({ agents: { a1: "nightly" } });
  notifier.event("a1", "extension_ui_request", { requestId: "r1", method: "confirm", title: "Deploy?", message: "to prod" });
  notifier.event("s1", "turn_end", { reason: "done" });
  notifier.event("a1", "turn_end", { reason: "stopped" });
  notifier.event("a1", "turn_end", { reason: "done" });
  notifier.event("a1", "turn_end", { reason: "errored", error: "boom" });
  await flush();
  assert.deepEqual(sent.map(m => m.content), [
    "**Title a1** (nightly) needs an answer\nDeploy?\nto prod\n_Reply yes or no._\nhttps://pi.example/?s=a1",
    "**Title a1** (nightly) finished.\nhttps://pi.example/?s=a1",
    "**Title a1** (nightly) failed: boom\nhttps://pi.example/?s=a1",
  ]);
  notifier.stop();
});

test("replies map to a select, confirm, input or message", () => {
  const q = (method, options = []) => ({ kind: "question", sessionId: "s", requestId: "r 1", method, options });
  const rest = "/extension-ui/r%201";
  assert.deepEqual(replyAction(q("select", ["red", "green"]), "2"), { rest, body: { value: "green" } });
  assert.deepEqual(replyAction(q("select", ["red", "green"]), " red "), { rest, body: { value: "red" } });
  assert.ok(replyAction(q("select", ["red", "green"]), "3").hint);
  assert.ok(replyAction(q("select", ["red", "green"]), "Red").hint);
  assert.deepEqual(replyAction(q("confirm"), "Y"), { rest, body: { confirmed: true } });
  assert.deepEqual(replyAction(q("confirm"), "no"), { rest, body: { confirmed: false } });
  assert.ok(replyAction(q("confirm"), "maybe").hint);
  assert.deepEqual(replyAction(q("input"), "hello there"), { rest, body: { value: "hello there" } });
  assert.deepEqual(replyAction({ kind: "turn", sessionId: "s" }, "carry on"), { rest: "/message", body: { text: "carry on" } });
});

test("replies are routed by reference or to the latest notice, and confirmed", async () => {
  const { notifier, sent, reactions, posts } = setup({ agents: { a1: "bot" } });
  notifier.event("a1", "extension_ui_request", select);
  await flush();
  notifier.event("a1", "turn_end", { reason: "done" });
  await flush();
  const [question, turn] = sent;
  await notifier.handleMessage(dm("1", { message_reference: { message_id: question.id } }));
  await notifier.handleMessage(dm("next step please"));
  assert.deepEqual(posts, [["a1", "/extension-ui/r1", { value: "red" }], ["a1", "/message", { text: "next step please" }]]);
  assert.equal(reactions.length, 2);
  assert.equal(turn.content.includes("finished"), true);

  await notifier.handleMessage(dm("7", { message_reference: { message_id: question.id } }));
  await notifier.handleMessage(dm("hi", { message_reference: { message_id: "unknown" } }));
  assert.deepEqual(sent.slice(2).map(m => m.content), ["Reply with a number from 1 to 2 or an exact option.", "Reply to one of my messages to answer it."]);
  assert.equal(posts.length, 2);
  notifier.stop();
});

test("a question whose DM failed is sent once more, and a failed delivery is reported", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { notifier, sent } = setup({ agents: { s1: "labrat" }, post: async () => { throw new Error("worker down"); } });
  let fails = 1;
  const real = sent.push.bind(sent);
  sent.push = (...a) => { if (fails-- > 0) throw new Error("discord down"); return real(...a); };
  notifier.event("s1", "extension_ui_request", select);
  await flush();
  assert.equal(sent.length, 0);
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Pick one/);
  await notifier.handleMessage(dm("1"));
  await flush();
  assert.match(sent[1].content, /Could not deliver/);
  assert.deepEqual(replyAction({ kind: "question", requestId: "r", method: "input", options: [] }, "  "), { hint: "Reply with the text to enter." });
});

test("an already answered question says so", async () => {
  const { notifier, sent } = setup({ agents: { a1: "bot" }, post: async () => ({ status: 409, body: { error: "stale_extension_ui_request" } }) });
  notifier.event("a1", "extension_ui_request", select);
  await flush();
  const reply = dm("2");
  await notifier.handleMessage(reply);
  assert.deepEqual(sent.at(-1), { id: "m2", content: "That question was already answered.", replyTo: reply.id });
  notifier.stop();
});

test("messages from anyone else, bots or guilds are ignored", async () => {
  const { notifier, sent, posts } = setup({ agents: { a1: "bot" } });
  notifier.event("a1", "turn_end", { reason: "done" });
  await flush();
  await notifier.handleMessage(dm("x", { author: { id: "99" } }));
  await notifier.handleMessage(dm("x", { author: { id: USER, bot: true } }));
  await notifier.handleMessage(dm("x", { guild_id: "g" }));
  assert.equal(sent.length, 1);
  assert.equal(posts.length, 0);
});

test("long notices are cut to 2000 characters, keeping the link", () => {
  assert.equal(truncate("abc", 3), "abc");
  assert.equal(truncate("abcd", 3), "ab…");
  const link = "https://pi.example/?s=s1";
  const text = questionText({ title: "t", request: { method: "input", title: "x".repeat(5000) }, link });
  assert.equal(text.length, 2000);
  assert.ok(text.endsWith(`…\n${link}`));
  assert.equal(turnEndText({ title: "t", reason: "errored", error: "e".repeat(3000), link: "" }).length, 2000);
});

test("Discord contact is off unless both the token and the user are set", () => {
  const transport = { start() { this.started = true; }, stop() {}, send: async () => ({}), react: async () => {} };
  assert.equal(discordFromEnv({}, { transport }), null);
  assert.equal(discordFromEnv({ PI_WEB_DISCORD_TOKEN: "t" }, { transport }), null);
  assert.equal(discordFromEnv({ PI_WEB_DISCORD_USER: "1" }, { transport }), null);
  assert.equal(transport.started, undefined);
  const on = discordFromEnv({ PI_WEB_DISCORD_TOKEN: "t", PI_WEB_DISCORD_USER: "1" }, { transport, log: () => {} });
  assert.ok(on && transport.started);
  on.stop();
});

test("REST: DM channel once, Bot auth, 429 retry_after honoured", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let limited = true;
  const fetchImpl = async (url, init) => {
    calls.push([init.method, url.replace("https://discord.com/api/v10", ""), init.headers.authorization, init.headers["user-agent"]]);
    if (url.endsWith("/users/@me/channels")) return Response.json({ id: "c9" });
    if (limited) { limited = false; return Response.json({ retry_after: 2 }, { status: 429 }); }
    return Response.json({ id: "m1" });
  };
  const transport = discordTransport({ token: "tok", userId: USER, fetchImpl, log: () => {} });
  const sending = transport.send("x".repeat(2500));
  for (let i = 0; i < 5; i++) await flush();
  t.mock.timers.tick(2000);
  assert.deepEqual(await sending, { id: "m1" });
  await transport.send("again");
  assert.deepEqual(calls.map(c => c.slice(0, 2)), [["POST", "/users/@me/channels"], ["POST", "/channels/c9/messages"], ["POST", "/channels/c9/messages"], ["POST", "/channels/c9/messages"]]);
  assert.ok(calls.every(c => c[2] === "Bot tok" && c[3].startsWith("DiscordBot (")));
});

test("gateway: hello → identify → heartbeat → dispatch → reconnect and resume", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.sent = []; this.readyState = 1; this.handlers = {}; sockets.push(this); }
    addEventListener(type, fn) { this.handlers[type] = fn; }
    send(data) { this.sent.push(JSON.parse(data)); }
    close(code) { this.closedWith = code; this.readyState = 3; }
    server(payload) { this.handlers.message({ data: JSON.stringify(payload) }); }
  }
  const fetchImpl = async () => Response.json({ url: "wss://gateway.example" });
  const messages = [];
  const transport = discordTransport({ token: "tok", userId: USER, fetchImpl, WebSocketImpl: FakeSocket, random: () => 0.5, onMessage: m => messages.push(m), log: () => {} });
  transport.start();
  await flush();
  const [a] = sockets;
  assert.equal(a.url, "wss://gateway.example/?v=10&encoding=json");
  a.server({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.deepEqual(a.sent[0], { op: 2, d: { token: "tok", intents: 4096, properties: { os: process.platform, browser: "pi-ez-web", device: "pi-ez-web" } } });
  a.server({ op: 0, t: "READY", s: 1, d: { session_id: "sess", resume_gateway_url: "wss://resume.example" } });
  t.mock.timers.tick(500);
  assert.deepEqual(a.sent[1], { op: 1, d: 1 });
  a.server({ op: 11 });
  a.server({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { content: "hi" } });
  assert.deepEqual(messages, [{ content: "hi" }]);

  // The next heartbeat goes unacknowledged: drop the socket and resume.
  t.mock.timers.tick(1000);
  assert.deepEqual(a.sent[2], { op: 1, d: 2 });
  t.mock.timers.tick(1000);
  assert.equal(a.closedWith, 4000);
  t.mock.timers.tick(1000);
  await flush();
  const b = sockets[1];
  assert.equal(b.url, "wss://resume.example/?v=10&encoding=json");
  b.server({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.deepEqual(b.sent[0], { op: 6, d: { token: "tok", session_id: "sess", seq: 2 } });

  b.server({ op: 0, t: "RESUMED", s: 3 });

  // RECONNECT resumes; INVALID_SESSION (not resumable) identifies afresh.
  b.server({ op: 7 });
  t.mock.timers.tick(1000);
  await flush();
  sockets[2].server({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.equal(sockets[2].sent[0].op, 6);
  sockets[2].server({ op: 9, d: false });
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(sockets[3].url, "wss://gateway.example/?v=10&encoding=json");
  sockets[3].server({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.equal(sockets[3].sent[0].op, 2);

  // A dropped connection reconnects with backoff; stop() ends it all.
  sockets[3].server({ op: 0, t: "READY", s: 1, d: { session_id: "sess2", resume_gateway_url: "wss://resume.example" } });
  sockets[3].handlers.close({ code: 1006 });
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(sockets.length, 5);
  transport.stop();
  assert.equal(sockets[4].closedWith, 1000);
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(sockets.length, 5);
});

test("web remembers agent sessions, passes worker events on, and posts to sessions", async () => {
  const cachePath = path.join(mkdtempSync(path.join(tmpdir(), "discord-")), "remote-projects.json");
  const posted = [];
  const frame = `data: ${JSON.stringify({ seq: 1, sessionId: "s0", type: "turn_end", reason: "done" })}\n\n`;
  const fetchImpl = async (url, init = {}) => {
    const p = new URL(url).pathname.replace("/v1/workspaces", "");
    const method = init.method || "GET";
    if (p === "") return Response.json({ workspaces: [{ name: "ws1", repository: "a/b", state: "running" }] });
    if (p === "/ws1/api/state") return Response.json({ projects: [{ id: "p1", sessions: [{ id: "s0", title: "Hello" }] }] });
    if (p === "/ws1/api/events") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame)); } }));
    if (method === "POST") { posted.push([p, init.body instanceof ReadableStream ? "stream" : JSON.parse(init.body)]); return Response.json(p.endsWith("/sessions") ? { id: "s1" } : { ok: true }); }
    return Response.json({}, { status: 404 });
  };
  const events = [];
  const opts = { url: "http://w", hub: new EventHub(), fetchImpl, cachePath, modelAuthSyncMs: 0, retryMs: 60_000, onEvent: (...a) => events.push(a) };
  const remote = createRemoteWorkspaces(opts);
  try {
    const api = new Hono();
    registerRemoteRoutes(api, remote);
    const res = await api.request("/projects/p1/sessions", { method: "POST", body: JSON.stringify({ agent: "nightly" }) });
    assert.deepEqual(await res.json(), { id: "s1" });
    assert.equal(remote.agentOf("s1"), "nightly");
    assert.equal(remote.agentOf("s0"), null);
    assert.equal(remote.sessionTitle("s0"), "Hello");
    await flush();
    assert.deepEqual(events, [["s0", "turn_end", { reason: "done" }]]);
    assert.deepEqual(await remote.sessionPost("s0", "/message", { text: "go" }), { status: 200, body: { ok: true } });
    assert.deepEqual(posted, [["/ws1/api/projects/p1/sessions", { agent: "nightly" }], ["/ws1/api/sessions/s0/message", { text: "go" }]]);
    assert.equal((await remote.sessionPost("nope", "/message", {})).status, 404);
  } finally { remote.stop(); }
  const again = createRemoteWorkspaces({ ...opts, onEvent: null });
  assert.equal(again.agentOf("s1"), "nightly", "survives a restart");
  again.stop();
});

test("after a restart with no browser, forwarding a create or a message subscribes web to that worker's events", async () => {
  const cachePath = path.join(mkdtempSync(path.join(tmpdir(), "discord-")), "remote-projects.json");
  // The cached sidebar makes the owners known, so nothing polls /api/state.
  writeFileSync(cachePath, JSON.stringify({ ws1: [{ id: "p1", sessions: [{ id: "s0", title: "Hello" }] }] }));
  let streams = 0;
  const frame = `data: ${JSON.stringify({ seq: 1, sessionId: "s0", type: "turn_end", reason: "done" })}\n\n`;
  const fetchImpl = async (url, init = {}) => {
    const p = new URL(url).pathname.replace("/v1/workspaces", "");
    if (p === "/ws1/api/events") { streams++; return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame)); } })); }
    if ((init.method || "GET") === "POST") return Response.json(p.endsWith("/sessions") ? { id: "s1" } : { ok: true });
    return Response.json({ error: "unexpected" }, { status: 500 });
  };
  const events = [];
  const remote = createRemoteWorkspaces({ url: "http://w", hub: new EventHub(), fetchImpl, cachePath, modelAuthSyncMs: 0, retryMs: 60_000, onEvent: (...a) => events.push(a) });
  try {
    const api = new Hono();
    registerRemoteRoutes(api, remote);
    await api.request("/sessions/s0/stop", { method: "POST" });
    await flush();
    assert.equal(streams, 0, "other calls do not subscribe");
    assert.equal((await api.request("/sessions/s0/message", { method: "POST", body: JSON.stringify({ text: "go" }) })).status, 200);
    await flush();
    assert.equal(streams, 1);
    assert.deepEqual(events, [["s0", "turn_end", { reason: "done" }]]);
    await api.request("/projects/p1/sessions", { method: "POST", body: JSON.stringify({ agent: "nightly" }) });
    await flush();
    assert.equal(streams, 1, "one stream per worker");
  } finally { remote.stop(); }

  const answer = createRemoteWorkspaces({ url: "http://w", hub: new EventHub(), fetchImpl, cachePath, modelAuthSyncMs: 0, retryMs: 60_000 });
  try {
    await answer.sessionPost("s0", "/extension-ui/answer", {});
    await flush();
    assert.equal(streams, 2, "a Discord answer subscribes too");
  } finally { answer.stop(); }
});
