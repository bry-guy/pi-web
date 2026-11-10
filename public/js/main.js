import "./shell.js";
import "./thread.js";
import "./dialogs.js";
import "./session-picker.js";
import "./project-menu.js";
import { settingsRoute } from "./settings.js";
import "./files.js";
import "./repo-picker.js";
import "./app.js";
import { connectSSE, openTranscript, paintCachedState, refreshState, resumeConnection } from "./api.js";
import { store } from "./store.js";
import { openSavedSelectionEarly, restoreLastSelection, selectChat, selectSession, selectSessionById, urlSessionId } from "./shell.js";

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
// Back and Forward between sessions: open the one the URL names (a removed one leaves the view as it is).
window.addEventListener("popstate", () => {
  const id = urlSessionId();
  if (id && id !== store.activeKey()) selectSessionById(id, { history: "none" });
});
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

// Open the session the URL names, else the last selected one; fall back to the most recent chat, then a project session.
// Startup selections replace the URL rather than adding Back steps.
const s = store.state;
const startup = { history: "replace" };
const urlId = urlSessionId();
if (!s.fatalError && store.activeKey() && store.activeKey() !== earlyId) {
  // The user picked another conversation while startup state was loading; keep it.
} else if (!s.fatalError && urlId && urlId !== earlyId && selectSessionById(urlId, startup)) {
  // The URL named a conversation other than the saved one, and it still exists.
} else if (!s.fatalError && earlyId && restoreLastSelection(startup)) {
  // Saved conversation still exists; restoreLastSelection() applied its full selection.
} else if (!s.fatalError && earlyId && store.activeKey() === earlyId) {
  // Saved conversation was closed or moved: drop the stale early selection, then fall back.
  store.set({ chatId: null, sessionId: null, projectId: null, model: s.effectiveDefaultModel || null, requestedModel: null, modelFallback: false, modelUnavailable: false });
  if (s.chats[0]) selectChat(s.chats[0].id, startup);
} else if (!s.fatalError && !restoreLastSelection(startup) && s.chats[0]) selectChat(s.chats[0].id, startup);
// A deep link such as #settings/workers opens after the startup selection above.
const route = settingsRoute(location.hash);
if (route) store.set(route);
else if (!s.fatalError && !store.activeKey()) {
  const p = s.projects[0];
  if (p?.sessions[0]) { store.state.openTree[p.id] = true; selectSession(p.id, p.sessions[0].id, startup); }
  else store.notify("state");
}
