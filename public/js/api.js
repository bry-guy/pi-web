import { appendOperationEvent, completeOperation, completeOperationSnapshot } from "./operations.js";
import { CONTRACT_VERSION, store } from "./store.js";

const JH = { "content-type": "application/json" };
// The app may be served under a path prefix; root-absolute
// API paths are resolved against the document base so "/" stays unchanged.
export const BASE = new URL(".", document.baseURI).pathname;
const withBase = url => typeof url === "string" && url.startsWith("/") ? BASE + url.slice(1) : url;
const fetch = (url, init) => globalThis.fetch(withBase(url), init);
export function formatDuration(durationMs) {
  return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

async function responseBody(r) {
  const type = r.headers.get("content-type") || "";
  if (type.includes("application/json")) return r.json().catch(() => ({}));
  const text = await r.text().catch(() => "");
  return text ? { message: text.slice(0, 300) } : {};
}

const j = async (r) => {
  const body = await responseBody(r);
  if (!r.ok) {
    const code = body.error || `http_${r.status}`;
    const message = body.message || (body.requestId ? `${code} (${body.requestId})` : code);
    throw Object.assign(new Error(message), body, {
      status: r.status,
      requestId: body.requestId || r.headers.get("x-request-id"),
    });
  }
  return body;
};

export const api = {
  state: () => fetch("/api/state", { cache: "no-store" }).then(j),
  workspaceGrants: () => fetch("/api/remote-workspaces/grants").then(j),
  wakeWorkspace: name => fetch(`/api/remote-workspaces/${encodeURIComponent(name)}/wake`, { method: "POST", headers: JH, body: "{}" }).catch(() => {}),
  restartWorkspace: name => fetch(`/api/remote-workspaces/${encodeURIComponent(name)}/restart`, { method: "POST", headers: JH, body: "{}" }).then(j),
  pinWorkspace: (name, pinned) => fetch(`/api/remote-workspaces/${encodeURIComponent(name)}/pin`, { method: "PUT", headers: JH, body: JSON.stringify({ pinned }) }).then(j),
  workspaceInventory: () => fetch("/api/remote-workspaces").then(j),
  reloadWorkspace: name => fetch(`/api/remote-workspaces/${encodeURIComponent(name)}/reload`, { method: "POST", headers: JH, body: "{}" }).then(j),
  reloadWorkspaces: () => fetch("/api/remote-workspaces/reload", { method: "POST", headers: JH, body: "{}" }).then(j),
  sleepWorkspace: name => fetch(`/api/remote-workspaces/${encodeURIComponent(name)}/sleep`, { method: "POST", headers: JH, body: "{}" }).then(j),
  deleteWorkspace: (name, purge = false) => fetch(`/api/remote-workspaces/${encodeURIComponent(name)}${purge ? "?purge=1" : ""}`, { method: "DELETE" }).then(j),
  resetWorkspace: (name, confirm) => fetch(`/api/remote-workspaces/${encodeURIComponent(name)}/reset`, { method: "POST", headers: JH, body: JSON.stringify({ confirm }) }).then(j),
  health: () => fetch(`/api/health?probe=${Date.now()}`, { cache: "no-store" }).then(j),
  logs: (limit = 500) => fetch(`/api/logs?limit=${encodeURIComponent(limit)}`, { cache: "no-store" }).then(j),
  models: () => fetch("/api/models").then(j),
  providers: () => fetch("/api/providers").then(j),
  authStart: (providerId, type) => fetch(`/api/providers/${encodeURIComponent(providerId)}/login`, { method: "POST", headers: JH, body: JSON.stringify({ type }) }).then(j),
  authFlow: id => fetch(`/api/auth-flows/${encodeURIComponent(id)}`).then(j),
  authInput: (id, promptId, value) => fetch(`/api/auth-flows/${encodeURIComponent(id)}/input`, { method: "POST", headers: JH, body: JSON.stringify({ promptId, value }) }).then(j),
  authCancel: id => fetch(`/api/auth-flows/${encodeURIComponent(id)}`, { method: "DELETE" }).then(j),
  providerLogout: providerId => fetch(`/api/providers/${encodeURIComponent(providerId)}/logout`, { method: "POST" }).then(j),
  fetchProject: (id, operationId = null, sessionId = null) => fetch(`/api/projects/${encodeURIComponent(id)}/fetch`, { method: "POST", headers: { ...JH, ...(operationId ? { "x-pi-operation-id": operationId } : {}) }, body: JSON.stringify({ ...(operationId ? { operationId } : {}), ...(sessionId ? { sessionId } : {}) }) }).then(j),
  newChat: () => fetch("/api/chats", { method: "POST" }).then(j),
  newProject: value => {
    const body = typeof value === "string" ? { repoPath: value } : (value || {});
    return fetch("/api/projects", { method: "POST", headers: JH, body: JSON.stringify(body) }).then(j);
  },
  syncedSessions: (projectId) => fetch(`/api/projects/${projectId}/synced-sessions`).then(j),
  syncedPreview: (projectId, syncId) => fetch(`/api/projects/${projectId}/synced-sessions/${encodeURIComponent(syncId)}`).then(j),
  newProjectSession: (projectId, options = {}) => fetch(`/api/projects/${projectId}/sessions`, { method: "POST", headers: { ...JH, ...(options?.operationId ? { "x-pi-operation-id": options.operationId } : {}) }, body: JSON.stringify(options || {}) }).then(j),
  forkSession: (id, name = null) => fetch(`/api/sessions/${encodeURIComponent(id)}/fork`, { method: "POST", headers: JH, body: JSON.stringify({ name }) }).then(j),
  branchSession: (id, options = {}) => fetch(`/api/sessions/${encodeURIComponent(id)}/branch-context`, { method: "POST", headers: { ...JH, ...(options?.operationId ? { "x-pi-operation-id": options.operationId } : {}) }, body: JSON.stringify(options || {}) }).then(j),
  mergeBranch: (id, operationId = null) => fetch(`/api/sessions/${encodeURIComponent(id)}/merge-local`, { method: "POST", headers: { ...JH, ...(operationId ? { "x-pi-operation-id": operationId } : {}) }, body: JSON.stringify(operationId ? { operationId } : {}) }).then(j),
  pullBranch: (id) => fetch(`/api/sessions/${encodeURIComponent(id)}/pull`, { method: "POST", headers: JH, body: JSON.stringify({}) }).then(j),
  pushPreview: id => fetch(`/api/sessions/${encodeURIComponent(id)}/push-preview`, { cache: "no-store" }).then(j),
  pushBranch: (id, operationId = null, expected = {}) => {
    const body = { ...(operationId ? { operationId } : {}), ...(expected?.head ? { expectedHead: expected.head } : {}), ...(Object.prototype.hasOwnProperty.call(expected || {}, "baseHead") ? { expectedBaseHead: expected.baseHead } : {}) };
    return fetch(`/api/sessions/${encodeURIComponent(id)}/push`, { method: "POST", headers: { ...JH, ...(operationId ? { "x-pi-operation-id": operationId } : {}) }, body: JSON.stringify(body) }).then(j);
  },
  deleteBranch: (projectId, branch, options = {}) => fetch(`/api/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch)}`, { method: "DELETE", headers: { ...JH, ...(options?.operationId ? { "x-pi-operation-id": options.operationId } : {}) }, body: JSON.stringify(options || {}) }).then(j),
  repositorySources: () => fetch("/api/repository-sources").then(j),
  githubRepos: (query = "", page = 1) => fetch(`/api/github/repos?q=${encodeURIComponent(query)}&page=${encodeURIComponent(page)}`).then(j),
  githubPublicRepos: (owner, query = "", page = 1) => {
    const params = new URLSearchParams({ q: query, page: String(page) });
    if (owner) params.set("owner", owner);
    return fetch(`/api/github/public-repos?${params}`).then(j);
  },
  githubLogin: () => fetch("/api/github/device-login", { method: "POST" }).then(j),
  githubFlow: id => fetch(`/api/github/device-login/${encodeURIComponent(id)}`).then(j),
  githubCancel: id => fetch(`/api/github/device-login/${encodeURIComponent(id)}`, { method: "DELETE" }).then(j),
  githubLogout: () => fetch("/api/github/logout", { method: "POST" }).then(j),
  files: (projectId, contextId, target = "origin") => {
    const params = new URLSearchParams({ target });
    if (contextId) params.set("contextId", contextId);
    return fetch(`/api/projects/${encodeURIComponent(projectId)}/files?${params}`).then(j);
  },
  file: (projectId, contextId, filePath, target = "origin") => {
    const params = new URLSearchParams({ path: filePath, target });
    if (contextId) params.set("contextId", contextId);
    return fetch(`/api/projects/${encodeURIComponent(projectId)}/file?${params}`).then(j);
  },
  transcript: (id) => fetch(`/api/sessions/${id}/transcript`).then(j),
  meta: (id) => fetch(`/api/sessions/${id}/meta`).then(j),
  message: (id, text, mode = "prompt", images = [], clientMessageId = null) => fetch(`/api/sessions/${id}/message`, {
    method: "POST", headers: JH, body: JSON.stringify({ text, mode, images, ...(clientMessageId ? { clientMessageId } : {}) }),
  }).then(j),
  stop: (id) => fetch(`/api/sessions/${id}/stop`, { method: "POST" }).then(j),
  bang: (id, cmd) => fetch(`/api/sessions/${id}/bang`, { method: "POST", headers: JH, body: JSON.stringify({ cmd }) }).then(j),
  setModel: (id, model) => fetch(`/api/sessions/${id}/model`, { method: "POST", headers: JH, body: JSON.stringify({ model }) }).then(j),
  context: id => fetch(`/api/sessions/${encodeURIComponent(id)}/context`).then(j),
  thinking: id => fetch(`/api/sessions/${encodeURIComponent(id)}/thinking`).then(j),
  setThinking: (id, level) => fetch(`/api/sessions/${encodeURIComponent(id)}/thinking`, { method: "POST", headers: JH, body: JSON.stringify({ level }) }).then(j),
  commands: id => fetch(`/api/sessions/${encodeURIComponent(id)}/commands`).then(j),
  command: (id, text, mode = "prompt") => fetch(`/api/sessions/${encodeURIComponent(id)}/command`, { method: "POST", headers: JH, body: JSON.stringify({ text, mode }) }).then(j),
  extensionUiResponse: (sessionId, requestId, body) => fetch(`/api/sessions/${encodeURIComponent(sessionId)}/extension-ui/${encodeURIComponent(requestId)}`, { method: "POST", headers: JH, body: JSON.stringify(body || {}) }).then(j),
  extensionUiCancel: (sessionId, requestId) => fetch(`/api/sessions/${encodeURIComponent(sessionId)}/extension-ui/${encodeURIComponent(requestId)}`, { method: "DELETE" }).then(j),
  exportSession: (id, format = "html") => `/api/sessions/${encodeURIComponent(id)}/export?format=${encodeURIComponent(format)}`,
  sessionHistory: id => fetch(`/api/sessions/${encodeURIComponent(id)}/history`).then(j),
  hook: (id, name, operationId = null) => fetch(`/api/sessions/${encodeURIComponent(id)}/hooks/${encodeURIComponent(name)}`, { method: "POST", headers: { ...JH, ...(operationId ? { "x-pi-operation-id": operationId } : {}) }, body: JSON.stringify(operationId ? { operationId } : {}) }).then(j),
  settings: (defaultModel, reposRoot) => {
    const body = {};
    if (defaultModel !== undefined) body.defaultModel = defaultModel;
    if (reposRoot !== undefined) body.reposRoot = reposRoot;
    return fetch("/api/settings", { method: "POST", headers: JH, body: JSON.stringify(body) }).then(j);
  },
  settingsPatch: patch => {
    const operationId = patch?.operationId;
    return fetch("/api/settings", { method: "POST", headers: { ...JH, ...(operationId ? { "x-pi-operation-id": operationId } : {}) }, body: JSON.stringify(patch || {}) }).then(j);
  },
  restore: id => fetch(`/api/sessions/${encodeURIComponent(id)}/restore`, { method: "POST", headers: JH, body: "{}" }).then(j),
  removeProject: projectId => fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).then(j),
  endIdle: projectId => fetch(`/api/projects/${encodeURIComponent(projectId)}/end-idle`, { method: "POST", headers: JH, body: "{}" }).then(j),
  close: (id, operationId = null, kind = "session") => fetch(`/api/sessions/${id}/close`, { method: "POST", headers: { ...JH, ...(operationId ? { "x-pi-operation-id": operationId } : {}) }, body: JSON.stringify({ ...(operationId ? { operationId } : {}), kind }) }).then(j),
};

