import { api, openTranscript, refreshState, transcriptLoading } from "./api.js";
import { activeOperations, beginOperation, completeOperation, operationForScope, operationHint } from "./operations.js";
import { setHTML, store, toast } from "./store.js";
import { launchSetup } from "./panel-utils.js";

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const mobile = () => matchMedia("(max-width: 760px)").matches;
// workspaced reports running | sleeping | starting; the UI says awake | asleep | starting.
export const workerStateLabel = state => ({ running: "awake", sleeping: "asleep", starting: "starting" })[state] || state || "awake";
const ACTIVE_SESSION_STORAGE_KEY = "pi-ez-web:active-session";
function saveActiveSession(value) {
  try { globalThis.localStorage?.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(value)); } catch { /* storage is optional */ }
}
function savedActiveSession() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(ACTIVE_SESSION_STORAGE_KEY) || "null");
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}
function cancelExtensionUiFor(nextSessionId) {
  const request = store.state.extensionUi;
  if (!request || request.sessionId === nextSessionId) return;
  void api.extensionUiCancel(request.sessionId, request.requestId).catch(() => {});
  store.set({ extensionUi: null });
}
export const icon = name => {
  const paths = {
    settings: '<path d="M9.7 1.5h.6l.7 1.9 1.5.9 2-.5.4.4.3.5-.9 1.8.1 1.7 1.5 1.4-.2.6-.2.5-2 .1-1.2 1.2-.1 2-.5.2-.6.2-1.4-1.5-1.7-.1-1.8.9-.5-.3-.4-.4.5-2-1-1.5-1.8-.7v-.6-.6l1.8-.7 1-1.5-.5-2 .5-.4.4-.3 1.8.9 1.7-.1 1.4-1.5Z"/><circle cx="10" cy="10" r="2.2"/>',
    chevronLeft: '<path d="m12.5 4-6 6 6 6"/>',
    copy: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/>',
    // Three stacked sheets: the copy glyph with one more sheet behind it, for "copy the whole turn".
    copyTurn: '<rect x="8" y="8" width="9" height="9" rx="1.5"/><path d="M14.25 8V6.75a1.5 1.5 0 0 0-1.5-1.5h-6a1.5 1.5 0 0 0-1.5 1.5v6a1.5 1.5 0 0 0 1.5 1.5H8"/><path d="M11.5 5.25V4A1.5 1.5 0 0 0 10 2.5H4A1.5 1.5 0 0 0 2.5 4v6A1.5 1.5 0 0 0 4 11.5h1.25"/>',
    check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
    // Distinct glyphs: the sidebar is a panel, the files column is a code symbol (</>).
    sidebar: '<rect x="3" y="4" width="14" height="12" rx="2.5"/><path d="M8 4v12"/>',
    code: '<path d="m6.5 6-4 4 4 4"/><path d="m13.5 6 4 4-4 4"/><path d="m11.4 4-2.8 12"/>',
    chevronRight: '<path d="m7.5 4 6 6-6 6"/>',
  };
  return `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">${paths[name] || ""}</svg>`;
};

export function openSessionPicker(projectId, { mode = "switch", sourceSessionId = null, branch = null, name = null } = {}) {
  const project = store.state.projects.find(p => p.id === projectId);
  if (!project) return;
  const source = sourceSessionId || (mode !== "new" ? store.state.sessionId : null);
  const active = source ? store.findSession(source, project.sessions) : null;
  const defaultBranch = project.defaultBranch || project.primaryBranch || "main";
  const unavailable = active && project.contexts?.some(context => context.id === active.contextId && context.kind === "unavailable");
  const currentBranch = unavailable ? null : active ? (active.branch || defaultBranch) : (project.branch || defaultBranch);
  store.set({
    sessionPicker: {
      projectId,
      mode: ["switch", "fork"].includes(mode) ? mode : "new",
      sourceSessionId: source,
      branch: branch || (mode === "new" ? defaultBranch : currentBranch),
      baseBranch: defaultBranch,
      name: name ?? (mode === "new" ? "" : active?.name || active?.title || ""),
      newBranch: "",
      newBranchAuto: false,
      branchMenuOpen: false,
      currentBranch,
    },
    sessionPickerError: null,
    drawerOpen: false,
  });
}

