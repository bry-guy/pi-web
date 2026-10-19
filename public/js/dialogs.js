import { api, refreshState, refreshWorkers } from "./api.js";
import { beginOperation, combineOperationResults, completeOperation, operationFor, operationHint } from "./operations.js";
import { setHTML, store } from "./store.js";
import { esc, openSessionPicker, selectSession } from "./shell.js";
import { gitErrorMessage, workerErrorMessage } from "./panel-utils.js";


/* ---------------- logs modal ---------------- */
class PiLogs extends HTMLElement {
  connectedCallback() {
    this.loaded = false;
    this.loading = false;
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.onDocumentKeydown = e => {
      if (e.key === "Escape" && store.state.logsOpen) {
        e.preventDefault();
        store.set({ logsOpen: false });
      }
    };
    document.addEventListener("keydown", this.onDocumentKeydown);
    this.addEventListener("click", e => this.onClick(e));
    this.render();
  }

  disconnectedCallback() {
    this.unsub?.();
    document.removeEventListener("keydown", this.onDocumentKeydown);
  }

  async onClick(e) {
    const scrim = this.querySelector(".logs-scrim");
    if (e.target === scrim || e.target.closest("[data-act='close-logs']")) {
      store.set({ logsOpen: false });
      return;
    }
    if (e.target.closest("[data-act='refresh-logs']")) await this.load();
  }

  async load() {
    if (this.loading) return;
    this.loading = true;
    store.set({ logsLoading: true, logsError: null });
    try {
      const result = await api.logs(800);
      store.set({ logs: Array.isArray(result.logs) ? result.logs : [], logsFile: result.file || "logs/pi-ez-web.log", logsLoading: false, logsError: null });
    } catch (error) {
      store.set({ logsLoading: false, logsError: error.error || error.message || String(error) });
    } finally {
      this.loading = false;
      this.render();
    }
  }

  time(value) {
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString([], { hour12: false });
  }

  localOperation(operation) {
    const status = operation.status === "error" ? "error" : operation.status === "success" ? "success" : "running";
    const events = (operation.events || []).map(item => {
      const message = item.message || item.output || item.type || "Progress update.";
      return `<div class="logs-event ${item.type === "error" || item.stream === "stderr" ? "error" : item.type === "result" ? "success" : "info"}"><time>${this.time(item.at)}</time><span>${esc(message)}</span></div>`;
    }).join("");
    return `<section class="logs-operation ${status}"><div class="logs-operation-head"><strong>${esc(operation.title)}</strong><span>${status}</span></div>${events || `<div class="logs-event info"><span>${esc(operationHint(operation))}</span></div>`}</section>`;
  }

  serverEntry(entry) {
    const status = entry.level === "error" || entry.type === "error" ? "error" : entry.type === "result" ? "success" : "info";
    const source = [entry.source, entry.kind, entry.phase].filter(Boolean).join(" · ");
    const detail = entry.output && entry.output !== entry.message ? `<div class="logs-detail">${esc(entry.output)}</div>` : "";
    return `<div class="logs-event ${status}"><time>${this.time(entry.at)}</time>${source ? `<small>${esc(source)}</small>` : ""}<span>${esc(entry.message || entry.type || "Log entry")}</span>${detail}</div>`;
  }

  render() {
    if (!store.state.logsOpen) {
      this.loaded = false;
      this.innerHTML = "";
      return;
    }
    if (!this.loaded) {
      this.loaded = true;
      queueMicrotask(() => void this.load());
    }
    const operations = [...(store.state.operations || [])].reverse().map(operation => this.localOperation(operation)).join("");
    const serverLogs = (store.state.logs || []).map(entry => this.serverEntry(entry)).join("");
    const loading = store.state.logsLoading ? `<div class="logs-empty">Loading server logs…</div>` : "";
    const error = store.state.logsError ? `<div class="logs-error">Could not load the server log: ${esc(store.state.logsError)}</div>` : "";
    this.innerHTML = `<div class="logs-scrim"><section class="logs-modal" role="dialog" aria-modal="true" aria-label="Logs"><div class="logs-head"><div><div class="logs-title">Logs</div><div class="logs-subtitle">Live actions in this tab and the server log file.</div></div><button class="ghost-btn" data-act="close-logs" aria-label="Close">×</button></div><div class="logs-body">${error}${loading}<section class="logs-section"><div class="logs-section-title">Recent actions</div>${operations || `<div class="logs-empty">No actions have run in this tab.</div>`}</section><section class="logs-section"><div class="logs-section-title">Server log · ${esc(store.state.logsFile || "logs/pi-ez-web.log")}</div><div class="logs-server-list">${serverLogs || `<div class="logs-empty">No server log entries yet.</div>`}</div></section></div><div class="logs-actions"><button class="settings-action quiet" data-act="refresh-logs" ${store.state.logsLoading ? "disabled" : ""}>Refresh</button><button class="settings-save" data-act="close-logs">Close</button></div></section></div>`;
  }
}


