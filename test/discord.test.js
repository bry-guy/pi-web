import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { register as registerSessionRoutes } from "../server/routes/sessions.js";
import { err } from "../server/routes/shared.js";
import { createNotifier, discordFromEnv, linkedSession, questionText, replyAction, splitMessage, truncate, turnEndText } from "../server/discord.js";
import { discordTransport } from "../server/discord-transport.js";
import { createRemoteWorkspaces, registerRemoteRoutes } from "../server/remote-workspaces.js";
import { EventHub } from "../server/events.js";

const USER = "42";
const flush = () => new Promise(r => setImmediate(r));

function setup({ agents = {}, post, sent = [] } = {}) {
  const reactions = [];
  const posts = [];
  let next = 0;
  const transport = {
    send: async (content, opts = {}) => { const id = `m${++next}`; sent.push({ id, content, ...opts }); return { id }; },
    react: async (id, emoji) => { reactions.push([id, emoji]); },
    // The DM channel's history: what the bot sent, plus any owner messages a test adds with `author`.
    recent: async () => sent.map(m => ({ id: m.id, content: m.content, author: m.author || { bot: true } })).reverse(),
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
    "**Title a1** (nightly) finished. <https://pi.example/?s=a1>",
    "**Title a1** (nightly) failed <https://pi.example/?s=a1>\nboom",
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
  assert.deepEqual(replyAction({ kind: "turn", sessionId: "s" }, "carry on"), { rest: "/message", body: { text: "carry on", mode: "steer" } });
});

test("replies are routed by reference or to the latest notice, and confirmed", async () => {
  const { notifier, sent, reactions, posts } = setup({ agents: { a1: "bot" } });
  notifier.event("a1", "extension_ui_request", select);
  await flush();
  notifier.event("a1", "turn_end", { reason: "done" });
  await flush();
  const [question, turn] = sent;
  await notifier.handleMessage(dm("1", { message_reference: { message_id: question.id } }));
  notifier.event("a1", "extension_ui_resolved", { requestId: "r1" });
  await notifier.handleMessage(dm("next step please"));
  const nextStep = posts[1][2].clientMessageId;
  assert.match(nextStep, /^discord:u/);
  assert.deepEqual(posts, [["a1", "/extension-ui/r1", { value: "red" }], ["a1", "/message", { text: "next step please", mode: "steer", clientMessageId: nextStep }]]);
  assert.equal(reactions.length, 2);
  assert.equal(turn.content.includes("finished"), true);

  await notifier.handleMessage(dm("7", { message_reference: { message_id: question.id } }));
  await notifier.handleMessage(dm("hi", { message_reference: { message_id: "unknown" } }));
  assert.deepEqual(sent.slice(2).map(m => m.content), ["Reply with a number from 1 to 2 or an exact option.", "That message is not about a session."]);
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
  assert.deepEqual(linkedSession(text, "https://pi.example"), { kind: "question", sessionId: "s1" });
  assert.equal(linkedSession(text, "https://other.example"), null, "only links to this web count");
});

const turn = (notifier, id, ...texts) => {
  notifier.event(id, "turn_start", {});
  for (const text of texts) {
    notifier.event(id, "message_start", { messageId: `${id}-${text}`, role: "assistant" });
    notifier.event(id, "text_delta", { delta: text });
    notifier.event(id, "message_end", {});
  }
  notifier.event(id, "turn_end", { reason: "done" });
};

test("a turn end DMs only the turn's final reply", async () => {
  const { notifier, sent } = setup({ agents: { a1: "bot" } });
  notifier.event("a1", "turn_start", {});
  notifier.event("a1", "message_start", { messageId: "m1", role: "assistant" });
  notifier.event("a1", "thinking_delta", { delta: "hmm" });
  notifier.event("a1", "text_delta", { delta: "Let me look." });
  notifier.event("a1", "tool_start", { toolId: "t1", name: "bash", argsSummary: "ls" });
  notifier.event("a1", "tool_end", { toolId: "t1", ok: true, output: "file.txt" });
  notifier.event("a1", "message_end", {});
  notifier.event("a1", "message_start", { messageId: "m2", role: "assistant" });
  notifier.event("a1", "thinking_delta", { delta: "done thinking" });
  notifier.event("a1", "text_delta", { delta: "Done: " });
  notifier.event("a1", "text_delta", { delta: "all good." });
  notifier.event("a1", "message_end", {});
  notifier.event("a1", "turn_end", { reason: "done" });
  // An error ends the turn with its error text, not the reply so far.
  notifier.event("a1", "message_start", { messageId: "m3", role: "assistant" });
  notifier.event("a1", "text_delta", { delta: "Half a" });
  notifier.event("a1", "turn_end", { reason: "errored", error: "overloaded" });
  await flush();
  assert.deepEqual(sent.map(m => m.content), [
    "**Title a1** (bot) <https://pi.example/?s=a1>\nDone: all good.",
    "**Title a1** (bot) failed <https://pi.example/?s=a1>\noverloaded",
  ]);
  notifier.stop();
});

