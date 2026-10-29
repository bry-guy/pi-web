import { api, refreshState } from "./api.js";
import { beginOperation, completeOperation } from "./operations.js";
import { store } from "./store.js";
import { esc, icon, selectSession } from "./shell.js";
import { launchSetup } from "./panel-utils.js";

/* ---------------- repo picker ---------------- */
class PiRepoPicker extends HTMLElement {
  connectedCallback() {
    this.repoRoot = store.state.reposRoot;
    this.source = null;
    this.sourceMenuOpen = false;
    this.onDocumentKeydown = e => {
      if (e.key === "Escape" && store.state.repoPickerOpen) {
        e.preventDefault();
        void this.dismiss();
      }
    };
    document.addEventListener("keydown", this.onDocumentKeydown);
    this.unsub = store.subscribe(w => {
      if (w !== "state") return;
      const rootChanged = this.repoRoot !== null && this.repoRoot !== store.state.reposRoot;
      this.repoRoot = store.state.reposRoot;
      if (rootChanged) this.loaded = false;
      this.render();
      if (rootChanged && store.state.repoPickerOpen) void this.load();
    });
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-repo]")) {
        e.preventDefault(); e.target.closest("[data-repo]").click();
      }
    });
    this.addEventListener("input", e => {
      if (e.target.matches(".modal-filter")) {
        store.state.repoQuery = e.target.value;
        this.loaded = false;
        this.renderResults();
        void this.load();
      }
      if (e.target.matches(".git-url-input")) this.gitUrl = e.target.value;
    });
    this.render();
  }
  disconnectedCallback() {
    this.unsub?.();
    clearTimeout(this.githubTimer);
    document.removeEventListener("keydown", this.onDocumentKeydown);
  }
  async dismiss() {
    await this.cancelGithubLogin();
    store.set({ repoPickerOpen: false, repoPickerSource: null });
  }
  availableSources() {
    const configured = store.state.repositorySources?.sources || [];
    const enabled = new Set(configured.filter(source => source.enabled !== false).map(source => source.id));
    return ["github", "git-url"].filter(id => !configured.length || enabled.has(id));
  }
  chooseSource(source) {
    if (!this.availableSources().includes(source)) return;
    const changed = this.source !== source;
    this.source = source;
    if (changed) store.state.repoQuery = "";
    store.state.repoPickerSource = source;
    this.sourceMenuOpen = false;
    this.loaded = false;
    this.errorMsg = null;
    this.githubRepos = [];
    this.render();
    void this.load();
  }
  async onClick(e) {
    const scrim = this.querySelector(".scrim");
    if (e.target === scrim || e.target.closest("[data-act='close']")) {
      void this.dismiss(); return;
    }
    const sourceToggle = e.target.closest("[data-source-toggle]");
    if (sourceToggle) { this.sourceMenuOpen = !this.sourceMenuOpen; this.render(); return; }
    const source = e.target.closest("[data-source]");
    if (source) { this.chooseSource(source.dataset.source); return; }
    if (e.target.closest("[data-github-login]")) { void this.startGithubLogin(); return; }
    if (e.target.closest("[data-github-more]")) { void this.loadGithubMore(); return; }
    if (e.target.closest("[data-github-cancel]")) { void this.cancelGithubLogin(); return; }
    if (e.target.closest("[data-git-url-connect]")) { void this.connect("git-url", this.querySelector(".git-url-input")?.value); return; }
    const row = e.target.closest("[data-repo]");
    if (!row) return;
    const value = row.dataset.repo;
    await this.connect(this.source || "github", value, row.dataset.fullName);
  }
  async connect(source, value, fullName) {
    if (this.connecting) return;
    this.connecting = true;
    this.errorMsg = null;
    this.renderResults();
    const operation = beginOperation("create-project", "Create project", "", "Request started.");
    try {
      const grant = this.querySelector(".grant-select")?.value || undefined;
      const body = source === "github" ? { source, fullName, grant, operationId: operation.id } : { source, url: value, grant, operationId: operation.id };
      const result = await api.newProject(body);
      this.connecting = false;
      operation.sessionId = result.sessionId || null;
      store.set({ repoPickerOpen: false, repoPickerSource: null });
      store.state.openTree[result.id] = true;
      selectSession(result.id, result.sessionId, { showOperation: true });
      completeOperation(operation, result);
      launchSetup(result.sessionId, result);
      try { await refreshState(); } catch (err) { store.setError(`Could not refresh project state: ${err.message || err}`); }
    } catch (err) {
      this.connecting = false;
      completeOperation(operation, {}, err);
      const messages = {
        project_exists: "Already connected.",
        github_auth_required: "Connect GitHub before selecting a private repository.",
        repository_exists: "That repository already exists in the repository root.",
        branch_exists: "That branch already exists.",
        clone_failed: "Git could not clone this repository.",
        invalid_git_url: "Use a public HTTPS Git URL.",
        grant_not_allowed: "This repository may not use that grant.",
        no_such_grant: "That grant no longer exists.",
      };
      this.errorMsg = messages[err.error] || String(err.message || err.error || err);
      this.renderResults();
    }
  }
  async load() {
    if (this.loaded || !store.state.repoPickerOpen) return;
    this.loaded = true;
    const source = this.source || "github";
    if (source === "git-url") { this.renderResults(); return; }
    {
      const status = store.state.repositorySources?.sources?.find(item => item.id === "github");
      this.githubNextPage = null;
      if (!status?.authenticated && !status?.owner) {
        this.githubRepos = [];
        this.errorMsg = "Set a GitHub owner in Settings to browse public repositories, or sign in to list your repositories.";
        this.renderResults();
        return;
      }
      try {
        const result = status?.authenticated
          ? await api.githubRepos(store.state.repoQuery)
          : await api.githubPublicRepos(status?.owner, store.state.repoQuery);
        this.githubRepos = result.repos || [];
        this.githubNextPage = result.nextPage;
        this.githubPublicOnly = !status?.authenticated;
      } catch (err) {
        this.errorMsg = err.error === "github_auth_required"
          ? "Sign in with GitHub to list private repositories."
          : err.error === "github_owner_required"
            ? "Set a default GitHub owner in Settings to browse public repositories."
            : `Could not load GitHub repositories: ${err.message || err.error || err}`;
        this.githubRepos = [];
      }
      this.renderResults();
      return;
    }
    this.renderResults();
  }
  async loadGithubMore() {
    if (!this.githubNextPage || this.githubMoreLoading) return;
    const status = store.state.repositorySources?.sources?.find(item => item.id === "github");
    const page = this.githubNextPage;
    this.githubMoreLoading = true;
    this.renderResults();
    try {
      const result = status?.authenticated
        ? await api.githubRepos(store.state.repoQuery, page)
        : await api.githubPublicRepos(status?.owner, store.state.repoQuery, page);
      const existing = new Set((this.githubRepos || []).map(repo => repo.fullName));
      this.githubRepos = [...(this.githubRepos || []), ...(result.repos || []).filter(repo => !existing.has(repo.fullName))];
      this.githubNextPage = result.nextPage;
      this.errorMsg = null;
    } catch (err) {
      this.errorMsg = `Could not load more GitHub repositories: ${err.message || err.error || err}`;
    } finally {
      this.githubMoreLoading = false;
      this.renderResults();
    }
  }
  async startGithubLogin() {
    if (this.githubFlow) return;
    try {
      const result = await api.githubLogin();
      this.githubFlow = result.flow;
      this.renderResults();
      void this.pollGithubLogin(this.githubFlow.id);
    } catch (err) {
      this.errorMsg = err.error === "github_not_configured" ? "GitHub OAuth is not configured on the server." : `GitHub login failed: ${err.message || err.error || err}`;
      this.renderResults();
    }
  }
  async pollGithubLogin(id) {
    clearTimeout(this.githubTimer);
    if (!store.state.repoPickerOpen || this.githubFlow?.id !== id) return;
    try {
      const result = await api.githubFlow(id);
      if (!store.state.repoPickerOpen || this.githubFlow?.id !== id) return;
      this.githubFlow = result.flow;
      if (["complete", "error", "cancelled"].includes(this.githubFlow.state)) {
        if (this.githubFlow.state === "complete") {
          const accountLogin = this.githubFlow.account?.login;
          const ownerUnset = !store.state.settings?.githubOwner?.value;
          this.githubFlow = null;
          if (accountLogin && ownerUnset) {
            try { await api.settingsPatch({ githubOwner: accountLogin }); } catch {}
          }
          await refreshState();
          this.loaded = false;
          this.errorMsg = null;
          await this.load();
        } else {
          this.errorMsg = this.githubFlow.error?.message || "GitHub login did not complete.";
          this.githubFlow = null;
          this.renderResults();
        }
        return;
      }
      this.renderResults();
      this.githubTimer = setTimeout(() => this.pollGithubLogin(id), 1000);
    } catch (err) {
      this.githubFlow = null;
      this.errorMsg = `GitHub login status failed: ${err.message || err.error || err}`;
      this.renderResults();
    }
  }
  async cancelGithubLogin() {
    const id = this.githubFlow?.id;
    clearTimeout(this.githubTimer);
    this.githubFlow = null;
    if (id) await api.githubCancel(id).catch(() => {});
    if (store.state.repoPickerOpen) this.renderResults();
  }
  render() {
    if (!store.state.repoPickerOpen) {
      this.innerHTML = ""; this.loaded = false; this.errorMsg = null; this.sourceMenuOpen = false; this.source = null; this.grants = null; return;
    }
    if (!this.source) this.source = store.state.repoPickerSource || store.state.repositorySources?.default || "github";
    if (!this.querySelector(".scrim")) {
      this.innerHTML = `<div class="scrim">
        <div class="modal">
          <div class="modal-head">
            <div class="modal-title-row">
              <button class="ghost-btn session-picker-back" data-act="close" aria-label="Back" title="Back">${icon("chevronLeft")}</button>
              <div class="modal-title">Select a repository</div>
            </div>
            <div class="modal-filter-row">
              <div class="source-picker">
                <button class="account-chip" data-source-toggle aria-haspopup="listbox" aria-expanded="false">GitHub ▾</button>
                <div class="source-menu" hidden></div>
              </div>
              <input class="modal-filter" placeholder="Find a repository" aria-label="Find a repository">
              <select class="grant-select" aria-label="Grant" title="What this project's worker may hold, defined by whoever deploys pi-ez-web" hidden></select>
            </div>
          </div>
          <div class="modal-list"></div>
        </div>
      </div>`;
    }
    const label = this.source === "git-url" ? "Git URL" : "GitHub";
    const toggle = this.querySelector("[data-source-toggle]");
    if (toggle) { toggle.textContent = `${label} ▾`; toggle.setAttribute("aria-expanded", String(this.sourceMenuOpen)); }
    const menu = this.querySelector(".source-menu");
    if (menu) {
      menu.hidden = !this.sourceMenuOpen;
      menu.innerHTML = this.availableSources().map(source => `<button data-source="${source}" role="option" aria-selected="${source === this.source}">${source === "github" ? "GitHub" : "Git URL"}</button>`).join("");
    }
    const filter = this.querySelector(".modal-filter");
    if (filter) {
      filter.hidden = this.source === "git-url";
      filter.placeholder = "Find a GitHub repository";
      if (filter.value !== store.state.repoQuery && document.activeElement !== filter) filter.value = store.state.repoQuery;
    }
    // Grants exist only when project workers (workspaced) are configured.
    if (this.grants === undefined || this.grants === null) {
      this.grants = [];
      api.workspaceGrants().then(result => { this.grants = result.grants || []; this.render(); }).catch(() => {});
    }
    const select = this.querySelector(".grant-select");
    if (select) {
      select.hidden = this.grants.length < 2;
      const chosen = select.value || "default";
      select.innerHTML = this.grants.map(g => `<option value="${esc(g.name)}" title="${esc(g.description || "")}"${g.name === chosen ? " selected" : ""}>${esc(g.name)}${g.anyProject ? "" : " (listed repos only)"}</option>`).join("");
    }
    this.renderResults();
    void this.load();
  }
  renderResults() {
    const list = this.querySelector(".modal-list");
    if (!list) return;
    const source = this.source || "github";
    if (this.connecting) {
      list.innerHTML = `<div class="modal-empty">Connecting repository…</div>`;
      return;
    }
    if (this.githubFlow) {
      const flow = this.githubFlow;
      list.innerHTML = `<div class="github-login-state"><div>Open <a href="${esc(flow.verificationUri)}" target="_blank" rel="noopener">${esc(flow.verificationUri)}</a></div><strong>${esc(flow.userCode || "")}</strong><div>Approve access, then leave this dialog open.</div><button class="settings-action" data-github-cancel>Cancel</button></div>`;
      return;
    }
    if (source === "git-url") {
      list.innerHTML = `<div class="git-url-form"><label for="git-url-input">Public HTTPS Git URL</label><input id="git-url-input" class="git-url-input" value="${esc(this.gitUrl || "")}" placeholder="https://github.com/owner/repository.git"><button class="connect-btn" data-git-url-connect>Connect</button><div class="modal-help">Private GitHub repositories use the GitHub source. SSH URLs are not supported yet.</div>${this.errorMsg ? `<div class="modal-empty">${esc(this.errorMsg)}</div>` : ""}</div>`;
      return;
    }
    {
      const status = store.state.repositorySources?.sources?.find(item => item.id === "github");
      const q = store.state.repoQuery.trim().toLowerCase();
      const rows = (this.githubRepos || [])
        .filter(repo => !q || repo.name.toLowerCase().includes(q) || repo.fullName.toLowerCase().includes(q))
        .map(repo => `<div class="repo-row" role="button" tabindex="0" data-repo="${esc(repo.fullName)}" data-full-name="${esc(repo.fullName)}"><div class="rr-main"><div class="rr-name">${esc(repo.name)}</div><div class="rr-meta"><span>${esc(repo.fullName)}</span></div></div><span class="rr-vis">${repo.private ? "private" : "public"}</span></div>`).join("");
      const login = !status?.authenticated
        ? `<div class="github-login-banner"><span>${status?.configured ? "Sign in to include private repositories." : "Sign in to access GitHub repositories."}</span><button class="settings-action" data-github-login>Sign in with GitHub</button></div>`
        : "";
      const setup = !status?.configured && !status?.owner
        ? `<div class="modal-empty">GitHub sign-in needs server app setup. Set the advanced <span class="settings-mono">PI_WEB_GITHUB_CLIENT_ID</span> override.</div>`
        : "";
      const empty = !rows && !this.errorMsg && !setup && !this.githubNextPage
        ? `<div class="modal-empty">No public GitHub repositories ${q ? "match" : `were found for ${esc(status?.owner || "this owner")}`}.</div>` : "";
      const more = this.githubNextPage
        ? `<button class="settings-action github-more" data-github-more ${this.githubMoreLoading ? "disabled" : ""}>${this.githubMoreLoading ? "Loading…" : "Load more repositories"}</button>`
        : "";
      list.innerHTML = `${login}${setup}${this.errorMsg ? `<div class="modal-empty">${esc(this.errorMsg)}</div>` : ""}${rows || empty}${more}`;
      return;
    }
  }
}

customElements.define("pi-repo-picker", PiRepoPicker);
