import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { EventHub, hub as workerHub } from "../server/events.js";
import { buildApi } from "../server/routes.js";
import { ExtensionUiHost } from "../server/extension-ui.js";
import { createRemoteWorkspaces, registerRemoteRoutes } from "../server/remote-workspaces.js";
import { createWorkspaced } from "../workspaced/index.js";

function frames(hub) {
  const values = [];
  hub.addClient(frame => {
    const match = frame.match(/data: (\{.*\})\n/);
    if (match) values.push(JSON.parse(match[1]));
  });
  return values;
}

async function waitFor(values, predicate) {
  for (let i = 0; i < 100; i++) {
    const value = values.find(predicate);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, i < 50 ? 1 : 20));
  }
  throw new Error("timed out waiting for event");
}

test("extension UI resolves select and confirm requests", async () => {
  const hub = new EventHub();
  const events = frames(hub);
  const adapter = new ExtensionUiHost({ hub });
  const ui = adapter.uiContext("session-1");

  const selected = ui.select("Choose", ["one", "two"]);
  const selectEvent = await waitFor(events, event => event.type === "extension_ui_request" && event.method === "select");
  assert.deepEqual(selectEvent.options, ["one", "two"]);
  assert.throws(() => adapter.respond("session-1", selectEvent.requestId, { value: "three" }), error => error.code === "invalid_extension_ui_response");
  assert.deepEqual(adapter.respond("session-1", selectEvent.requestId, { value: "two" }), { ok: true });
  assert.equal(await selected, "two");

  const confirmed = ui.confirm("Continue", "Proceed?");
  const confirmEvent = await waitFor(events, event => event.type === "extension_ui_request" && event.method === "confirm");
  assert.throws(() => adapter.respond("session-1", confirmEvent.requestId, { value: "wrong" }), error => error.code === "invalid_extension_ui_response");
  assert.deepEqual(adapter.respond("session-1", confirmEvent.requestId, { confirmed: true }), { ok: true });
  assert.equal(await confirmed, true);
});