// Start a sleeping worker as soon as the user shows interest, so its ~3s
// startup overlaps with reading and typing instead of the first request.
function wakeEarly(project) {
  if (project?.workspace && project.workspaceState === "sleeping") void api.wakeWorkspace(project.workspace);
}

export function selectSession(projectId, sessionId, { showOperation = false } = {}) {
  cancelExtensionUiFor(sessionId);
  const project = store.state.projects.find(p => p.id === projectId);
  const node = findNode(project?.sessions, sessionId);
  wakeEarly(project);
  store.set({
    view: "chat", projectId, sessionId, chatId: null, drawerOpen: false, sessionPicker: null, sessionPickerError: null,
    filesOpen: store.state.filesOpen, files: [], fileError: null, filePath: null, fileView: null,
    fileTarget: "origin", fileTargets: ["origin", "primary"], fileLoading: false, filesLoading: false, filesLoadedKey: null,
    model: node?.model || store.state.effectiveDefaultModel || null,
    requestedModel: node?.requestedModel || null,
    modelFallback: !!node?.modelFallback,
    modelUnavailable: !!node?.modelUnavailable,
  });
  saveActiveSession({ kind: "session", projectId, id: sessionId });
  store.markRead(sessionId);
  const operation = showOperation && !transcriptLoading(sessionId)
    ? beginOperation("open-session", "Open session", "", "Request started.", sessionId, {
      projectId, contextId: node?.contextId, workspacePath: node?.workspacePath, action: "open-session",
    })
    : null;
  openTranscript(sessionId, { operation });
}
export function selectSessionById(sessionId, options = {}) {
  for (const project of store.state.projects) {
    if (findNode(project.sessions, sessionId)) {
      store.state.openTree[project.id] = true;
      selectSession(project.id, sessionId, options);
      return true;
    }
  }
  const chat = store.state.chats.find(item => item.id === sessionId);
  if (chat) {
    selectChat(sessionId);
    return true;
  }
  return false;
}

export function selectChat(chatId) {
  cancelExtensionUiFor(chatId);
  const chat = store.state.chats.find(c => c.id === chatId);
  store.set({
    view: "chat", chatId, sessionId: null, projectId: null, drawerOpen: false, sessionPicker: null, sessionPickerError: null,
    filesOpen: false, files: [], fileError: null, filePath: null, fileView: null,
    fileTarget: "origin", fileTargets: ["origin", "primary"], fileLoading: false, filesLoading: false, filesLoadedKey: null,
    model: chat?.model || store.state.effectiveDefaultModel || null,
    requestedModel: chat?.requestedModel || null,
    modelFallback: !!chat?.modelFallback,
    modelUnavailable: !!chat?.modelUnavailable,
  });
  saveActiveSession({ kind: "chat", id: chatId });
  store.markRead(chatId);
  openTranscript(chatId);
}

// On reload, open the saved conversation before /api/state returns so its
// transcript loads in parallel. main.js validates it once state arrives.
export function openSavedSelectionEarly() {
  const saved = savedActiveSession();
  if (!saved?.id || !["chat", "session"].includes(saved.kind)) return null;
  const isChat = saved.kind === "chat";
  store.set({ view: "chat", chatId: isChat ? saved.id : null, sessionId: isChat ? null : saved.id, projectId: isChat ? null : saved.projectId || null, model: null, requestedModel: null, modelFallback: false, modelUnavailable: false });
  openTranscript(saved.id);
  return saved.id;
}

export function restoreLastSelection() {
  const saved = savedActiveSession();
  if (!saved?.id) return false;
  if (saved.kind === "chat" && store.state.chats.some(chat => chat.id === saved.id)) {
    selectChat(saved.id);
    return true;
  }
  if (saved.kind === "session") {
    const project = store.state.projects.find(candidate => candidate.id === saved.projectId && findNode(candidate.sessions, saved.id));
    if (project) {
      store.state.openTree[project.id] = true;
      selectSession(project.id, saved.id);
      return true;
    }
  }
  return false;
}
export async function newChat() {
  const { id } = await api.newChat();
  // Select immediately: real `/api/state` discovery can be slow, and waiting
  // here leaves the previous chat active long enough for a prompt to land in
  // the wrong transcript.
  selectChat(id);
  await refreshState();
}

