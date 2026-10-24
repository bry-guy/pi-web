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

test("the composer answers typed questions; a failed answer keeps the question", async () => {
  for (const method of ["input", "editor"]) {
    store.state.drafts = {};
    const request = { sessionId: "s1", requestId: method, method, prefill: "original" };
    const element = mount(request);
    assert.equal(element.querySelector("input, textarea"), null, "the card has no text field");
    assert.equal(element.acceptsText("s1"), true);
    assert.equal(store.draft("s1"), "original", "a suggested answer starts the composer's draft");

    const response = deferred();
    api.extensionUiResponse = () => response.promise;
    store.setError = message => { store.state.error = message; store.notify("state"); };
    const sent = element.answer("typed draft");
    assert.equal(element.querySelector(".ask-card").getAttribute("aria-busy"), "true");
    response.reject(new Error("rejected"));
    assert.equal(await sent, false, "a failed send reports it, so the composer keeps the text");
    assert.equal(element.querySelector(".ask-card").getAttribute("aria-busy"), "false");
    assert.ok(store.state.asks.s1, "and the question stays");
    element.remove();
    root = null;
  }
});

test("confirm questions and plain option lists do not take the composer's text", () => {
  const element = mount({ sessionId: "s1", requestId: "c", method: "confirm", title: "Sure?" });
  assert.equal(element.acceptsText("s1"), false);
  ask({ sessionId: "s1", requestId: "s", method: "select", title: "Pick", options: ["a", "b"] });
  assert.equal(element.acceptsText("s1"), false);
  ask({ sessionId: "s1", requestId: "o", method: "select", title: "Pick", options: ["1. a — first", "2. Type something."] });
  assert.equal(element.acceptsText("s1"), true, "a questionnaire with its own 'type something' row does");
});

test("answering or dismissing removes the question; a new one starts from its prefill", async () => {
  store.state.drafts = {};
  const request = { sessionId: "s1", requestId: "first", method: "input", prefill: "prefill" };
  const element = mount(request);
  assert.equal(await element.answer("submitted"), true);
  assert.equal(store.state.asks.s1, undefined);
  assert.equal(element.querySelector(".ask-card"), null);

  store.setDraft("", "s1");
  ask({ ...request, requestId: "second" });
  assert.equal(store.draft("s1"), "prefill");
  store.setDraft("kept", "s1");
  ask({ ...request, requestId: "third" });
  assert.equal(store.draft("s1"), "kept", "a prefill never replaces what was typed");
  element.querySelector("[data-extension-ui-cancel]").click();
  await settle();
  assert.equal(store.state.asks.s1, undefined, "dismissing clears it even if the server already forgot it");
});

test("ticked boxes are remembered per question across conversation switches", async () => {
  const sent = [];
  api.extensionUiResponse = async (_session, _request, body) => { sent.push(body); return { ok: true }; };
  const multi = sessionId => ({ sessionId, requestId: "m", method: "input", title: "Pick some\n\n1. A — first\n2. B — second\n3. C — third\n\nEnter the numbers", placeholder: "1,3; custom answer" });
  const element = mount(multi("s1"));
  ask(multi("s2"));
  const tick = n => {
    const box = element.querySelector(`[data-extension-ui-check='${n}']`);
    box.checked = true;
    box.dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  tick(3);
  tick(1);
  store.set({ sessionId: "s2" });
  assert.equal(element.querySelectorAll("[data-extension-ui-check]:checked").length, 0, "the other conversation's question starts empty");
  store.set({ sessionId: "s1" });
  assert.deepEqual([...element.querySelectorAll("[data-extension-ui-check]:checked")].map(b => b.dataset.extensionUiCheck), ["1", "3"]);
  await element.answer("and more");
  assert.deepEqual(sent.at(-1), { value: "1,3; and more" });
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
  void element.answer("old");
  ask({ sessionId: "s1", requestId: "new", method: "input" });
  void element.answer("new");
  oldResponse.resolve({ ok: true });
  await settle();
  assert.equal(store.state.asks.s1.requestId, "new", "the old reply does not remove the new question");
  assert.equal(element.querySelector(".ask-card").getAttribute("aria-busy"), "true", "nor unlock it");
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