test("extension UI responses are exposed through the session API", async () => {
  const hub = new EventHub();
  const events = frames(hub);
  const adapter = new ExtensionUiHost({ hub });
  const api = buildApi({}, { extensionUi: adapter });
  const selected = adapter.uiContext("session-3").select("Choose", ["one"]);
  const event = await waitFor(events, value => value.type === "extension_ui_request");
  const response = await api.request(`http://pi-web.test/sessions/session-3/extension-ui/${event.requestId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "one" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(await selected, "one");
});

test("extension UI handles an already-aborted dialog signal", async () => {
  const adapter = new ExtensionUiHost({ hub: new EventHub() });
  const signal = AbortSignal.abort();
  assert.equal(await adapter.uiContext("session-aborted").select("Choose", ["one"], { signal }), undefined);
});

test("extension UI cancellation resolves the Pi-compatible fallback", async () => {
  const hub = new EventHub();
  const events = frames(hub);
  const adapter = new ExtensionUiHost({ hub });
  const ui = adapter.uiContext("session-2");
  const selected = ui.select("Choose", ["one"], { timeout: 1000 });
  const event = await waitFor(events, value => value.type === "extension_ui_request");
  assert.deepEqual(adapter.cancel("session-2", event.requestId), { ok: true, cancelled: true });
  assert.equal(await selected, undefined);
});

test("pending extension dialogs are re-sent when the browser reloads the transcript", async () => {
  const hub = new EventHub();
  const events = frames(hub);
  const adapter = new ExtensionUiHost({ hub });
  const selected = adapter.uiContext("session-r").select("Choose", ["one"]);
  const first = await waitFor(events, event => event.type === "extension_ui_request");
  events.length = 0;
  adapter.replayPending("session-r");
  adapter.replayPending("other-session");
  const replayed = await waitFor(events, event => event.type === "extension_ui_request");
  assert.equal(replayed.requestId, first.requestId);
  assert.deepEqual(replayed.options, ["one"]);
  adapter.respond("session-r", first.requestId, { value: "one" });
  assert.equal(await selected, "one");
});

test("an extension's status is remembered for a page that loads later, and forgotten with the session", async () => {
  const hub = new EventHub();
  const events = frames(hub);
  const adapter = new ExtensionUiHost({ hub });
  const status = events => events.filter(event => event.type === "extension_ui_status").map(event => [event.sessionId, event.key, event.text]);
  adapter.uiContext("session-s").setStatus("pi-sync", "sync: up to date");
  adapter.uiContext("session-s").setStatus("other", "busy");
  adapter.uiContext("session-s").setStatus("other", undefined);
  events.length = 0;
  adapter.replayPending("session-s");
  adapter.replayPending("other-session");
  assert.deepEqual(status(events), [["session-s", "pi-sync", "sync: up to date"]], "only what is still shown, only for that session");
  events.length = 0;
  adapter.cancelSession("session-s");
  assert.deepEqual(status(events), [["session-s", "pi-sync", null]], "open pages drop the label of a session whose runtime is gone");
  events.length = 0;
  adapter.replayPending("session-s");
  assert.deepEqual(status(events), []);
});

test("a page loaded after a worker's session set its sync status gets it through web's relay", async () => {
  // The worker: its real API on its hub, with a status set before web or any page was listening.
  const extensionUi = new ExtensionUiHost({ hub: workerHub });
  extensionUi.uiContext("s1").setStatus("pi-sync", "sync: up to date");
  const sup = { transcript: async () => [], isStreaming: () => false, isCompacting: () => false, queue: () => [] };
  const workerApp = new Hono();
  workerApp.get("/api/state", c => c.json({ projects: [{ id: "p1", name: "app", sessions: [{ id: "s1" }] }] }));
  // The hub's frames as the worker's /events sends them, without that route's 15-second keepalive timer.
  let unlisten;
  workerApp.get("/api/events", () => new Response(new ReadableStream({
    start(controller) { unlisten = workerHub.addClient(frame => controller.enqueue(new TextEncoder().encode(frame))); },
    cancel() { unlisten(); },
  }), { headers: { "content-type": "text/event-stream" } }));
  workerApp.route("/api", buildApi(sup, { extensionUi }));
  const worker = serve({ fetch: workerApp.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise(resolve => worker.once("listening", resolve));
  const provider = { list: async () => [{ name: "app", ready: true, state: "running" }], upstream: () => `http://127.0.0.1:${worker.address().port}` };
  const daemon = serve({ fetch: createWorkspaced({ provider, token: "t" }).fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise(resolve => daemon.once("listening", resolve));
  const hub = new EventHub();
  const events = frames(hub);
  const remote = createRemoteWorkspaces({ url: `http://127.0.0.1:${daemon.address().port}`, token: "t", hub, retryMs: 50, modelAuthSyncMs: 0 });
  try {
    const api = new Hono();
    registerRemoteRoutes(api, remote);
    await remote.projects();
    await waitFor(events, event => event.type === "events_resync");
    assert.equal(events.some(event => event.type === "extension_ui_status"), false, "nothing replays a status on its own");
    // The page opens the conversation: its transcript load brings the status with it.
    assert.equal((await api.request("/sessions/s1/transcript")).status, 200);
    const shown = await waitFor(events, event => event.type === "extension_ui_status");
    assert.deepEqual([shown.sessionId, shown.key, shown.text], ["s1", "pi-sync", "sync: up to date"]);
  } finally {
    remote.stop();
    daemon.close();
    worker.closeAllConnections();
    worker.close();
  }
});

test("a question tells the browser when it is no longer waiting, however it ended", async () => {
  const hub = new EventHub();
  const events = frames(hub);
  const adapter = new ExtensionUiHost({ hub });
  const ui = adapter.uiContext("session-9");

  const answered = ui.select("Which?", ["one", "two"]);
  const asked = await waitFor(events, event => event.type === "extension_ui_request");
  adapter.respond("session-9", asked.requestId, { value: "two" });
  assert.equal(await answered, "two");
  await waitFor(events, event => event.type === "extension_ui_resolved" && event.requestId === asked.requestId);

  // Abandoned (the turn was aborted) with nobody answering.
  const controller = new AbortController();
  const abandoned = ui.confirm("Still there?", "", { signal: controller.signal });
  await waitFor(events, event => event.type === "extension_ui_request" && event.title === "Still there?");
  controller.abort();
  assert.equal(await abandoned, false);
  const second = events.filter(event => event.type === "extension_ui_request").at(-1);
  await waitFor(events, event => event.type === "extension_ui_resolved" && event.requestId === second.requestId);
});
