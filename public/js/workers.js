// One worker's card and actions, shared by Settings → Workers and the session panel.
import { api, refreshState, refreshWorkers } from "./api.js";
import { store } from "./store.js";
import { esc, workerStateLabel } from "./shell.js";
import { workerErrorMessage } from "./panel-utils.js";

const amounts = values => Object.entries(values || {}).filter(([, value]) => value).map(([key, value]) => `${key} ${value}`).join(" · ") || "not set";

export function workerCard(worker, usageAvailable, { canDelete = true } = {}) {
  const name = esc(worker.name);
  const state = workerStateLabel(worker.state);
  const asleep = worker.state === "sleeping";
  const usage = usageAvailable && worker.usage
    ? `${worker.usage.cpuMillicores}m CPU · ${Math.round(worker.usage.memoryBytes / 1048576)} MiB memory`
    : "n/a";
  const grant = worker.grant;
  const grantFacts = grant ? `
      <div class="worker-fact"><dt>Grant</dt><dd>${esc(grant.name)}${grant.description ? `<small>${esc(grant.description)}</small>` : ""}</dd></div>
      <div class="worker-fact"><dt>Service account</dt><dd>${esc(grant.serviceAccount || "default")} in ${esc(grant.namespace || "default")}</dd></div>
      <div class="worker-fact"><dt>Egress</dt><dd>${esc(grant.egress || "default")}</dd></div>
      <div class="worker-fact"><dt>Env variables</dt><dd>${grant.env?.length ? grant.env.map(esc).join(", ") : "none"}<small>Names only. Values are not shown.</small></dd></div>`
    : `<div class="worker-fact"><dt>Grant</dt><dd>default</dd></div>`;
  return `<div class="settings-card settings-card-spaced worker-card" data-worker="${name}">
      <div class="settings-row">
        <div class="sr-main"><div class="sr-title">${name}<span class="worker-state ${state}">${esc(state)}</span>${worker.busy ? `<span class="worker-state busy">busy</span>` : ""}</div><div class="sr-sub">${esc(worker.repository || "Plain chats (no repository)")}</div></div>
      </div>
      <div class="settings-row">
        <div class="sr-main"><div class="sr-title">Keep awake</div><div class="sr-sub">Never put to sleep automatically.</div></div>
        <button class="settings-action${worker.keepAwake ? " active" : ""}" data-act="keep-awake-worker" data-name="${name}" data-pinned="${worker.keepAwake ? 1 : 0}" aria-pressed="${!!worker.keepAwake}">${worker.keepAwake ? "On" : "Off"}</button>
      </div>
      <dl class="worker-facts">
        <div class="worker-fact"><dt>Last used</dt><dd>${worker.lastUsed ? esc(new Date(worker.lastUsed).toLocaleString()) : "never"}</dd></div>
        <div class="worker-fact"><dt>Requests</dt><dd>${esc(amounts(worker.resources?.requests))}</dd></div>
        <div class="worker-fact"><dt>Limits</dt><dd>${esc(amounts(worker.resources?.limits))}</dd></div>
        <div class="worker-fact"><dt>Usage now</dt><dd>${esc(usage)}</dd></div>
        ${grantFacts}
      </dl>
      <div class="settings-row settings-actions-row"><span class="settings-mono">${asleep ? "Asleep. Opening one of its projects wakes it." : ""}</span>
        <div class="settings-actions">
          <button class="settings-action" data-act="reload-worker" data-name="${name}" ${asleep ? "disabled" : ""}>Reload</button>
          <button class="settings-action" data-act="restart-worker" data-name="${name}">Restart</button>
          <button class="settings-action" data-act="stop-worker" data-name="${name}" ${asleep ? "disabled" : ""} title="Put it to sleep now. Its disk is kept and it wakes on use.">Stop</button>
          <button class="settings-action danger" data-act="reset-worker" data-name="${name}">Reset</button>
          ${canDelete ? `<button class="settings-action danger" data-act="delete-worker" data-name="${name}">Delete</button>` : ""}
        </div>
      </div>
    </div>`;
}

// Disruptive actions open a confirmation; the rest act directly and report through `notify(message, kind)`.
export async function workerAction(action, name, pinned, notify) {
  if (action === "restart-worker" || action === "reset-worker") {
    store.set({ confirm: { type: action === "reset-worker" ? "resetWorker" : "restartWorker", id: name, name } });
    return;
  }
  if (action === "delete-worker") {
    const project = store.state.projects.find(item => item.workspace === name);
    store.set({ confirm: { type: "deleteWorker", id: name, name, projectId: project?.id || null, purge: false, error: null } });
    return;
  }
  try {
    if (action === "keep-awake-worker") await api.pinWorkspace(name, !pinned);
    else if (action === "stop-worker") await api.sleepWorkspace(name);
    else await api.reloadWorkspace(name);
    notify(action === "keep-awake-worker" ? `Keep awake ${pinned ? "off" : "on"} for ${name}.` : action === "stop-worker" ? `${name} is asleep.` : `${name} reloaded.`);
    if (action === "stop-worker") void refreshState().catch(() => {});
  } catch (err) {
    notify(`${name}: ${workerErrorMessage(err)}`, "error");
  }
  await refreshWorkers();
}
