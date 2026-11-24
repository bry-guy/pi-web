import test from "node:test";
import assert from "node:assert/strict";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://pi-web.test/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, customElements: dom.window.customElements });
const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = () => ({ unref() {} });
const [{ store }, { applyEvent }] = await Promise.all([import("../public/js/store.js"), import("../public/js/api.js")]);
globalThis.setInterval = originalSetInterval;

test("a remote session that drops mid-turn stops looking like it runs", () => {
  applyEvent({ type: "remote_sessions", sessions: [{ id: "r1", streaming: true }, { id: "r2", streaming: true }] });
  assert.equal(store.state.transcripts.r1.streaming, true);
  applyEvent({ type: "remote_sessions", sessions: [{ id: "r2", streaming: true }] });
  assert.equal(store.state.transcripts.r1.streaming, false);
  assert.equal(store.state.transcripts.r2.streaming, true);
});