// A new project session opens at once on the main checkout; the server updates main in the background.
const creatingSession = new Set();
export async function newProjectSession(projectId) {
  const project = store.state.projects.find(p => p.id === projectId);
  if (!project || creatingSession.has(projectId)) return;
  creatingSession.add(projectId);
  wakeEarly(project);
  const branch = project.defaultBranch || project.primaryBranch || "main";
  const operation = beginOperation("create-session", "New session", "", "Request started.", null, { projectId, action: "create-session" });
  try {
    let result;
    // A sleeping worker answers "starting" until it is up (about a minute at most).
    for (let attempt = 0; ; attempt++) {
      try { result = await api.newProjectSession(projectId, { branch, pull: "background", operationId: operation.id }); break; }
      catch (error) {
        if (error?.error !== "workspace_starting" || attempt >= 20) throw error;
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    operation.sessionId = result.id;
    completeOperation(operation, result);
    if (!findNode(project.sessions, result.id)) {
      const now = new Date().toISOString();
      project.sessions.unshift({ id: result.id, title: "New session", contextId: result.contextId || null, branch: result.branch || branch, workspacePath: result.workspacePath || null, model: store.state.effectiveDefaultModel, when: "now", updatedAt: now, activityAt: now, streaming: false, children: [] });
    }
    store.state.openTree[projectId] = true;
    selectSession(projectId, result.id);
    launchSetup(result.id, result);
    void refreshState().catch(() => {});
  } catch (error) {
    completeOperation(operation, {}, error);
    store.setError(`Could not start a session: ${error.detail || error.message || error.error || error}`);
  } finally {
    creatingSession.delete(projectId);
  }
}

// Per conversation: one slow close (e.g. waking a worker) must not swallow clicks on other rows.
const closesInFlight = new Set();
const closeErrorMessage = error => ({
  session_streaming: "Stop the current response before ending this conversation.",
  workspace_starting: "This project's worker is starting. Try again in a few seconds.",
}[error?.error] || error?.detail || error?.message || error?.error || "Could not end this conversation.");

function removeNode(nodes, id) {
  const index = (nodes || []).findIndex(node => node.id === id);
  if (index >= 0) return !!nodes.splice(index, 1);
  return (nodes || []).some(node => removeNode(node.children, id));
}

// Ends a session or chat: stops its turn, withdraws it from sync, archives it.
export async function closeConversation(id, kind = "session") {
  if (!id || closesInFlight.has(id)) return;
  closesInFlight.add(id);
  const label = kind === "chat" ? "End chat" : "End session";
  const title = (kind === "chat" ? store.state.chats.find(chat => chat.id === id) : store.state.projects.map(p => findNode(p.sessions, id)).find(Boolean))?.title || (kind === "chat" ? "Chat" : "Session");
  const operation = beginOperation("close", label, "", "Request started.", id, { action: "close" });
  let result = null;
  try {
    result = await api.close(id, operation.id, kind);
    completeOperation(operation, result);
    // Drop the row now; a slow /api/state must not show it again until the next refresh agrees.
    const s = store.state;
    if (s.projects.some(project => removeNode(project.sessions, id)) || s.chats.some((chat, i) => chat.id === id && s.chats.splice(i, 1))) store.notify("state");
    toast(`Ended “${title}”.`, "info", { label: "Undo", run: () => restoreConversation(id) });
    // Its worktree is now unused, clean and merged: offer the usual Delete branch confirmation.
    const cleanup = result?.cleanup;
    if (cleanup) toast(`${cleanup.branch} is merged and no session uses it.`, "info", { label: "Delete branch…", run: () => store.set({ confirm: { type: "deleteBranch", projectId: cleanup.projectId, id: null, branch: cleanup.branch, primaryBranch: cleanup.primaryBranch, label: cleanup.branch, sessions: [], closeSessions: false, force: false, dirty: false, status: "clean", error: null } }) });
    void refreshState().catch(err => store.setError(`Could not refresh state after close: ${err.message || err}`));
  } catch (error) {
    const displayError = Object.assign(new Error(closeErrorMessage(error)), error);
    completeOperation(operation, result || {}, displayError);
    store.setError(displayError.message);
  } finally {
    closesInFlight.delete(id);
  }
}

// Undoes an end. A pi-sync detach is not undone: the conversation is no longer shared.
export async function restoreConversation(id) {
  try {
    await api.restore(id);
    await refreshState();
  } catch (error) {
    store.setError(`Could not restore: ${error.detail || error.message || error.error || error}`);
  }
}

function findNode(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}
function fuzzyMatch(value, query) {
  if (!query) return true;
  let i = 0;
  const text = String(value || "").toLowerCase();
  for (const char of query.toLowerCase()) {
    i = text.indexOf(char, i);
    if (i < 0) return false;
    i++;
  }
  return true;
}
function nodeMatches(n, q) {
  if (!q) return true;
  return fuzzyMatch(n.title, q) || (n.children || []).some(child => nodeMatches(child, q));
}

/* ---------------- sidebar ---------------- */
class PiSidebar extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state" || w === "transcript") this.render(); });
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("keydown", e => this.onKeyDown(e));
    this.addEventListener("input", e => {
      if (e.target.matches(".rail-search")) {
        store.state.query = e.target.value;
        this.renderResults();
      }
    });
    this.render();
  }
  disconnectedCallback() { this.unsub?.(); }

  onKeyDown(e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    const target = e.target.closest("[data-act]");
    if (!target || target.matches("button,input")) return;
    e.preventDefault();
    target.click();
  }

  onClick(e) {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "restore-session") {
      e.stopPropagation();
      void restoreConversation(t.dataset.id);
      return;
    }
    if (act === "toggle-ended") {
      e.stopPropagation();
      store.state.openEnded = { ...store.state.openEnded, [t.dataset.id]: !store.state.openEnded?.[t.dataset.id] };
      store.notify("state");
      return;
    }
    if (act === "close-row") {
      e.stopPropagation();
      void closeConversation(t.dataset.id, t.dataset.kind);
      return;
    }
    if (act === "collapse") {
      e.preventDefault();
      e.stopPropagation();
      store.set(mobile() ? { drawerOpen: false } : { railOpen: !store.state.railOpen });
    }
    else if (act === "search") {
      e.preventDefault();
      e.stopPropagation();
      store.set({ railOpen: true });
      requestAnimationFrame(() => this.querySelector(".rail-search")?.focus());
    }
    else if (act === "new-chat") newChat().catch(err => store.setError(`Could not create chat: ${err.message || err}`));
    else if (act === "repo-picker") store.set({ repoPickerOpen: true, drawerOpen: false });
    else if (act === "settings") store.set({ view: "settings", drawerOpen: false });
    else if (act === "toggle-tree") {
      e.stopPropagation();
      const id = t.dataset.treeId;
      if (!id) return;
      store.state.openTree[id] = !store.state.openTree[id];
      if (store.state.openTree[id]) wakeEarly(store.state.projects.find(p => p.id === id));
      store.notify("state");
    } else if (act === "restart-ws") {
      e.stopPropagation();
      api.restartWorkspace(t.dataset.ws)
        .then(() => refreshState())
        .catch(err => store.setError(`Restart failed: ${err.error || err.message || err}`));
    } else if (act === "toggle-pin") {
      e.stopPropagation();
      api.pinWorkspace(t.dataset.ws, t.dataset.pinned !== "1")
        .then(() => refreshState())
        .catch(err => store.setError(`Keep-awake failed: ${err.error || err.message || err}`));
    } else if (act === "project-row") newProjectSession(t.dataset.id);
    else if (act === "session-row") {
      selectSession(t.dataset.pid, t.dataset.id, { showOperation: true });
    } else if (act === "chat-row") selectChat(t.dataset.id);
  }

  count(nodes) { return nodes.reduce((n, x) => n + 1 + this.count(x.children), 0); }

  // Project workers sleep when idle and wake on use; pinning keeps one awake
  // (e.g. a dev server you want left running).
  workspaceToggle(p) {
    const problem = p.workspaceProblem;
    if (problem?.fatal || p.workspaceState === "failed") {
      const why = problem?.message || "The worker is not running.";
      return `<button class="row-ws failed" data-act="restart-ws" data-ws="${esc(p.workspace)}" title="${esc(`${why} Click to restart it.`)}" aria-label="${esc(`${p.name}: failed. ${why} Restart`)}">restart</button>`;
    }
    const label = workerStateLabel(p.workspaceState);
    const title = `${problem ? `${problem.message} ` : ""}Grant: ${p.workspaceGrant || "default"}. ${p.workspacePinned ? "Kept awake. Click to let it sleep when idle." : "Sleeps when idle and wakes on use. Click to keep awake."}`;
    return `<button class="row-ws ${label}${problem ? " warn" : ""}" data-act="toggle-pin" data-ws="${esc(p.workspace)}" data-pinned="${p.workspacePinned ? 1 : 0}" title="${esc(title)}" aria-label="${esc(`${p.name}: ${label}${p.workspacePinned ? ", kept awake" : ""}. ${title}`)}">${label}${p.workspacePinned ? `<i class="row-ws-keep" aria-hidden="true"></i>` : ""}</button>`;
  }

  sessionRows(p, nodes, depth, q, out, forceAll = false) {
    for (const n of nodes) {
      const direct = !q || fuzzyMatch(n.title, q);
      const descendant = q && (n.children || []).some(child => nodeMatches(child, q));
      if (q && !forceAll && !direct && !descendant) continue;
      const kids = n.children.length > 0;
      const open = !!store.state.openTree[n.id];
      const sel = store.state.sessionId === n.id && !store.state.chatId && store.state.view === "chat";
      const streaming = store.transcript(n.id).streaming;
      const unread = !!store.state.unread[n.id];
      out.push(`<div class="row-wrap nested" style="margin-left:${20 + depth * 14}px">
        <div class="row ${sel ? "active " : ""}${streaming ? "streaming " : ""}${unread ? "unread" : ""}" role="button" tabindex="0" ${kids ? `aria-expanded="${open || !!q}"` : ""} data-act="session-row" data-id="${esc(n.id)}" data-pid="${esc(p.id)}" data-kids="${kids ? 1 : 0}">
          <span class="caret" ${kids ? `data-act="toggle-tree" data-tree-id="${esc(n.id)}" role="button" tabindex="0" aria-label="${open ? "Collapse" : "Expand"} ${esc(n.title)}"` : ""}>${kids ? ((open || q) ? "▾" : "▸") : "·"}</span>
          <span class="lbl">${esc(n.title)}</span>
          <span class="live-dot" aria-label="${unread ? "Unread reply" : "Streaming"}"></span>
          <button class="row-close" data-act="close-row" data-kind="session" data-pid="${esc(p.id)}" data-id="${esc(n.id)}"
            data-label="${esc(n.title)}" data-branch="${esc(n.branch || "")}" title="End session" aria-label="End session ${esc(n.title)}">×</button>
        </div></div>`);
      if (kids && (open || q || forceAll)) this.sessionRows(p, n.children, depth + 1, forceAll ? "" : q, out, forceAll);
    }
  }

  // Ended sessions, collapsed under the project's live ones, each with Restore.
  endedRows(p, out) {
    const open = !!store.state.openEnded?.[p.id];
    out.push(`<div class="row-wrap nested" style="margin-left:20px">
      <div class="row ended-toggle" role="button" tabindex="0" aria-expanded="${open}" data-act="toggle-ended" data-id="${esc(p.id)}">
        <span class="caret">${open ? "▾" : "▸"}</span><span class="lbl">Ended</span><span class="count">${p.ended.length}</span>
      </div></div>`);
    if (!open) return;
    for (const n of p.ended) {
      out.push(`<div class="row-wrap nested" style="margin-left:34px">
        <div class="row ended-row" title="Ended ${esc(n.when)}">
          <span class="caret">·</span><span class="lbl">${esc(n.title)}</span>
          <button class="row-restore" data-act="restore-session" data-id="${esc(n.id)}" aria-label="Restore ${esc(n.title)}">Restore</button>
        </div></div>`);
    }
  }

  render() {
    const s = store.state;
    const isMobile = mobile();
    const expanded = isMobile ? s.drawerOpen : s.railOpen;
    const layout = !expanded && !isMobile ? "mini" : !expanded ? "empty" : "rail";
    if (this.dataset.layout !== layout) {
      this.dataset.layout = layout;
      if (layout === "mini") {
        setHTML(this, `<aside class="mini">
          <button class="mini-logo" data-act="collapse" title="Expand sidebar">π</button>
          <div class="mini-gap"></div>
          <button class="mini-btn cta-plus" data-act="new-chat" title="New chat">+</button>
          <button class="mini-btn quiet" data-act="search" title="Search sessions" aria-label="Search sessions">⌕</button>
          <div class="mini-flex"></div>
          <button class="mini-btn quiet" data-act="settings" title="Settings">${icon("settings")}</button>
        </aside>`);
        return;
      }
      if (layout === "empty") { setHTML(this, ""); return; }
      setHTML(this, `<aside class="rail">
        <div class="rail-head">
          <button class="rail-logo" data-act="collapse" title="Collapse sidebar">π</button><div class="rail-word">pi</div>
        </div>
        <div class="rail-actions">
          <input class="rail-search" placeholder="Filter chats and sessions" aria-label="Filter chats and sessions">
        </div>
        <div class="rail-scroll">
          <div class="sec-head"><div class="sec-label">Projects</div>
            <button class="ghost-btn cta-plus" data-act="repo-picker" title="New project" style="padding:3px 6px">+</button></div>
          <div class="projects-list"></div>
          <div class="sec-head chats-head"><div class="sec-label">Chats</div>
            <button class="ghost-btn cta-plus" data-act="new-chat" title="New chat" style="padding:3px 6px">+</button></div>
          <div class="chats-list"></div>
        </div>
        <button class="rail-foot" data-act="settings" title="Settings" aria-label="Settings">
          <span class="avatar" aria-hidden="true">π</span><span class="rail-user">pi-web</span>
          <span class="rail-foot-icon" aria-hidden="true">${icon("settings")}</span>
        </button>
      </aside>`);
    }
    if (layout === "rail") {
      const inp = this.querySelector(".rail-search");
      if (inp && inp.value !== s.query && document.activeElement !== inp) inp.value = s.query;
      this.renderResults();
    }
  }

  renderResults() {
    if (this.dataset.layout !== "rail") return;
    const s = store.state;
    const q = s.query.trim().toLowerCase();
    const projRows = [];
    for (const p of s.projects) {
      const nameMatch = !q || fuzzyMatch(p.name, q);
      if (q && !nameMatch && !p.sessions.some(n => nodeMatches(n, q))) continue;
      const open = !!s.openTree[p.id] || !!q;
      const active = s.view === "chat" && s.projectId === p.id && !s.chatId;
      projRows.push(`<div class="row-wrap" style="margin-top:1px">
        <div class="row mono ${active && !open ? "active" : ""}" role="button" tabindex="0" aria-expanded="${open}" data-act="project-row" data-id="${esc(p.id)}">
          <span class="caret" data-act="toggle-tree" data-tree-id="${esc(p.id)}" role="button" tabindex="0" aria-label="${open ? "Collapse" : "Expand"} ${esc(p.name)}">${open ? "▾" : "▸"}</span>
          <span class="lbl">${esc(p.name)}</span>
          ${p.workspace ? this.workspaceToggle(p) : ""}<span class="count">${this.count(p.sessions)}</span>
        </div></div>`);
      if (open) this.sessionRows(p, p.sessions, 0, nameMatch ? "" : q, projRows, !!q && nameMatch);
      if (open && !q && p.ended?.length) this.endedRows(p, projRows);
    }
    const chatRows = s.chats
      .filter(cRow => !q || fuzzyMatch(cRow.title, q))
      .map(cRow => {
        const streaming = cRow.streaming || store.transcript(cRow.id).streaming;
        const unread = !!s.unread[cRow.id];
        return `<div class="row ${s.chatId === cRow.id ? "active " : ""}${streaming ? "streaming " : ""}${unread ? "unread " : ""}" role="button" tabindex="0" data-act="chat-row" data-id="${esc(cRow.id)}">
        <span class="lbl">${esc(cRow.title)}</span><span class="live-dot" aria-label="${unread ? "Unread reply" : "Streaming"}"></span><span class="when">${esc(cRow.when)}</span>
        <button class="row-close" data-act="close-row" data-kind="chat" data-id="${esc(cRow.id)}"
          data-label="${esc(cRow.title)}" data-branch="" title="End chat" aria-label="End chat ${esc(cRow.title)}">×</button>
      </div>`;
      }).join("");
    setHTML(this.querySelector(".projects-list"), projRows.join(""));
    setHTML(this.querySelector(".chats-list"), chatRows);
  }
}

