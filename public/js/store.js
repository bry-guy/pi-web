// One flat state object + subscribers, mirroring the design handoff's State
// section. Transcripts are cached per session and fed by SSE.
export const CONTRACT_VERSION = 1;

function* iterateSessions(nodes = []) {
  for (const node of nodes) {
    yield node;
    yield* iterateSessions(node.children || []);
  }
}

function timeValue(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareActivity(a, b, field = "updatedAt") {
  return (timeValue(b[field] || b.activityAt) - timeValue(a[field] || a.activityAt))
    || String(a.id || "").localeCompare(String(b.id || ""));
}

function sortSessionNodes(nodes, topLevel = true) {
  for (const node of nodes || []) sortSessionNodes(node.children || [], false);
  return (nodes || []).sort((a, b) => compareActivity(a, b, topLevel ? "activityAt" : "updatedAt"));
}

export const SHOW_HIDDEN_FILES_KEY = "pi-show-hidden-files";
// A per-browser view preference, like the theme; hidden files are shown unless turned off.
function showHiddenFilesFromStorage() {
  try { return globalThis.localStorage?.getItem(SHOW_HIDDEN_FILES_KEY) !== "false"; } catch { return true; }
}

const UNREAD_STORAGE_KEY = "pi-ez-web:unread";
function unreadFromStorage() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(UNREAD_STORAGE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([, unread]) => unread === true))
      : {};
  } catch {
    return {};
  }
}
function persistUnread(unread) {
  try { globalThis.localStorage?.setItem(UNREAD_STORAGE_KEY, JSON.stringify(unread)); } catch { /* storage is optional */ }
}

function findSessionPath(nodes, id, path = []) {
  for (const node of nodes || []) {
    const next = [...path, node];
    if (node.id === id) return next;
    const hit = findSessionPath(node.children, id, next);
    if (hit) return hit;
  }
  return null;
}

// Skip DOM writes when markup is unchanged: rewriting identical HTML still
// costs layout and replaces nodes mid-tap, which drops the tap's click.
// Callers pass the same esc()/renderMarkdown()-built markup they previously
// assigned directly; this helper adds no new untrusted input path.
export function setHTML(el, html) {
  if (el.__html === html) return false;
  el.innerHTML = html;
  el.__html = html;
  return true;
}

