import { api, refreshState } from "./api.js";
import { beginOperation, completeOperation } from "./operations.js";
import { setHTML, store, toast } from "./store.js";
import { closeConversation, esc, icon, selectSession } from "./shell.js";
import { openProjectMenu } from "./project-menu.js";
import { gitErrorMessage, runningPickerOperation, pickerError, launchSetup, pickerOperationKinds, featureBranchForName } from "./panel-utils.js";

// A fork's default name: the session's name plus the first free "(fork)", "(fork 2)", … among the project's sessions.
export function uniqueForkName(name, taken) {
  const base = String(name || "Session").replace(/\s+\(fork(?: \d+)?\)$/, "").trim() || "Session";
  const names = new Set(taken);
  for (let n = 1; ; n++) {
    const candidate = `${base} (fork${n === 1 ? "" : ` ${n}`})`;
    if (!names.has(candidate)) return candidate;
  }
}

function uniqueBranch(branch, taken) {
  const names = new Set(taken);
  if (!names.has(branch)) return branch;
  for (let n = 2; ; n++) if (!names.has(`${branch}-${n}`)) return `${branch}-${n}`;
}


/* ---------------- branch/session picker ---------------- */
class PiSessionPicker extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("input", e => {
      const picker = store.state.sessionPicker;
      if (!picker) return;
      if (e.target.matches("[data-fork-name]")) {
        picker.forkName = e.target.value;
        const branchInput = this.querySelector("[data-fork-branch]");
        if (branchInput) branchInput.placeholder = this.forkDefaults().branch;
      }
      if (e.target.matches("[data-fork-branch]")) picker.forkBranch = e.target.value;
      if (e.target.matches("[data-session-new-branch]")) {
        picker.newBranch = e.target.value;
        picker.newBranchAuto = false;
        this.syncActionState();
      }
    });
    this.addEventListener("change", e => {
      const picker = store.state.sessionPicker;
      if (!picker) return;
      if (e.target.matches("[data-session-base-branch]")) picker.baseBranch = e.target.value;
      store.notify("state");
    });
    this.render();
  }

  disconnectedCallback() { this.unsub?.(); }
  picker() { return store.state.sessionPicker; }
  project() { return store.state.projects.find(project => project.id === this.picker()?.projectId) || null; }
  flatten(nodes) { return (nodes || []).flatMap(node => [node, ...this.flatten(node.children)]); }

  close() { store.set({ sessionPicker: null, sessionPickerError: null }); }

  // The panel's steps (Switch, Fork) replace its body; "<" returns to the main screen.
  showScreen(screen) {
    const picker = this.picker();
    if (!picker || this.busy) return;
    picker.screen = screen;
    if (screen === "switch") { picker.branch = picker.currentBranch; picker.newBranch = ""; picker.newBranchAuto = false; }
    if (screen === "fork") { picker.forkName = ""; picker.forkBranch = ""; }
    store.set({ sessionPickerError: null });
    queueMicrotask(() => this.querySelector(screen === "fork" ? "[data-fork-name]" : "[data-act='back-session-picker']")?.focus());
  }

  allBranches(project) {
    return [...new Set([...(project.branches || []), ...(project.remoteBranches || []).map(name => name.replace(/^origin\//, "")), ...(project.contexts || []).map(context => context.branch).filter(Boolean)])];
  }

  forkDefaults() {
    const picker = this.picker();
    const project = this.project();
    if (!picker || !project) return { name: "", branch: "" };
    const source = this.flatten(project.sessions).find(session => session.id === picker.sourceSessionId);
    const taken = this.flatten(project.sessions).map(session => session.title || session.name).filter(Boolean);
    const defaultName = uniqueForkName(source?.name || source?.title || picker.name, taken);
    const name = String(picker.forkName || "").trim() || defaultName;
    return { name, defaultName, branch: uniqueBranch(featureBranchForName(name) || "feature/fork", this.allBranches(project)) };
  }

  async submitFork() {
    const picker = this.picker();
    if (!picker) return;
    const { name, branch } = this.forkDefaults();
    await this.submit("fork", String(picker.forkBranch || "").trim() || branch, name);
  }

  async selectBranch(branch) {
    const picker = this.picker();
    if (!picker) return;
    picker.branch = branch;
    store.notify("state");
    if (picker.sourceSessionId && branch !== picker.currentBranch) await this.submit("switch", null, null);
  }

  syncActionState() {
    const picker = this.picker();
    if (!picker || this.busy) return;
    for (const button of this.querySelectorAll("[data-new-branch-action]")) button.disabled = !String(picker.newBranch || "").trim();
  }

  detailFileCount(count, label) {
    return `${count} file${count === 1 ? "" : "s"} ${label}`;
  }

  // Git facts for a branch's checkout or worktree; plain text, wrapped, never truncated.
  gitRows(context) {
    if (!context) return [];
    const commit = context.commit || {};
    const hash = commit.shortHash || commit.hash?.slice(0, 8) || context.head?.slice(0, 8) || "Unavailable";
    const subject = String(commit.subject || "").split(/\r?\n/, 1)[0];
    const details = context.statusDetails;
    const statusParts = [];
    if (details?.conflicts) statusParts.push(this.detailFileCount(details.conflicts, "conflicted"));
    if (details?.staged) statusParts.push(this.detailFileCount(details.staged, "staged"));
    if (details?.unstaged) statusParts.push(this.detailFileCount(details.unstaged, "unstaged"));
    if (details?.untracked) statusParts.push(this.detailFileCount(details.untracked, "untracked"));
    const tracking = [
      context.ahead ? `${context.ahead} ahead` : "",
      context.behind ? `${context.behind} behind` : "",
    ].filter(Boolean);
    const statusValue = statusParts.length
      ? [...statusParts, ...tracking].join(", ")
      : context.status === "clean"
        ? tracking.length ? `Clean, ${tracking.join(", ")}` : "Clean"
        : context.status === "unavailable"
          ? "Unavailable"
          : context.status || "Unknown";
    const kind = context.kind === "checkout" ? "checkout" : context.kind === "worktree" ? "worktree" : "unavailable";
    return [
      ["Branch", context.branch || "Unavailable"],
      ["Commit", subject ? `${hash} ${subject}` : hash, commit.hash || context.head || ""],
      ["Workspace", `${kind} · ${context.path || "Unavailable"}`],
      ["Status", statusValue],
    ];
  }

  async fetchBranches() {
    if (this.busy) return;
    const picker = this.picker();
    const project = this.project();
    const sessionId = picker?.sourceSessionId || null;
    if (!project || runningPickerOperation("fetch", sessionId)) return;
    this.busy = true;
    this.busyLabel = "Fetching…";
    const operation = beginOperation("fetch", "Fetch Git branches", "", "Request started.", sessionId, { projectId: project.id, action: "fetch" });
    store.set({ sessionPickerError: null });
    let result = null;
    try {
      result = await api.fetchProject(project.id, operation.id, sessionId);
      await refreshState();
      completeOperation(operation, result);
      toast("Fetched Git branches.");
    } catch (err) {
      completeOperation(operation, result || {}, err);
      pickerError(`Could not fetch branches: ${gitErrorMessage(err)}`, picker);
    } finally { this.busy = false; this.busyLabel = null; this.afterOperation(); }
  }

  /** The workspace's own log (hooks, git operations, fork and switch), fetched once per opening. */
  loadHistory() {
    const picker = this.picker();
    if (!picker || !picker.sourceSessionId || picker.history !== undefined) return;
    picker.history = null;
    api.sessionHistory(picker.sourceSessionId)
      .then(result => { picker.history = result.entries || []; })
      .catch(() => { picker.history = []; picker.historyError = "Could not load history."; })
      .finally(() => { if (this.picker() === picker) this.render(); });
  }

  afterOperation() {
    const picker = this.picker();
    if (picker) picker.history = undefined;
    this.render();
  }

  async onClick(e) {
    const scrim = this.querySelector(".session-picker-scrim");
    if (e.target === scrim || e.target.closest("[data-act='close-session-picker']")) { this.close(); return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "open-switch" || act === "open-fork") { this.showScreen(act === "open-switch" ? "switch" : "fork"); return; }
    if (act === "back-session-picker") { this.showScreen("main"); return; }
    if (act === "switch-new-branch") {
      const picker = this.picker();
      if (picker) { picker.branch = "__new__"; await this.submit("switch", null, null); }
      return;
    }
    if (act === "select-session-branch") {
      await this.selectBranch(e.target.closest("[data-act]").dataset.branch);
      return;
    }
    if (act === "fetch-branches") {
      await this.fetchBranches();
      return;
    }
    if (act === "run-hook") { void this.runHook(e.target.closest("[data-act]")?.dataset.hook); return; }
    if (act === "merge-branch") {
      const picker = this.picker(); const project = this.project();
      if (!picker || !project) return;
      const context = (project.contexts || []).find(item => item.branch === picker.currentBranch);
      const primaryBranch = project.defaultBranch || project.primaryBranch || "main";
      const confirm = { type: "merge", projectId: project.id, id: picker.sourceSessionId, branch: picker.currentBranch, primaryBranch, error: null, sessions: context?.sessions || [], dirty: context?.dirty ?? false, status: context?.status || "unknown" };
      this.close(); store.set({ confirm }); return;
    }
    if (act === "delete-branch") {
      const picker = this.picker(); const project = this.project();
      if (!picker || !project) return;
      const context = (project.contexts || []).find(item => item.branch === picker.currentBranch);
      const primaryBranch = project.defaultBranch || project.primaryBranch || "main";
      this.close();
      store.set({ confirm: { type: "deleteBranch", projectId: project.id, id: picker.sourceSessionId, branch: picker.currentBranch, primaryBranch, label: picker.currentBranch, sessions: context?.sessions || [], closeSessions: false, force: false, dirty: context?.dirty ?? false, status: context?.status || "unknown", error: null } });
      return;
    }
    if (act === "fork-session") { await this.submitFork(); return; }
    if (act === "toggle-history") {
      const picker = this.picker();
      const id = e.target.closest("[data-act]").dataset.id;
      picker.openHistory = picker.openHistory?.includes(id) ? picker.openHistory.filter(item => item !== id) : [...(picker.openHistory || []), id];
      this.render();
      return;
    }
    if (act === "end-session") {
      const id = this.picker()?.sourceSessionId;
      if (id && !this.busy) { this.close(); await closeConversation(id, "session"); }
      return;
    }
    if (act === "open-project-menu") {
      const project = this.project();
      if (project) openProjectMenu(project.id);
      return;
    }
    if (act === "pull-branch") await this.pull();
    if (act === "push-branch") await this.push();
  }

  async submit(mode, forkBranch = null, nameOverride = undefined) {
    const picker = this.picker(); const project = this.project();
    if (!picker || !project || this.busy) return;
    const primary = project.defaultBranch || project.primaryBranch || "main";
    // An existing session's panel no longer edits its name: a switch keeps it, a fork names the copy.
    const enteredName = String(nameOverride === undefined ? picker.name || "" : nameOverride || "").trim();
    let branch = forkBranch ?? (picker.branch === "__new__" ? String(picker.newBranch || "").trim() : String(picker.branch || "").trim());
    if (!branch && enteredName && mode === "fork") {
      branch = featureBranchForName(enteredName);
      picker.newBranch = branch;
      picker.newBranchAuto = !!branch;
    }
    if (!branch) { store.set({ sessionPickerError: "Enter a branch name or session name." }); return; }
    if (branch === picker.currentBranch) { store.set({ sessionPickerError: "Choose a branch other than the current one." }); return; }
    const baseBranch = picker.baseBranch || primary;
    const knownBranches = new Set([...(project.branches || []), ...(project.contexts || []).map(context => context.branch).filter(Boolean)]);
    const needsPrimaryFetch = !knownBranches.has(branch) && baseBranch === primary;
    this.busy = true;
    this.busyLabel = needsPrimaryFetch ? `Fetching ${primary}…` : mode === "switch" ? "Switching…" : "Copying…";
    store.set({ sessionPickerError: null });
    const operation = beginOperation(
      mode === "switch" ? "switch-session" : "fork-session",
      mode === "switch" ? "Switch session" : "Copy conversation",
      "",
      needsPrimaryFetch ? `Waiting for ${primary} preparation…` : "Request started.",
      picker.sourceSessionId,
    );
    let result = null;
    try {
      result = await api.branchSession(picker.sourceSessionId, { branch, baseBranch, operationId: operation.id, mode, ...(enteredName ? { name: enteredName } : {}) });
      const targetId = result?.id || picker.sourceSessionId;
      if (!targetId) throw new Error("The server did not return a session id.");
      operation.sessionId = targetId;
      completeOperation(operation, result);
      store.set({ sessionPicker: null, sessionPickerError: null });
      store.state.openTree[project.id] = true;
      selectSession(project.id, targetId);
      launchSetup(targetId, result);
      void refreshState().catch(err => store.setError(`Could not refresh session state: ${err.message || err}`));
    } catch (err) {
      const messages = {
        no_such_base_branch: "That base branch no longer exists.",
        session_streaming: "Wait for the current response to finish before switching.",
        same_branch: "Choose a different branch.",
      };
      const displayError = Object.assign(new Error(messages[err.error] || gitErrorMessage(err)), err);
      completeOperation(operation, result || {}, displayError);
      pickerError(messages[err.error] || gitErrorMessage(err), picker);
    } finally { this.busy = false; this.busyLabel = null; this.afterOperation(); }
  }

  async pull() {
    const id = this.picker()?.sourceSessionId;
    if (!id || this.busy) return;
    this.busy = true;
    this.busyLabel = "Pulling…";
    const operation = beginOperation("pull", "Pull", "", "Request started.", id);
    let result = null;
    try {
      result = await api.pullBranch(id);
      completeOperation(operation, result);
      toast("Pulled the latest commits.");
      void refreshState().catch(err => store.setError(`Could not refresh branch state: ${err.message || err}`));
    } catch (err) {
      completeOperation(operation, result || {}, err);
      store.set({ sessionPickerError: gitErrorMessage(err) });
    } finally { this.busy = false; this.busyLabel = null; this.afterOperation(); }
  }

  async push() {
    const id = this.picker()?.sourceSessionId;
    const project = this.project();
    if (!id || !project || this.busy || runningPickerOperation("push-preview", id)) return;
    this.busy = true;
    this.busyLabel = "Checking commits to push…";
    const operation = beginOperation("push-preview", "Review push", "", "Checking commits to push…", id);
    try {
      const preview = await api.pushPreview(id);
      completeOperation(operation, { ok: true, httpStatus: 200, stdout: `${preview.commitCount} commit${preview.commitCount === 1 ? "" : "s"} ready to push.` });
      this.close();
      store.set({ confirm: { type: "push", projectId: project.id, id, branch: preview.branch, upstream: preview.upstream, commits: preview.commits || [], commitCount: preview.commitCount || 0, head: preview.head, baseHead: preview.baseHead, error: null } });
    } catch (err) {
      completeOperation(operation, {}, err);
      store.set({ sessionPickerError: gitErrorMessage(err) });
    } finally { this.busy = false; this.busyLabel = null; this.afterOperation(); }
  }

  async runHook(name) {
    const picker = this.picker();
    const id = picker?.sourceSessionId;
    const title = name ? `${name[0].toUpperCase()}${name.slice(1)}` : "Hook";
    if (!id || !name || runningPickerOperation("hook", id, title)) return;
    const operation = beginOperation("hook", title, "", "Request started.", id);
    let result = null;
    try {
      result = await api.hook(id, name, operation.id);
      completeOperation(operation, result);
      toast(`${title} finished.`);
      void refreshState().catch(err => pickerError(`Could not refresh hook state: ${err.message || err}`, picker));
    } catch (err) {
      completeOperation(operation, result || {}, err);
      pickerError(`${title} failed: ${err.error || err.message || err}`, picker);
    } finally { this.afterOperation(); }
  }

  // Recent operations still running for this session, shown at the top of History until they are logged.
  runningEntries(sessionId) {
    return (store.state.operations || [])
      .filter(operation => operation.status === "running" && operation.sessionId === sessionId && (pickerOperationKinds.has(operation.kind) || operation.kind === "pull"))
      .map(operation => ({
        id: operation.id, title: operation.title, status: "running", at: operation.startedAt,
        output: (operation.events || []).map(event => event.output || event.message).filter(Boolean).join("\n"),
      }));
  }

  historySection(picker) {
    const entryRow = entry => {
      const open = !!picker.openHistory?.includes(entry.id);
      const when = new Date(entry.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const outcome = entry.status === "success" ? "ok" : entry.status === "error" ? "failed" : entry.status;
      return `<div class="history-entry ${esc(entry.status)}"><button type="button" class="history-entry-head" data-act="toggle-history" data-id="${esc(entry.id)}" aria-expanded="${open}"><span class="history-main"><strong>${esc(entry.title)}</strong><small>${esc(when)}${entry.exit != null ? ` · exit ${esc(entry.exit)}` : ""}</small></span><span class="history-status">${entry.status === "running" ? `<i class="operation-dot" aria-hidden="true"></i>` : ""}${esc(outcome)}</span></button>${open ? `<pre class="history-output">${esc(entry.output || "No output.")}</pre>` : ""}</div>`;
    };
    const running = this.runningEntries(picker.sourceSessionId);
    const logged = picker.history || [];
    const entries = [...running, ...logged.filter(entry => !running.some(item => item.id === entry.id))];
    const body = picker.history == null && !running.length
      ? `<div class="session-history-empty">Loading history…</div>`
      : entries.length ? entries.map(entryRow).join("")
        : `<div class="session-history-empty">${esc(picker.historyError || "Nothing has run in this workspace yet. Setup, fetches, pulls, pushes, merges, forks and switches appear here.")}</div>`;
    return `<section class="session-history-log" aria-label="History">
        <div class="session-context-heading"><span>History</span>${entries.length ? `<span>${entries.length}</span>` : ""}</div>
        <div class="history-list">${body}</div>
      </section>`;
  }

  // The Switch step: pick a branch to move this session onto, or name a new one.
  switchBody(_project, branches, primary, branchMeta) {
    const picker = this.picker();
    const current = picker.currentBranch || "";
    const options = branches.map(branch => `<button type="button" class="branch-option" data-act="select-session-branch" data-branch="${esc(branch)}" role="option" aria-selected="${branch === current}" ${branch === current || this.busy ? "disabled" : ""}><span class="branch-option-name">${esc(branch)}</span><span class="branch-option-meta">${esc(branch === current ? "current" : branchMeta(branch))}</span></button>`).join("");
    const baseOptions = branches.map(branch => `<option value="${esc(branch)}" ${(picker.baseBranch || primary) === branch ? "selected" : ""}>${esc(branch)}</option>`).join("");
    const newBranch = String(picker.newBranch || "").trim();
    return `<section class="session-switch" aria-label="Switch branch">
        <p class="session-picker-help">Moves this session onto another branch. Branches other than ${esc(primary)} use their own worktree.</p>
        <div class="session-context-heading"><span>Branches</span><span>${branches.length}</span></div>
        <div class="branch-list" role="listbox" aria-label="Branches">${options}</div>
        <div class="session-context-heading"><span>New branch</span></div>
        <div class="session-form">
          <label class="session-picker-source"><span>Name</span><input class="session-branch-input" data-session-new-branch value="${esc(picker.newBranch || "")}" placeholder="feature/my-change" autocomplete="off"></label>
          <label class="session-picker-source"><span>Based on</span><select data-session-base-branch>${baseOptions}</select></label>
        </div>
        <div class="session-action-row"><button class="btn btn-ghost" data-act="back-session-picker">Cancel</button><button class="btn btn-primary" data-act="switch-new-branch" data-new-branch-action ${this.busy || !newBranch ? "disabled" : ""}>Switch to new branch</button></div>
      </section>`;
  }

  // The Fork step: name the copy and its branch; empty fields use the shown defaults.
  forkBody() {
    const picker = this.picker();
    const defaults = this.forkDefaults();
    return `<section class="session-fork" aria-label="Fork session">
        <p class="session-picker-help">Copies this conversation to a new branch in its own worktree and opens the copy. This session stays where it is.</p>
        <div class="session-form">
          <label class="session-picker-source"><span>Name</span><input class="session-name-input" data-fork-name value="${esc(picker.forkName || "")}" placeholder="${esc(defaults.defaultName)}" autocomplete="off"></label>
          <label class="session-picker-source"><span>Branch</span><input class="session-branch-input" data-fork-branch value="${esc(picker.forkBranch || "")}" placeholder="${esc(defaults.branch)}" autocomplete="off"></label>
        </div>
        <div class="session-action-row"><button class="btn btn-ghost" data-act="back-session-picker">Cancel</button><button class="btn btn-primary" data-act="fork-session" ${this.busy ? "disabled" : ""}>${this.busy ? esc(this.busyLabel || "Forking…") : "Fork"}</button></div>
      </section>`;
  }

  render() {
    const picker = this.picker();
    const project = picker ? this.project() : null;
    if (!picker || !project) {
      setHTML(this, "");
      this.shownScreen = null;
      return;
    }
    const focused = document.activeElement;
    const focusKey = focused && this.contains(focused) && focused.matches("input, select")
      ? [...focused.attributes].map(attribute => attribute.name).find(name => name.startsWith("data-session-") || name.startsWith("data-fork-"))
      : null;
    const selectionStart = focused?.selectionStart;
    const selectionEnd = focused?.selectionEnd;
    const contexts = project.contexts || [];
    const primary = project.defaultBranch || project.primaryBranch || contexts.find(context => context.primaryBranch)?.primaryBranch || "main";
    const contextFor = branch => contexts.find(context => context.branch === branch) || null;
    const branches = [...new Set([primary, ...(project.branches || []), ...contexts.map(context => context.branch).filter(Boolean)])]
      .sort((a, b) => (a === primary ? -1 : b === primary ? 1 : a.localeCompare(b)));
    const screen = picker.screen || "main";
    const current = picker.currentBranch || "";
    const effectiveBranch = current || project.branch || primary;
    const context = contextFor(effectiveBranch);
    const users = (context?.sessions || []).filter(user => user.id !== picker.sourceSessionId);
    const sourceSession = picker.sourceSessionId ? this.flatten(project.sessions).find(session => session.id === picker.sourceSessionId) : null;
    const onCurrent = !!current;
    const primarySelected = current === primary;
    const primaryReason = `Unavailable for ${primary}; ${primary} is the primary checkout.`;
    const userText = users.length ? users.map(user => `<span class="session-context-user ${user.streaming ? "working" : ""}"><i></i>${esc(user.title)} · ${user.streaming ? "working" : "idle"}</span>`).join("") : `<span class="session-picker-help">No other sessions use this branch.</span>`;
    const branchMeta = branch => {
      const item = contextFor(branch);
      if (!item) return "not checked out";
      return `${item.kind === "checkout" ? "CHECKOUT" : "WORKTREE"} · ${item.status || (item.dirty ? "dirty" : "clean")}`;
    };
    const detailList = rows => `<dl class="session-details-list">${rows.map(([key, value, title = ""]) => `<div class="session-detail-row"><dt>${esc(key)}</dt><dd${title ? ` title="${esc(title)}"` : ""}>${esc(value)}</dd></div>`).join("")}</dl>`;
    this.loadHistory();

    let body;
    if (screen === "switch") body = this.switchBody(project, branches, primary, branchMeta);
    else if (screen === "fork") body = this.forkBody();
    else {
      const fetchRunning = !!runningPickerOperation("fetch", picker.sourceSessionId);
      const fetchButton = `<button class="btn btn-secondary" data-act="fetch-branches" title="Fetch remote Git branches" aria-label="Fetch remote Git branches" ${this.busy || fetchRunning ? "disabled" : ""}>${this.busy && this.busyLabel === "Fetching…" ? "Fetching…" : "Fetch"}</button>`;
      const gitRows = this.gitRows(context);
      const gitButtons = `${fetchButton}${onCurrent ? `<button class="btn btn-secondary" data-act="pull-branch" ${this.busy ? "disabled" : ""}>Pull</button><button class="btn btn-secondary" data-act="push-branch" ${this.busy ? "disabled" : ""}>${this.busy && this.busyLabel === "Checking commits to push…" ? esc(this.busyLabel) : "Push"}</button>` : ""}<button class="btn btn-secondary" data-act="open-switch" ${this.busy ? "disabled" : ""}>Switch…</button>`;
      const gitSection = `<section class="session-branch-actions" aria-label="Git">
        <div class="session-context-heading"><span>Git</span></div>
        ${gitRows.length ? detailList(gitRows) : `<p class="session-picker-help">Git details are unavailable for this session.</p>`}
        <div class="session-context-users branch-user-list">${userText}</div>
        <div class="session-action-row">${gitButtons}</div>
        ${onCurrent ? `<div class="session-action-row session-danger-row"><button class="btn btn-caution" data-act="delete-branch" ${primarySelected || this.busy ? "disabled" : ""} title="${primarySelected ? esc(primaryReason) : "Delete local branch"}">Delete branch</button><button class="btn btn-primary" data-act="merge-branch" ${primarySelected || this.busy ? "disabled" : ""} title="${primarySelected ? esc(primaryReason) : `Merge to ${esc(primary)}`}">Merge to ${esc(primary)}</button></div>` : ""}
      </section>`;
      {
        const hookNames = picker.sourceSessionId ? Object.entries(project.hooks || {}).filter(([name, enabled]) => enabled && name).map(([name]) => name).sort((a, b) => (a === "setup" ? -1 : b === "setup" ? 1 : a.localeCompare(b))) : [];
        const hookLabel = name => `${name[0].toUpperCase()}${name.slice(1)}`;
        const actionRow = (title, hint, button) => `<div class="panel-row"><div class="panel-row-text"><strong>${esc(title)}</strong><small>${esc(hint)}</small></div>${button}</div>`;
        const hookRows = hookNames.map(name => {
          const label = hookLabel(name);
          const running = !!runningPickerOperation("hook", picker.sourceSessionId, label);
          const hint = name === "setup" ? "Runs the project's setup script (e.g. npm ci) in this worktree." : `Runs the project's ${name} hook in this worktree.`;
          return actionRow(label, hint, `<button class="btn btn-secondary" data-act="run-hook" data-hook="${esc(name)}" ${running ? "disabled" : ""}>${esc(running ? "Running…" : label)}</button>`);
        }).join("");
        const sessionSection = `<section class="session-picker-actions" aria-label="Session">
          <div class="session-context-heading"><span>Session</span></div>
          <div class="panel-rows session-picker-session-buttons">
            ${actionRow("Fork", "Copies this conversation to a new branch and worktree.", `<button class="btn btn-secondary" data-act="open-fork" ${this.busy ? "disabled" : ""}>Fork…</button>`)}
            ${hookRows}
            ${actionRow("End session", "Stops it, withdraws it from sync on this server and archives it. Git is not touched.", `<button class="btn btn-caution" data-act="end-session" ${this.busy ? "disabled" : ""}>End</button>`)}
            ${actionRow("Project", "New and past sessions, other devices, worker, removal.", `<button class="btn btn-secondary" data-act="open-project-menu">Open…</button>`)}
          </div>
        </section>`;
        body = `${sessionSection}${gitSection}${this.historySection(picker)}`;
      }
    }

    const error = store.state.sessionPickerError ? `<div class="session-picker-error">${esc(store.state.sessionPickerError)}</div>` : "";
    const progress = this.busy ? `<div class="session-picker-progress" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>${esc(this.busyLabel || "Working…")}</span></div>` : "";
    const sessionName = sourceSession?.title || sourceSession?.name || picker.name || "";
    const heads = {
      main: ["Session", [project.name, sessionName].filter(Boolean).join(" · ")],
      switch: ["Switch branch", `${sessionName ? `${sessionName} · ` : ""}on ${current || "no branch"}`],
      fork: ["Fork session", `Copy ${sessionName || "this conversation"} to a new branch`],
    };
    const [title, subtitle] = heads[screen];
    const back = screen === "main" ? "" : `<button class="ghost-btn session-picker-back" data-act="back-session-picker" aria-label="Back">${icon("chevronLeft")}</button>`;
    const head = `${back}<div><div class="modal-title">${esc(title)}</div><div class="session-picker-subtitle">${esc(subtitle)}</div></div><button class="ghost-btn" data-act="close-session-picker" aria-label="Close">×</button>`;
    // The scrim and dialog are built once per opening: re-creating them on every
    // update replayed their fade/pop entry animations, so the screen flashed and jumped.
    let dialog = this.querySelector(".session-picker");
    if (!dialog) {
      this.innerHTML = `<div class="session-picker-scrim"><section class="session-picker" role="dialog" aria-modal="true"><div class="session-picker-head"></div><div class="session-picker-body"></div></section></div>`;
      this.__html = null;
      dialog = this.querySelector(".session-picker");
    }
    dialog.setAttribute("aria-label", title);
    const scroller = this.querySelector(".session-picker-body");
    const scrolled = this.shownScreen === screen ? scroller.scrollTop : 0;
    setHTML(this.querySelector(".session-picker-head"), head);
    scroller.setAttribute("aria-busy", String(!!this.busy));
    setHTML(scroller, `${progress}${error}${body}`);
    // Re-rendering replaces the body; keep the reader's place (e.g. after expanding a history entry).
    scroller.scrollTop = scrolled;
    this.shownScreen = screen;
    if (focusKey) {
      const next = this.querySelector(`[${focusKey}]`);
      if (next) {
        next.focus({ preventScroll: true });
        if (selectionStart != null && typeof next.setSelectionRange === "function") next.setSelectionRange(selectionStart, selectionEnd ?? selectionStart);
      }
    }
  }
}

customElements.define("pi-session-picker", PiSessionPicker);