/* ---------------- confirmation modal ---------------- */
class PiConfirm extends HTMLElement {
  connectedCallback() {
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.addEventListener("click", e => {
      const scrim = this.querySelector(".confirm-scrim");
      if (e.target === scrim || e.target.closest("[data-act='cancel']")) store.set({ confirm: null });
      else if (e.target.closest("[data-act='go']")) void this.go();
    });
    this.addEventListener("input", e => {
      if (!e.target.matches("[data-confirm-typed]")) return;
      this.typed = e.target.value;
      this.querySelector("[data-act='go']").disabled = this.typed !== store.state.confirm?.name;
    });
    this.addEventListener("change", e => {
      if (e.target.matches("[data-confirm-delete-after]")) store.set(s => ({ confirm: { ...s.confirm, deleteAfter: e.target.checked } }));
      if (e.target.matches("[data-confirm-close-sessions]")) store.set(s => ({ confirm: { ...s.confirm, closeSessions: e.target.checked } }));
      if (e.target.matches("[data-confirm-purge]")) store.set(s => ({ confirm: { ...s.confirm, purge: e.target.checked } }));
      if (e.target.matches("[data-confirm-force]")) store.set(s => ({ confirm: { ...s.confirm, force: e.target.checked } }));
    });
    this.render();
  }
  disconnectedCallback() { this.unsub?.(); }

  async go() {
    const c = store.state.confirm;
    if (!c || this.busy) return;
    if (c.type === "restartWorker" || c.type === "resetWorker" || c.type === "deleteWorker") return this.goWorker(c);
    const project = store.state.projects.find(item => item.id === c.projectId);
    const primary = c.primaryBranch || project?.defaultBranch || project?.primaryBranch || "main";
    this.busy = true;
    this.busyLabel = c.type === "merge" ? `Fetching ${primary}…` : c.type === "push" ? "Pushing commits…" : c.type === "deleteBranch" ? "Deleting branch…" : "Working…";
    const operation = ["merge", "push", "deleteBranch"].includes(c.type)
      ? beginOperation(c.type === "merge" ? "merge" : c.type === "push" ? "push" : "delete", c.type === "merge" ? `Merge ${c.branch}` : c.type === "push" ? `Push ${c.branch}` : `Delete ${c.branch}`, "", "Request started.", c.id)
      : null;
    let result = null;
    let followup = null;
    try {
      if (c.type === "close") {
        await api.close(c.id);
      } else if (c.type === "merge") {
        result = await api.mergeBranch(c.id, operation?.id);
      } else if (c.type === "push") {
        result = await api.pushBranch(c.id, operation?.id, { head: c.head, baseHead: c.baseHead });
      } else if (c.type === "deleteBranch") {
        result = await api.deleteBranch(c.projectId, c.branch, { force: !!c.force, closeSessions: !!c.closeSessions, operationId: operation?.id });
      }
      await refreshState();
      if (operation) completeOperation(operation, combineOperationResults(result, followup));
      store.set({ confirm: null });
      const active = store.state.sessionId;
      if (c.type === "merge" && active && store.findAnySession(active)) openSessionPicker(c.projectId, { mode: "switch", sourceSessionId: active });
      if (active && !store.findAnySession(active)) {
        const project = store.state.projects.find(item => item.id === c.projectId);
        const primary = c.primaryBranch || project?.defaultBranch || project?.primaryBranch || "main";
        const first = this.flatten(project?.sessions || []).find(session => session.branch === primary) || this.flatten(project?.sessions || [])[0];
        if (first) selectSession(c.projectId, first.id);
      }
    } catch (err) {
      if (operation) {
        const prior = combineOperationResults(result, followup);
        completeOperation(operation, { ...prior, stderr: [prior.stderr, err.detail || err.message || String(err)].filter(Boolean).join("\n") }, err);
      }
      const activeConfirm = store.state.confirm;
      if (activeConfirm?.id === c.id && activeConfirm.type === c.type) store.set({ confirm: { ...activeConfirm, error: gitErrorMessage(err) } });
      else store.setError(`Could not complete ${c.type || "operation"}: ${gitErrorMessage(err)}`);
    } finally { this.busy = false; this.busyLabel = null; this.render(); }
  }

