// The Project menu: everything about a project rather than one conversation —
// new and idle sessions, past sessions, conversations from other devices, its worker, removal.
import { api, refreshState, refreshWorkers } from "./api.js";
import { setHTML, store, toast } from "./store.js";
import { esc, newProjectSession, restoreConversation, selectSession } from "./shell.js";
import { workerAction, workerCard } from "./workers.js";
import { gitErrorMessage, launchSetup } from "./panel-utils.js";

export function openProjectMenu(projectId) {
  store.set({ projectMenu: { projectId }, sessionPicker: null, drawerOpen: false });
}

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

  async run(label, work) {
    const menu = this.menu();
    if (!menu || menu.busy) return;
    menu.busy = label; menu.error = null; this.render();
    try { await work(); } catch (err) { this.fail(err.detail || gitErrorMessage(err)); } finally {
      if (this.menu() === menu) { menu.busy = null; this.render(); }
    }
  }

  async onClick(e) {
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

  render() {
    const menu = this.menu();
    const project = menu ? this.project() : null;
    if (!menu || !project) { setHTML(this, ""); return; }
    this.loadSynced(menu);
    if (project.workspace && !menu.workersLoaded) { menu.workersLoaded = true; void refreshWorkers(); }
    const busy = !!menu.busy;
    const primary = project.defaultBranch || project.primaryBranch || "main";
    const row = (title, hint, button) => `<div class="panel-row"><div class="panel-row-text"><strong>${esc(title)}</strong><small>${esc(hint)}</small></div>${button}</div>`;
    const listRow = (attrs, title, sub, action) => `<button type="button" class="session-history-row" ${attrs}><span class="session-history-main"><strong>${esc(title)}</strong><small>${esc(sub)}</small></span><span class="session-history-resume">${action}</span></button>`;

    const projectSection = `<section class="session-picker-actions" aria-label="Project">
      <div class="panel-rows">
        ${row("New session", `Starts a conversation on ${primary}.`, `<button class="btn btn-secondary" data-act="new-session" ${busy ? "disabled" : ""}>New</button>`)}
        ${row("End idle sessions", "Ends sessions with no activity for a day. Nothing running is touched.", `<button class="btn btn-secondary" data-act="end-idle" ${busy ? "disabled" : ""}>End idle</button>`)}
      </div></section>`;

    const past = project.ended || [];
    const pastSection = past.length ? `<section class="session-history"><div class="session-context-heading session-history-heading"><span>Past sessions</span><span>${past.length}</span></div>
      <div class="session-history-scroll">${past.map(item => listRow(`data-act="open-past" data-id="${esc(item.id)}"`, item.title, `Ended ${item.when}`, "Open")).join("")}</div></section>` : "";

    const synced = menu.synced || [];
    const syncedSection = synced.length ? `<section class="session-history"><div class="session-context-heading session-history-heading"><span>From other devices</span><span>${synced.length}</span></div>
      <div class="session-history-scroll">${synced.map(item => listRow(`data-act="open-synced" data-sync-id="${esc(item.sessionId)}" data-branch="${esc(item.branch || "")}"`, item.title || "Untitled conversation", `${item.branch || primary}${item.leaseHolder ? ` · running on ${item.leaseHolder}` : ""}`, "Open")).join("")}</div></section>` : "";

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
    const head = `<div><div class="modal-title">Project</div><div class="session-picker-subtitle">${esc(project.name)}</div></div><button class="ghost-btn" data-act="close-project-menu" aria-label="Close">×</button>`;
    // Built once per opening, so re-renders do not replay the entry animation.
    if (!this.querySelector(".session-picker")) {
      this.innerHTML = `<div class="session-picker-scrim"><section class="session-picker" role="dialog" aria-modal="true" aria-label="Project"><div class="session-picker-head"></div><div class="session-picker-body"></div></section></div>`;
      this.__html = null;
    }
    const scroller = this.querySelector(".session-picker-body");
    const top = scroller.scrollTop;
    setHTML(this.querySelector(".session-picker-head"), head);
    setHTML(scroller, `${progress}${error}${projectSection}${pastSection}${syncedSection}${workerSection}${dangerSection}`);
    scroller.scrollTop = top;
  }
}

customElements.define("pi-project-menu", PiProjectMenu);
