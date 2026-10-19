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
    if (c.type === "restartWorker" || c.type === "resetWorker" || c.type === "deleteWorker" || c.type === "removeProject") return this.goWorker(c);
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
      else if (c.type === "removeProject") await (c.workspace ? api.deleteWorkspace(c.workspace, !!c.purge) : api.removeProject(c.projectId));
      else await api.restartWorkspace(c.name);
      store.set({ confirm: null });
      if (c.type === "deleteWorker" || c.type === "removeProject") {
        if (c.projectId && store.state.projectId === c.projectId) store.set({ projectId: null, sessionId: null, sessionPicker: null });
        await refreshState();
      }
      await refreshWorkers();
    } catch (err) {
      const active = store.state.confirm;
      if (active?.id === c.id && active.type === c.type) store.set({ confirm: { ...active, error: workerErrorMessage(err) } });
      else store.setError(`Could not ${{ resetWorker: "reset", deleteWorker: "delete", removeProject: "remove" }[c.type] || "restart"} ${c.name}: ${workerErrorMessage(err)}`);
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
    } else if (c.type === "removeProject") {
      title = `Remove ${esc(c.name)}?`;
      body = c.workspace
        ? "Deletes its worker, so the project and its sessions leave the list. Its disk (checkout, sessions, unpushed work) is kept, so adding the repository again picks it back up."
        : "Ends its sessions and removes it from the list. The checkout on disk is kept, so adding the repository again picks it back up.";
      if (c.workspace) options = `<label class="confirm-check"><input type="checkbox" data-confirm-purge ${c.purge ? "checked" : ""}><span>Also delete its disk, including uncommitted and unpushed work</span></label>`;
      action = c.purge ? "Remove project and disk" : "Remove project";
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


/**
 * Questions from Pi and its extensions (select, confirm, input, editor), shown as a card above
 * the composer instead of a modal: the conversation stays usable, and the card stays with its
 * session when you switch away. It goes away when answered, dismissed, or no longer waiting.
 *
 * ask_user_question reaches the browser as one select (or, for multi-select, one input) per
 * question with numbered "N. label — description" lines and a trailing "Type something." row;
 * that shape is parsed into option rows, checkboxes and an inline answer field. A typed answer
 * picks "Type something." and then fills in the text prompt the questionnaire asks next.
 */
const OPTION_LINE = /^(\d+)\.\s+(.+?)(?:\s+—\s+(.*))?$/s;

export function parseQuestion(request) {
  let title = String(request.title || "");
  let header = null;
  const tagged = /^\[([^\]\n]+)\]\s+/.exec(title);
  if (tagged) { header = tagged[1]; title = title.slice(tagged[0].length); }
  let preview = "";
  const previewAt = title.indexOf("\n\n--- ");
  if (previewAt >= 0) { preview = title.slice(previewAt + 2); title = title.slice(0, previewAt); }
  const parsed = { header, question: title.trim(), preview, options: [], otherIndex: -1, multi: false };
  if (request.method === "select") {
    const options = request.options || [];
    parsed.options = options.map((line, index) => {
      const match = OPTION_LINE.exec(line);
      return match && Number(match[1]) === index + 1 ? { label: match[2], description: match[3] || "" } : { label: line, description: "" };
    });
    // The questionnaire's last row is a bare "N. Type something." with no description.
    const numbered = options.every((line, index) => OPTION_LINE.exec(line)?.[1] === String(index + 1));
    const last = parsed.options.at(-1);
    if (numbered && options.length > 1 && last && !last.description && parsed.options.slice(0, -1).every(option => option.description)) parsed.otherIndex = options.length - 1;
  } else if (request.method === "input") {
    // Multi-select arrives as an input whose title lists the numbered options, then instructions.
    const [question, list, ...rest] = parsed.question.split("\n\n");
    const lines = (list || "").split("\n");
    // (The text prompt after "Type something." repeats the list too, but has no placeholder.)
    if (request.placeholder && rest.length && lines.every((line, index) => OPTION_LINE.exec(line)?.[1] === String(index + 1))) {
      parsed.question = question;
      parsed.options = lines.map(line => { const match = OPTION_LINE.exec(line); return { label: match[2], description: match[3] || "" }; });
      parsed.multi = true;
    }
  }
  return parsed;
}

