import { api, refreshState, refreshWorkers } from "./api.js";
import { beginOperation, completeOperation } from "./operations.js";
import { SHOW_HIDDEN_FILES_KEY, setHTML, store } from "./store.js";
import { esc, icon } from "./shell.js";
import { operationFeedback, workerErrorMessage } from "./panel-utils.js";
import { workerAction as runWorkerAction, workerCard } from "./workers.js";


/* ---------------- settings ---------------- */
const CATEGORIES = [
  ["providers", "Providers"],
  ["pi", "Pi"],
  ["workers", "Workers"],
  ["sync", "Sync"],
  ["repositories", "Repositories"],
  ["defaults", "Defaults"],
  ["appearance", "Appearance"],
  ["diagnostics", "Diagnostics"],
];
const CATEGORY_IDS = new Set(CATEGORIES.map(([id]) => id));
const DEFAULT_CATEGORY = "providers";
const WORKERS_POLL_MS = 5_000;

// #settings is the category list; #settings/<category> is one page.
export function settingsRoute(hash) {
  const match = /^#settings(?:\/([a-z]+))?$/.exec(hash);
  return match ? { view: "settings", settingsCategory: CATEGORY_IDS.has(match[1]) ? match[1] : null } : null;
}
const settingsHash = (open, category) => !open ? "" : category ? `#settings/${category}` : "#settings";