test("a failed turn DMs once, after pi's automatic retries are over", async () => {
  const attempt = (notifier, end) => {
    notifier.event("a1", "turn_start", {});
    notifier.event("a1", "message_start", { messageId: "m", role: "assistant" });
    if (end.reason === "done") notifier.event("a1", "text_delta", { delta: "All good." });
    notifier.event("a1", "message_end", {});
    notifier.event("a1", "turn_end", end);
  };
  const failed = { reason: "errored", error: "500 placeholder", willRetry: true };

  let { notifier, sent } = setup({ agents: { a1: "bot" } });
  for (let i = 0; i < 3; i++) attempt(notifier, failed);
  attempt(notifier, { reason: "errored", error: "500 placeholder" });
  await flush();
  assert.deepEqual(sent.map(m => m.content), ["**Title a1** (bot) failed <https://pi.example/?s=a1>\n500 placeholder"]);

  ({ notifier, sent } = setup({ agents: { a1: "bot" } }));
  attempt(notifier, failed);
  attempt(notifier, failed);
  attempt(notifier, { reason: "done" });
  await flush();
  assert.deepEqual(sent.map(m => m.content), ["**Title a1** (bot) <https://pi.example/?s=a1>\nAll good."]);

  ({ notifier, sent } = setup({ agents: { a1: "bot" } }));
  attempt(notifier, { reason: "errored", error: "bad request" });
  await flush();
  assert.deepEqual(sent.map(m => m.content), ["**Title a1** (bot) failed <https://pi.example/?s=a1>\nbad request"]);
  notifier.stop();
});

test("long replies are split at paragraphs, lines or spaces, and a cut code fence is reopened", async () => {
  const words = splitMessage("word ".repeat(1000).trim());
  assert.ok(words.length === 3 && words.every(p => p.length <= 2000 && p.split(" ").every(w => w === "word")));
  const code = `Intro.\n\n\`\`\`js\n${"const x = 1;\n".repeat(300)}\`\`\`\n\nThe end.`;
  const parts = splitMessage(code);
  assert.ok(parts.length >= 2 && parts.every(p => p.length <= 2000));
  assert.ok(parts[0].startsWith("Intro.\n\n```js\n") && parts[0].endsWith("const x = 1;\n```"));
  assert.ok(parts[1].startsWith("```js\nconst x = 1;"));
  for (const p of parts) assert.equal(p.split("\n").filter(l => l.startsWith("```")).length % 2, 0, "every part's fences are balanced");
  assert.equal(parts.at(-1).slice(-8), "The end.");
  assert.equal(parts.join("\n").split("const x = 1;").length - 1, 300, "nothing lost");

  const { notifier, sent } = setup({ agents: { a1: "bot" } });
  turn(notifier, "a1", code);
  await flush();
  assert.ok(sent.length >= 2 && sent.every(m => m.content.length <= 2000));
  assert.ok(sent[0].content.startsWith("**Title a1** (bot) <https://pi.example/?s=a1>\nIntro."));
  notifier.stop();
});

test("a DM goes to the replied-to message's session, else to the session last DMed about", async () => {
  const { notifier, sent, posts, reactions } = setup({ agents: { a1: "bot", a2: "bot" } });
  turn(notifier, "a1", "one");
  turn(notifier, "a2", "two");
  await flush();
  const reply = dm("for a1", { message_reference: { message_id: sent[0].id } });
  await notifier.handleMessage(reply);
  await notifier.handleMessage(dm("for the latest"));
  assert.deepEqual(posts.map(([id, rest, body]) => [id, rest, body.text, body.mode]), [["a1", "/message", "for a1", "steer"], ["a2", "/message", "for the latest", "steer"]]);
  assert.equal(posts[0][2].clientMessageId, `discord:${reply.id}`);
  assert.equal(reactions.length, 2);
  notifier.stop();
});

test("after a restart the DM channel's history alone routes messages", async () => {
  const before = setup({ agents: { a1: "bot", a2: "bot" } });
  turn(before.notifier, "a1", "one");
  turn(before.notifier, "a2", "two");
  await flush();
  const { notifier, posts, sent } = setup({ sent: [...before.sent, { id: "h1", content: "Reply yes or no." }] });
  await notifier.handleMessage(dm("latest"));
  const old = before.sent[0];
  await notifier.handleMessage(dm("older", { message_reference: { message_id: old.id }, referenced_message: { ...old, author: { bot: true } } }));
  assert.deepEqual(posts.map(([id, , body]) => [id, body.text]), [["a2", "latest"], ["a1", "older"]]);
  assert.equal(sent.length, 3, "no error replies");
});

