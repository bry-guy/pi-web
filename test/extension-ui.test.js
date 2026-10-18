import assert from "node:assert/strict";
import { test } from "node:test";
import { EventHub } from "../server/events.js";
import { buildApi } from "../server/routes.js";
import { ExtensionUiHost } from "../server/extension-ui.js";

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
    await new Promise(resolve => setTimeout(resolve, 1));
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