  // Worker restart and reset go straight to workspaced; a refusal (busy, asleep) stays in the dialog.
  async goWorker(c) {
    if (c.type === "resetWorker" && this.typed !== c.name) return;
    this.busy = true;
    this.render();
    try {
      if (c.type === "resetWorker") await api.resetWorkspace(c.name, c.name);
      else if (c.type === "deleteWorker") await api.deleteWorkspace(c.name, !!c.purge);
      else await api.restartWorkspace(c.name);
      store.set({ confirm: null });
      if (c.type === "deleteWorker") {
        if (c.projectId && store.state.projectId === c.projectId) store.set({ projectId: null, sessionId: null, sessionPicker: null });
        await refreshState();
      }
      await refreshWorkers();
    } catch (err) {
      const active = store.state.confirm;
      if (active?.id === c.id && active.type === c.type) store.set({ confirm: { ...active, error: workerErrorMessage(err) } });
      else store.setError(`Could not ${{ resetWorker: "reset", deleteWorker: "delete" }[c.type] || "restart"} ${c.name}: ${workerErrorMessage(err)}`);
    } finally { this.busy = false; this.render(); }
  }

  flatten(nodes) { return (nodes || []).flatMap(node => [node, ...this.flatten(node.children)]); }

  render() {
    const c = store.state.confirm;
    if (!c) { this.innerHTML = ""; return; }
    const confirmKey = `${c.type}:${c.id}`;
    if (this.confirmKey !== confirmKey) { this.confirmKey = confirmKey; this.typed = ""; }
    const project = store.state.projects.find(item => item.id === c.projectId);
    const primary = c.primaryBranch || project?.defaultBranch || project?.primaryBranch || "main";
    const sessions = c.sessions || [];
    const activeSessions = sessions.filter(session => session.streaming);
    const sessionList = sessions.length ? `<div class="confirm-sessions"><strong>Sessions using this branch</strong>${sessions.map(session => `<div>${esc(session.title)} · ${session.streaming ? "working" : "idle"}</div>`).join("")}</div>` : "";
    let title = "", body = "", options = "", action = "Confirm";
    if (c.type === "restartWorker") {
      title = `Restart ${esc(c.name)}?`;
      body = "Its worker gets a fresh pod and reruns startup. Its disk is kept.";
      action = "Restart worker";
    } else if (c.type === "resetWorker") {
      title = `Reset ${esc(c.name)}?`;
      body = "This wipes the worker's disk, including its project checkout and any uncommitted work. Add the project again afterwards.";
      options = `<label class="confirm-typed"><span>Type <code>${esc(c.name)}</code> to confirm</span><input class="settings-inline-input" data-confirm-typed value="${esc(this.typed || "")}" autocomplete="off" spellcheck="false"></label>`;
      action = "Reset worker";
    } else if (c.type === "deleteWorker") {
      title = `Delete ${esc(c.name)}?`;
      body = "Deletes the worker, so its project and sessions leave the list. Its disk (checkout, sessions, unpushed work) is kept, so adding the repository again picks it back up.";
      options = `<label class="confirm-check"><input type="checkbox" data-confirm-purge ${c.purge ? "checked" : ""}><span>Also delete its disk, including uncommitted and unpushed work</span></label>`;
      action = c.purge ? "Delete worker and disk" : "Delete worker";
    } else if (c.type === "close") {
      title = c.kind === "chat" ? "Close chat" : "Close session";
      body = `“${esc(c.label)}” will be archived. Its transcript and Git context remain available.`;
      action = c.kind === "chat" ? "Close chat" : "Close session";
    } else if (c.type === "merge") {
      title = `Merge ${esc(c.branch)} to ${esc(primary)}?`;
      body = `This merges into the local ${esc(primary)} checkout, returns affected sessions to it, and deletes the local branch and worktree. It does not push.`;
      options = sessions.length ? `<div class="confirm-warn">${sessions.length} session${sessions.length === 1 ? "" : "s"} will return to ${esc(primary)} after the merge.</div>` : "";
      action = "Merge locally";
    } else if (c.type === "push") {
      title = `Push ${esc(c.branch)}?`;
      body = `Push ${c.commitCount} commit${c.commitCount === 1 ? "" : "s"} from ${esc(c.branch)} to ${esc(c.upstream)}.`;
      options = c.commits?.length
        ? `<div class="confirm-commits"><strong>Commits to push</strong>${c.commits.map(commit => `<div><code>${esc(commit.shortHash || commit.hash?.slice(0, 7) || "commit")}</code><span>${esc(commit.subject || "(no subject)")}</span></div>`).join("")}${c.commitCount > c.commits.length ? `<small>Showing ${c.commits.length} of ${c.commitCount} commits.</small>` : ""}</div>`
        : `<div class="confirm-warn">No new commits are ahead of ${esc(c.upstream)}.</div>`;
      action = "Push commits";
    } else {
      title = `Delete ${esc(c.branch)}?`;
      body = `The local branch and worktree will be deleted. Remote branches are not affected.${activeSessions.length ? " Working sessions will be interrupted." : ""}`;
      options = `${sessions.length ? `<div class="confirm-warn">Affected sessions will move to ${esc(primary)} unless you choose to close them.</div>` : ""}${activeSessions.length ? `<label class="confirm-check"><input type="checkbox" data-confirm-close-sessions ${c.closeSessions ? "checked" : ""}><span>Close affected sessions instead of moving them to ${esc(primary)}</span></label>` : ""}${c.dirty ? `<label class="confirm-check"><input type="checkbox" data-confirm-force ${c.force ? "checked" : ""}><span>I understand uncommitted changes will be deleted</span></label>` : ""}`;
      action = "Delete branch";
    }
    const disabled = this.busy || (c.type === "deleteBranch" && c.dirty && !c.force) || (c.type === "push" && !c.commitCount) || (c.type === "resetWorker" && this.typed !== c.name);
    const progressOperation = c.type === "deleteBranch" ? operationFor("delete", { sessionId: c.id }) : ["merge", "push"].includes(c.type) ? operationFor(c.type, { sessionId: c.id }) : null;
    const progressHint = operationHint(progressOperation, this.busyLabel || "Working…") || this.busyLabel || "Working…";
    const progress = this.busy
      ? `<div class="confirm-progress" role="status" aria-live="polite"><i class="operation-dot" aria-hidden="true"></i><span>${esc(progressHint)}</span></div>`
      : "";
    this.innerHTML = `<div class="confirm-scrim"><div class="confirm-modal" role="dialog" aria-modal="true" aria-busy="${this.busy}"><div class="confirm-title">${title}</div><div class="confirm-body">${body}${sessionList}${options}</div>${c.error ? `<div class="confirm-error">${esc(c.error)}</div>` : ""}<div class="confirm-actions"><div class="confirm-button-row"><button class="confirm-back" data-act="cancel">Go back</button><button class="confirm-cta danger" data-act="go" ${disabled ? "disabled" : ""}>${this.busy ? "Working…" : action}</button></div>${progress}</div></div></div>`;
  }
}


