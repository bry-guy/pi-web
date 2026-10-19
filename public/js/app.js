import { api, refreshState } from "./api.js";
import { setHTML, store, toastActions } from "./store.js";
import { esc, mobile } from "./shell.js";
import { closeFileView } from "./files.js";
import { installHints } from "./hints.js";


/* ---------------- app root ---------------- */
class PiApp extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="frame">
        <div class="preview-banner hidden" data-preview-banner role="status" aria-label="Preview environment"></div>
        <div class="shell">
        <pi-sidebar></pi-sidebar>
        <main class="col">
          <pi-header></pi-header>
          <div class="screen" data-screen="chat">
            <div class="scrollable"><div class="col-pad"><pi-thread></pi-thread></div></div>
            <pi-composer></pi-composer>
          </div>
          <div class="screen hidden" data-screen="file"><pi-file-view></pi-file-view></div>
          <div class="screen" data-screen="settings"><div class="scrollable"><pi-settings></pi-settings></div></div>
        </main>
        <pi-files></pi-files>
        <div class="drawer-scrim hidden"></div>
        <div class="connection-status hidden" data-connection-status></div>
        <div class="app-toasts" data-toasts aria-live="polite"></div>
        <div class="update-prompt hidden" data-update-prompt>
          <span>New pi update ready.</span><button class="update-btn" data-act="update">Reload</button>
        </div>
        <pi-repo-picker></pi-repo-picker>
        <pi-session-picker></pi-session-picker>
        <pi-project-menu></pi-project-menu>
        <pi-logs></pi-logs>
        <pi-confirm></pi-confirm>
        <pi-extension-ui></pi-extension-ui>
        <div class="reload-prompt hidden" data-reload-prompt>
          <div class="reload-card"><div class="screen-title">Reload required</div><div class="proj-sub" data-reload-message></div><button class="primary-btn" data-act="reload">Reload</button></div>
        </div>
      </div></div>`;
    this.scrim = this.querySelector(".drawer-scrim");
    this.scrim.addEventListener("click", () => store.set({ drawerOpen: false }));
    // Swipe left anywhere while the mobile drawer is open to close it.
    let swipe = null;
    this.addEventListener("touchstart", e => {
      const onDrawer = e.target.closest?.("aside.rail, .drawer-scrim") && !e.target.closest("input, textarea, select");
      swipe = mobile() && store.state.drawerOpen && onDrawer && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });
    this.addEventListener("touchcancel", () => { swipe = null; }, { passive: true });
    this.addEventListener("touchend", e => {
      const touch = e.changedTouches[0];
      if (swipe && touch && swipe.x - touch.clientX > 60 && Math.abs(touch.clientY - swipe.y) < 50) store.set({ drawerOpen: false });
      swipe = null;
    }, { passive: true });
    this.addEventListener("click", e => {
      if (e.target.closest("[data-act='reload']")) location.reload();
      const toastButton = e.target.closest("[data-act='toast-action']");
      if (toastButton) {
        const id = toastButton.dataset.toastId;
        const run = toastActions.get(id);
        toastActions.delete(id);
        store.set({ toasts: store.state.toasts.filter(item => item.id !== id) });
        void run?.();
      }
      if (e.target.closest("[data-act='update']")) {
        e.preventDefault();
        store.set({ updateAvailable: false });
        if (typeof window.__piApplyUpdate === "function") window.__piApplyUpdate();
        else location.reload();
      }
    });
    this.addEventListener("toggle-files", () => {
      const open = !store.state.filesOpen;
      const key = this.filesKey();
      const cached = key && store.state.filesLoadedKey === key;
      // Leave the #file/<path> entry too, so the address and Back match what is shown.
      closeFileView();
      store.set({ filesOpen: open, fileError: null, filePath: null, fileView: null, fileLoading: false, filesLoading: open && !cached });
      if (!open) return;
      this.ensureFiles(true);
    });
    this.unsub = store.subscribe(w => { if (w === "state") this.sync(); });
    this.onResize = () => this.sync();
    window.addEventListener("resize", this.onResize);
    this.gitRefreshTimer = setInterval(() => {
      // Do not update workspace state while a picker or confirmation is active.
      if (document.visibilityState === "visible" && store.inProject() && !store.state.sessionPicker && !store.state.confirm) {
        void refreshState().catch(() => {});
        if (store.state.filesOpen) void this.ensureFiles(true);
      }
    }, 3500);
    this.gitRefreshTimer.unref?.();
    this.sync();
  }
  disconnectedCallback() {
    this.unsub?.();
    clearInterval(this.gitRefreshTimer);
    window.removeEventListener("resize", this.onResize);
    document.body?.classList.remove("modal-open");
  }

  filesKey() {
    const p = store.project();
    if (!p || !store.inProject()) return null;
    const node = store.findSession(store.state.sessionId);
    return `${p.id}:${node?.contextId || node?.workspacePath || p.contexts?.[0]?.id || ""}:${store.state.fileTarget}`;
  }

  sameFileData(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  async ensureFiles(force = false) {
    if (!(store.inProject() && store.state.filesOpen)) return;
    const key = this.filesKey();
    if (!key) return;
    const keyChanged = !!this.activeFilesKey && this.activeFilesKey !== key;
    if (keyChanged) {
      store.state.filePath = null;
      store.state.fileView = null;
      store.state.fileLoading = false;
      store.state.filesLoading = false;
      store.notify("file");
    }
    this.activeFilesKey = key;
    if (this.loadingFilesKey === key) return;
    const initialLoad = store.state.filesLoadedKey !== key;
    if (!force && !initialLoad) return;
    this.loadingFilesKey = key;
    if (initialLoad) {
      store.state.files = [];
      store.state.filesLoadedKey = null;
      store.state.fileError = null;
      store.state.filesLoading = true;
      store.notify("files");
    }
    const node = store.findSession(store.state.sessionId);
    try {
      const result = await api.files(store.state.projectId, node?.contextId || store.project()?.contexts?.[0]?.id, store.state.fileTarget);
      if (this.filesKey() === key) {
        const nextFiles = Array.isArray(result.tree) ? result.tree : [];
        const nextTargets = Array.isArray(result.targets) ? result.targets : store.state.fileTargets;
        const nextTarget = result.target ?? store.state.fileTarget;
        const filesChanged = !this.sameFileData(store.state.files, nextFiles);
        const targetsChanged = !this.sameFileData(store.state.fileTargets, nextTargets);
        const targetChanged = store.state.fileTarget !== nextTarget;
        const changed = filesChanged
          || targetsChanged
          || targetChanged
          || store.state.filesLoadedKey !== key
          || store.state.filesLoading
          || store.state.fileError !== null;
        if (filesChanged) store.state.files = nextFiles;
        if (targetsChanged) store.state.fileTargets = nextTargets;
        if (targetChanged) store.state.fileTarget = nextTarget;
        store.state.filesLoadedKey = key;
        store.state.filesLoading = false;
        store.state.fileError = null;
        if (changed) store.notify("files");
      }
    } catch (err) {
      if (this.filesKey() === key) {
        const message = `Could not load files: ${err.error || err.message || err}`;
        const changed = store.state.filesLoading || store.state.fileError !== message;
        store.state.filesLoading = false;
        store.state.fileError = message;
        if (changed) store.notify("files");
      }
    } finally {
      if (this.loadingFilesKey === key) this.loadingFilesKey = null;
    }
  }

  sync() {
    const v = store.state.view;
    const modalOpen = !!(store.state.repoPickerOpen || store.state.sessionPicker || store.state.projectMenu || store.state.logsOpen || store.state.confirm || store.state.extensionUi);
    document.body?.classList.toggle("modal-open", modalOpen);
    const previewBanner = this.querySelector("[data-preview-banner]");
    const preview = store.state.uiConfig?.preview === true;
    if (previewBanner) {
      previewBanner.textContent = store.state.uiConfig?.label || "Preview UI · production data";
      previewBanner.classList.toggle("hidden", !preview);
    }
    const bar = this.querySelector("pi-header .bar");
    if (bar) this.style.setProperty("--header-height", `${bar.getBoundingClientRect().height}px`);
    // An open file covers the chat pane instead of replacing it, so the chat keeps its layout and scroll position.
    const screen = store.state.filePath && v === "chat" ? "file" : v;
    // Settings has the one header, so the chat header steps aside while it is open.
    this.querySelector("main.col").classList.toggle("settings-open", v === "settings");
    for (const el of this.querySelectorAll("[data-screen]")) {
      const name = el.dataset.screen;
      el.classList.toggle("hidden", name !== screen && !(screen === "file" && name === "chat"));
      el.classList.toggle("covered", screen === "file" && name === "chat");
    }
    this.querySelector(".shell").classList.toggle("file-open", screen === "file");
    setHTML(this.querySelector("[data-toasts]"), store.state.toasts.map(item => `<div class="app-toast ${esc(item.tone)}" role="status"><span>${esc(item.message)}</span>${item.actionLabel ? `<button class="app-toast-action" data-act="toast-action" data-toast-id="${esc(item.id)}">${esc(item.actionLabel)}</button>` : ""}</div>`).join(""));
    this.scrim.classList.toggle("hidden", !(mobile() && store.state.drawerOpen));
    const connection = this.querySelector("[data-connection-status]");
    const offline = store.state.offline;
    connection.textContent = offline ? "Offline — reconnecting when network returns…" : "Reconnecting to pi-ez-web…";
    connection.classList.toggle("hidden", (!offline && !store.state.reconnecting) || !!store.state.fatalError);
    const update = this.querySelector("[data-update-prompt]");
    update.classList.toggle("hidden", !store.state.updateAvailable || !!store.state.fatalError);
    const prompt = this.querySelector("[data-reload-prompt]");
    prompt.classList.toggle("hidden", !store.state.fatalError);
    if (store.state.fatalError) this.querySelector("[data-reload-message]").textContent = store.state.fatalError;
    if (store.state.filesOpen && store.inProject()) void this.ensureFiles();
  }
}

customElements.define("pi-app", PiApp);
installHints();