class PiExtensionUI extends HTMLElement {
  connectedCallback() {
    this.busy = false;
    this.draftKey = null;
    this.unsub = store.subscribe(w => { if (w === "state") this.render(); });
    this.addEventListener("click", e => void this.onClick(e));
    this.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        void this.cancel();
      } else if (e.key === "Enter" && e.target.matches("input[data-extension-ui-value]")) {
        e.preventDefault();
        void this.submitField();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.matches("textarea")) {
        e.preventDefault();
        void this.submitField();
      }
    });
    this.render();
  }

  disconnectedCallback() { this.unsub?.(); }

  request() { return store.state.asks?.[store.activeKey()] || null; }

  done(request) {
    const asks = { ...store.state.asks };
    if (asks[request.sessionId]?.requestId === request.requestId) delete asks[request.sessionId];
    store.set({ asks });
  }

  async onClick(e) {
    const request = this.request();
    if (!request || this.busy) return;
    if (e.target.closest("[data-extension-ui-cancel]")) return this.cancel();
    const option = e.target.closest("[data-extension-ui-option]");
    if (option) {
      const value = request.options?.[Number(option.dataset.extensionUiOption)];
      if (typeof value === "string") return this.send(request, { value });
    }
    const confirm = e.target.closest("[data-extension-ui-confirm]");
    if (confirm) return this.send(request, { confirmed: confirm.dataset.extensionUiConfirm === "yes" });
    if (e.target.closest("[data-extension-ui-submit]")) return this.submitField();
  }

  submitField() {
    const request = this.request();
    if (!request || this.busy) return;
    const question = parseQuestion(request);
    const text = this.querySelector("[data-extension-ui-value]")?.value || "";
    if (question.multi) {
      const picked = [...this.querySelectorAll("[data-extension-ui-check]:checked")].map(box => box.dataset.extensionUiCheck);
      return this.send(request, { value: text.trim() ? `${picked.join(",")}; ${text.trim()}` : picked.join(",") });
    }
    if (request.method === "select") {
      if (!text.trim() || question.otherIndex < 0) return;
      this.followUp = { sessionId: request.sessionId, question: question.question, text: text.trim(), until: Date.now() + 15_000 };
      return this.send(request, { value: request.options[question.otherIndex] });
    }
    return this.send(request, { value: text });
  }

  async send(request, body) {
    // Only this question's request may release the busy state; a newer question resets it.
    const key = `${request.sessionId}:${request.requestId}`;
    this.busy = true;
    this.busyKey = key;
    this.render();
    try {
      await api.extensionUiResponse(request.sessionId, request.requestId, body);
      this.done(request);
    } catch (error) {
      // No longer waiting (answered elsewhere, timed out, or the turn ended): just clear it.
      if (error.error === "stale_extension_ui_request") this.done(request);
      else store.setError(`Could not send the answer: ${error.message || error.error || error}`);
    } finally {
      if (this.busyKey === key) { this.busy = false; this.busyKey = null; }
      this.render();
    }
  }

  async cancel() {
    const request = this.request();
    if (!request || this.busy) return;
    this.busy = true;
    this.render();
    try { await api.extensionUiCancel(request.sessionId, request.requestId); } catch { /* already gone */ }
    this.busy = false;
    this.done(request);
  }

  render() {
    const request = this.request();
    if (!request) { this.draftKey = null; setHTML(this, ""); return; }
    const key = `${request.sessionId}:${request.requestId}`;
    const follow = this.followUp;
    if (follow && request.method === "input" && !request.placeholder && follow.sessionId === request.sessionId
      && Date.now() < follow.until && parseQuestion(request).question.startsWith(follow.question)) {
      // The questionnaire's "type your answer" prompt: answer it with what was already typed.
      this.followUp = null;
      this.autoKey = key;
      void this.send(request, { value: follow.text });
    }
    if (this.autoKey === key) { setHTML(this, ""); return; }
    const fresh = this.draftKey !== key;
    // Keep what was typed (and checked) across re-renders of the same question.
    const oldField = this.querySelector("[data-extension-ui-value]");
    const typed = fresh ? (request.prefill || "") : oldField?.value ?? "";
    const checked = fresh ? new Set() : new Set([...this.querySelectorAll("[data-extension-ui-check]:checked")].map(box => box.dataset.extensionUiCheck));
    const hadFocus = !fresh && document.activeElement === oldField;
    if (fresh && this.busyKey !== key) { this.busy = false; this.busyKey = null; }
    this.draftKey = key;
    const q = parseQuestion(request);
    const off = this.busy ? "disabled" : "";
    const ro = this.busy ? "readonly" : "";
    const head = `<div class="ask-head"><strong>${esc(q.header || (request.method === "confirm" ? "Confirm" : "Pi is asking"))}</strong><button class="ask-dismiss" data-extension-ui-cancel ${off} title="Dismiss (Esc)" aria-label="Dismiss">×</button></div>`;
    const question = q.question ? `<p class="ask-question">${esc(q.question)}</p>` : "";
    const preview = q.preview ? `<details class="ask-preview"><summary>Previews</summary><pre>${esc(q.preview)}</pre></details>` : "";
    const optionText = option => `<strong>${esc(option.label)}</strong>${option.description ? `<small>${esc(option.description)}</small>` : ""}`;
    let body;
    if (request.method === "select") {
      body = `<div class="ask-options">${q.options.map((option, index) => index === q.otherIndex ? "" : `<button class="ask-option" data-extension-ui-option="${index}" ${off}>${optionText(option)}</button>`).join("")}</div>`;
      if (q.otherIndex >= 0) body += `<div class="ask-field"><input data-extension-ui-value placeholder="Or type your own answer" autocomplete="off" ${ro}><button class="btn btn-secondary" data-extension-ui-submit ${off}>Send</button></div>`;
    } else if (request.method === "confirm") {
      body = `${request.message ? `<p class="ask-message">${esc(request.message)}</p>` : ""}<div class="ask-actions"><button class="btn btn-ghost" data-extension-ui-confirm="no" ${off}>No</button><button class="btn btn-primary" data-extension-ui-confirm="yes" ${off}>Yes</button></div>`;
    } else if (q.multi) {
      body = `<div class="ask-options">${q.options.map((option, index) => `<label class="ask-option ask-check"><input type="checkbox" data-extension-ui-check="${index + 1}" ${checked.has(String(index + 1)) ? "checked" : ""} ${off}><span>${optionText(option)}</span></label>`).join("")}</div>
        <div class="ask-field"><input data-extension-ui-value placeholder="Anything to add (optional)" autocomplete="off" ${ro}><button class="btn btn-primary" data-extension-ui-submit ${off}>Send</button></div>`;
    } else {
      const field = request.method === "editor"
        ? `<textarea data-extension-ui-value rows="6" placeholder="${esc(request.placeholder || "")}" ${ro}></textarea>`
        : `<input data-extension-ui-value placeholder="${esc(request.placeholder || "")}" autocomplete="off" ${ro}>`;
      body = `<div class="ask-field ${request.method === "editor" ? "multiline" : ""}">${field}<button class="btn btn-primary" data-extension-ui-submit ${off}>Send</button></div>`;
    }
    setHTML(this, `<div class="ask-dock"><section class="ask-card" role="region" aria-label="${esc(q.header || "Pi is asking")}" aria-busy="${this.busy}">${head}<div class="ask-body">${question}${preview}${body}</div></section></div>`);
    const field = this.querySelector("[data-extension-ui-value]");
    if (field && field.value !== typed) field.value = typed;
    if (hadFocus) field?.focus();
  }
}

customElements.define("pi-logs", PiLogs);
customElements.define("pi-confirm", PiConfirm);
customElements.define("pi-extension-ui", PiExtensionUI);
