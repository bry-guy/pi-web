import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";

let dom;
let api;
let store;
let root;
let originalSetError;
const globals = {};
const apiMethods = {};
const importIntervals = [];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function mount(request, sessionId = request.sessionId) {
  store.state.sessionId = sessionId;
  store.state.chatId = null;
  store.state.asks = { [request.sessionId]: request };
  root = document.createElement("pi-extension-ui");
  document.body.append(root);
  return root;
}

const ask = request => store.set({ asks: { ...store.state.asks, [request.sessionId]: request } });
const settle = () => new Promise(resolve => setImmediate(resolve));

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://pi-web.test/", pretendToBeVisual: true });
  for (const name of ["window", "document", "HTMLElement", "customElements", "Node", "Event", "KeyboardEvent", "MouseEvent", "CustomEvent", "matchMedia", "requestAnimationFrame"]) {
    globals[name] = globalThis[name];
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    CustomEvent: dom.window.CustomEvent,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  });
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const timer = originalSetInterval(...args);
    importIntervals.push(timer);
    return timer;
  };
  try {
    ({ api } = await import("../public/js/api.js"));
    ({ store } = await import("../public/js/store.js"));
    await import("../public/js/dialogs.js");
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
  originalSetError = store.setError;
  apiMethods.extensionUiResponse = api.extensionUiResponse;
  apiMethods.extensionUiCancel = api.extensionUiCancel;
});

beforeEach(() => {
  api.extensionUiResponse = async () => ({ ok: true });
  api.extensionUiCancel = async () => ({ ok: true });
});

afterEach(() => {
  root?.remove();
  root = null;
  store.state.asks = {};
  store.state.sessionId = null;
  store.state.chatId = null;
  store.state.error = null;
  store.setError = originalSetError;
  api.extensionUiResponse = apiMethods.extensionUiResponse;
  api.extensionUiCancel = apiMethods.extensionUiCancel;
});

after(() => {
  for (const timer of importIntervals) clearInterval(timer);
  dom.window.close();
  for (const [name, value] of Object.entries(globals)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
});

test("typed answers survive re-renders, including a failed send", async () => {
  for (const method of ["input", "editor"]) {
    const request = { sessionId: "s1", requestId: method, method, prefill: "original" };
    const element = mount(request);
    const field = element.querySelector("[data-extension-ui-value]");
    assert.equal(field.value, "original");
    field.value = "typed draft";
    field.focus();
    store.notify("state");
    assert.equal(element.querySelector("[data-extension-ui-value]").value, "typed draft");
    assert.equal(document.activeElement, element.querySelector("[data-extension-ui-value]"));

    const response = deferred();
    api.extensionUiResponse = () => response.promise;
    store.setError = message => { store.state.error = message; store.notify("state"); };
    element.querySelector("[data-extension-ui-submit]").click();
    assert.equal(element.querySelector("[data-extension-ui-value]").readOnly, true);
    response.reject(new Error("rejected"));
    await settle();
    const current = element.querySelector("[data-extension-ui-value]");
    assert.equal(current.value, "typed draft", "a failed send keeps the answer");
    assert.equal(current.readOnly, false);
    assert.ok(store.state.asks.s1, "and the question");
    element.remove();
    root = null;
  }
});

test("answering or dismissing removes the question; a new one starts from its prefill", async () => {
  const request = { sessionId: "s1", requestId: "first", method: "input", prefill: "prefill" };
  const element = mount(request);
  element.querySelector("[data-extension-ui-value]").value = "submitted";
  element.querySelector("[data-extension-ui-submit]").click();
  await settle();
  assert.equal(store.state.asks.s1, undefined);
  assert.equal(element.querySelector(".ask-card"), null);

  ask({ ...request, requestId: "second" });
  const field = element.querySelector("[data-extension-ui-value]");
  assert.equal(field.value, "prefill");
  field.value = "dismissed draft";
  element.querySelector("[data-extension-ui-cancel]").click();
  await settle();
  assert.equal(store.state.asks.s1, undefined, "dismissing clears it even if the server already forgot it");
});

test("a stale question clears itself, and an old reply cannot unlock a newer question", async () => {
  api.extensionUiResponse = async () => { throw Object.assign(new Error("gone"), { error: "stale_extension_ui_request" }); };
  const element = mount({ sessionId: "s1", requestId: "stale", method: "confirm", title: "Old" });
  element.querySelector("[data-extension-ui-confirm='yes']").click();
  await settle();
  assert.equal(store.state.asks.s1, undefined, "no longer waiting: it goes away instead of reopening");

  const oldResponse = deferred();
  const newResponse = deferred();
  let calls = 0;
  api.extensionUiResponse = () => (++calls === 1 ? oldResponse.promise : newResponse.promise);
  ask({ sessionId: "s1", requestId: "old", method: "input" });
  element.querySelector("[data-extension-ui-submit]").click();
  ask({ sessionId: "s1", requestId: "new", method: "input", prefill: "new prefill" });
  assert.equal(element.querySelector("[data-extension-ui-value]").value, "new prefill");
  element.querySelector("[data-extension-ui-submit]").click();
  oldResponse.resolve({ ok: true });
  await settle();
  assert.equal(store.state.asks.s1.requestId, "new", "the old reply does not remove the new question");
  assert.equal(element.querySelector("[data-extension-ui-value]").readOnly, true, "nor unlock it");
  newResponse.resolve({ ok: true });
  await settle();
  assert.equal(store.state.asks.s1, undefined);
});

test("each session keeps its own question", () => {
  const element = mount({ sessionId: "s1", requestId: "q", method: "confirm", title: "For s1" });
  ask({ sessionId: "s2", requestId: "q", method: "confirm", title: "For s2" });
  assert.match(element.textContent, /For s1/);
  store.set({ sessionId: "s2" });
  assert.match(element.textContent, /For s2/);
  store.set({ sessionId: "s3" });
  assert.equal(element.querySelector(".ask-card"), null);
});