/* ---------------- header ---------------- */
class PiHeader extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state" || w === "transcript") this.render(); });
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && !e.target.matches("button,input,select")) {
        const t = e.target.closest("[data-act]");
        if (t) { e.preventDefault(); t.click(); }
      }
    });
    this.render();
  }
  disconnectedCallback() {
    this.unsub?.();
  }

  async onClick(e) {
    // The whole header row opens the session panel. A tap with no button under it
    // counts too: the header may have re-rendered between press and release, which
    // leaves the click on <pi-header> itself rather than inside the header.
    const t = e.target.closest("[data-act]");
    const act = t ? t.dataset.act : store.inProject() && store.project() ? "session-panel" : null;
    if (!act) return;
    if (act === "sidebar-toggle") {
      e.preventDefault();
      e.stopPropagation();
      store.set(mobile()
        ? { drawerOpen: !store.state.drawerOpen }
        : { railOpen: !store.state.railOpen });
    } else if (act === "settings") {
      store.set({ view: "settings" });
    } else if (act === "workspace-settings" || act === "session-panel") {
      const p = store.project();
      if (p) openSessionPicker(p.id, { mode: "switch", sourceSessionId: store.state.sessionId });
      void refreshState().catch(() => {});
    } else if (act === "sync-detail") {
      store.set({ commandNotice: { sessionId: store.activeKey(), title: "Sync", message: t.dataset.detail } });
    } else if (act === "files") {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent("toggle-files", { bubbles: true }));
    }
  }

  sessionContext() {
    const p = store.project();
    const node = store.findSession(store.state.sessionId);
    if (!p) return null;
    return p.contexts?.find(context => context.id === node?.contextId)
      || p.contexts?.find(context => context.path === node?.workspacePath)
      || p.contexts?.find(context => context.kind === "checkout")
      || p.contexts?.[0]
      || null;
  }

  sessionBranch() {
    return this.sessionContext()?.branch || null;
  }

  contextLabel(context) {
    if (context?.kind === "unavailable") return "Unavailable context";
    return context?.branch || "detached HEAD";
  }

  render() {
    const s = store.state;
    const p = store.project();
    const inProject = store.inProject() && p;
    const chat = s.chats.find(x => x.id === s.chatId);
    const node = inProject ? store.findSession(s.sessionId) : null;
    const title = s.view === "settings" ? "Settings"
      : chat ? chat.title : node ? node.title : (s.chatId ? "New chat" : (p ? p.name : "Chat"));
    const activeSession = node || chat;
    const syncInfo = syncSummary(activeSession?.id && store.state.extensionStatuses[activeSession.id]?.["pi-sync"]);
    const syncLine = syncInfo ? `<button class="sync-label ${syncInfo.tone}" data-act="sync-detail" data-detail="${esc(syncInfo.full)}" title="${esc(syncInfo.full)}" aria-label="${esc(syncInfo.full)}">${esc(`${syncInfo.state}: ${syncInfo.message}`)}</button>` : "";
    const workspace = inProject ? this.sessionContext() : null;
    const branch = workspace ? this.contextLabel(workspace) : null;
    const commit = workspace?.head ? String(workspace.head) : "";
    const commitLabel = commit
      ? `<span class="workspace-divider">·</span><span class="workspace-commit" title="Current commit ${esc(commit)}">${esc(commit.slice(0, 8))}</span>`
      : "";
    const workspaceTrigger = inProject && workspace ? `
        <button class="workspace-trigger" data-act="workspace-settings" title="Show Git context" aria-label="Show Git context for ${esc(p.name)} ${esc(branch)}">
          <span class="workspace-branch">${esc(branch)}</span>${commitLabel}<span class="workspace-divider">·</span><span class="workspace-state">${esc(gitStatusText(workspace))}</span>
        </button>` : "";
    // Git and sync share one line; sync is the only label for sync state.
    const subArea = workspaceTrigger || syncLine ? `<div class="bar-sub">${workspaceTrigger}${syncLine}</div>` : "";
    const operationScope = {
      sessionId: s.sessionId || s.chatId, projectId: s.projectId,
      contextId: node?.contextId, workspacePath: node?.workspacePath,
    };
    const latestOperation = s.view === "chat" && !s.sessionPicker
      ? operationForScope(null, operationScope)
      : null;
    const operation = s.view === "chat" && !s.sessionPicker
      ? activeOperations(operationScope)[0] || (latestOperation?.status === "error" ? latestOperation : null)
      : null;
    const operationStatus = operation?.status === "error" ? "error" : "running";
    const operationArea = operation ? `
      <div class="bar-operation-hint ${operationStatus}" role="status" aria-live="polite">
        <i class="${operation.status === "running" ? "operation-dot" : "operation-state-dot"}" aria-hidden="true"></i>
        <span>${esc(operationHint(operation))}</span>
      </div>` : "";
    const filesBtn = inProject ? `
      <button class="ghost-btn" data-act="files" title="${s.filesOpen ? "Collapse file tree" : "Expand file tree"}"
        aria-pressed="${!!s.filesOpen}" aria-label="${s.filesOpen ? "Collapse file tree" : "Expand file tree"}"
        style="${s.filesOpen ? "color:var(--text)" : ""}">${icon("code")}</button>` : "";
    const sidebarOpen = mobile() ? s.drawerOpen : s.railOpen;
    const sidebarControl = mobile()
      ? `<svg width="17" height="15" viewBox="0 0 17 15" aria-hidden="true"><rect width="17" height="1.8" y="0" fill="currentColor"/><rect width="17" height="1.8" y="6.6" fill="currentColor"/><rect width="17" height="1.8" y="13.2" fill="currentColor"/></svg>`
      : icon("sidebar");
    // The whole header of a conversation opens its session panel; its buttons keep their own actions.
    const panelAct = inProject ? ` data-act="session-panel"` : "";
    setHTML(this, `<header class="bar${panelAct ? " bar-session" : ""}"${panelAct}>
      <button class="hamburger" data-act="sidebar-toggle" title="${sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}" aria-expanded="${sidebarOpen}">${sidebarControl}</button>
      <div class="bar-main"><div class="bar-title">${esc(title)}</div>${subArea}${operationArea}</div>
      ${filesBtn}
    </header>`);
  }

}

// The header's sync label comes from the pi-sync extension's status text ("sync: up to date").
export function syncSummary(extensionText = "") {
  const detail = String(extensionText || "").replace(/^sync:\s*/, "");
  if (!detail) return null;
  const tone = /in use/.test(detail) ? "busy" : /offline|missing|taken over|failed|error|unavailable/.test(detail) ? "error" : "";
  return { tone, state: "Sync", message: detail, full: detail };
}

// Plain-words Git state shared by the header and the Files panel.
export function gitStatusText(status) {
  const cleanliness = status.status === "unavailable" ? "unavailable" : status.status === "unknown" || status.dirty == null ? "unknown" : status.dirty ? "dirty" : "clean";
  return [cleanliness, status.ahead ? `↑${status.ahead}` : "", status.behind ? `↓${status.behind}` : ""].filter(Boolean).join(" · ");
}

customElements.define("pi-sidebar", PiSidebar);
customElements.define("pi-header", PiHeader);