class PiExtensionUI extends HTMLElement {
  connectedCallback() {
    this.busy = false;
    this.busyOwner = null;
    this.draft = null;
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.addEventListener("click", e => this.onClick(e));
    this.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.preventDefault();
        void this.cancel();
      } else if (e.key === "Enter" && e.target.matches("input")) {
        e.preventDefault();
        void this.submit({ value: e.target.value });
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.matches("textarea")) {
        e.preventDefault();
        void this.submit({ value: e.target.value });
      }
    });
    this.render();
  }

  disconnectedCallback() { this.unsub?.(); }

  request() {
    const request = store.state.extensionUi;
    return request && request.sessionId === store.activeKey() ? request : null;
  }

  owns(request, draft) {
    const current = this.request();
    return this.draft === draft && this.busyOwner === draft
      && current?.sessionId === request.sessionId && current?.requestId === request.requestId;
  }

  async onClick(e) {
    const request = this.request();
    if (!request || this.busy) return;
    if (e.target.matches(".extension-ui-scrim") || e.target.closest("[data-extension-ui-cancel]")) return this.cancel();
    const option = e.target.closest("[data-extension-ui-option]");
    if (option) {
      const value = request.options?.[Number(option.dataset.extensionUiOption)];
      if (typeof value === "string") return this.submit({ value });
    }
    if (e.target.closest("[data-extension-ui-submit]")) {
      const field = this.querySelector("[data-extension-ui-value]");
      return this.submit(request.method === "confirm"
        ? { confirmed: true }
        : { value: field?.value || "" });
    }
  }

  async submit(body) {
    const request = this.request();
    if (!request || this.busy) return;
    const draft = this.draft;
    const field = this.querySelector("[data-extension-ui-value]");
    if (field && draft?.sessionId === request.sessionId && draft.requestId === request.requestId) draft.value = field.value;
    if (!draft) return;
    this.busy = true;
    this.busyOwner = draft;
    this.render();
    try {
      await api.extensionUiResponse(request.sessionId, request.requestId, body);
      if (!this.owns(request, draft)) return;
      this.busy = false;
      this.busyOwner = null;
      this.draft = null;
      store.set({ extensionUi: null });
    } catch (error) {
      if (!this.owns(request, draft)) return;
      this.busy = false;
      this.busyOwner = null;
      store.setError(`Extension UI response failed: ${error.message || error}`);
      this.render();
    }
  }

  async cancel() {
    const request = this.request();
    if (!request || this.busy) return;
    const draft = this.draft;
    if (!draft) return;
    this.busy = true;
    this.busyOwner = draft;
    this.render();
    try { await api.extensionUiCancel(request.sessionId, request.requestId); }
    catch (error) {
      if (this.owns(request, draft)) store.setError(`Could not cancel extension UI: ${error.message || error}`);
    } finally {
      if (!this.owns(request, draft)) return;
      this.busy = false;
      this.busyOwner = null;
      this.draft = null;
      store.set({ extensionUi: null });
    }
  }

  render() {
    const request = this.request();
    if (!request) {
      this.draft = null;
      this.busy = false;
      this.busyOwner = null;
      setHTML(this, "");
      return;
    }
    const identityChanged = !this.draft || this.draft.sessionId !== request.sessionId || this.draft.requestId !== request.requestId;
    if (identityChanged) {
      this.draft = { sessionId: request.sessionId, requestId: request.requestId, value: request.prefill || "" };
      this.busy = false;
      this.busyOwner = null;
    }
    const draft = this.draft;
    const oldField = this.querySelector("[data-extension-ui-value]");
    const active = document.activeElement;
    if (!identityChanged && oldField) draft.value = oldField.value;
    let focusSelector = null;
    let selection = null;
    if (!identityChanged && this.contains(active)) {
      if (active.matches("[data-extension-ui-value]")) {
        focusSelector = "[data-extension-ui-value]";
        selection = [active.selectionStart, active.selectionEnd, active.selectionDirection];
      } else if (active.matches("[data-extension-ui-option]")) {
        focusSelector = `[data-extension-ui-option="${active.dataset.extensionUiOption}"]`;
      } else if (active.matches("[data-extension-ui-submit]")) focusSelector = "[data-extension-ui-submit]";
      else if (active.matches("[data-extension-ui-cancel]")) focusSelector = "[data-extension-ui-cancel]";
    }
    const method = request.method;
    const title = esc(request.title || "Pi extension");
    let body;
    let actions = `<button class="confirm-back" data-extension-ui-cancel ${this.busy ? "disabled" : ""}>Cancel</button>`;
    if (method === "select") {
      const options = (request.options || []).map((option, index) => `<button class="extension-ui-option" data-extension-ui-option="${index}" ${this.busy ? "disabled" : ""}>${esc(option)}</button>`).join("");
      body = `<div class="extension-ui-options">${options || `<div class="modal-empty">No options available.</div>`}</div>`;
    } else if (method === "confirm") {
      body = `<p class="extension-ui-message">${esc(request.message || "")}</p>`;
      actions += `<button class="confirm-cta accent" data-extension-ui-submit ${this.busy ? "disabled" : ""}>Confirm</button>`;
    } else {
      const multiline = method === "editor";
      const field = multiline
        ? `<textarea data-extension-ui-value rows="8" placeholder="${esc(request.placeholder || "")}" ${this.busy ? "readonly" : ""}></textarea>`
        : `<input data-extension-ui-value placeholder="${esc(request.placeholder || "")}" autocomplete="off" ${this.busy ? "readonly" : ""}>`;
      body = `<label class="extension-ui-field"><span>${multiline ? "Edit" : "Value"}</span>${field}</label>`;
      actions += `<button class="confirm-cta accent" data-extension-ui-submit ${this.busy ? "disabled" : ""}>Continue</button>`;
    }
    const html = `<div class="extension-ui-scrim"><section class="extension-ui-modal" role="dialog" aria-modal="true" aria-busy="${this.busy}" aria-label="${title}"><div class="extension-ui-head"><div class="modal-title">${title}</div></div><div class="extension-ui-body">${body}</div>${actions ? `<div class="extension-ui-actions">${actions}</div>` : ""}</section></div>`;
    const changed = setHTML(this, html);
    const field = this.querySelector("[data-extension-ui-value]");
    if (field && field.value !== draft.value) field.value = draft.value;
    if (identityChanged) this.querySelector("[data-extension-ui-value], [data-extension-ui-option]")?.focus();
    else if (changed && focusSelector) {
      const target = this.querySelector(focusSelector);
      target?.focus();
      if (selection && target?.matches("[data-extension-ui-value]")) target.setSelectionRange(...selection);
    }
  }
}

customElements.define("pi-logs", PiLogs);
customElements.define("pi-confirm", PiConfirm);
customElements.define("pi-extension-ui", PiExtensionUI);
