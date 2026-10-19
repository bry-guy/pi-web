import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://pi-web.test/",
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  customElements: dom.window.customElements,
  Node: dom.window.Node,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  CustomEvent: dom.window.CustomEvent,
  localStorage: dom.window.localStorage,
  location: dom.window.location,
  history: dom.window.history,
});

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => {
  const timer = realSetInterval(fn, ms, ...args);
  timer.unref?.();
  return timer;
};
const { store } = await import("../public/js/store.js");
const { api } = await import("../public/js/api.js");
await import("../public/js/panels.js");
globalThis.setInterval = realSetInterval;

function makeState() {
  return {
    projects: [],
    chats: [],
    buildId: "test",
    defaultModel: null,
    defaultThinkingLevel: "medium",
    effectiveDefaultModel: null,
    defaultModelStatus: "automatic",
    models: [],
    providers: [],
    piConfiguration: {
      config: { profile: "old-profile", profileSource: "explicit", packages: ["npm:one"], extensions: [] },
      profile: { status: "loaded", source: "old-profile", error: null },
      warnings: [],
      runtime: { extensions: [], skills: [], prompts: 0 },
    },
    repositorySources: { default: "local", sources: [{ id: "github", configured: true, authenticated: false }] },
    sync: { configured: true, connection: "available", implementation: "fake" },
    settings: {
      defaultRepositorySource: { value: "local", editable: true },
      githubOwner: { value: "owner", editable: true },
      sync: {
        serverUrl: { value: "https://sync.test", editable: true },
        allConversations: { value: false, editable: true },
      },
    },
    reposRoot: "~/src",
    reposRootSource: "config",
  };
}

let serverState;
let patchHandler;
let stateHandler;
let rootHandler;

async function applyPatch(patch) {
  if (patch.defaultThinkingLevel !== undefined) serverState.defaultThinkingLevel = patch.defaultThinkingLevel;
  if (patch.defaultRepositorySource !== undefined) serverState.settings.defaultRepositorySource.value = patch.defaultRepositorySource;
  if (patch.githubOwner !== undefined) serverState.settings.githubOwner.value = patch.githubOwner;
  if (patch.sync) {
    if (patch.sync.serverUrl !== undefined) serverState.settings.sync.serverUrl.value = patch.sync.serverUrl;
    if (patch.sync.allConversations !== undefined) serverState.settings.sync.allConversations.value = patch.sync.allConversations;
  }
  if (patch.pi) serverState.piConfiguration.config = patch.pi;
  return { defaultThinkingLevel: patch.defaultThinkingLevel, piConfiguration: serverState.piConfiguration };
}

function resetHandlers() {
  patchHandler = applyPatch;
  stateHandler = async () => structuredClone(serverState);
  rootHandler = async (_config, reposRoot) => {
    serverState.reposRoot = reposRoot;
    return { reposRoot, reposRootSource: "config" };
  };
}

api.settingsPatch = patch => patchHandler(patch);
api.state = () => stateHandler();
api.settings = (...args) => rootHandler(...args);
resetHandlers();

function mountSettings(category = "repositories") {
  serverState = makeState();
  store.set({ ...structuredClone(serverState), view: "settings", settingsCategory: category });
  const settings = document.createElement("pi-settings");
  document.body.append(settings);
  return settings;
}