const STATE_CACHE = "pi-ez-web:state";
// Draws the last known sidebar before the network answers; refreshState replaces it.
export function paintCachedState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_CACHE) || "null");
    if (Array.isArray(s?.projects) && Array.isArray(s?.chats) && !store.state.projects?.length) store.set({ projects: s.projects, chats: s.chats });
  } catch { /* ignore a corrupt cache */ }
}

let stateRefreshPromise = null;
let lastStateKey = null;
// Workers page data. A 404 means this server runs without workspaced.
export async function refreshWorkers() {
  try {
    store.set({ workers: await api.workspaceInventory(), workersError: null });
  } catch (err) {
    store.set({ workersError: err.status === 404 ? "Workers are not enabled on this server." : `Could not load workers: ${err.message || err}` });
  }
}

export function refreshState() {
  if (stateRefreshPromise) return stateRefreshPromise;
  const request = (async () => {
    const s = await api.state();
    // Polled every few seconds: an unchanged answer must not re-render the sidebar and thread.
    const key = `${store.activeKey()}\n${JSON.stringify(s)}`;
    if (key === lastStateKey && !store.state.reconnecting) return;
    lastStateKey = key;
    applyState(s);
    try { localStorage.setItem(STATE_CACHE, JSON.stringify({ projects: s.projects, chats: s.chats })); } catch { /* quota or private mode */ }
  })();
  stateRefreshPromise = request;
  request.then(
    () => { if (stateRefreshPromise === request) stateRefreshPromise = null; },
    () => { if (stateRefreshPromise === request) stateRefreshPromise = null; },
  );
  return request;
}

