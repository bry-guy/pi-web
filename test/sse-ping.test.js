import test from "node:test";
import assert from "node:assert/strict";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://pi-web.test/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, customElements: dom.window.customElements });
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = () => ({ unref() {} });
const [{ store }, { applyEvent, handlePing }] = await Promise.all([import("../public/js/store.js"), import("../public/js/api.js")]);
globalThis.setInterval = originalSetInterval;

test("a ping below the seen seq (server restarted) resets seqs so live events apply again", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ records: [], seq: 2 }), { headers: { "content-type": "application/json" } });
  store.state.transcripts.s1 = { records: [], streaming: true, seq: 900 };
  applyEvent({ v: 1, seq: 3, sessionId: "s1", type: "message_start", messageId: "m1" });
  assert.equal(store.state.transcripts.s1.records.length, 0, "stale high seq drops the event");
  handlePing({ type: "ping", seq: 3 });
  assert.equal(store.state.transcripts.s1.seq, -1);
  applyEvent({ v: 1, seq: 4, sessionId: "s1", type: "message_start", messageId: "m2" });
  assert.equal(store.state.transcripts.s1.records.length, 1);
});