export const store = {
  state: {
    view: "chat",            // chat | settings
    projectId: null,
    sessionId: null,
    chatId: null,            // non-null => plain chat (no project workspace controls)
    railOpen: true,
    drawerOpen: false,
    openTree: {},
    openTools: {},
    openActivity: {},
    openDirs: {},
    confirm: null,          // merge | push | deleteBranch confirmation payload
    operation: null,         // most recent operation status
    operations: [],           // recent client-visible operations for Logs
    logsOpen: false,
    logs: [],
    logsFile: "logs/pi-ez-web.log",
    logsLoading: false,
    logsError: null,
    filesOpen: false,
    showHiddenFiles: showHiddenFilesFromStorage(), // file tree shows names starting with "."
    repoPickerOpen: false,
    repoPickerSource: null,
    sessionPicker: null,       // { projectId, mode: "new"|"switch"|"fork", sourceSessionId, branch, name }
    sessionPickerContextId: null,
    sessionPickerError: null,
    query: "",
    repoQuery: "",
    drafts: {},              // sessionId -> unsent composer text
    model: null,             // active session model reference
    requestedModel: null,    // unavailable historical model when using a fallback
    modelFallback: false,
    modelUnavailable: false,
    defaultModel: null,      // configured setting; null means Automatic
    defaultThinkingLevel: "medium",
    effectiveDefaultModel: null,
    defaultModelStatus: "automatic",
    modelError: null,
    models: [],              // registry-backed { id, provider, label }
    error: null,             // transient composer/action error
    commandNotice: null,     // last web-adapted Pi slash-command result
    toasts: [],              // short results of async actions, newest last
    extensionUi: null,
    extensionStatuses: {},
    fatalError: null,        // unrecoverable wire-contract error
    fileError: null,
    filePath: null,
    fileView: null,
    fileTarget: "origin",
    fileTargets: ["origin", "primary"],
    fileLoading: false,
    filesLoading: false,
    filesLoadedKey: null,
    // server data
    projects: [],
    chats: [],
    buildId: null,
    reconnecting: false,
    offline: globalThis.navigator?.onLine === false,
    updateAvailable: false,
    providers: [],
    piConfiguration: null,
    repositorySources: null,
    sync: null,
    uiConfig: null,
    settings: null,
    settingsCategory: null,  // Settings page; null = category list (mobile) or the default page (desktop)
    workers: null,           // workspaced inventory for the Settings → Workers page
    workersError: null,
    repos: [],
    reposRoot: null,     // configured directory scanned by /api/repos
    reposRootSource: "default", // default | config | environment
    files: [],
    queued: {},              // sessionId -> follow-up count (queue_update)
    unread: unreadFromStorage(), // sessionId -> completed reply not yet read
    transcripts: {},         // sessionId -> { records, streaming, seq }
  },
  listeners: new Set(),
  set(patch) {
    Object.assign(this.state, typeof patch === "function" ? patch(this.state) : patch);
    this.notify("state");
  },
  isReading(id) {
    return !!id && this.state.view === "chat" && this.activeKey() === id;
  },
  markRead(id) {
    if (!id || !this.state.unread[id]) return;
    delete this.state.unread[id];
    persistUnread(this.state.unread);
    this.notify("state");
  },
  markUnread(id) {
    if (!id || this.isReading(id) || this.state.unread[id]) return;
    this.state.unread[id] = true;
    persistUnread(this.state.unread);
    this.notify("state");
  },
  notify(what) {
    for (const fn of this.listeners) fn(what);
  },
  setError(message, ms = 5000) {
    const token = Symbol("error");
    this._errorToken = token;
    this.set({ error: message });
    if (ms > 0) setTimeout(() => {
      if (this._errorToken === token) this.set({ error: null });
    }, ms);
  },
  touchSession(id, at = Date.now()) {
    const stamp = new Date(at).toISOString();
    for (const project of this.state.projects) {
      const path = findSessionPath(project.sessions, id);
      if (!path) continue;
      const target = path.at(-1);
      target.updatedAt = stamp;
      target.when = "now";
      for (const node of path) node.activityAt = stamp;
      sortSessionNodes(project.sessions);
      this.notify("state");
      return;
    }
    const chat = this.state.chats.find(item => item.id === id);
    if (chat) {
      chat.updatedAt = stamp;
      chat.activityAt = stamp;
      chat.when = "now";
      this.state.chats.sort((a, b) => compareActivity(a, b));
      this.notify("state");
    }
  },
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  activeKey() {
    return this.state.chatId || this.state.sessionId;
  },
  draft(id = this.activeKey()) {
    if (!id) return "";
    const draft = this.state.drafts[id];
    return typeof draft === "string" ? draft : draft?.text || "";
  },
  draftData(id = this.activeKey()) {
    if (!id) return null;
    const draft = this.state.drafts[id];
    if (typeof draft === "string") return this.state.drafts[id] = { text: draft, attachments: [] };
    return draft || null;
  },
  ensureDraft(id) {
    return this.draftData(id) || (id ? (this.state.drafts[id] = { text: "", attachments: [] }) : null);
  },
  draftAttachments(id = this.activeKey()) {
    const attachments = this.draftData(id)?.attachments;
    return Array.isArray(attachments) ? attachments : [];
  },
  setDraft(value, id = this.activeKey()) {
    if (!id) return;
    const draft = this.ensureDraft(id);
    const text = value || "";
    if (text !== draft.text) draft.revision = (draft.revision || 0) + 1;
    draft.text = text;
    this.trimDraft(id);
    this.notify("draft");
  },
  setDraftAttachments(attachments, id = this.activeKey()) {
    if (!id) return;
    const draft = this.ensureDraft(id);
    const next = attachments || [];
    if (next !== draft.attachments) draft.revision = (draft.revision || 0) + 1;
    draft.attachments = next;
    this.trimDraft(id);
    this.notify("draft");
  },
  setDraftPendingAttachments(count, id = this.activeKey()) {
    if (!id) return;
    const draft = this.ensureDraft(id);
    if (count) draft.pendingAttachments = count;
    else delete draft.pendingAttachments;
    this.trimDraft(id);
    this.notify("draft");
  },
  setDraftSending(sending, id = this.activeKey()) {
    if (!id) return;
    const draft = this.ensureDraft(id);
    if (sending) draft.sending = true;
    else delete draft.sending;
    this.trimDraft(id);
    this.notify("draft");
  },
  hasDraft(id = this.activeKey()) {
    const draft = this.draftData(id);
    return !!(this.draft(id) || draft?.attachments?.length || draft?.pendingAttachments || draft?.sending);
  },
  trimDraft(id) {
    const draft = this.state.drafts[id];
    if (draft && !this.draft(id) && !draft.attachments?.length && !draft.pendingAttachments && !draft.sending) delete this.state.drafts[id];
  },
  clearDraft(id = this.activeKey()) {
    if (!id) return;
    delete this.state.drafts[id];
    this.notify("draft");
  },
  transcript(id = this.activeKey()) {
    return this.state.transcripts[id] || { records: [], streaming: false };
  },
  project() {
    return this.state.projects.find(p => p.id === this.state.projectId) || null;
  },
  findSession(id, nodes) {
    nodes = nodes || (this.project()?.sessions ?? []);
    for (const n of nodes) {
      if (n.id === id) return n;
      const r = this.findSession(id, n.children);
      if (r) return r;
    }
    return null;
  },
  findAnySession(id) {
    for (const project of this.state.projects) {
      const node = this.findSession(id, project.sessions);
      if (node) return node;
    }
    return this.state.chats.find(chat => chat.id === id) || null;
  },
  sessionsUsingWorkspace(workspacePath) {
    const sessions = [];
    for (const project of this.state.projects) {
      for (const node of iterateSessions(project.sessions)) {
        if (node.workspacePath === workspacePath) sessions.push(node);
      }
    }
    return sessions;
  },
  inProject() {
    return this.state.view === "chat" && !this.state.chatId && !!this.state.sessionId;
  },
};

// Short, non-blocking result of an async action; dismisses itself.
export function toast(message, tone = "info") {
  const id = Math.random().toString(36).slice(2);
  store.set({ toasts: [...store.state.toasts, { id, message, tone }].slice(-3) });
  setTimeout(() => store.set({ toasts: store.state.toasts.filter(item => item.id !== id) }), 3500);
}