function applyState(s) {
  const active = findSessionInState(s, store.activeKey());
  store.set({
    projects: s.projects,
    chats: s.chats,
    buildId: s.buildId || null,
    reconnecting: false,
    defaultModel: s.defaultModel || null,
    defaultThinkingLevel: s.defaultThinkingLevel || "medium",
    effectiveDefaultModel: s.effectiveDefaultModel || null,
    defaultModelStatus: s.defaultModelStatus || "automatic",
    modelError: s.modelError || null,
    models: s.models || [],
    providers: s.providers || [],
    piConfiguration: s.piConfiguration || null,
    repositorySources: s.repositorySources || null,
    sync: s.sync || null,
    settings: s.settings || null,
    reposRoot: s.reposRoot || null,
    reposRootSource: s.reposRootSource || "default",
    model: active?.model || s.effectiveDefaultModel || null,
    requestedModel: active?.requestedModel || null,
    modelFallback: !!active?.modelFallback,
    modelUnavailable: !!active?.modelUnavailable,
  });
  for (const project of s.projects || []) seedStreaming(project.sessions);
  for (const chat of s.chats || []) {
    const transcript = store.state.transcripts[chat.id] ||= { records: [], streaming: false, seq: -1 };
    transcript.streaming = !!chat.streaming;
  }
  store.notify("transcript");
}