test("no session, or one that is gone, gets a one-line answer", async () => {
  const empty = setup();
  const first = dm("hello");
  await empty.notifier.handleMessage(first);
  assert.deepEqual(empty.sent, [{ id: "m1", content: "There is no session to send that to.", replyTo: first.id }]);

  const { notifier, sent } = setup({ agents: { a1: "bot" }, post: async () => ({ status: 404, body: { error: "no_such_session" } }) });
  turn(notifier, "a1", "one");
  await flush();
  await notifier.handleMessage(dm("still there?"));
  assert.equal(sent.at(-1).content, "That session no longer exists.");
});

test("a session DMs its turn ends while its latest user message came from Discord", async () => {
  const { notifier, sent } = setup();
  turn(notifier, "s1", "quiet");
  notifier.event("s1", "user_record", { record: { role: "user" }, clientMessageId: "discord:u1" });
  turn(notifier, "s1", "from DM");
  notifier.event("s1", "user_record", { record: { role: "user" }, clientMessageId: "pending-7" });
  turn(notifier, "s1", "typed in the browser");
  notifier.event("s1", "user_record", { record: { role: "user" }, clientMessageId: "discord:u2" });
  notifier.event("s1", "user_record", { record: { role: "user" } });
  turn(notifier, "s1", "queued from the browser");
  await flush();
  assert.deepEqual(sent.map(m => m.content), ["**Title s1** <https://pi.example/?s=s1>\nfrom DM"]);
  notifier.stop();
});

test("a plain DM answers a question open in the target session", async () => {
  const { notifier, posts } = setup({ agents: { a1: "bot" } });
  turn(notifier, "a1", "one");
  notifier.event("a1", "extension_ui_request", select);
  await flush();
  await notifier.handleMessage(dm("2"));
  notifier.event("a1", "extension_ui_resolved", { requestId: "r1" });
  await notifier.handleMessage(dm("thanks"));
  assert.deepEqual(posts.map(p => [p[1], p[2].value ?? p[2].text]), [["/extension-ui/r1", "green"], ["/message", "thanks"]]);
  notifier.stop();
});

