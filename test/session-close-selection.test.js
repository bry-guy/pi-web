import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://pi-web.test/" });
const domGlobals = {
  window: dom.window,
  document: dom.window.document,
  location: dom.window.location,
  history: dom.window.history,
  HTMLElement: dom.window.HTMLElement,
  customElements: dom.window.customElements,
};
const previousGlobals = new Map();
for (const [name, value] of Object.entries(domGlobals)) {
  previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = () => ({ unref() {} });
const [{ store }, { applyEvent, refreshState }, { selectChat, selectSession }] = await Promise.all([
  import("../public/js/store.js"),
  import("../public/js/api.js"),
  import("../public/js/shell.js"),
]);
globalThis.setInterval = originalSetInterval;

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  dom.window.close();
});

function json(data) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function prepare({ projects = [], chats = [], selection = {} }) {
  store.set({
    view: "chat", projectId: null, sessionId: null, chatId: null,
    projects, chats, transcripts: {}, filesOpen: false,
    files: [], fileError: null, filePath: null, fileView: null,
    fileTarget: "none", fileTargets: ["none", "HEAD"], fileLoading: false,
    filesLoading: false, filesLoadedKey: null,
    ...selection,
  });
}

function startClose(t, sessionId, nextState) {
  const stateResponse = deferred();
  const transcriptReads = [];
  globalThis.fetch = async input => {
    const url = String(input);
    if (url === "/api/state") return stateResponse.promise;
    if (url.endsWith("/transcript")) {
      transcriptReads.push(url);
      return json({ records: [], seq: 0 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  applyEvent({ type: "session_closed", sessionId });
  const refresh = refreshState();
  return {
    transcriptReads,
    refresh,
    resolve: () => stateResponse.resolve(json(nextState)),
  };
}

async function finishClose(close) {
  close.resolve();
  await close.refresh;
  await new Promise(resolve => setImmediate(resolve));
}

const state = (projects = [], chats = []) => ({ projects, chats, effectiveDefaultModel: "model" });
const project = (sessions = []) => ({ id: "p", sessions });
const session = id => ({ id, model: "model", children: [] });
const chat = id => ({ id, model: "model" });

test("chat close keeps a newer chat selected while refresh is pending", async t => {
  prepare({ chats: [chat("chat-a"), chat("chat-b")], selection: { chatId: "chat-a" } });
  const close = startClose(t, "chat-a", state([], [chat("chat-fallback"), chat("chat-b")]));
  selectChat("chat-b");
  store.set({ filesOpen: true, files: [{ path: "b.js" }], filePath: "b.js" });

  await finishClose(close);

  assert.equal(store.state.chatId, "chat-b");
  assert.equal(store.state.sessionId, null);
  assert.equal(store.state.projectId, null);
  assert.equal(store.state.filesOpen, true);
  assert.deepEqual(store.state.files, [{ path: "b.js" }]);
  assert.equal(store.state.filePath, "b.js");
  assert.deepEqual(close.transcriptReads, ["/api/sessions/chat-b/transcript"]);
});

test("project-session close keeps a newer session selected while refresh is pending", async t => {
  prepare({ projects: [project([session("session-a"), session("session-b")])], selection: { projectId: "p", sessionId: "session-a" } });
  const close = startClose(t, "session-a", state([project([session("session-fallback"), session("session-b")])]));
  selectSession("p", "session-b");
  store.set({ filesOpen: true, files: [{ path: "b.js" }], filePath: "b.js" });

  await finishClose(close);

  assert.equal(store.state.chatId, null);
  assert.equal(store.state.sessionId, "session-b");
  assert.equal(store.state.projectId, "p");
  assert.equal(store.state.filesOpen, true);
  assert.deepEqual(store.state.files, [{ path: "b.js" }]);
  assert.equal(store.state.filePath, "b.js");
  assert.deepEqual(close.transcriptReads, ["/api/sessions/session-b/transcript"]);
});

test("selected chat close clears its selection after refresh", async t => {
  prepare({ chats: [chat("chat-a"), chat("chat-b")], selection: { chatId: "chat-a" } });
  store.set({ filesOpen: true, files: [{ path: "stale.js" }], filePath: "stale.js", fileView: { path: "stale.js" }, fileError: "stale", fileLoading: true, filesLoading: true });
  const close = startClose(t, "chat-a", state([], [chat("chat-b")]));

  await finishClose(close);

  assert.equal(store.state.chatId, null);
  assert.equal(store.state.filesOpen, false);
  assert.deepEqual(store.state.files, []);
  assert.equal(store.state.filePath, null);
  assert.equal(store.state.fileView, null);
  assert.equal(store.state.fileError, null);
  assert.equal(store.state.fileLoading, false);
  assert.equal(store.state.filesLoading, false);
});

test("selected project-session close falls back to the first remaining session", async t => {
  prepare({ projects: [project([session("session-a")])], selection: { projectId: "p", sessionId: "session-a" } });
  const close = startClose(t, "session-a", state([project([session("session-fallback")])]));

  await finishClose(close);

  assert.equal(store.state.projectId, "p");
  assert.equal(store.state.sessionId, "session-fallback");
  assert.deepEqual(close.transcriptReads, ["/api/sessions/session-fallback/transcript"]);
});

test("selected project-session close falls back to a chat when no session remains", async t => {
  prepare({ projects: [project([session("session-a")])], selection: { projectId: "p", sessionId: "session-a" } });
  const close = startClose(t, "session-a", state([project()], [chat("chat-fallback")]));

  await finishClose(close);

  assert.equal(store.state.projectId, null);
  assert.equal(store.state.sessionId, null);
  assert.equal(store.state.chatId, "chat-fallback");
  assert.deepEqual(close.transcriptReads, ["/api/sessions/chat-fallback/transcript"]);
});

test("selected project-session close clears its selection when no fallback remains", async t => {
  prepare({ projects: [project([session("session-a")])], selection: { projectId: "p", sessionId: "session-a" } });
  const close = startClose(t, "session-a", state([project()]));

  await finishClose(close);

  assert.equal(store.state.sessionId, null);
  assert.equal(store.state.chatId, null);
  assert.deepEqual(close.transcriptReads, []);
});

test("inactive close leaves the selected conversation and its panels alone", async t => {
  prepare({ projects: [project([session("session-a"), session("session-b")])], selection: { projectId: "p", sessionId: "session-b" } });
  const close = startClose(t, "session-a", state([project([session("session-b")])]));
  store.set({ filesOpen: true, files: [{ path: "b.js" }], filePath: "b.js" });

  await finishClose(close);

  assert.equal(store.state.projectId, "p");
  assert.equal(store.state.sessionId, "session-b");
  assert.equal(store.state.chatId, null);
  assert.equal(store.state.filesOpen, true);
  assert.deepEqual(store.state.files, [{ path: "b.js" }]);
  assert.equal(store.state.filePath, "b.js");
  assert.deepEqual(close.transcriptReads, []);
});

test("inactive chat close leaves the selected chat and its panels alone", async t => {
  prepare({ chats: [chat("chat-a"), chat("chat-b")], selection: { chatId: "chat-b" } });
  const close = startClose(t, "chat-a", state([], [chat("chat-b")]));
  store.set({ filesOpen: true, files: [{ path: "b.js" }], filePath: "b.js" });

  await finishClose(close);

  assert.equal(store.state.chatId, "chat-b");
  assert.equal(store.state.sessionId, null);
  assert.equal(store.state.projectId, null);
  assert.equal(store.state.filesOpen, true);
  assert.deepEqual(store.state.files, [{ path: "b.js" }]);
  assert.equal(store.state.filePath, "b.js");
  assert.deepEqual(close.transcriptReads, []);
});