function seedStreaming(nodes) {
  for (const node of nodes || []) {
    const transcript = store.state.transcripts[node.id] ||= { records: [], streaming: false, seq: -1 };
    transcript.streaming = !!node.streaming;
    seedStreaming(node.children);
  }
}

function findSessionInState(state, id) {
  if (!id) return null;
  for (const p of state.projects || []) {
    const hit = findNode(p.sessions, id);
    if (hit) return hit;
  }
  return (state.chats || []).find(c => c.id === id) || null;
}
function findNode(nodes, id) {
  for (const node of nodes || []) {
    if (node.id === id) return node;
    const hit = findNode(node.children, id);
    if (hit) return hit;
  }
  return null;
}

// --- transcript loading: subscribe first, buffer, snapshot, apply ---
const loading = new Set();
const buffers = new Map();
export function shouldBufferEvent(type) { return type !== "session_switched"; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchTranscriptWithRetry(id, delays = [300, 900, 2000]) {
  for (let attempt = 0; ; attempt++) {
    try { return await api.transcript(id); }
    catch (err) {
      if (err.error || attempt >= delays.length) throw err;
      await sleep(delays[attempt]);
    }
  }
}

export function transcriptLoading(id) { return loading.has(id); }

const reloadAfterLoad = new Set();
export async function openTranscript(id, { scrollToLatest = true, operation = null } = {}) {
  if (!id) return;
  if (loading.has(id)) { reloadAfterLoad.add(id); return; }
  const startedAt = Date.now();
  if (operation) appendOperationEvent(operation.id, { type: "request", message: `GET /api/sessions/${id}/transcript` });
  loading.add(id);
  buffers.set(id, []);
  try {
    const snap = await fetchTranscriptWithRetry(id);
    const pending = (store.state.transcripts[id]?.records || []).filter(record => record.pending || record.deliveryError);
    const records = [...(snap.records || [])];
    for (const record of pending) {
      if (!records.some(existing => existing.role === "user" && existing.text === record.text)) records.push(record);
    }
    store.state.transcripts[id] = {
      records,
      streaming: !!snap.streaming,
      compacting: !!snap.compacting,
      seq: snap.seq ?? -1,
      scrollToLatest,
    };
    const snapshotSeq = snap.seq ?? -1;
    for (const evt of buffers.get(id) || []) {
      if (evt.seq > snapshotSeq) applyEvent(evt, true);
    }
    if (operation) {
      appendOperationEvent(operation.id, { type: "result", message: `Loaded ${records.length} transcript records in ${Date.now() - startedAt}ms.` });
      completeOperation(operation, { ok: true, httpStatus: 200 });
    }
  } catch (err) {
    if (operation) completeOperation(operation, {}, err);
    store.setError(`Could not load transcript: ${err.error || err.message || err}`);
  } finally {
    buffers.delete(id);
    loading.delete(id);
    store.notify("transcript");
    if (reloadAfterLoad.delete(id)) queueMicrotask(() => void openTranscript(id, { scrollToLatest: false }));
  }
}

// --- SSE ---
let es = null;
let recoveryTimer = null;
let recoveryAttempt = 0;
let recoveryInFlight = false;
let reloadIssued = false;

function stopRecovery() {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  recoveryAttempt = 0;
  store.set({ reconnecting: false, offline: false });
}

function scheduleRecovery(delay) {
  if (recoveryTimer || reloadIssued) return;
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    void recoverConnection();
  }, delay);
}