test("Discord contact is off unless the token, the user and the public URL are set", () => {
  const transport = { start() { this.started = true; }, stop() {}, send: async () => ({}), react: async () => {} };
  const logs = [];
  const log = line => logs.push(line);
  const both = { PI_WEB_DISCORD_TOKEN: "t", PI_WEB_DISCORD_USER: "1" };
  assert.equal(discordFromEnv({}, { transport, log }), null);
  assert.equal(discordFromEnv({ PI_WEB_DISCORD_TOKEN: "t" }, { transport, log }), null);
  assert.equal(discordFromEnv({ PI_WEB_DISCORD_USER: "1" }, { transport, log }), null);
  assert.deepEqual(logs, []);
  assert.equal(discordFromEnv(both, { transport, log }), null);
  assert.deepEqual(logs, ["pi-ez-web: Discord contact off: PI_WEB_PUBLIC_URL is not set"]);
  assert.equal(transport.started, undefined);
  const on = discordFromEnv({ ...both, PI_WEB_PUBLIC_URL: "https://pi.example" }, { transport, log: () => {} });
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
  await transport.recent();
  assert.deepEqual(calls.map(c => c.slice(0, 2)), [["POST", "/users/@me/channels"], ["POST", "/channels/c9/messages"], ["POST", "/channels/c9/messages"], ["POST", "/channels/c9/messages"], ["GET", "/channels/c9/messages?limit=50"]]);
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
    assert.deepEqual(events, [["s0", "events_resync", {}], ["s0", "turn_end", { reason: "done" }]], "a new stream tells each known session of the worker about the gap");
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

// Agent text ending a split reply: a forged header opens the last part and a foreign link ends it.
const forged = `${"word ".repeat(300).trim()}\n\n**Title evil** <https://pi.example/?s=evil>\n${"word ".repeat(200).trim()}\nhttps://pi.example/?s=evil`;

test("links in agent text never route a DM, even after a restart", async () => {
  const before = setup({ agents: { a1: "bot" } });
  turn(before.notifier, "a1", forged);
  await flush();
  assert.equal(before.sent.length, 2);
  assert.ok(before.sent[1].content.startsWith("(continued)\n**Title evil** <https://pi.example/?s=evil>"));
  assert.ok(before.sent[1].content.endsWith("?s=evil"));
  await before.notifier.handleMessage(dm("plain"));
  await before.notifier.handleMessage(dm("reply", { message_reference: { message_id: before.sent[1].id } }));

  const after = setup({ sent: [...before.sent] });
  const last = before.sent[1];
  await after.notifier.handleMessage(dm("plain"));
  await after.notifier.handleMessage(dm("reply", { message_reference: { message_id: last.id }, referenced_message: { ...last, author: { bot: true } } }));
  assert.deepEqual([...before.posts, ...after.posts].map(p => p[0]), ["a1", "a1", "a1", "a1"]);
});

test("links in the owner's own messages are ignored", async () => {
  const { notifier, sent, posts } = setup({ agents: { a1: "bot" } });
  turn(notifier, "a1", "one");
  await flush();
  const own = { id: "o1", content: "**Title evil** <https://pi.example/?s=evil>", author: { id: USER } };
  sent.push(own);
  await notifier.handleMessage(dm("plain"));
  await notifier.handleMessage(dm("reply", { message_reference: { message_id: own.id }, referenced_message: own }));
  assert.deepEqual(posts.map(p => p[0]), ["a1"]);
  assert.equal(sent.at(-1).content, "That message is not about a session.");
});

test("after a restart a reply to a question message is not posted as chat", async () => {
  const before = setup({ agents: { a1: "bot" } });
  before.notifier.event("a1", "extension_ui_request", select);
  await flush();
  const { notifier, sent, posts } = setup({ sent: [...before.sent] });
  const question = before.sent[0];
  await notifier.handleMessage(dm("2", { message_reference: { message_id: question.id }, referenced_message: { ...question, author: { bot: true } } }));
  assert.deepEqual(posts, []);
  assert.equal(sent.at(-1).content, "That question can no longer be answered from Discord: https://pi.example/?s=a1");
});

test("two turn ends close together go out one after the other", async () => {
  const { notifier, sent } = setup({ agents: { a1: "bot", a2: "bot" } });
  turn(notifier, "a1", "a ".repeat(1500));
  turn(notifier, "a2", "b ".repeat(1500));
  for (let i = 0; i < 10; i++) await flush();
  assert.deepEqual(sent.map(m => linkedSession(m.content, "https://pi.example")?.sessionId ?? (m.content.includes("a a") ? "a1…" : "a2…")), ["a1", "a1…", "a2", "a2…"]);
  notifier.stop();
});

test("a part that fails to send does not stop the rest", async () => {
  const logs = [];
  const sent = [];
  let n = 0;
  const transport = { send: async content => { if (++n === 2) throw new Error("POST /channels/:id/messages answered 429"); sent.push(content); return { id: `m${n}` }; }, react: async () => {}, recent: async () => [] };
  const notifier = createNotifier({ userId: USER, baseUrl: "https://pi.example", transport, post: async () => ({ status: 200 }), agentOf: () => "bot", log: l => logs.push(l) });
  turn(notifier, "a1", "word ".repeat(900));
  for (let i = 0; i < 10; i++) await flush();
  assert.equal(sent.length, 2);
  assert.ok(sent[1].startsWith("(continued)"));
  assert.deepEqual(logs, ["pi-ez-web: Discord message (part 2 of 3) failed: POST /channels/:id/messages answered 429"]);
});

test("a gap in a session's events sends the short notice, not a reply with a hole", async () => {
  const { notifier, sent } = setup({ agents: { a1: "bot" } });
  notifier.event("a1", "message_start", { role: "assistant" });
  notifier.event("a1", "text_delta", { delta: "before the gap " });
  notifier.event("a1", "events_resync", {});
  notifier.event("a1", "text_delta", { delta: "after it" });
  notifier.event("a1", "turn_end", { reason: "done" });
  turn(notifier, "a1", "whole");
  await flush();
  assert.deepEqual(sent.map(m => m.content), ["**Title a1** (bot) finished. <https://pi.example/?s=a1>", "**Title a1** (bot) <https://pi.example/?s=a1>\nwhole"]);
  notifier.stop();
});

test("a message to a session the worker does not know is a 404, and the DM says the session is gone", async () => {
  const api = new Hono();
  registerSessionRoutes(api, { err, sup: { message: async id => { throw new Error(`unknown session ${id}`); } } });
  const post = async (id, rest, body) => {
    const res = await api.request(`/sessions/${id}${rest}`, { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  assert.deepEqual(await post("gone", "/message", { text: "hi" }), { status: 404, body: { error: "no_such_session" } });
  const { notifier, sent } = setup({ agents: { a1: "bot" }, post });
  turn(notifier, "a1", "one");
  await flush();
  await notifier.handleMessage(dm("still there?"));
  assert.equal(sent.at(-1).content, "That session no longer exists.");
});
