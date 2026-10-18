import "./shell.js";
import "./thread.js";
import "./dialogs.js";
import "./session-picker.js";
import { settingsRoute } from "./settings.js";
import "./files.js";
import "./repo-picker.js";
import "./app.js";
import { connectSSE, openTranscript, paintCachedState, refreshState, resumeConnection } from "./api.js";
import { store } from "./store.js";
import { openSavedSelectionEarly, restoreLastSelection, selectChat, selectSession } from "./shell.js";

let updateReloadRequested = false;

async function loadUiConfig() {
  try {
    const response = await fetch("ui-config.json", { cache: "no-store" });
    if (!response.ok) return;
    const config = await response.json();
    if (config && typeof config === "object" && !Array.isArray(config)) store.set({ uiConfig: config });
  } catch {
    // The UI remains compatible with deployments that predate this endpoint.
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    const announceUpdate = worker => {
      if (navigator.serviceWorker.controller && worker) store.set({ updateAvailable: true });
    };
    if (registration.waiting) announceUpdate(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed") announceUpdate(worker);
      });
    });
    window.__piApplyUpdate = () => {
      updateReloadRequested = true;
      registration.waiting?.postMessage({ type: "SKIP_WAITING" });
      if (!registration.waiting) location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (updateReloadRequested) location.reload();
    });
  } catch {
    // The app remains fully usable when service workers are unavailable.
  }
}

window.addEventListener("offline", () => store.set({ offline: true, reconnecting: false }));
window.addEventListener("online", resumeConnection);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") resumeConnection(); });
window.addEventListener("pageshow", resumeConnection);
paintCachedState();
const uiConfig = loadUiConfig();
void registerServiceWorker();
connectSSE();
const earlyId = openSavedSelectionEarly();
try {
  await Promise.all([uiConfig, refreshState()]);
} catch {
  // PiApp renders the fatal restart prompt from store.state.fatalError.
}

// Restore the last selected session; fall back to the most recent chat, then a project session.
const s = store.state;
if (!s.fatalError && store.activeKey() && store.activeKey() !== earlyId) {
  // The user picked another conversation while startup state was loading; keep it.
} else if (!s.fatalError && earlyId && restoreLastSelection()) {
  // Saved conversation still exists; restoreLastSelection() applied its full selection.
} else if (!s.fatalError && earlyId && store.activeKey() === earlyId) {
  // Saved conversation was closed or moved: drop the stale early selection, then fall back.
  store.set({ chatId: null, sessionId: null, projectId: null, model: s.effectiveDefaultModel || null, requestedModel: null, modelFallback: false, modelUnavailable: false });
  if (s.chats[0]) selectChat(s.chats[0].id);
} else if (!s.fatalError && !restoreLastSelection() && s.chats[0]) selectChat(s.chats[0].id);
// A deep link such as #settings/workers opens after the startup selection above.
const route = settingsRoute(location.hash);
if (route) store.set(route);
else if (!s.fatalError && !store.activeKey()) {
  const p = s.projects[0];
  if (p?.sessions[0]) { store.state.openTree[p.id] = true; selectSession(p.id, p.sessions[0].id); }
  else store.notify("state");
}