async function recoverConnection() {
  if (reloadIssued || recoveryInFlight || globalThis.navigator?.onLine === false) return;
  recoveryInFlight = true;
  try {
    const health = await api.health();
    if (!health?.ok) throw new Error("health check failed");
    if (store.state.buildId && health.buildId && health.buildId !== store.state.buildId) {
      reloadIssued = true;
      location.reload();
      return;
    }
    // Same guard as the 3.5s refresh timer: don't rewrite state under an open picker or confirm.
    if (!store.state.sessionPicker && !store.state.confirm) await refreshState();
    stopRecovery();
  } catch {
    recoveryAttempt += 1;
    const delay = Math.min(10000, 500 * (2 ** Math.min(recoveryAttempt, 4)));
    scheduleRecovery(delay);
  } finally {
    recoveryInFlight = false;
  }
}

function startRecovery() {
  if (globalThis.navigator?.onLine === false) {
    store.set({ offline: true, reconnecting: false });
    return;
  }
  if (recoveryTimer || recoveryInFlight || reloadIssued) return;
  store.set({ reconnecting: true });
  scheduleRecovery(250);
}

function viewingSession(id) {
  return !!id && store.state.view === "chat" && store.activeKey() === id;
}

export function resumeConnection() {
  if (globalThis.navigator?.onLine === false) {
    store.set({ offline: true, reconnecting: false });
    return;
  }
  store.set({ offline: false });
  connectSSE();
  void recoverConnection();
}

export function connectSSE() {
  if (es) es.close();
  es = new EventSource(`${BASE}api/events?build=${encodeURIComponent(store.state.buildId || "")}`);
  es.onopen = () => {
    if (recoveryTimer || recoveryInFlight) {
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = null;
      void recoverConnection();
    }
  };
  es.onmessage = (m) => {
    let evt;
    try { evt = JSON.parse(m.data); } catch { return; }
    if (evt.v !== CONTRACT_VERSION) {
      store.set({ fatalError: "This server sent an incompatible event contract. Reload the page." });
      return;
    }
    const buf = buffers.get(evt.sessionId);
    if (buf && shouldBufferEvent(evt.type)) { buf.push(evt); return; }
    applyEvent(evt);
  };
  es.onerror = () => {
    // EventSource reconnects by itself, while the health poller handles a
    // rollout that replaces this process and eventually reloads on a new build.
    const id = store.activeKey();
    if (globalThis.navigator?.onLine !== false && id) void openTranscript(id, { scrollToLatest: false });
    startRecovery();
  };
}