class PiSettings extends HTMLElement {
  connectedCallback() {
    this.feedback = null;
    this.drafts = new Map();
    this.detailsOpen = new Map();
    this.workerResults = null;
    this.resettingInteraction = true;
    this.settingsOpen = store.state.view === "settings";
    this.onDocumentKeydown = e => {
      if (e.key === "Escape" && store.state.view === "settings"
        && !store.state.logsOpen && !store.state.repoPickerOpen && !store.state.sessionPicker && !store.state.projectMenu
        && !store.state.confirm && !store.state.extensionUi) {
        e.preventDefault();
        store.set({ view: "chat", settingsCategory: null });
      }
    };
    document.addEventListener("keydown", this.onDocumentKeydown);
    this.onPopState = () => {
      const route = settingsRoute(location.hash);
      if (route) store.set(route);
      else if (store.state.view === "settings") store.set({ view: "chat", settingsCategory: null });
    };
    window.addEventListener("popstate", this.onPopState);
    this.onVisibility = () => this.syncWorkers();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.unsub = store.subscribe(w => {
      if (w !== "state") return;
      const settingsOpen = store.state.view === "settings";
      if (settingsOpen !== this.settingsOpen) {
        this.resetDrafts();
        this.resettingInteraction = true;
        this.__html = null;
      }
      this.syncHash(this.settingsOpen, settingsOpen);
      this.settingsOpen = settingsOpen;
      this.render();
    });
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("input", e => this.trackDraft(e.target));
    this.addEventListener("change", e => {
      this.trackDraft(e.target);
      if (e.target.matches("[data-setting='defaultThinkingLevel']")) void this.saveDefaultThinking(e.target.value);
    });
    this.addEventListener("keydown", e => {
      if (e.key === "Enter" && e.target.matches(".repos-root-input")) {
        e.preventDefault();
        this.saveReposRoot();
      }
    });
    this.render();
  }
  disconnectedCallback() {
    this.resetDrafts();
    this.resettingInteraction = true;
    this.settingsOpen = false;
    this.__html = null;
    this.unsub?.();
    document.removeEventListener("keydown", this.onDocumentKeydown);
    window.removeEventListener("popstate", this.onPopState);
    document.removeEventListener("visibilitychange", this.onVisibility);
    clearTimeout(this.flowTimer);
    clearTimeout(this.feedbackTimer);
    clearInterval(this.workersTimer);
    this.workersTimer = null;
  }
  // Opening pushes a history entry, moving between pages replaces it, and closing
  // goes back over it, so Back leaves Settings in one step.
  syncHash(wasOpen, open) {
    if (!wasOpen && !open) return;
    const hash = settingsHash(open, store.state.settingsCategory);
    if (location.hash === hash) return;
    const url = `${location.pathname}${location.search}${hash}`;
    if (open && !wasOpen) history.pushState({ piSettings: true }, "", url);
    else if (open) history.replaceState(history.state, "", url);
    else if (history.state?.piSettings) history.back();
    else history.replaceState(null, "", url);
  }
  // Workers refresh while their page is visible and stop when it is hidden or left.
  syncWorkers() {
    const active = store.state.view === "settings" && store.state.settingsCategory === "workers" && document.visibilityState === "visible";
    if (active && !this.workersTimer) {
      void refreshWorkers();
      this.workersTimer = setInterval(() => void refreshWorkers(), WORKERS_POLL_MS);
    } else if (!active && this.workersTimer) {
      clearInterval(this.workersTimer);
      this.workersTimer = null;
    }
  }
  resetDrafts() {
    this.drafts = new Map();
    this.detailsOpen = new Map();
    this.workerResults = null;
  }
  settingKey(control) {
    if (control?.matches?.(".repos-root-input")) return "reposRoot";
    if (control?.matches?.("[data-setting]") && !control.matches("[data-auth-input]")) return control.dataset.setting;
    return null;
  }
  settingControl(key) {
    return [...this.querySelectorAll("[data-setting], .repos-root-input")].find(control => this.settingKey(control) === key);
  }
  settingValue(control) {
    return control.type === "checkbox" ? control.checked : control.value;
  }
  trackDraft(control) {
    const key = this.settingKey(control);
    if (key && !control.disabled) this.drafts.set(key, this.settingValue(control));
  }
  captureDrafts() {
    for (const key of this.drafts.keys()) {
      const control = this.settingControl(key);
      if (control) this.drafts.set(key, this.settingValue(control));
    }
  }
  snapshotDrafts(keys) {
    const values = new Map();
    for (const key of keys) {
      const control = this.settingControl(key);
      if (control) values.set(key, this.settingValue(control));
    }
    return { drafts: this.drafts, values };
  }
  clearDrafts(snapshot) {
    if (!snapshot || snapshot.drafts !== this.drafts) return;
    this.captureDrafts();
    let changed = false;
    for (const [key, value] of snapshot.values) {
      if (this.drafts.has(key) && Object.is(this.drafts.get(key), value)) {
        this.drafts.delete(key);
        changed = true;
      }
    }
    if (changed) this.__html = null;
  }
  setFeedback(message, kind = "success") {
    this.feedback = { message, kind };
    clearTimeout(this.feedbackTimer);
    this.feedbackTimer = setTimeout(() => {
      this.feedback = null;
      this.render();
    }, 3500);
    this.render();
  }
  async onClick(e) {
    if (e.target.closest("[data-act='close-settings']")) { store.set({ view: "chat", settingsCategory: null }); return; }
    const category = e.target.closest("[data-settings-category]");
    if (category) { store.set({ settingsCategory: category.dataset.settingsCategory }); return; }
    if (e.target.closest("[data-act='settings-list']")) { store.set({ settingsCategory: null }); return; }
    if (e.target.closest("[data-act='open-logs']")) { store.set({ logsOpen: true, logsError: null }); return; }
    const theme = e.target.closest("[data-theme-choice]");
    if (theme) {
      const value = theme.dataset.themeChoice;
      document.documentElement.dataset.theme = value;
      try { localStorage.setItem("pi-theme", value); } catch { /* storage is optional */ }
      for (const b of this.querySelectorAll("[data-theme-choice]")) b.setAttribute("aria-pressed", String(b === theme));
      return;
    }
    if (e.target.closest("[data-act='toggle-hidden-files']")) {
      const show = store.state.showHiddenFiles === false;
      try { localStorage.setItem(SHOW_HIDDEN_FILES_KEY, String(show)); } catch { /* storage is optional */ }
      store.set({ showHiddenFiles: show });
      return;
    }
    if (e.target.closest("[data-act='save-repos-root']")) return this.saveReposRoot();
    if (e.target.closest("[data-act='save-repository-settings']")) return this.saveRepositorySettings();
    if (e.target.closest("[data-act='save-sync-settings']")) return this.saveSyncSettings();
    if (e.target.closest("[data-act='save-pi-configuration']")) return this.savePiConfiguration();
    if (e.target.closest("[data-act='open-github-picker']")) return this.openGithubPicker();
    if (e.target.closest("[data-github-logout]")) return this.logoutGithub();
    if (e.target.closest("[data-act='reload-all-workers']")) return this.reloadAllWorkers();
    const workerAction = e.target.closest("[data-act$='-worker']");
    if (workerAction) return runWorkerAction(workerAction.dataset.act, workerAction.dataset.name, workerAction.dataset.pinned === "1", (message, kind) => this.setFeedback(message, kind));
    const login = e.target.closest("[data-auth-login]");
    if (login) return this.startAuth(login.dataset.authLogin, login.dataset.authType);
    const logout = e.target.closest("[data-auth-logout]");
    if (logout) return this.logoutProvider(logout.dataset.authLogout);
    if (e.target.closest("[data-auth-cancel]")) return this.cancelAuth();
    if (e.target.closest("[data-auth-submit]")) return this.submitAuth();
  }
  async saveReposRoot() {
    const input = this.querySelector(".repos-root-input");
    if (!input) return;
    const snapshot = this.snapshotDrafts(["reposRoot"]);
    const value = input.value.trim() || null;
    const previous = store.state.reposRoot;
    try {
      const result = await api.settings(undefined, value);
      store.set({ reposRoot: result.reposRoot || null, reposRootSource: result.reposRootSource || "default", repos: [] });
      this.clearDrafts(snapshot);
      this.setFeedback("Repository path saved.");
    } catch (err) {
      store.set({ reposRoot: previous });
      this.setFeedback(`Repository path failed: ${err.error || err.message || err}`, "error");
    }
  }
  async saveDefaultThinking(level) {
    const snapshot = this.snapshotDrafts(["defaultThinkingLevel"]);
    const previous = store.state.defaultThinkingLevel;
    try {
      const result = await api.settingsPatch({ defaultThinkingLevel: level });
      store.set({ defaultThinkingLevel: result.defaultThinkingLevel || level });
      this.clearDrafts(snapshot);
      this.setFeedback("Default thinking mode saved.");
    } catch (err) {
      store.set({ defaultThinkingLevel: previous });
      this.setFeedback(`Default thinking mode failed: ${err.error || err.message || err}`, "error");
    }
  }
  async saveSyncSettings() {
    const syncSettings = store.state.settings?.sync || {};
    const patch = { sync: {} };
    if (syncSettings.serverUrl?.editable !== false) patch.sync.serverUrl = this.querySelector("[data-setting='syncServerUrl']")?.value.trim() || null;
    const choice = name => { const v = this.querySelector(`[data-setting='${name}']`)?.value; return v ? v : null; };
    if (syncSettings.allConversations?.editable !== false) { const v = choice("syncAllConversations"); patch.sync.allConversations = v; }
    patch.sync.code = choice("syncCode");
    const snapshot = this.snapshotDrafts(Object.keys(patch.sync).map(key => ({ serverUrl: "syncServerUrl", allConversations: "syncAllConversations", code: "syncCode" })[key]));
    try {
      await api.settingsPatch(patch);
      await refreshState();
      this.clearDrafts(snapshot);
      this.setFeedback("Synchronization settings saved.");
    } catch (err) {
      const message = err.error === "setting_overridden"
        ? "One or more synchronization settings are deployment-controlled."
        : `Synchronization settings failed: ${err.error || err.message || err}`;
      this.setFeedback(message, "error");
    }
  }
  async saveRepositorySettings() {
    const patch = {};
    if (store.state.settings?.defaultRepositorySource?.editable !== false) patch.defaultRepositorySource = this.querySelector("[data-setting='defaultRepositorySource']")?.value;
    if (store.state.settings?.githubOwner?.editable !== false) patch.githubOwner = this.querySelector("[data-setting='githubOwner']")?.value.trim() || null;
    if (!Object.keys(patch).length) return;
    const snapshot = this.snapshotDrafts(Object.keys(patch));
    try {
      await api.settingsPatch(patch);
      await refreshState();
      this.clearDrafts(snapshot);
      this.setFeedback("Repository settings saved.");
    } catch (err) {
      const message = err.error === "invalid_github_owner"
        ? "Enter a valid GitHub user or organization name."
        : `Repository settings failed: ${err.error || err.message || err}`;
      this.setFeedback(message, "error");
    }
  }
  async savePiConfiguration() {
    const lines = selector => (this.querySelector(selector)?.value || "")
      .split("\n").map(value => value.trim()).filter(Boolean);
    const current = store.state.piConfiguration?.config || {};
    const profile = this.querySelector("[data-setting='piProfile']")?.value.trim() || null;
    const pi = {
      profile,
      profileSource: profile ? "explicit" : current.profileSource === "disabled" ? "disabled" : "auto",
      packages: lines("[data-setting='piPackages']"),
      extensions: lines("[data-setting='piExtensions']"),
    };
    const snapshot = this.snapshotDrafts(["piProfile", "piPackages", "piExtensions"]);
    await this.applyPiConfiguration(pi, "applied", snapshot);
  }
  async applyPiConfiguration(pi, verb, snapshot) {
    const operation = beginOperation("pi-profile", "Apply Pi resources", "", "Request started.");
    try {
      const result = await api.settingsPatch({ pi, operationId: operation.id, activeSessionId: store.activeKey() });
      completeOperation(operation, result);
      const profileError = result.piConfiguration?.profile?.error;
      try {
        await refreshState();
        if (!profileError) this.clearDrafts(snapshot);
      } catch (err) {
        store.setError(`Could not refresh Pi resource state: ${err.message || err}`);
      }
      const message = profileError
        ? `Pi configuration ${verb}, but the profile could not be loaded: ${profileError}`
        : `Pi profile ${verb}. Resources are active for the selected session and load for other sessions when they open.`;
      this.setFeedback(message, profileError ? "error" : "success");
    } catch (err) {
      completeOperation(operation, {}, err);
      const message = err.error === "pi_configuration_busy"
        ? "Stop active sessions before changing Pi extensions."
        : `Pi configuration failed: ${err.error || err.message || err}`;
      this.setFeedback(message, "error");
    }
  }
  async reloadAllWorkers() {
    try {
      this.workerResults = (await api.reloadWorkspaces()).results;
    } catch (err) {
      this.workerResults = null;
      this.setFeedback(`Reload failed: ${workerErrorMessage(err)}`, "error");
    }
    await refreshWorkers();
  }
  async startAuth(providerId, type) {
    if (this.flow) return;
    try {
      const result = await api.authStart(providerId, type);
      this.flow = result.flow;
      this.render();
      void this.pollAuth(this.flow.id);
    } catch (err) {
      store.setError(`Provider login failed: ${err.error || err.message || err}`);
    }
  }
  async pollAuth(id) {
    clearTimeout(this.flowTimer);
    try {
      const result = await api.authFlow(id);
      if (!this.flow || this.flow.id !== id) return;
      this.flow = result.flow;
      this.render();
      if (this.flow.state === "complete") {
        this.flow = null;
        await refreshState();
        store.setError("Provider connected.", 2200);
        return;
      }
      if (["error", "cancelled"].includes(this.flow.state)) {
        const message = this.flow.error?.message || "Provider login did not complete.";
        this.flow = null;
        store.setError(message);
        return;
      }
      this.flowTimer = setTimeout(() => this.pollAuth(id), 1000);
    } catch (err) {
      this.flow = null;
      store.setError(`Provider login status failed: ${err.error || err.message || err}`);
    }
  }
  async submitAuth() {
    const prompt = this.flow?.prompt;
    if (!this.flow || !prompt) return;
    const input = this.querySelector("[data-auth-input]");
    const value = input?.value || "";
    if (input && prompt.type === "secret") input.value = "";
    try {
      const result = await api.authInput(this.flow.id, prompt.id, value);
      this.flow = result.flow;
      this.render();
    } catch (err) {
      store.setError(`Provider input failed: ${err.error || err.message || err}`);
    }
  }
  async cancelAuth() {
    const id = this.flow?.id;
    if (!id) return;
    clearTimeout(this.flowTimer);
    try { await api.authCancel(id); } catch { /* terminal cancellation is best effort */ }
    this.flow = null;
    this.render();
  }
  async logoutProvider(providerId) {
    try {
      await api.providerLogout(providerId);
      await refreshState();
      store.setError("Provider disconnected.", 2200);
    } catch (err) {
      store.setError(`Provider logout failed: ${err.error || err.message || err}`);
    }
  }
  openGithubPicker() {
    const github = store.state.repositorySources?.sources?.find(source => source.id === "github");
    store.set({ repoPickerOpen: true, repoPickerSource: "github" });
    // A Settings action labelled “Sign in” must actually begin sign-in. The
    // picker owns the Device Flow display and polling, so defer until it has
    // rendered in its GitHub source state.
    if (github?.configured && !github.authenticated) {
      queueMicrotask(() => { void document.querySelector("pi-repo-picker")?.startGithubLogin(); });
    }
  }
  async logoutGithub() {
    try {
      await api.githubLogout();
      await refreshState();
      store.setError("GitHub disconnected.", 2200);
    } catch (err) {
      store.setError(`GitHub disconnect failed: ${err.error || err.message || err}`);
    }
  }
  providerCard(provider) {
    const name = provider.id === "openai-codex"
      ? "OpenAI — ChatGPT"
      : provider.id === "openai"
        ? "OpenAI — API"
        : provider.name;
    const status = provider.configured
      ? `Connected${provider.sourceLabel ? ` · ${provider.sourceLabel}` : ""}`
      : "Not connected";
    const models = provider.availableModels || 0;
    const login = provider.source === "environment" ? "" : provider.authMethods?.map(method => {
      const label = provider.id === "openai-codex" && method.id === "oauth"
        ? "Sign in with ChatGPT"
        : provider.id === "anthropic" && method.id === "oauth"
          ? "Sign in with Anthropic"
          : method.id === "api_key"
            ? `Use ${provider.id === "openai" ? "OpenAI" : provider.id === "anthropic" ? "Anthropic" : name} API key`
            : method.label;
      return `<button class="settings-action" data-auth-login="${esc(provider.id)}" data-auth-type="${esc(method.id)}">${esc(provider.configured ? `Reconnect · ${label}` : label)}</button>`;
    }).join("") || "";
    const logout = provider.canLogout
      ? `<button class="settings-action quiet" data-auth-logout="${esc(provider.id)}">Disconnect</button>` : "";
    return `<div class="settings-card provider-card">
      <div class="provider-card-head">
        <div><div class="sr-title">${esc(name)}</div><div class="sr-sub">${esc(status)} · ${models} available model${models === 1 ? "" : "s"}</div></div>
        <span class="status-dot ${provider.configured ? "" : "off"}" aria-label="${provider.configured ? "Connected" : "Not connected"}"></span>
      </div>
      ${provider.error ? `<div class="provider-error">${esc(provider.error.message || "Provider status unavailable.")}</div>` : ""}
      <div class="provider-actions">${login}${logout || (!login ? `<span class="provider-action-note">No browser login available</span>` : "")}</div>
    </div>`;
  }
  authFlowCard() {
    const flow = this.flow;
    if (!flow) return "";
    const note = flow.notification;
    let notification = "";
    if (note?.type === "auth_url") notification = `<div class="auth-note">${esc(note.instructions || "Complete login in your browser.")} <a href="${esc(note.url)}" target="_blank" rel="noopener">Open authorization page</a></div>`;
    else if (note?.type === "device_code") notification = `<div class="auth-device"><div>Open <a href="${esc(note.verificationUri)}" target="_blank" rel="noopener">${esc(note.verificationUri)}</a></div><strong>${esc(note.userCode)}</strong><div class="auth-note">The server will finish after you approve this device.</div></div>`;
    else if (note?.message) notification = `<div class="auth-note">${esc(note.message)}</div>`;
    let prompt = "";
    if (flow.prompt?.type === "select") prompt = `<select data-auth-input aria-label="${esc(flow.prompt.message)}">${(flow.prompt.options || []).map(option => `<option value="${esc(option.id)}">${esc(option.label)}</option>`).join("")}</select>`;
    else if (flow.prompt) prompt = `<input data-auth-input type="${flow.prompt.type === "secret" ? "password" : "text"}" placeholder="${esc(flow.prompt.placeholder || "")}" aria-label="${esc(flow.prompt.message)}">`;
    return `<div class="auth-flow-card" data-auth-flow-id="${esc(flow.id || "")}" data-auth-prompt-id="${esc(flow.prompt?.id || "")}" role="dialog" aria-label="Provider login">
      <div class="auth-flow-head"><strong>Provider login</strong><button class="ghost-btn" data-auth-cancel aria-label="Cancel login">×</button></div>
      ${notification}
      ${flow.prompt ? `<div class="auth-prompt"><label>${esc(flow.prompt.message)}</label>${prompt}<button class="settings-save" data-auth-submit>Submit</button></div>` : ""}
      ${flow.state === "pending" ? `<div class="auth-note">Waiting for provider…</div>` : ""}
      ${flow.error ? `<div class="provider-error">${esc(flow.error.message)}</div>` : ""}
    </div>`;
  }
  appearancePage() {
    return `<section class="settings-section">
        <div class="settings-card settings-card-spaced"><div class="settings-row">
          <div class="sr-main"><div class="sr-title">Theme</div><div class="sr-sub">Stored in this browser.</div></div>
          <div class="segmented" role="group" aria-label="Theme">${[["system", "System"], ["light", "Light"], ["dark", "Dark"]].map(([value, label]) => `<button data-theme-choice="${value}" aria-pressed="${(document.documentElement.dataset.theme || "system") === value}">${label}</button>`).join("")}</div>
        </div>
        <div class="settings-row">
          <div class="sr-main"><div class="sr-title">Show hidden files</div><div class="sr-sub">Lists files and folders whose names start with a dot (<span class="settings-mono">.github</span>, <span class="settings-mono">.env</span>) in Files. Stored in this browser.</div></div>
          <button class="settings-switch" role="switch" data-act="toggle-hidden-files" aria-checked="${store.state.showHiddenFiles !== false}" aria-label="Show hidden files"><span aria-hidden="true"></span></button>
        </div></div>
      </section>`;
  }
  providersPage() {
    const providers = store.state.providers || [];
    return `<section class="settings-section">
        <p class="settings-intro">Model providers Pi can use. Sign in with OAuth or add an API key; signing out removes that login from this server only.</p>
        <div class="provider-list">${providers.map(provider => this.providerCard(provider)).join("") || `<div class="modal-empty">No provider status available.</div>`}</div>
      </section>
      ${this.authFlowCard()}`;
  }
  piPage() {
    const piState = store.state.piConfiguration || {};
    const piConfig = piState.config || { profile: null, packages: [], extensions: [] };
    const profileInputValue = piConfig.profile || "";
    const profileStatus = ["loaded", "cached"].includes(piState.profile?.status)
      ? `${piState.profile.status === "cached" ? "Using cached" : "Loaded"} ${piState.profile.source}${piState.profile.ref ? ` @ ${piState.profile.ref}` : ""}${piState.profile.commit ? ` · ${piState.profile.commit.slice(0, 12)}` : ""}`
      : piState.profile?.status === "error"
        ? `Profile error: ${piState.profile.error}`
        : "Using the deployment's Pi settings";
    const loadedExtensions = Array.isArray(piState.runtime?.extensions) ? piState.runtime.extensions : [];
    const loadedSkills = Array.isArray(piState.runtime?.skills) ? piState.runtime.skills : [];
    const resourceRows = (items, empty) => items.length
      ? `<ul>${items.map(item => `<li><strong>${esc(item.name || "Unnamed resource")}</strong><span>${esc(item.path || "")}</span><small>${esc([item.source, item.scope, item.origin].filter(Boolean).join(" · "))}</small></li>`).join("")}</ul>`
      : `<div class="pi-resource-empty">${esc(empty)}</div>`;
    const extensionList = piState.runtime
      ? `<details class="pi-loaded-list" data-settings-details="extensions"><summary>Extensions (${loadedExtensions.length})</summary><div class="pi-resource-scroll">${resourceRows(loadedExtensions, "No extensions loaded.")}</div></details>`
      : "";
    const skillList = piState.runtime
      ? `<details class="pi-loaded-list" data-settings-details="skills"><summary>Skills (${loadedSkills.length})</summary><div class="pi-resource-scroll">${resourceRows(loadedSkills, "No skills loaded.")}</div></details>`
      : "";
    const skillCount = Array.isArray(piState.runtime?.skills) ? loadedSkills.length : (piState.runtime?.skills || 0);
    const packageStatus = piState.runtime?.packageStatus;
    const packageSummary = packageStatus?.configured
      ? ` ${packageStatus.loaded} of ${packageStatus.configured} configured package${packageStatus.configured === 1 ? "" : "s"} active${packageStatus.failed ? `; ${packageStatus.failed} skipped` : ""}.`
      : "";
    const runtimeSummary = piState.runtime
      ? `${loadedExtensions.length} extension${loadedExtensions.length === 1 ? "" : "s"}, ${skillCount} skill${skillCount === 1 ? "" : "s"}, and ${piState.runtime.prompts || 0} prompts loaded${piState.runtime.loadedAt ? ` at ${new Date(piState.runtime.loadedAt).toLocaleTimeString()}` : ""}.${packageSummary}`
      : "Resources load when a session runtime is attached.";
    const piProblems = [
      ...(piState.warnings || []),
      ...(piState.runtime?.errors || []).map(error => `${error.path}: ${error.error}`),
      ...(piState.runtime?.skillDiagnostics || []).map(error => `${error.path || "skill"}: ${error.message}`),
    ];
    const piOperation = operationFeedback("pi-profile", "Applying Pi resources…");
    return `<section class="settings-section">
        <div class="settings-card settings-card-spaced">
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Dotfiles profile</div><div class="sr-sub">Optional: enter a local path or HTTPS URL. Leave blank to use only the deployment's Pi settings. GitHub profiles read <span class="settings-mono">.pi/agent/settings.json</span> and supported resources.</div></div>
            <input class="settings-inline-input pi-profile-input" data-setting="piProfile" value="${esc(profileInputValue)}" placeholder="https://github.com/owner/dotfiles">
          </div>
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Extra packages to load</div><div class="sr-sub">Optional packages added on top of the profile. Enter one Pi npm/git package source per line; missing packages install on Save &amp; reload.</div></div>
            <textarea class="settings-inline-input pi-resource-list" data-setting="piPackages" rows="4" placeholder="npm:context-mode&#10;git:github.com/owner/pi-extension">${esc((piConfig.packages || []).join("\n"))}</textarea>
          </div>
          <details class="settings-advanced" data-settings-details="advanced" ${(piConfig.extensions || []).length ? "open" : ""}><summary>Advanced</summary><div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Local extension paths (advanced)</div><div class="sr-sub">Optional server-local extension files or directories, one path per line. These are not package names; relative paths resolve from <span class="settings-mono">PI_WEB_HOME</span>.</div></div>
            <textarea class="settings-inline-input pi-resource-list" data-setting="piExtensions" rows="4" placeholder="/data/extensions/my-extension.ts">${esc((piConfig.extensions || []).join("\n"))}</textarea>
          </div></details>
          <div class="settings-row pi-resource-status"><div class="sr-main"><div class="sr-title">${esc(profileStatus)}</div><div class="sr-sub">${esc(runtimeSummary)}</div>
            ${piState.runtime ? `<div class="settings-subhead">What's loaded</div>` : ""}${extensionList}${skillList}
            ${piProblems.length ? `<div class="settings-subhead">Problems</div><div class="provider-error">${piProblems.map(esc).join(" · ")}</div>` : ""}</div></div>
          <div class="settings-row settings-actions-row"><span class="settings-mono">Save &amp; reload fetches the profile, installs missing packages, and reloads idle sessions. It is refused while a session is running; stop it first. Remote extensions execute with the server user's full permissions.</span><div class="settings-actions"><button class="settings-save" data-act="save-pi-configuration">Save &amp; reload</button>${piOperation}</div></div>
        </div>
      </section>`;
  }
  workersPage() {
    const inventory = store.state.workers;
    const workers = inventory?.workspaces || [];
    const awake = workers.some(worker => worker.state === "running");
    const results = this.workerResults
      ? `<div class="worker-results" role="status">${this.workerResults.map(result => `<div class="${result.ok ? "" : "error"}">${esc(result.name)}: ${result.ok ? "reloaded" : esc(workerErrorMessage({ error: result.error }))}</div>`).join("")}</div>`
      : "";
    const list = inventory
      ? workers.length ? workers.map(worker => workerCard(worker, inventory.usageAvailable)).join("") : `<div class="modal-empty">No workers yet. Adding a project starts one.</div>`
      : store.state.workersError ? "" : `<div class="modal-empty">Loading workers…</div>`;
    return `<section class="settings-section">
        <div class="settings-card settings-card-spaced"><div class="settings-row">
          <div class="sr-main"><div class="sr-title">Reload</div><div class="sr-sub">Re-reads the dotfiles profile and extensions in each awake worker. Sleeping workers are not woken.</div></div>
          <button class="settings-save" data-act="reload-all-workers" ${awake ? "" : "disabled"}>Reload all awake workers</button>
        </div>${results}</div>
        ${store.state.workersError ? `<div class="provider-error">${esc(store.state.workersError)}</div>` : ""}
        ${list}
      </section>`;
  }
  syncPage() {
    const syncState = store.state.sync || {};
    const syncSettings = store.state.settings?.sync || {};
    const syncServerUrl = syncSettings.serverUrl?.value || "";
    const syncServerEditable = syncSettings.serverUrl?.editable !== false;
    const syncAll = syncSettings.allConversations?.value;
    const syncCode = syncSettings.code?.value || "";
    const option = (value, label, current) => `<option value="${value}" ${current === value ? "selected" : ""}>${label}</option>`;
    const syncAllEditable = syncSettings.allConversations?.editable !== false;
    const syncLabel = syncState.configured ? "Connected" : "Local only";
    return `<section class="settings-section">
        <div class="settings-card settings-card-spaced">
          ${syncServerEditable ? `<div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Sync server</div><div class="sr-sub">Canonical enrolled conversations live in the configured pi-sync service. Leave this empty to keep local-only behavior.</div></div>
            <input class="settings-inline-input" data-setting="syncServerUrl" value="${esc(syncServerUrl)}" placeholder="https://pi-sync.example">
          </div>` : ""}
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Synchronize all conversations</div><div class="sr-sub">${syncAllEditable ? "Default follows <span class=\"settings-mono\">allSessions</span> in your dotfiles' <span class=\"settings-mono\">pi-sync.json</span>. Otherwise use <span class=\"settings-mono\">/sync</span> in a conversation." : "Set by the deployment. Use <span class=\"settings-mono\">/sync</span> to enroll a conversation."}</div></div>
            <select class="settings-inline-input" data-setting="syncAllConversations" ${syncAllEditable ? "" : "disabled"}>${option("", "Follow dotfiles", syncAll === null || syncAll === undefined ? "" : null)}${option("on", "On", syncAll === true ? "on" : null)}${option("off", "Off", syncAll === false ? "off" : null)}</select>
          </div>
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Share uncommitted code</div><div class="sr-sub">Default follows <span class="settings-mono">code</span> in your dotfiles' <span class="settings-mono">pi-sync.json</span>.</div></div>
            <select class="settings-inline-input" data-setting="syncCode">${option("", "Follow dotfiles", syncCode)}${option("ask", "Ask per repository", syncCode)}${option("auto", "Always", syncCode)}${option("off", "Never", syncCode)}</select>
          </div>
          <div class="settings-row"><div class="sr-main"><div class="sr-title">${esc(syncLabel)}</div><div class="sr-sub">${syncState.configured ? esc(syncState.serverUrl || syncServerUrl) : "No sync server configured; conversations stay on this host."}</div></div><span class="status-dot ${syncState.configured ? "" : "off"}"></span></div>
          ${`<div class="settings-row settings-actions-row"><span></span><button class="settings-save" data-act="save-sync-settings">Save</button></div>`}
        </div>
      </section>`;
  }
  repositoriesPage() {
    const settings = store.state.settings || {};
    const source = settings.defaultRepositorySource?.value || store.state.repositorySources?.default || "github";
    const sourceEditable = settings.defaultRepositorySource?.editable !== false;
    const owner = settings.githubOwner?.value || "";
    const ownerEditable = settings.githubOwner?.editable !== false;
    const githubStatus = store.state.repositorySources?.sources?.find(source => source.id === "github");
    const githubSummary = githubStatus?.authenticated
      ? `Connected${githubStatus.account?.login ? ` as ${githubStatus.account.login}` : ""}`
      : githubStatus?.configured ? "Not connected" : "Sign-in requires server GitHub app setup";
    return `<section class="settings-section">
        <div class="settings-card settings-card-spaced">
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">Default source</div><div class="sr-sub">Choose where the project picker opens first.</div></div>
            <select class="settings-select" data-setting="defaultRepositorySource" ${sourceEditable ? "" : "disabled"}>
              ${["github", "git-url"].map(value => `<option value="${value}" ${source === value ? "selected" : ""}>${value === "github" ? "GitHub" : "Git URL"}</option>`).join("")}
            </select>
          </div>
          <div class="settings-row settings-path-row">
            <div class="sr-main"><div class="sr-title">GitHub owner filter</div><div class="sr-sub">Only repositories owned by this account or organization are shown.</div></div>
            <input class="settings-inline-input" data-setting="githubOwner" value="${esc(owner)}" placeholder="bry-guy" ${ownerEditable ? "" : "disabled"}>
          </div>
          <div class="settings-row"><div class="sr-main"><div class="sr-title">GitHub account</div><div class="sr-sub">${esc(githubSummary)}. Use the project picker to sign in or choose a repository.</div><div class="provider-actions"><button class="settings-action" data-act="open-github-picker">${githubStatus?.authenticated ? "Manage repositories" : "Sign in with GitHub"}</button>${githubStatus?.authenticated && githubStatus.credentialSource === "stored" ? `<button class="settings-action quiet" data-github-logout>Sign out</button>` : ""}</div></div></div>
          <div class="settings-row settings-actions-row"><span class="settings-mono">${sourceEditable && ownerEditable ? "Stored in config.json" : "One or more values are environment-controlled"}</span><div class="settings-actions"><button class="settings-save" data-act="save-repository-settings" ${sourceEditable || ownerEditable ? "" : "disabled"}>Save</button></div></div>
        </div>
      </section>`;
  }
  defaultsPage() {
    const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const defaultThinkingLevel = store.state.defaultThinkingLevel || "medium";
    return `<section class="settings-section">
      <div class="settings-card settings-card-spaced">
        <div class="settings-row">
          <div class="sr-main"><div class="sr-title">Default model</div><div class="sr-sub">Automatic uses the first available authenticated model.${store.state.defaultModelStatus === "unavailable" ? " The configured model is currently unavailable." : ""}</div></div>
          <pi-model-picker data-mode="default" data-variant="settings"></pi-model-picker>
        </div>
        <div class="settings-row settings-path-row">
          <div class="sr-main"><div class="sr-title">Default thinking mode</div><div class="sr-sub">Used for new chats; existing sessions keep their saved mode.</div></div>
          <select class="settings-select" data-setting="defaultThinkingLevel">
            ${thinkingLevels.map(level => `<option value="${level}" ${level === defaultThinkingLevel ? "selected" : ""}>${level}</option>`).join("")}
          </select>
        </div>
        ${store.state.reposRootSource === "environment" ? "" : `<div class="settings-row settings-path-row">
          <div class="sr-main"><div class="sr-title">Local repositories</div><div class="sr-sub">Folder scanned by the project picker. Empty uses <span class="settings-mono">~/src</span>${store.state.reposRootSource === "environment" ? ". <span class=\"settings-mono\">PI_WEB_REPOS_ROOT</span> currently overrides this value" : ""}.</div></div>
          <div class="settings-path-control">
            <input class="repos-root-input" aria-label="Local repositories path" value="${esc(store.state.reposRoot || "")}" placeholder="~/src">
            <button class="settings-save" data-act="save-repos-root">Save</button>
          </div>
        </div>`}
      </div>
      </section>`;
  }
  diagnosticsPage() {
    const s = store.state;
    const runtime = s.piConfiguration?.runtime || {};
    const facts = [
      ["Build", s.buildId || "unknown", "The running server build. Reload the page after an update."],
      ["Mode", s.mode || "unknown", "mock serves sample data without Pi or Git; real runs Pi sessions and Git."],
      ["Pi extensions", `${(runtime.extensions || []).length} loaded`, "Extensions Pi loaded from its profile and local paths."],
      ["Pi skills", `${(runtime.skills || []).length} loaded`, "Skills agents in this server can use."],
      ["Pi load errors", `${(runtime.errors || []).length}`, "Problems Pi reported while loading. Fix them under Pi."],
    ];
    return `<section class="settings-section">
        <p class="settings-intro">What this server is running and what Pi loaded. Share the build and any load errors when reporting a problem.</p>
        <div class="settings-card settings-card-spaced">${facts.map(([title, value, sub]) => `<div class="settings-row"><div class="sr-main"><div class="sr-title">${esc(title)}</div><div class="sr-sub">${esc(sub)}</div></div><span class="settings-mono">${esc(value)}</span></div>`).join("")}</div>
        <div class="settings-card settings-card-spaced"><div class="settings-row"><div class="sr-main"><div class="sr-title">Server logs</div><div class="sr-sub">Recent operations and server output, newest first. Use them to see why a hook, push or merge failed.</div></div><button class="settings-action" data-act="open-logs">Open logs</button></div></div>
      </section>`;
  }
  render() {
    const category = store.state.settingsCategory || DEFAULT_CATEGORY;
    const label = CATEGORIES.find(([id]) => id === category)[1];
    const pages = {
      providers: () => this.providersPage(),
      pi: () => this.piPage(),
      workers: () => this.workersPage(),
      sync: () => this.syncPage(),
      repositories: () => this.repositoriesPage(),
      defaults: () => this.defaultsPage(),
      appearance: () => this.appearancePage(),
      diagnostics: () => this.diagnosticsPage(),
    };
    const feedback = this.feedback
      ? `<div class="settings-feedback ${this.feedback.kind === "error" ? "error" : ""}" role="status">${esc(this.feedback.message)}</div>`
      : "";
    const preserveInteraction = !this.resettingInteraction;
    this.resettingInteraction = false;
    if (preserveInteraction) this.captureDrafts();
    const active = preserveInteraction ? this.ownerDocument.activeElement : null;
    const focusKey = this.contains(active) ? this.settingKey(active) : null;
    const selection = focusKey && typeof active.selectionStart === "number"
      ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection }
      : null;
    if (preserveInteraction) {
      for (const details of this.querySelectorAll("details[data-settings-details]")) {
        this.detailsOpen.set(details.dataset.settingsDetails, details.open);
      }
    }
    const html = `<div class="settings-layout" data-view="${store.state.settingsCategory ? "category" : "list"}">
      <nav class="settings-nav" aria-label="Settings categories">
        <div class="settings-nav-head"><button class="ghost-btn settings-close" data-act="close-settings" title="Back to chat" aria-label="Back to chat">${icon("chevronLeft")}</button><div class="settings-nav-title">Settings</div></div>
        <ul class="settings-nav-list">${CATEGORIES.map(([id, name]) => `<li><button class="settings-nav-item${id === category ? " active" : ""}" data-settings-category="${id}"${id === category ? ` aria-current="page"` : ""}><span class="settings-nav-label">${name}</span><span class="settings-nav-chevron" aria-hidden="true">${icon("chevronRight")}</span></button></li>`).join("")}</ul>
      </nav>
      <div class="settings-pane">
        <div class="settings-pane-head"><button class="ghost-btn settings-close settings-pane-back" data-act="settings-list" title="All settings" aria-label="All settings">${icon("chevronLeft")}</button><div class="screen-title">${label}</div></div>
        ${feedback}
        ${pages[category]()}
      </div>
    </div>`;
    setHTML(this, html);
    for (const [key, value] of this.drafts) {
      const control = this.settingControl(key);
      if (!control || control.disabled) continue;
      if (control.type === "checkbox") control.checked = value;
      else control.value = value;
    }
    for (const details of this.querySelectorAll("details[data-settings-details]")) {
      const key = details.dataset.settingsDetails;
      if (this.detailsOpen.has(key)) details.open = this.detailsOpen.get(key);
    }
    if (focusKey) {
      const control = this.settingControl(focusKey);
      if (control && !control.disabled) {
        if (control !== active) control.focus({ preventScroll: true });
        if (selection && typeof control.setSelectionRange === "function") {
          control.setSelectionRange(selection.start, selection.end, selection.direction);
        }
      }
    }
    this.syncWorkers();
  }
}

customElements.define("pi-settings", PiSettings);
