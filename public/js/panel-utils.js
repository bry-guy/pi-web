import { api } from "./api.js";
import { beginOperation, completeOperation, operationFor, operationHint } from "./operations.js";
import { store } from "./store.js";
import { esc } from "./shell.js";


export const gitErrorMessage = error => ({
  bad_branch: "Enter a valid Git branch name.",
  no_such_context: "That Git context is no longer available.",
  no_project_for_session: "This session is no longer attached to a project.",
  checkout_dirty: "The primary checkout has uncommitted changes.",
  workspace_dirty: "Clean this workspace before continuing.",
  git_status_unavailable: "Git status is unavailable; check the workspace and try again.",
  main_worktree_external: "The primary branch is checked out by another worktree.",
  main_fetch_failed: "Could not fetch the primary branch's upstream.",
  git_fetch_failed: "Git could not fetch the repository.",
  main_not_fast_forwardable: "The primary branch has diverged; reconcile it before continuing.",
  git_switch_failed: "Git could not switch the checkout.",
  merge_conflict: "Git reported a merge conflict; the merge was aborted.",
  git_pull_failed: "Git could not pull this branch.",
  git_push_failed: "Git could not push this branch.",
  push_preview_failed: "The commits to push could not be listed.",
  push_preview_stale: "The branch changed; review the commits to push again.",
  detached_head: "This workspace is detached and has no branch to push.",
  branch_delete_failed: "Git could not delete this branch.",
  sessions_active: "Stop active sessions before changing this branch.",
  merge_rehome_failed: "The merge landed, but sessions could not return to the primary branch.",
  merge_cleanup_failed: "The merge landed, but the source branch could not be removed.",
}[error?.error] || error?.detail || error?.message || error?.error || "Git operation failed.");

export const workerErrorMessage = error => ({
  workspace_busy: "This worker is busy. Wait until it is idle, then try again.",
  asleep: "This worker is asleep. Open one of its projects to wake it first.",
  confirm_required: "Type the worker's name to confirm.",
  workspace_unavailable: "The worker is not responding.",
  workspaced_unavailable: "The worker service is unavailable.",
}[error?.error] || error?.message || error?.error || "The worker action failed.");

export function operationFeedback(kinds, fallback = "Working…") {
  const operation = operationFor(kinds);
  if (!operation) return "";
  const status = operation.status === "error" ? "error" : operation.status === "success" ? "success" : "running";
  const dot = status === "running" ? `<i class="operation-dot" aria-hidden="true"></i>` : `<i class="operation-state-dot" aria-hidden="true"></i>`;
  return `<span class="operation-hint ${status}" data-operation-hint="${esc(operation.kind)}">${dot}<span>${esc(operationHint(operation, fallback))}</span></span>`;
}

export const pickerOperationKinds = new Set(["setup", "hook", "check", "fetch", "create", "create-session", "create-project", "fork", "fork-session", "switch", "switch-session", "push", "push-preview", "merge", "delete"]);

export function runningPickerOperation(kind, sessionId, title = null) {
  return (store.state.operations || []).find(operation => operation.status === "running"
    && operation.kind === kind
    && operation.sessionId === sessionId
    && (!title || operation.title === title));
}

export function pickerError(message, owner = null) {
  if (owner && store.state.sessionPicker === owner) store.set({ sessionPickerError: message });
  else store.setError(message);
}

export function launchSetup(sessionId, initial) {
  if (!initial?.setupNeeded) return;
  const operation = beginOperation("setup", "Setup", "", "Starting setup…", sessionId, { action: "setup" });
  void api.hook(sessionId, "setup", operation.id)
    .then(result => completeOperation(operation, result))
    .catch(error => {
      completeOperation(operation, {}, error);
      pickerError(`Setup failed: ${error.error || error.message || error}`);
    });
}

export function pickerOperationFeed(picker) {
  const sourceId = picker?.sourceSessionId || null;
  const operations = (store.state.operations || []).filter(operation => pickerOperationKinds.has(operation.kind)
    && (sourceId ? operation.sessionId === sourceId : !operation.sessionId));
  const events = operations.flatMap((operation, operationIndex) => {
    const values = operation.events?.length ? [...operation.events] : [];
    const current = operationHint(operation);
    const last = values.at(-1);
    const lastValue = last?.message || last?.output || "";
    if (current && (!last || ["Request started.", "Result received."].includes(lastValue) && current !== lastValue)) {
      values.push({ at: operation.lastUpdatedAt || operation.finishedAt || operation.startedAt, message: current, type: "current" });
    }
    return (values.length ? values : [{ at: operation.lastUpdatedAt || operation.startedAt, message: current }])
      .map((event, eventIndex) => ({ operation, event, order: operationIndex * 1000 + eventIndex }));
  }).sort((a, b) => (Number(a.event.at || 0) - Number(b.event.at || 0)) || (a.order - b.order)).slice(-12);
  if (!events.length) return "";
  const rows = events.map(({ operation, event }) => {
    const message = event.message || event.output || event.type || operationHint(operation);
    return `<div class="session-operation-event ${event.type === "error" ? "error" : ""}" data-operation-kind="${esc(operation.kind)}" data-operation-hint="${esc(operation.kind)}">${esc(message)}</div>`;
  }).join("");
  return `<div class="session-operation-feed" role="log" aria-live="polite">${rows}</div>`;
}

export function featureBranchForName(value) {
  const slug = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug ? `feature/${slug}` : "";
}