function tOf(id) {
  return (store.state.transcripts[id] ||= { records: [], streaming: false, seq: -1 });
}
function byId(records, id) { return records.find(r => r.id === id); }

// Event families that never touch transcript sequence state; true means handled.
function applyUiEvent(evt) {
  if (evt.type === "session_switched" && evt.toSessionId) {
    // pi-sync catches up in place: the same id reloads its transcript, a different id selects the replacement.
    if (evt.toSessionId === evt.sessionId) {
      void openTranscript(evt.sessionId, { scrollToLatest: false });
      void refreshState().catch(err => store.setError(`Could not refresh state: ${err.message || err}`));
    } else if (viewingSession(evt.sessionId)) {
      void refreshState()
        .then(async () => { if (viewingSession(evt.sessionId)) (await import("./shell.js")).selectSessionById(evt.toSessionId); })
        .catch(err => store.setError(`Could not refresh state: ${err.message || err}`));
    }
    return true;
  }
  if (evt.type === "extension_ui_request") {
    store.set({ extensionUi: { ...evt, sessionId: evt.sessionId } });
    return true;
  }
  if (evt.type === "extension_ui_notify") {
    store.set({ commandNotice: { sessionId: evt.sessionId, title: "Pi", message: evt.message || "", level: evt.level || "info" } });
    return true;
  }
  if (evt.type === "extension_ui_status") {
    store.set(state => ({ extensionStatuses: {
      ...state.extensionStatuses,
      [evt.sessionId]: { ...(state.extensionStatuses[evt.sessionId] || {}), [evt.key]: evt.text },
    } }));
    return true;
  }
  if (evt.type === "extension_ui_working" && "message" in evt) {
    // pi-summarize's live line for a busy turn; null clears it.
    store.set(state => ({ workingMessages: { ...(state.workingMessages || {}), [evt.sessionId]: evt.message || null } }));
    return true;
  }
  if (evt.type === "extension_ui_title") {
    if (evt.sessionId === store.activeKey() && typeof document !== "undefined") document.title = evt.title || "pi";
    return true;
  }
  if (evt.type === "extension_ui_editor") {
    if (evt.sessionId === store.activeKey() && typeof document !== "undefined") {
      const field = document.querySelector("pi-composer textarea");
      if (field) {
        const value = String(evt.text || "");
        if (evt.action === "paste") {
          const start = field.selectionStart ?? field.value.length;
          const end = field.selectionEnd ?? start;
          field.value = field.value.slice(0, start) + value + field.value.slice(end);
          field.selectionStart = field.selectionEnd = start + value.length;
        } else {
          field.value = value;
          field.selectionStart = field.selectionEnd = value.length;
        }
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    return true;
  }
  if (evt.type === "operation_log") {
    appendOperationEvent(evt.operationId, evt.event);
    return true;
  }
  if (evt.type === "operation_complete") {
    completeOperationSnapshot(evt.operation);
    return true;
  }
  return false;
}

function applyTranscriptEvent(evt, t, replay) {
  const recs = t.records;
  switch (evt.type) {
    case "user_record": {
      const record = evt.record;
      const pendingIndex = evt.clientMessageId
        ? recs.findIndex(item => item.pendingId === evt.clientMessageId)
        : recs.findLastIndex(item => item.role === "user" && (item.pending || item.deliveryError) && item.text === record?.text);
      if (record && pendingIndex >= 0) recs.splice(pendingIndex, 1, record);
      else if (record && !byId(recs, record.id)) recs.push(record);
      updateFirstTitle(evt.sessionId, record?.text);
      if (!replay) store.touchSession(evt.sessionId);
      break;
    }
    case "prompt_handled": {
      const pendingIndex = recs.findIndex(item => item.pendingId === evt.clientMessageId);
      if (pendingIndex >= 0) recs.splice(pendingIndex, 1);
      break;
    }
    case "turn_start":
      t.streaming = true;
      break;
    case "queue_update":
      store.state.queued[evt.sessionId] = evt.followUp || 0;
      break;
    case "message_start":
      if (!byId(recs, evt.messageId)) recs.push({ id: evt.messageId, role: "assistant", text: "", streaming: true, at: Date.now() });
      break;
    case "thinking_delta": {
      // Thinking is kept on the message for the steps view; the chat never shows it inline.
      let r = byId(recs, evt.messageId);
      if (!r) {
        r = { id: evt.messageId, role: "assistant", text: "", streaming: true, at: Date.now() };
        recs.push(r);
      }
      r.thinking = (r.thinking || "") + evt.delta;
      break;
    }
    case "summary":
      if (evt.record && !byId(recs, evt.record.id)) recs.splice(lastStreamingIndex(recs), 0, evt.record);
      break;
    case "text_delta": {
      let r = byId(recs, evt.messageId);
      if (!r) {
        r = { id: evt.messageId, role: "assistant", text: "", streaming: true, at: Date.now() };
        recs.push(r);
      }
      // The snapshot sequence barrier makes replay ordering explicit; do not
      // infer identity from text suffixes (repeated tokens are legitimate).
      r.text += evt.delta;
      r.streaming = true;
      break;
    }
    case "message_end": {
      const r = byId(recs, evt.messageId);
      if (r) delete r.streaming;
      break;
    }
    case "tool_start":
      if (!byId(recs, evt.toolId)) {
        const at = lastStreamingIndex(recs);
        recs.splice(at, 0, { id: evt.toolId, role: "tool", tool: evt.name, arg: evt.argsSummary || "", meta: "", out: "", at: Date.now(), running: true });
      }
      break;
    case "activity":
      if (evt.record?.role === "activity") {
        const existing = byId(recs, evt.record.id);
        if (existing && evt.record.kind === "agent") {
          const incomingRevision = Number(evt.record.revision) || 1;
          const currentRevision = Number(existing.revision) || 1;
          const terminal = new Set(["completed", "failed", "cancelled", "stopped", "aborted", "error"]);
          if (incomingRevision < currentRevision
            || (terminal.has(existing.status) && !terminal.has(evt.record.status))) break;
          if (incomingRevision === currentRevision && existing.status === evt.record.status && existing.summary === evt.record.summary) break;
          Object.assign(existing, evt.record);
        } else if (existing) Object.assign(existing, evt.record);
        else {
          const at = evt.record.kind === "agent" ? lastStreamingIndex(recs) : recs.length;
          recs.splice(at, 0, evt.record);
        }
        if (evt.record.key === "compaction") t.compacting = evt.record.status === "running";
      }
      break;
    case "tool_end": {
      const r = byId(recs, evt.toolId);
      if (r) {
        r.out = evt.output || "";
        r.meta = [evt.meta, evt.durationMs != null ? formatDuration(evt.durationMs) : ""].filter(Boolean).join(" · ");
        delete r.running;
      }
      break;
    }
    case "diff":
      if (!byId(recs, evt.toolId + ":d")) {
        const lines = [];
        for (const h of evt.hunks || []) {
          if (h.header) lines.push({ sign: "", text: h.header });
          for (const l of h.lines || []) lines.push(l);
        }
        const at = lastStreamingIndex(recs);
        recs.splice(at, 0, { id: evt.toolId + ":d", role: "diff", file: evt.path, add: "+" + evt.adds, del: "−" + evt.dels, lines });
      }
      break;
    case "bang_start":
      if (!byId(recs, evt.bangId)) recs.push({ id: evt.bangId, role: "bang", cmd: evt.cmd, meta: "…", out: "" });
      break;
    case "bang_end": {
      const r = byId(recs, evt.bangId);
      if (r) { r.out = evt.stdout || ""; r.meta = `exit ${evt.exit} · ${formatDuration(evt.durationMs)}`; }
      break;
    }
    case "turn_end": {
      t.streaming = false;
      delete store.state.queued[evt.sessionId];
      store.set(state => { const working = { ...(state.workingMessages || {}) }; delete working[evt.sessionId]; return { workingMessages: working }; });
      store.state.openActivity.todo = false;
      const lastAssistant = [...recs].reverse().find(record => record.role === "assistant");
      const hasAssistantText = !!lastAssistant?.text;
      if (evt.reason !== "stopped" || hasAssistantText) store.markUnread(evt.sessionId);
      if (evt.reason === "stopped") {
        const empty = [...recs].reverse().find(r => r.role === "assistant" && r.streaming && !r.text && !r.thinking);
        if (empty) recs.splice(recs.indexOf(empty), 1);
      }
      for (const r of recs) if (r.role === "assistant" && r.streaming) delete r.streaming;
      if (evt.reason === "errored" && evt.error) {
        const id = `error:${evt.turnId || evt.seq || evt.sessionId}`;
        if (!byId(recs, id)) recs.push({ id, role: "error", text: evt.error });
      }
      if (!replay && evt.sessionId === store.activeKey()) {
        openTranscript(evt.sessionId, { scrollToLatest: false });
      }
      break;
    }
    case "extension_error":
      store.setError(`Extension ${evt.extensionPath || "error"}: ${evt.error || "failed"}`);
      break;
    case "session_created":
    case "session_forked":
    case "session_meta":
    case "session_merged":
    case "git_merge":
    case "git_branch_deleted":
      refreshState().catch(err => store.setError(`Could not refresh state: ${err.message || err}`));
      break;
    case "session_closed": {
      const wasChat = store.state.chatId === evt.sessionId;
      const wasSession = store.state.sessionId === evt.sessionId;
      const selection = [store.state.chatId, store.state.sessionId, store.state.projectId];
      const fileReset = { files: [], fileError: null, filePath: null, fileView: null, fileTarget: "origin", fileTargets: ["origin", "primary"], fileLoading: false, filesLoading: false, filesLoadedKey: null };
      refreshState().then(() => {
        const s = store.state;
        if (s.chatId !== selection[0] || s.sessionId !== selection[1] || s.projectId !== selection[2]) return;
        if (wasChat) {
          store.set({ ...fileReset, chatId: null, filesOpen: false, model: s.effectiveDefaultModel || null, requestedModel: null, modelFallback: false, modelUnavailable: false });
          return;
        }
        if (!wasSession) return;
        const p = s.projects.find(x => x.id === s.projectId);
        if (p?.sessions[0]) {
          store.set({ ...fileReset, view: "chat", projectId: p.id, sessionId: p.sessions[0].id, chatId: null, model: p.sessions[0].model || s.effectiveDefaultModel || null, requestedModel: p.sessions[0].requestedModel || null, modelFallback: !!p.sessions[0].modelFallback, modelUnavailable: !!p.sessions[0].modelUnavailable });
          openTranscript(p.sessions[0].id);
        } else if (s.chats[0]) {
          const chat = s.chats[0];
          store.set({ ...fileReset, view: "chat", chatId: chat.id, sessionId: null, projectId: null, filesOpen: false, model: chat.model || s.effectiveDefaultModel || null, requestedModel: chat.requestedModel || null, modelFallback: !!chat.modelFallback, modelUnavailable: !!chat.modelUnavailable });
          openTranscript(chat.id);
        } else {
          store.set({ ...fileReset, sessionId: null, chatId: null, filesOpen: false, model: s.effectiveDefaultModel || null, requestedModel: null, modelFallback: false, modelUnavailable: false });
        }
      }).catch(err => store.setError(`Could not refresh state: ${err.message || err}`));
      break;
    }
    default: break;
  }
}

export function applyEvent(evt, replay = false) {
  if (applyUiEvent(evt)) return;
  const t = tOf(evt.sessionId);
  const seq = Number(evt.seq);
  if (Number.isFinite(seq)) {
    const lastSeq = Number.isFinite(Number(t.seq)) ? Number(t.seq) : -1;
    if (seq <= lastSeq) return;
    t.seq = seq;
  }
  applyTranscriptEvent(evt, t, replay);
  if (["turn_end", "bang_end"].includes(evt.type)
    && findSessionInState({ projects: store.state.projects, chats: [] }, evt.sessionId)) {
    refreshState().catch(err => store.setError(`Could not refresh workspace state: ${err.message || err}`));
  }
  if (evt.type === "text_delta") store.notify("delta:" + evt.sessionId);
  else if (evt.type === "thinking_delta") store.notify("thinking:" + evt.sessionId); // not chat-visible; only the steps view reads it
  else store.notify("transcript");
}

function updateFirstTitle(id, text) {
  const title = String(text || "").replace(/[*_`#>~]+/g, "").replace(/\s+/g, " ").trim().slice(0, 48);
  if (!title) return;
  for (const p of store.state.projects) {
    const node = findNode(p.sessions, id);
    if (node && node.title === "New session") {
      node.title = title;
      store.notify("state");
      return;
    }
  }
  const chat = store.state.chats.find(c => c.id === id);
  if (chat && chat.title === "New session") {
    chat.title = title;
    store.notify("state");
  }
}

function lastStreamingIndex(recs) {
  for (let i = recs.length - 1; i >= 0; i--) {
    if (recs[i].role === "assistant" && recs[i].streaming) return i;
  }
  return recs.length;
}