function typeInto(control, value) {
  control.value = value;
  control.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function unmountSettings(settings) {
  settings.remove();
  store.set({ view: "chat", settingsCategory: null });
  resetHandlers();
}

// Drafts live on the element across category switches; only the active page's controls are rendered.
function showCategory(category) {
  store.set({ settingsCategory: category });
}

test("notifications preserve drafts, focus, selection, and details while refreshing untouched state", () => {
  const settings = mountSettings("repositories");
  const owner = settings.querySelector("[data-setting='githubOwner']");
  owner.focus();
  typeInto(owner, "draft-owner");
  owner.setSelectionRange(5, 5);

  store.set({ error: "not rendered by settings" });
  assert.strictEqual(settings.querySelector("[data-setting='githubOwner']"), owner);
  assert.equal(document.activeElement, owner);
  assert.equal(owner.selectionStart, 5);

  store.set({ providers: [{ id: "new-provider", name: "New provider" }] });
  assert.equal(settings.querySelector("[data-setting='githubOwner']").value, "draft-owner");
  assert.equal(document.activeElement, settings.querySelector("[data-setting='githubOwner']"));
  assert.equal(settings.querySelector("[data-setting='githubOwner']").selectionStart, 5);

  store.set({
    settings: {
      ...store.state.settings,
      githubOwner: { value: "server-owner", editable: true },
      defaultRepositorySource: { value: "github", editable: true },
    },
    reposRoot: "~/worktrees",
  });
  assert.equal(settings.querySelector("[data-setting='githubOwner']").value, "draft-owner");
  assert.equal(settings.querySelector("[data-setting='defaultRepositorySource']").value, "github");
  showCategory("defaults");
  assert.equal(settings.querySelector(".repos-root-input").value, "~/worktrees");

  showCategory("pi");
  settings.querySelector(".settings-advanced").open = true;
  store.set({ error: "not rendered by settings" });
  assert.equal(settings.querySelector(".settings-advanced").open, true);
  unmountSettings(settings);
});

test("textarea, select, checkbox, and newly disabled fields restore correctly", () => {
  const settings = mountSettings("pi");
  const packages = settings.querySelector("[data-setting='piPackages']");
  typeInto(packages, "npm:draft\nnpm:second");

  showCategory("repositories");
  const source = settings.querySelector("[data-setting='defaultRepositorySource']");
  source.value = "github";
  source.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  typeInto(settings.querySelector("[data-setting='githubOwner']"), "draft-owner");

  showCategory("sync");
  typeInto(settings.querySelector("[data-setting='syncServerUrl']"), "https://draft.test");
  const syncAll = settings.querySelector("[data-setting='syncAllConversations']");
  syncAll.value = "on";
  syncAll.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

  store.set({
    providers: [{ id: "new-provider", name: "New provider" }],
    piConfiguration: {
      ...store.state.piConfiguration,
      config: { ...store.state.piConfiguration.config, packages: ["npm:server"] },
    },
    settings: {
      ...store.state.settings,
      defaultRepositorySource: { value: "local", editable: true },
      githubOwner: { value: "new-owner", editable: false },
      sync: {
        serverUrl: { value: "https://server.test", editable: true },
        allConversations: { value: false, editable: true },
      },
    },
  });

  assert.equal(settings.querySelector("[data-setting='syncServerUrl']").value, "https://draft.test");
  assert.equal(settings.querySelector("[data-setting='syncAllConversations']").value, "on");
  showCategory("repositories");
  assert.equal(settings.querySelector("[data-setting='defaultRepositorySource']").value, "github");
  assert.equal(settings.querySelector("[data-setting='githubOwner']").value, "new-owner");
  assert.equal(settings.querySelector("[data-setting='githubOwner']").disabled, true);
  showCategory("pi");
  assert.equal(settings.querySelector("[data-setting='piPackages']").value, "npm:draft\nnpm:second");
  unmountSettings(settings);
});

test("successful repository save clears only submitted drafts and failed save retains them", async () => {
  let settings = mountSettings("pi");
  typeInto(settings.querySelector("[data-setting='piProfile']"), "draft-profile");
  showCategory("repositories");
  typeInto(settings.querySelector("[data-setting='githubOwner']"), "saved-owner");
  await settings.saveRepositorySettings();
  assert.equal(settings.querySelector("[data-setting='githubOwner']").value, "saved-owner");
  showCategory("pi");
  assert.equal(settings.querySelector("[data-setting='piProfile']").value, "draft-profile");
  store.set({ settings: {
    ...store.state.settings,
    githubOwner: { value: "server-owner", editable: true },
  } });
  showCategory("repositories");
  assert.equal(settings.querySelector("[data-setting='githubOwner']").value, "server-owner");
  unmountSettings(settings);

  settings = mountSettings("repositories");
  typeInto(settings.querySelector("[data-setting='githubOwner']"), "failed-owner");
  patchHandler = async () => { throw Object.assign(new Error("invalid owner"), { error: "invalid_github_owner" }); };
  await settings.saveRepositorySettings();
  store.set({ settings: {
    ...store.state.settings,
    githubOwner: { value: "server-after-failure", editable: true },
  } });
  assert.equal(settings.querySelector("[data-setting='githubOwner']").value, "failed-owner");
  unmountSettings(settings);
});

test("repos-root and Pi saves clear only successful section drafts", async () => {
  let settings = mountSettings("defaults");
  typeInto(settings.querySelector(".repos-root-input"), "~/saved-root");
  await settings.saveReposRoot();
  assert.equal(settings.querySelector(".repos-root-input").value, "~/saved-root");

  typeInto(settings.querySelector(".repos-root-input"), "~/failed-root");
  rootHandler = async () => { throw new Error("save failed"); };
  await settings.saveReposRoot();
  store.set({ reposRoot: "~/server-root" });
  assert.equal(settings.querySelector(".repos-root-input").value, "~/failed-root");
  unmountSettings(settings);

  settings = mountSettings("pi");
  typeInto(settings.querySelector("[data-setting='piProfile']"), "new-profile");
  typeInto(settings.querySelector("[data-setting='piPackages']"), "npm:new");
  typeInto(settings.querySelector("[data-setting='piExtensions']"), "/new-extension");
  await settings.savePiConfiguration();
  assert.equal(settings.querySelector("[data-setting='piProfile']").value, "new-profile");
  assert.equal(settings.querySelector("[data-setting='piPackages']").value, "npm:new");
  assert.equal(settings.querySelector("[data-setting='piExtensions']").value, "/new-extension");

  typeInto(settings.querySelector("[data-setting='piProfile']"), "failed-profile");
  patchHandler = async () => { throw Object.assign(new Error("failed apply"), { error: "pi_configuration_busy" }); };
  await settings.savePiConfiguration();
  store.set({ piConfiguration: {
    ...store.state.piConfiguration,
    config: { ...store.state.piConfiguration.config, profile: "server-profile" },
  } });
  assert.equal(settings.querySelector("[data-setting='piProfile']").value, "failed-profile");
  unmountSettings(settings);
});

test("edits typed during a save survive its successful response", async () => {
  const settings = mountSettings("repositories");
  typeInto(settings.querySelector("[data-setting='githubOwner']"), "submitted-owner");
  let finish;
  patchHandler = patch => new Promise(resolve => {
    finish = () => {
      serverState.settings.githubOwner.value = patch.githubOwner;
      resolve({});
    };
  });
  const saving = settings.saveRepositorySettings();
  typeInto(settings.querySelector("[data-setting='githubOwner']"), "newer-owner");
  finish();
  await saving;
  assert.equal(settings.querySelector("[data-setting='githubOwner']").value, "newer-owner");
  store.set({ settings: {
    ...store.state.settings,
    githubOwner: { value: "later-server-owner", editable: true },
  } });
  assert.equal(settings.querySelector("[data-setting='githubOwner']").value, "newer-owner");
  unmountSettings(settings);
});

test("close and reopen clears drafts without letting an old save clear new drafts", async () => {
  const settings = mountSettings("repositories");
  typeInto(settings.querySelector("[data-setting='githubOwner']"), "submitted-owner");
  let finish;
  patchHandler = patch => new Promise(resolve => {
    finish = () => {
      serverState.settings.githubOwner.value = patch.githubOwner;
      resolve({});
    };
  });
  const saving = settings.saveRepositorySettings();
  store.set({ view: "chat" });
  assert.notEqual(document.activeElement, settings.querySelector("[data-setting='githubOwner']"));
  store.set({ view: "settings" });
  assert.equal(settings.querySelector("[data-setting='githubOwner']").value, "owner");
  typeInto(settings.querySelector("[data-setting='githubOwner']"), "reopened-owner");
  finish();
  await saving;
  assert.equal(settings.querySelector("[data-setting='githubOwner']").value, "reopened-owner");
  unmountSettings(settings);
});

test("Pi drafts remain until state refresh completes and default-thinking autosave stays active", async () => {
  const settings = mountSettings("pi");
  let finishState;
  stateHandler = () => new Promise(resolve => {
    finishState = () => resolve(structuredClone(serverState));
  });
  typeInto(settings.querySelector("[data-setting='piProfile']"), "submitted-profile");
  const saving = settings.savePiConfiguration();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(typeof finishState, "function");
  assert.equal(settings.querySelector("[data-setting='piProfile']").value, "submitted-profile");
  typeInto(settings.querySelector("[data-setting='piProfile']"), "newer-profile");
  finishState();
  await saving;
  assert.equal(settings.querySelector("[data-setting='piProfile']").value, "newer-profile");
  stateHandler = async () => structuredClone(serverState);

  let savedPatch;
  patchHandler = async patch => {
    savedPatch = patch;
    serverState.defaultThinkingLevel = patch.defaultThinkingLevel;
    return { defaultThinkingLevel: patch.defaultThinkingLevel };
  };
  showCategory("defaults");
  const thinking = settings.querySelector("[data-setting='defaultThinkingLevel']");
  thinking.value = "high";
  thinking.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(savedPatch, { defaultThinkingLevel: "high" });
  assert.equal(store.state.defaultThinkingLevel, "high");
  store.set({ defaultThinkingLevel: "low" });
  assert.equal(settings.querySelector("[data-setting='defaultThinkingLevel']").value, "low");
  unmountSettings(settings);
});

test("secret auth prompts are not drafts and prompt identity replaces reused markup", () => {
  const settings = mountSettings("providers");
  settings.flow = { id: "flow-1", state: "waiting_input", prompt: { id: "prompt-1", type: "secret", message: "Enter code" } };
  settings.render();
  const input = settings.querySelector("[data-auth-input]");
  typeInto(input, "private-value");
  settings.flow = { id: "flow-2", state: "waiting_input", prompt: { id: "prompt-2", type: "secret", message: "Enter code" } };
  settings.render();
  assert.notStrictEqual(settings.querySelector("[data-auth-input]"), input);
  assert.equal(settings.querySelector("[data-auth-input]").value, "");
  typeInto(settings.querySelector("[data-auth-input]"), "private-value");
  store.set({ providers: [{ id: "new-provider", name: "New provider" }] });
  assert.equal(settings.querySelector("[data-auth-input]").value, "");
  assert.equal([...settings.drafts.values()].includes("private-value"), false);
  unmountSettings(settings);
});

test.after(() => dom.window.close());
