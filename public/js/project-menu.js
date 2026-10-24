// The Project menu: everything about a project rather than one conversation —
// new and idle sessions, past sessions, conversations from other devices, its worker, removal.
// The Chats menu is its sibling for plain chats: new chat, past chats, and the chats worker.
import { api, refreshState, refreshWorkers } from "./api.js";
import { setHTML, store, toast } from "./store.js";
import { esc, newChat, newProjectSession, restoreConversation, selectChat, selectSession } from "./shell.js";
import { workerAction, workerCard } from "./workers.js";
import { gitErrorMessage, launchSetup } from "./panel-utils.js";

export function openProjectMenu(projectId) {
  store.set({ projectMenu: { projectId }, sessionPicker: null, drawerOpen: false });
}

export function openChatsMenu() {
  store.set({ projectMenu: { chats: true }, sessionPicker: null, drawerOpen: false });
}

// workspaced's worker for plain chats.
const CHATS_WORKER = "chats";

class PiProjectMenu extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.addEventListener("click", e => void this.onClick(e));
    this.render();
  }

  disconnectedCallback() { this.unsub?.(); }
  menu() { return store.state.projectMenu; }
  project() { return store.state.projects.find(project => project.id === this.menu()?.projectId) || null; }
  close() { store.set({ projectMenu: null }); }
  fail(message) { const menu = this.menu(); if (menu) { menu.error = message; this.render(); } }

  /** Conversations from other devices for this repository, listed once per opening. */
  loadSynced(menu) {
    if (menu.synced !== undefined) return;
    menu.synced = null;
    api.syncedSessions(menu.projectId)
      .then(result => { menu.synced = result.sessions || []; })
      .catch(() => { menu.synced = []; })
      .finally(() => { if (this.menu() === menu) this.render(); });
  }

  /** Loads a conversation preview once: a past session's transcript, or a shared one from the sync server. */
  loadPreview(menu, key) {
    const previews = menu.previews ||= {};
    if (previews[key]) return;
    previews[key] = { loading: true };
    const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const request = kind === "past" ? api.transcript(id) : api.syncedPreview(menu.projectId, id);
    request
      .then(result => { previews[key] = { records: (result.records || []).filter(record => ["user", "assistant"].includes(record.role) && record.text) }; })
      .catch(err => { previews[key] = { error: err.message || err.error || "The conversation could not be loaded." }; })
      .finally(() => { if (this.menu() === menu) this.render(); });
  }

  async run(label, work) {
    const menu = this.menu();
    if (!menu || menu.busy) return;
    menu.busy = label; menu.error = null; this.render();
    try { await work(); } catch (err) { this.fail(err.detail || gitErrorMessage(err)); } finally {
      if (this.menu() === menu) { menu.busy = null; this.render(); }
    }
  }

  async onClick(e) {
    if (this.menu()?.chats) return this.onChatsClick(e);
    const project = this.project();
    if (!project) return;
    if (e.target.matches(".session-picker-scrim") || e.target.closest("[data-act='close-project-menu']")) { this.close(); return; }
    const t = e.target.closest("[data-act]");
    const act = t?.dataset.act;
    if (act === "new-session") { this.close(); await newProjectSession(project.id); return; }
    if (act === "end-idle") {
      await this.run("Ending idle sessions…", async () => {
        const { ended } = await api.endIdle(project.id);
        toast(ended.length ? `Ended ${ended.length} idle session${ended.length === 1 ? "" : "s"}.` : "No idle sessions to end.");
        await refreshState();
      });
      return;
    }
    if (act === "toggle-preview") {
      const menu = this.menu();
      menu.preview = menu.preview === t.dataset.key ? null : t.dataset.key;
      if (menu.preview) this.loadPreview(menu, menu.preview);
      this.render();
      return;
    }
    if (act === "open-past") {
      // Opening a past session brings it back into the project's list.
      this.close();
      await restoreConversation(t.dataset.id);
      selectSession(project.id, t.dataset.id);
      return;
    }
    if (act === "open-synced") {
      await this.run("Opening conversation…", async () => {
        const primary = project.defaultBranch || project.primaryBranch || "main";
        const result = await api.newProjectSession(project.id, { mode: "synced", syncSessionId: t.dataset.syncId, branch: t.dataset.branch || primary, baseBranch: primary });
        this.close();
        store.state.openTree[project.id] = true;
        await refreshState().catch(() => undefined);
        selectSession(project.id, result.id);
        launchSetup(result.id, result);
      });
      return;
    }
    if (act === "remove-project") {
      this.close();
      store.set({ confirm: { type: "removeProject", id: project.id, projectId: project.id, name: project.name, workspace: project.workspace || null, purge: false, error: null } });
      return;
    }
    const worker = e.target.closest("[data-act$='-worker']");
    if (worker) {
      // Confirmations sit below this menu; close it so the dialog is visible.
      if (["restart-worker", "reset-worker"].includes(worker.dataset.act)) this.close();
      await workerAction(worker.dataset.act, worker.dataset.name, worker.dataset.pinned === "1", (message, kind) => kind === "error" ? this.fail(message) : toast(message));
    }
  }

  /** The last few messages of a previewed conversation, then its Open button. */
  previewBody(preview, openAttrs, busy) {
    const SHOWN = 12;
    let content;
    if (!preview || preview.loading) content = `<div class="convo-preview-note">Loading conversation…</div>`;
    else if (preview.error) content = `<div class="convo-preview-note">${esc(preview.error)}</div>`;
    else if (!preview.records.length) content = `<div class="convo-preview-note">No messages.</div>`;
    else {
      const hidden = preview.records.length - SHOWN;
      content = `${hidden > 0 ? `<div class="convo-preview-note">${hidden} earlier message${hidden === 1 ? "" : "s"}</div>` : ""}${preview.records.slice(-SHOWN).map(record => {
        const text = record.text.length > 600 ? `${record.text.slice(0, 600)}…` : record.text;
        return `<div class="convo-preview-msg ${record.role}"><span>${record.role === "user" ? "You" : "Pi"}</span><p>${esc(text)}</p></div>`;
      }).join("")}`;
    }
    return `<div class="convo-preview"><div class="convo-preview-scroll">${content}</div><div class="convo-preview-actions"><button class="btn btn-primary" ${openAttrs} ${busy ? "disabled" : ""}>Open</button></div></div>`;
  }

  async onChatsClick(e) {
    if (e.target.matches(".session-picker-scrim") || e.target.closest("[data-act='close-project-menu']")) { this.close(); return; }
    const t = e.target.closest("[data-act]");
    const act = t?.dataset.act;
    if (act === "new-chat") {
      this.close();
      await newChat().catch(err => store.setError(`Could not create chat: ${err.message || err}`));
      return;
    }
    if (act === "toggle-preview") {
      const menu = this.menu();
      menu.preview = menu.preview === t.dataset.key ? null : t.dataset.key;
      if (menu.preview) this.loadPreview(menu, menu.preview);
      this.render();
      return;
    }
    if (act === "open-past") {
      // Opening an ended chat brings it back into the list.
      this.close();
      await restoreConversation(t.dataset.id);
      selectChat(t.dataset.id);
      return;
    }
    const worker = e.target.closest("[data-act$='-worker']");
    if (worker) {
      if (["restart-worker", "reset-worker"].includes(worker.dataset.act)) this.close();
      await workerAction(worker.dataset.act, worker.dataset.name, worker.dataset.pinned === "1", (message, kind) => kind === "error" ? this.fail(message) : toast(message));
    }
  }

  /** The dialog frame, built once per opening so re-renders do not replay its entry animation. */
  frame(title, subtitle, body) {
    const head = `<div><div class="modal-title">${esc(title)}</div>${subtitle ? `<div class="session-picker-subtitle">${esc(subtitle)}</div>` : ""}</div><button class="ghost-btn" data-act="close-project-menu" aria-label="Close">×</button>`;
    if (!this.querySelector(".session-picker")) {
      this.innerHTML = `<div class="session-picker-scrim"><section class="session-picker" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="session-picker-head"></div><div class="session-picker-body"></div></section></div>`;
      this.__html = null;
    }
    const scroller = this.querySelector(".session-picker-body");
    const top = scroller.scrollTop;
    setHTML(this.querySelector(".session-picker-head"), head);
    setHTML(scroller, body);
    scroller.scrollTop = top;
  }

  listRow(menu, key, title, sub, openAttrs) {
    const open = menu.preview === key;
    const preview = open ? this.previewBody(menu.previews?.[key], openAttrs, !!menu.busy) : "";
    return `<div class="history-entry"><button type="button" class="history-entry-head" data-act="toggle-preview" data-key="${esc(key)}" aria-expanded="${open}"><span class="history-main"><strong>${esc(title)}</strong><small>${esc(sub)}</small></span><span class="history-status">${open ? "Hide" : "Preview"}</span></button>${preview}</div>`;
  }

  renderChats(menu) {
    const workers = store.state.workers;
    if (!menu.workersLoaded) { menu.workersLoaded = true; void refreshWorkers(); }
    const row = (title, hint, button) => `<div class="panel-row"><div class="panel-row-text"><strong>${esc(title)}</strong><small>${esc(hint)}</small></div>${button}</div>`;
    const actions = `<section class="session-picker-actions" aria-label="Chats"><div class="panel-rows">
      ${row("New chat", "A conversation without a repository.", `<button class="btn btn-secondary" data-act="new-chat">New</button>`)}
    </div></section>`;
    const past = store.state.endedChats || [];
    const pastSection = `<section class="session-history"><div class="session-context-heading session-history-heading"><span>Past chats</span><span>${past.length}</span></div>
      ${past.length
        ? `<div class="history-list">${past.map(item => this.listRow(menu, `past:${item.id}`, item.title, `Ended ${item.when}`, `data-act="open-past" data-id="${esc(item.id)}"`)).join("")}</div>`
        : `<div class="session-history-empty">Ended chats show up here, and opening one brings it back.</div>`}</section>`;
    // Without workspaced (mock mode) there is no workers list, and no chats worker to show.
    const worker = (workers?.workspaces || []).find(item => item.name === CHATS_WORKER);
    const workerSection = !workers && !store.state.workersError ? "" : `<section><div class="session-context-heading"><span>Worker</span></div>${worker
      ? workerCard(worker, workers.usageAvailable, { canDelete: false })
      : `<div class="session-history-empty">${esc(store.state.workersError || "The chats worker starts with the first chat.")}</div>`}</section>`;
    const error = menu.error ? `<div class="session-picker-error">${esc(menu.error)}</div>` : "";
    this.frame("Chats", "Conversations without a repository", `${error}${actions}${pastSection}${workerSection}`);
  }

  render() {
    const menu = this.menu();
    if (menu?.chats) { this.renderChats(menu); return; }
    const project = menu ? this.project() : null;
    if (!menu || !project) { setHTML(this, ""); return; }
    this.loadSynced(menu);
    if (project.workspace && !menu.workersLoaded) { menu.workersLoaded = true; void refreshWorkers(); }
    const busy = !!menu.busy;
    const primary = project.defaultBranch || project.primaryBranch || "main";
    const row = (title, hint, button) => `<div class="panel-row"><div class="panel-row-text"><strong>${esc(title)}</strong><small>${esc(hint)}</small></div>${button}</div>`;
    // Like History: a row expands to preview the conversation; Open sits under the preview.
    const listRow = (...args) => this.listRow(menu, ...args);

    const projectSection = `<section class="session-picker-actions" aria-label="Project">
      <div class="panel-rows">
        ${row("New session", `Starts a conversation on ${primary}.`, `<button class="btn btn-secondary" data-act="new-session" ${busy ? "disabled" : ""}>New</button>`)}
        ${row("End idle sessions", "Ends sessions with no activity for a day. Nothing running is touched.", `<button class="btn btn-secondary" data-act="end-idle" ${busy ? "disabled" : ""}>End idle</button>`)}
      </div></section>`;

    const past = project.ended || [];
    const pastSection = past.length ? `<section class="session-history"><div class="session-context-heading session-history-heading"><span>Past sessions</span><span>${past.length}</span></div>
      <div class="history-list">${past.map(item => listRow(`past:${item.id}`, item.title, `Ended ${item.when}`, `data-act="open-past" data-id="${esc(item.id)}"`)).join("")}</div></section>` : "";

    const synced = menu.synced || [];
    const syncedSection = synced.length ? `<section class="session-history"><div class="session-context-heading session-history-heading"><span>From other devices</span><span>${synced.length}</span></div>
      <div class="history-list">${synced.map(item => listRow(`synced:${item.sessionId}`, item.title || "Untitled conversation", `${item.branch || primary}${item.leaseHolder ? ` · running on ${item.leaseHolder}` : ""}`, `data-act="open-synced" data-sync-id="${esc(item.sessionId)}" data-branch="${esc(item.branch || "")}"`)).join("")}</div></section>` : "";

    const worker = project.workspace && (store.state.workers?.workspaces || []).find(item => item.name === project.workspace);
    const workerSection = !project.workspace ? "" : `<section><div class="session-context-heading"><span>Worker</span></div>${worker
      ? workerCard(worker, store.state.workers.usageAvailable, { canDelete: false })
      : `<div class="session-history-empty">${esc(store.state.workersError || "Loading worker…")}</div>`}</section>`;

    const removeHint = project.workspace
      ? "Deletes its worker; its sessions leave the list. The disk is kept unless you choose otherwise."
      : "Ends its sessions and removes it from the list. The checkout on disk is kept.";
    const dangerSection = `<section class="session-danger-row">${row("Remove project", removeHint, `<button class="btn btn-caution" data-act="remove-project" ${busy ? "disabled" : ""}>Remove…</button>`)}</section>`;

    const progress = busy ? `<div class="session-picker-progress" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>${esc(menu.busy)}</span></div>` : "";
    const error = menu.error ? `<div class="session-picker-error">${esc(menu.error)}</div>` : "";
    this.frame("Project", project.name, `${progress}${error}${projectSection}${pastSection}${syncedSection}${workerSection}${dangerSection}`);
  }
}

customElements.define("pi-project-menu", PiProjectMenu);
