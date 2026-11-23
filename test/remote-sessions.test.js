import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Hono } from "hono";
import { EventHub } from "../server/events.js";
import { createRemoteSessions, registerRemoteSessionRoutes, remoteSessionsFromEnv } from "../server/remote-sessions.js";
import { workerEnv } from "../workspaced/manifests.js";

function startFakeRelay(token = "ctrl-tok") {
  const sseClients = new Set();
  let sessions = [];
  const posted = [];
  let transcriptBody = {
    sessionId: "r-1",
    device: "macbook",
    cwd: "/Users/brain",
    title: "Home scratch",
    model: "anthropic/claude-opus",
    streaming: false,
    entries: [
      { type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "world" }] } },
    ],
  };

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/remote/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(`event: sessions\ndata: ${JSON.stringify({ sessions })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/remote/sessions") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessions }));
      return;
    }
    if (req.method === "GET" && url.pathname.endsWith("/transcript")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(transcriptBody));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    posted.push({ method: req.method, path: url.pathname, body });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
  });

  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        posted,
        setSessions(next) {
          sessions = next;
          const frame = `event: sessions\ndata: ${JSON.stringify({ sessions })}\n\n`;
          for (const c of sseClients) c.write(frame);
        },
        emitEvent(sessionId, event) {
          const frame = `event: session_event\ndata: ${JSON.stringify({ sessionId, event })}\n\n`;
          for (const c of sseClients) c.write(frame);
        },
        close() {
          for (const c of sseClients) c.end();
          return new Promise(r => server.close(r));
        },
      });
    });
  });
}

test("workerEnv pins PI_SYNC_ALL_SESSIONS=on and PI_SYNC_REMOTE_CONTROL=off", () => {
  const env = Object.fromEntries(workerEnv({ name: "chats", repository: null }).map(e => [e.name, e.value]));
  assert.equal(env.PI_SYNC_ALL_SESSIONS, "on");
  assert.equal(env.PI_SYNC_REMOTE_CONTROL, "off");
  assert.equal(remoteSessionsFromEnv({ PI_SYNC_SERVER_URL: "http://example.invalid" }), null);
});

test("remote sessions adapter streams SSE events, serves transcripts, answers questions, and fails closed when offline", async () => {
  const relay = await startFakeRelay("ctrl-tok");
  const hub = new EventHub();
  const hubFrames = [];
  hub.addClient(frame => { if (frame.startsWith("id:")) hubFrames.push(JSON.parse(frame.split("\ndata: ")[1])); });
  const discordEvents = [];

  const rs = createRemoteSessions({
    baseUrl: relay.url,
    token: "ctrl-tok",
    hub,
    onEvent: evt => discordEvents.push(evt),
    log: () => {},
  });
  const app = new Hono();
  registerRemoteSessionRoutes(app, rs);
  app.all("*", c => c.json({ fallback: true }, 404));

  relay.setSessions([{
    sessionId: "r-1",
    hostId: "h-1",
    device: "macbook",
    cwd: "/Users/brain",
    title: "Home scratch",
    model: "antigravity/gemini-4-neon",
    thinkingLevel: "xhigh",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    context: { window: 200000, used: 50000, remaining: 150000, percent: 25, input: 10000, cacheRead: 40000, cacheWrite: 0, model: "antigravity/gemini-4-neon" },
    streaming: false,
  }]);
  rs.start();

  try {
    for (let i = 0; i < 40 && !rs.owns("r-1"); i++) await new Promise(r => setTimeout(r, 15));
    assert.equal(rs.owns("r-1"), true);
    assert.equal(rs.list()[0].cwdShort, "~");

    // Context and thinking endpoints reflect live laptop metadata.
    const ctxRes = await app.request("/sessions/r-1/context");
    assert.equal(ctxRes.status, 200);
    assert.equal((await ctxRes.json()).percent, 25);
    const thinkRes = await app.request("/sessions/r-1/thinking");
    assert.equal(thinkRes.status, 200);
    assert.equal((await thinkRes.json()).level, "xhigh");
    const setThink = await app.request("/sessions/r-1/thinking", { method: "POST", body: JSON.stringify({ level: "high" }) });
    assert.equal(setThink.status, 200);
    const setModel = await app.request("/sessions/r-1/model", { method: "POST", body: JSON.stringify({ model: "anthropic/claude-opus-5-5" }) });
    assert.equal(setModel.status, 200);
    assert.equal(relay.posted.some(p => p.path === "/v1/remote/sessions/r-1/thinking" && p.body.level === "high"), true);
    assert.equal(relay.posted.some(p => p.path === "/v1/remote/sessions/r-1/model" && p.body.model === "anthropic/claude-opus-5-5"), true);

    // Transcript converts Pi JSONL entries into web transcript records.
    const tRes = await app.request("/sessions/r-1/transcript");
    assert.equal(tRes.status, 200);
    const tBody = await tRes.json();
    assert.equal(tBody.records.length, 2);
    assert.equal(tBody.records[0].role, "user");
    assert.equal(tBody.records[1].text, "world");
    assert.equal(tBody.remote.device, "macbook");

    // Non-remote sessions pass through to next().
    const miss = await app.request("/sessions/other/transcript");
    assert.equal(miss.status, 404);
    assert.equal((await miss.json()).fallback, true);

    // Message + stop forward to relay.
    const mRes = await app.request("/sessions/r-1/message", { method: "POST", body: JSON.stringify({ text: "ping", clientMessageId: "c1" }) });
    assert.equal(mRes.status, 200);
    const sRes = await app.request("/sessions/r-1/stop", { method: "POST" });
    assert.equal(sRes.status, 200);
    assert.equal(relay.posted.some(p => p.path === "/v1/remote/sessions/r-1/message" && p.body.text === "ping"), true);
    assert.equal(relay.posted.some(p => p.path === "/v1/remote/sessions/r-1/stop"), true);

    // Streaming events flow onto hub + Discord onEvent, including pi-summarize live working & summary lines.
    relay.emitEvent("r-1", { type: "turn_start" });
    relay.emitEvent("r-1", { type: "working_message", message: "Inspecting remote routes…" });
    relay.emitEvent("r-1", {
      type: "summary",
      entry: { id: "sum-1", type: "custom", customType: "pi-summarize", data: { kind: "activity", text: "Inspecting remote routes…", toolCallIds: ["t1"] } },
    });
    relay.emitEvent("r-1", { type: "message_start", role: "assistant" });
    relay.emitEvent("r-1", { type: "text_delta", delta: "hi!" });
    relay.emitEvent("r-1", { type: "message_end", role: "assistant" });
    relay.emitEvent("r-1", { type: "turn_end", ok: true });
    for (let i = 0; i < 40 && !hubFrames.some(f => f.type === "turn_end"); i++) await new Promise(r => setTimeout(r, 15));
    assert.equal(hubFrames.some(f => f.type === "extension_ui_working" && f.message === "Inspecting remote routes…"), true);
    assert.equal(hubFrames.some(f => f.type === "summary" && f.record?.text === "Inspecting remote routes…"), true);
    assert.equal(hubFrames.some(f => f.type === "text_delta" && f.delta === "hi!"), true);
    assert.equal(discordEvents.some(e => e.type === "turn_end"), true);

    // Ask-user questionnaire stepper walks select + custom input, then submits rpiv answers.
    relay.emitEvent("r-1", {
      type: "ask_user_prompt",
      toolCallId: "tc-1",
      questions: [
        { question: "Pick one?", header: "One", multiSelect: false, options: [{ label: "Alpha", description: "" }, { label: "Beta", description: "" }] },
        { question: "Why?", header: "Two", multiSelect: false, options: [{ label: "Fast", description: "" }] },
      ],
    });
    for (let i = 0; i < 40 && !hubFrames.some(f => f.type === "extension_ui_request"); i++) await new Promise(r => setTimeout(r, 15));
    const q1 = hubFrames.findLast(f => f.type === "extension_ui_request");
    assert.equal(q1.method, "select");
    const a1 = await app.request(`/sessions/r-1/extension-ui/${q1.requestId}`, { method: "POST", body: JSON.stringify({ value: "Beta" }) });
    assert.equal(a1.status, 200);
    const q2 = hubFrames.findLast(f => f.type === "extension_ui_request");
    assert.notEqual(q2.requestId, q1.requestId);
    // Choose "Type something…" then provide custom text.
    await app.request(`/sessions/r-1/extension-ui/${q2.requestId}`, { method: "POST", body: JSON.stringify({ value: "Type something…" }) });
    const q2Custom = hubFrames.findLast(f => f.type === "extension_ui_request");
    assert.equal(q2Custom.method, "input");
    const a2 = await app.request(`/sessions/r-1/extension-ui/${q2Custom.requestId}`, { method: "POST", body: JSON.stringify({ value: "because it is simpler" }) });
    assert.equal(a2.status, 200);
    const submitted = relay.posted.find(p => p.path === "/v1/remote/sessions/r-1/extension-ui/tc-1");
    assert.deepEqual(submitted?.body, {
      toolCallId: "tc-1",
      answers: [
        { questionIndex: 0, optionIndexes: [1] },
        { questionIndex: 1, text: "because it is simpler" },
      ],
    });

    // When host disconnects, session returns 503 host_offline (never queued).
    relay.setSessions([]);
    for (let i = 0; i < 40 && rs.owns("r-1"); i++) await new Promise(r => setTimeout(r, 15));
    const offlineMsg = await app.request("/sessions/r-1/message", { method: "POST", body: JSON.stringify({ text: "late" }) });
    assert.equal(offlineMsg.status, 503);
    assert.equal((await offlineMsg.json()).error, "host_offline");
  } finally {
    rs.stop();
    await relay.close();
  }
});
