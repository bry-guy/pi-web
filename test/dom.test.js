import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import createDOMPurify from "dompurify";

const state = {
  apiContractVersion: 5,
  buildId: "test",
  capabilities: ["provider-auth", "github-device-auth", "repository-sources", "session-activity", "slash-commands", "project-hooks", "workspace-actions", "workspace-contexts", "workspace-branches", "pi-resources", "extension-activity", "extension-ui", "subagent-activity", "file-explorer"],
  mode: "mock",
  defaultModel: "mock/fast",
  defaultThinkingLevel: "xhigh",
  models: [
    { id: "mock/fast", provider: "mock", label: "Mock Fast" },
    { id: "mock/smart", provider: "mock", label: "Mock Smart" },
  ],
  projects: [{
    id: "p1", name: "demo", repoPath: "/tmp/demo", branch: "main",
    branches: ["main", "develop", "feature/alpha", "feature/beta", "feature/gamma", "feature/delta", "feature/epsilon"], remoteBranches: ["origin/feature/remote-ui"], worktrees: { main: "/tmp/demo" },
    contexts: [
      { id: "ctx-main", branch: "main", path: "/tmp/demo", kind: "checkout", dirty: false, status: "clean", ahead: 0, behind: 0, head: "abcdef1234567890", commit: { hash: "abcdef1234567890", shortHash: "abcdef12", subject: "Initial project commit" }, statusDetails: { total: 4, staged: 1, unstaged: 2, untracked: 1, conflicts: 0 }, sessions: [
        { id: "s1", title: "New session", when: "now", streaming: false },
        { id: "sibling", title: "Sibling session", when: "now", streaming: false },
      ] },
      { id: "ctx-feature", branch: "feature/viewer", path: "/tmp/demo-feature", kind: "worktree", dirty: true, status: "dirty", ahead: 0, behind: 0, sessions: [] },
    ],
    workspaceStatus: { main: { id: "ctx-main", branch: "main", path: "/tmp/demo", kind: "checkout", dirty: false, status: "clean", ahead: 0, behind: 0, sessions: [], externalMain: false, protected: false } }, hooks: { check: true }, updated: "now",
    sessions: [
      { id: "s1", title: "New session", draft: false, contextId: "ctx-main", branch: "main", workspacePath: "/tmp/demo", model: "mock/fast", when: "now", streaming: false, children: [] },
      { id: "sibling", title: "Sibling session", contextId: "ctx-main", branch: "main", workspacePath: "/tmp/demo", model: "mock/fast", when: "now", streaming: false, children: [] },
    ],
  }],
  chats: [],
  sync: { configured: false, serverUrl: "", allConversations: false },
  providers: [
    { id: "anthropic", name: "Anthropic", configured: true, sourceLabel: "OAuth", availableModels: 2, authMethods: [{ id: "oauth", label: "Anthropic OAuth" }], canLogout: true },
    { id: "openai", name: "OpenAI", configured: false, availableModels: 0, authMethods: [{ id: "api_key", label: "OpenAI API key" }], canLogout: false },
  ],
  repositorySources: { default: "github", sources: [{ id: "github", enabled: true, configured: false, authenticated: false, owner: "bry-guy" }, { id: "git-url", enabled: true }] },
  settings: { githubOwner: { value: "bry-guy", editable: true }, defaultRepositorySource: { value: "github", editable: true } },
  piConfiguration: {
    config: { profile: "https://github.com/bry-guy/dotfiles", profileSource: "explicit", packages: ["npm:context-mode"], extensions: [] },
    profile: { status: "loaded", source: "https://github.com/bry-guy/dotfiles", error: null },
    warnings: [],
    runtime: { extensions: [{ path: "context-mode" }], errors: [], skills: [{ name: "todo-discipline", path: "/tmp/todo/SKILL.md" }], prompts: 0 },
  },
};
const transcript = { sessionId: "s1", seq: 0, streaming: false, records: [] };

function json(data, ok = true, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function boot() {
  const dom = new JSDOM("<!doctype html><html><body><pi-app></pi-app></body></html>", {
    url: "http://pi-web.test/",
    pretendToBeVisual: true,
  });
  let narrowViewport = false;
  let stateReads = 0;
  dom.setNarrowViewport = value => { narrowViewport = value; };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    HTMLElement: dom.window.HTMLElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    CustomEvent: dom.window.CustomEvent,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    matchMedia: () => ({ matches: narrowViewport, addEventListener() {}, removeEventListener() {} }),
    EventSource: class { close() {} },
    marked,
    DOMPurify: createDOMPurify(dom.window),
    fetch: async (input, options = {}) => {
      const url = String(input);
      if (url === "/api/state") {
        stateReads++;
        if (dom.window.__addSyncTargetOnStateRefresh && stateReads > 1 && !state.projects[0].sessions.some(session => session.id === "sync-target")) {
          state.projects[0].sessions.push({ id: "sync-target", title: "Canonical session", contextId: "ctx-main", branch: "main", workspacePath: "/tmp/demo", model: "mock/fast", when: "now", streaming: false, children: [] });
        }
        if (dom.window.__holdState) return new Promise(resolve => { dom.window.__resolveState = () => resolve(json(state)); });
        return json(state);
      }
      if (url === "/api/models") return json({ models: state.models });
      if (url.startsWith("/api/logs")) return json({ file: "logs/pi-ez-web.log", logs: [{ at: Date.now(), level: "info", source: "operation", message: "Server is ready." }] });
      if (url === "/api/events") return new Response(": connected v1\n\n", { headers: { "content-type": "text/event-stream" } });
      if (url.startsWith("/api/github/public-repos")) return json({ repos: [{ name: "pi-ez-web", fullName: "bry-guy/pi-ez-web", private: false }], nextPage: null });
      if (url === "/api/github/device-login" && options.method === "POST") return json({ flow: { id: "ghf1", state: "waiting_user", userCode: "TEST-CODE", verificationUri: "https://github.com/login/device", expiresAt: "2099-01-01T00:00:00.000Z" } }, true, 202);
      if (url === "/api/github/device-login/ghf1" && !options.method) {
        if (dom.window.__githubLoginComplete) return json({ flow: { id: "ghf1", state: "complete", account: { login: "logged-owner" } } });
        return json({ flow: { id: "ghf1", state: "waiting_user", userCode: "TEST-CODE", verificationUri: "https://github.com/login/device", expiresAt: "2099-01-01T00:00:00.000Z" } });
      }
      if (url === "/api/github/device-login/ghf1" && options.method === "DELETE") return json({ ok: true });
      if (url.startsWith("/api/sessions/") && url.endsWith("/transcript")) {
        dom.window.__transcriptReads = (dom.window.__transcriptReads || 0) + 1;
        if (dom.window.__transcriptError) return json(dom.window.__transcriptError, false, dom.window.__transcriptErrorStatus || 409);
        if (dom.window.__holdTranscript) return new Promise(resolve => { (dom.window.__transcriptResolvers ||= []).push(() => resolve(json(dom.window.__transcriptResponse || transcript))); });
        return json(dom.window.__transcriptResponse || transcript);
      }
      if (url.includes("/api/sessions/") && url.includes("/extension-ui/") && options.method === "POST") {
        dom.window.__extensionUiResponses = dom.window.__extensionUiResponses || [];
        dom.window.__extensionUiResponses.push(JSON.parse(options.body || "{}"));
        return json({ ok: true });
      }
      if (url.includes("/api/sessions/") && url.includes("/extension-ui/") && options.method === "DELETE") return json({ ok: true, cancelled: true });
      if (url === "/api/sessions/s1/push-preview") return json({ ok: true, branch: "main", upstream: "origin/main", head: "head-2", baseHead: "head-1", commitCount: 2, commits: [{ hash: "head-2", shortHash: "head-2", subject: "second commit" }, { hash: "head-1", shortHash: "head-1", subject: "first commit" }] });
      if (url === "/api/sessions/s1/push" && options.method === "POST") {
        const operationId = options.headers?.["x-pi-operation-id"] || "test-push";
        return json({ ok: true, branch: "main", upstream: "origin/main", operation: { id: operationId, status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Pushed main to origin/main." }] } });
      }
      if (url === "/api/sessions/s1/merge-local" && options.method === "POST") {
        const operationId = options.headers?.["x-pi-operation-id"] || "test-merge";
        if (dom.window.__holdMerge) return new Promise(resolve => { dom.window.__resolveMerge = () => resolve(dom.window.__mergeFails ? json({ error: "http_502" }, false, 502) : json({ ok: true, merged: "feat/ship", into: "main", deleted: true, operation: { id: operationId, status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Merged feat/ship into main." }] } })); });
        return json({ ok: true, merged: "feat/ship", into: "main", deleted: true, operation: { id: operationId, status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Merged feat/ship into main." }] } });
      }
      if (url === "/api/projects/p1/fetch" && options.method === "POST") {
        dom.window.__fetchCalls = (dom.window.__fetchCalls || 0) + 1;
        dom.window.__fetchBody = JSON.parse(options.body || "{}");
        const operationId = options.headers?.["x-pi-operation-id"] || options.headers?.get?.("x-pi-operation-id") || "test-fetch";
        return json({ ok: true, projectId: "p1", fetched: true, operation: { id: operationId, status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Fetched Git branches." }] } });
      }
      if (url.includes("/api/sessions/") && url.endsWith("/close") && options.method === "POST") {
        const operationId = options.headers?.["x-pi-operation-id"] || "test-close";
        return json({ ok: true, operation: { id: operationId, status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Session closed." }] } });
      }
      if (url.endsWith("/message") && options.method === "POST") {
        const request = { url, body: JSON.parse(options.body || "{}") };
        dom.window.__writeRequests = [...(dom.window.__writeRequests || []), request];
        const response = () => dom.window.__failWrites ? json({ error: "session_busy" }, false, 409) : json({ ok: true });
        if (dom.window.__holdMessage) return new Promise(resolve => { dom.window.__releaseMessage = () => resolve(response()); });
        return response();
      }
      if (url.endsWith("/bang") && options.method === "POST") {
        const request = { url, body: JSON.parse(options.body || "{}") };
        dom.window.__writeRequests = [...(dom.window.__writeRequests || []), request];
        return dom.window.__failWrites ? json({ error: "session_busy" }, false, 409) : json({ ok: true });
      }
      if (url === "/api/sessions/s1/commands") return json({ commands: [
        { name: "settings", description: "Open settings", source: "pi" },
        { name: "model", description: "Select a model", source: "pi" },
        { name: "name", description: "Set the session display name", source: "pi" },
      ] });
      if (url === "/api/sessions/s1/command" && options.method === "POST") {
        const request = { url, body: JSON.parse(options.body || "{}") };
        dom.window.__writeRequests = [...(dom.window.__writeRequests || []), request];
        if (dom.window.__failWrites && !request.body.text.startsWith("/sync")) return json({ error: "session_busy" }, false, 409);
        return json({ ok: true, action: request.body.text.startsWith("/sync") ? "notice" : "session_meta", message: "sync is available" });
      }
      if (url === "/api/sessions/s1/branch-context" && options.method === "POST" && JSON.parse(options.body || "{}").mode === "fork") {
        const body = JSON.parse(options.body);
        dom.window.__forkBody = body;
        state.projects[0].sessions.push({ id: "s-fork", title: body.name, contextId: "ctx-feature", branch: body.branch, workspacePath: "/tmp/demo-feature", model: "mock/fast", when: "now", streaming: false, children: [] });
        return json({ id: "s-fork", forkedFrom: "s1", branch: body.branch, contextId: "ctx-feature", workspacePath: "/tmp/demo-feature", setupNeeded: false, operation: { id: options.headers?.["x-pi-operation-id"] || "test-fork", status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: `Forked session s-fork on ${body.branch}.` }] } });
      }
      if (url === "/api/sessions/s1/branch-context" && options.method === "POST") {
        const project = state.projects[0];
        const session = project.sessions.find(item => item.id === "s1");
        Object.assign(session, { branch: "develop", contextId: "ctx-develop", workspacePath: "/tmp/demo-develop" });
        project.contexts.find(context => context.id === "ctx-main").sessions = project.contexts.find(context => context.id === "ctx-main").sessions.filter(item => item.id !== "s1");
        project.contexts.push({ id: "ctx-develop", branch: "develop", path: "/tmp/demo-develop", kind: "worktree", dirty: false, status: "clean", ahead: 0, behind: 0, sessions: [session] });
        const operationId = options.headers?.["x-pi-operation-id"] || "test-switch";
        return json({ ok: true, id: "s1", branch: "develop", contextId: "ctx-develop", workspacePath: "/tmp/demo-develop", operation: { id: operationId, status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Switched session s1 to develop." }] } });
      }
      if (url.endsWith("/hooks/setup") && options.method === "POST") {
        dom.window.__setupStarted = true;
        dom.window.__setupCalls = (dom.window.__setupCalls || 0) + 1;
        const operationId = options.headers?.["x-pi-operation-id"] || "test-setup";
        if (dom.window.__holdSetup) return new Promise(resolve => { dom.window.__resolveSetup = () => resolve(dom.window.__setupFails ? json({ error: "http_502" }, false, 502) : json({ hook: "setup", ok: true, exit: 0, stdout: "setup ok\n", operation: { id: operationId, status: "success", events: [{ at: Date.now(), type: "result", message: "Setup complete." }] } })); });
        return json({ hook: "setup", ok: true, exit: 0, stdout: "setup ok\n", operation: { id: operationId, status: "success", events: [{ at: Date.now(), type: "result", message: "Setup complete." }] } });
      }
      if (url.endsWith("/hooks/check") && options.method === "POST") {
        const operationId = options.headers?.["x-pi-operation-id"] || "test-check";
        return json({ hook: "check", ok: true, exit: 0, command: "npm test", stdout: "check ok\n", stderr: "", operation: { id: operationId, status: "success", events: [{ at: Date.now(), type: "result", message: "check ok" }] } });
      }
      if (url === "/api/settings") {
        const patch = JSON.parse(options.body || "{}");
        dom.window.__settingsPatches = [...(dom.window.__settingsPatches || []), patch];
        if (patch.githubOwner !== undefined) state.settings.githubOwner.value = patch.githubOwner;
        return json({ ok: true });
      }
      if (url === "/api/remote-workspaces" && !options.method) return json(dom.window.__workers);
      if (url === "/api/remote-workspaces/reload" && options.method === "POST") return json({ results: [{ name: "app", ok: true, status: 200, error: null }, { name: "scratch", ok: false, status: 409, error: "workspace_busy" }] });
      const workerCall = url.match(/^\/api\/remote-workspaces\/([^/]+)\/(restart|reset|reload)$/);
      if (workerCall && options.method === "POST") {
        dom.window.__workerCalls = [...(dom.window.__workerCalls || []), { name: workerCall[1], action: workerCall[2], body: JSON.parse(options.body || "{}") }];
        return dom.window.__workerError ? json({ error: dom.window.__workerError }, false, 409) : json({ ok: true });
      }
      if (url === "/api/sessions/s1/model") return json({ ok: true });
      if (url === "/api/chats") return json({ id: "c1" });
      if (url.includes("/api/projects/") && url.endsWith("/sessions")) {
        dom.window.__newSessionBody = JSON.parse(options.body || "{}");
        state.projects[0].sessions.unshift({ id: "s2", title: "Chat Name", draft: true, branch: "feature/from-picker", contextId: "ctx-feature", workspacePath: "/tmp/demo-feature", model: "mock/fast", when: "now", streaming: false, children: [] });
        return json({ id: "s2", projectId: "p1", branch: "feature/from-picker", contextId: "ctx-feature", workspacePath: "/tmp/demo-feature", setupNeeded: true, operation: { id: options.headers?.["x-pi-operation-id"] || "test-create", status: "success", httpStatus: 200, events: [{ at: Date.now(), type: "result", message: "Created session s2 on feature/from-picker." }] } });
      }
      if (url === "/api/projects") return json({ id: "p2", sessionId: "s2", setupNeeded: true });
      if (url.startsWith("/api/sessions/") && url.endsWith("/history")) {
        return json({ entries: [{ id: "op-1", kind: "hook", title: "Setup hook", status: "success", exit: 0, at: Date.now(), output: "installed dependencies\n" }] });
      }
      if (url.includes("/api/projects/") && url.includes("/file?")) {
        const params = new URL(url, "http://pi-web.test").searchParams;
        const target = params.get("target") || "origin";
        const targets = ["origin", "primary"];
        return json({
          path: "src/app.js", size: 18, binary: false, content: "const answer = 42;\n",
          highlighted: '<span class="hljs-keyword">const</span> answer = <span class="hljs-number">42</span>;\n',
          language: "javascript", target, targets,
          diff: target === "origin" ? { target, targets, label: "vs origin", changed: false, binary: false, lines: [] } : { target, targets, label: "vs main", adds: 2, dels: 0, changed: true, binary: false,
            lines: [{ sign: "", hunk: true, text: "@@ -1 +1,2 @@" }, { sign: "+", text: "const answer = 42;" }] },
        });
      }
      if (url.includes("/api/projects/") && (url.endsWith("/files") || url.includes("/files?"))) {
        dom.window.__fileListCalls = (dom.window.__fileListCalls || 0) + 1;
        const target = new URL(url, "http://pi-web.test").searchParams.get("target") || "origin";
        const targets = ["origin", "primary"];
        const tree = target === "origin" ? [
          { n: "src", p: "src", s: "modified", c: [{ n: "app.js", p: "src/app.js", s: "modified" }] },
          { n: ".github", p: ".github", c: [{ n: "ci.yml", p: ".github/ci.yml" }] },
          { n: "README.md", p: "README.md" },
          { n: ".env", p: ".env" },
          { n: "new.js", p: "new.js", s: "new" },
        ] : [
          { n: "src", p: "src", s: "modified", c: [{ n: "app.js", p: "src/app.js", s: "modified" }, { n: "untouched.js", p: "src/untouched.js" }] },
          { n: "new.js", p: "new.js", s: "new" },
          { n: "old.js", p: "old.js", s: "removed" },
          { n: "README.md", p: "README.md" },
        ];
        return json({ target, targets, tree });
      }
      return json({ ok: true });
    },
  });

  await import(`../public/js/main.js?dom-test=${Date.now()}`);
  await new Promise(resolve => setTimeout(resolve, 10));
  return dom;
}

test("DOM gate: actions, focus, models, and keyboard paths work", async () => {
  const dom = await boot();
  const { store } = await import("../public/js/store.js");
  const { api, applyEvent: applyEventNow, openTranscript, refreshState, shouldBufferEvent } = await import("../public/js/api.js");
  // The thread renders streaming events once per frame; assertions read the DOM right away, so flush it.
  const flushThreads = () => dom.window.document?.querySelectorAll("pi-thread")?.forEach(thread => { if (thread.renderQueued) thread.render(); });
  const applyEvent = (...args) => { const result = applyEventNow(...args); flushThreads(); return result; };
  const notify = store.notify.bind(store);
  store.notify = (...args) => { const result = notify(...args); flushThreads(); return result; };
  assert.equal(shouldBufferEvent("text_delta"), true);
  assert.equal(shouldBufferEvent("session_switched"), false);
  await api.message("s1", "token message", "prompt", [], "token-client");
  await api.bang("s1", "pwd");
  await api.command("s1", "/skill test", "prompt");
  await api.command("s1", "/sync status");
  assert.deepEqual(dom.window.__writeRequests.slice(-4).map(request => Object.keys(request.body).sort()), [["clientMessageId", "images", "mode", "text"], ["cmd"], ["mode", "text"], ["mode", "text"]]);
  let transcriptReads = dom.window.__transcriptReads || 0;
  dom.window.__transcriptError = { error: "other_conflict" };
  await openTranscript("s1");
  assert.equal(dom.window.__transcriptReads, transcriptReads + 1, "other transcript 409 errors fail fast");
  dom.window.__transcriptError = null;
  store.set({ error: null });
  const { openSessionPicker, selectSession } = await import("../public/js/shell.js");
  const root = dom.window.document.querySelector("pi-app");
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "visible" });
  assert.ok(root.querySelector("pi-sidebar"));
  assert.match(root.querySelector(".model-chip").textContent, /Mock Fast/);
  const parentSession = store.state.projects[0].sessions[0];
  parentSession.children = [{ id: "child", title: "Child session", children: [] }];
  store.state.openTree[parentSession.id] = true;
  store.notify("state");
  assert.ok(root.querySelector("[data-id='child']"));
  root.querySelector("[data-tree-id='s1']").click();
  assert.equal(root.querySelector("[data-id='child']"), null, "parent sessions collapse their children");
  parentSession.children = [];
  store.notify("state");
  assert.equal(root.querySelector(".workspace-commit").textContent, "abcdef12");
  assert.equal(root.querySelector(".workspace-commit").title, "Current commit abcdef1234567890");
  // Questions dock above the composer, nothing is blocked, and each one goes away once answered.
  const card = () => root.querySelector("pi-extension-ui .ask-card");
  applyEvent({ v: 1, seq: 1, sessionId: "s1", type: "extension_ui_request", requestId: "ui-1", method: "select", title: "Choose a conversation", options: ["one", "two"] });
  assert.match(card().textContent, /Choose a conversation/);
  assert.equal(dom.window.document.body.classList.contains("modal-open"), false, "a question is not a modal");
  assert.ok(card().closest(".screen[data-screen='chat']"), "it sits in the chat, above the composer");
  root.querySelector("[data-extension-ui-option='1']").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(card(), null);
  assert.deepEqual(dom.window.__extensionUiResponses.at(-1), { value: "two" });
  applyEvent({ v: 1, seq: 2, sessionId: "s1", type: "extension_ui_request", requestId: "ui-2", method: "confirm", title: "Continue", message: "Proceed?" });
  root.querySelector("[data-extension-ui-confirm='yes']").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(card(), null);
  assert.deepEqual(dom.window.__extensionUiResponses.at(-1), { confirmed: true });
  applyEvent({ v: 1, seq: 3, sessionId: "s1", type: "extension_ui_request", requestId: "ui-3", method: "input", title: "Name", placeholder: "Session name" });
  root.querySelector("[data-extension-ui-value]").value = "Web session";
  root.querySelector("[data-extension-ui-submit]").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(dom.window.__extensionUiResponses.at(-1), { value: "Web session" });
  applyEvent({ v: 1, seq: 4, sessionId: "s1", type: "extension_ui_request", requestId: "ui-4", method: "editor", title: "Edit", prefill: "before" });
  root.querySelector("[data-extension-ui-value]").value = "after";
  root.querySelector("[data-extension-ui-submit]").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(dom.window.__extensionUiResponses.at(-1), { value: "after" });
  // ask_user_question: option rows with descriptions, plus an inline "type your own" field.
  applyEvent({ v: 1, seq: 5, sessionId: "s1", type: "extension_ui_request", requestId: "ui-5", method: "select", title: "[Approach] Which one?", options: ["1. Fast — quick fix", "2. Thorough — full rewrite", "3. Type something."] });
  assert.match(root.querySelector(".ask-head").textContent, /Approach/);
  assert.equal(root.querySelectorAll(".ask-option").length, 2, "the 'Type something.' row becomes a field");
  assert.match(root.querySelector(".ask-option small").textContent, /quick fix/);
  root.querySelector("[data-extension-ui-value]").value = "Neither";
  root.querySelector("[data-extension-ui-submit]").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(dom.window.__extensionUiResponses.at(-1), { value: "3. Type something." }, "a typed answer picks the questionnaire's own row");
  applyEvent({ v: 1, seq: 51, sessionId: "s1", type: "extension_ui_request", requestId: "ui-5b", method: "input", title: "[Approach] Which one?\n\n1. Fast — quick fix\n2. Thorough — full rewrite\n\nType your answer:", placeholder: "" });
  assert.equal(card(), null, "its follow-up prompt is answered without showing");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(dom.window.__extensionUiResponses.at(-1), { value: "Neither" });
  assert.equal(store.state.asks.s1, undefined);
  // Multi-select: checkboxes, sent as the numbers the questionnaire expects.
  applyEvent({ v: 1, seq: 6, sessionId: "s1", type: "extension_ui_request", requestId: "ui-6", method: "input", title: "Pick some\n\n1. A — first\n2. B — second\n\nEnter the numbers", placeholder: "1,3; custom answer" });
  root.querySelector("[data-extension-ui-check='2']").checked = true;
  root.querySelector("[data-extension-ui-submit]").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(dom.window.__extensionUiResponses.at(-1), { value: "2" });
  // A question answered or timed out elsewhere disappears; another session's question waits there.
  applyEvent({ v: 1, seq: 7, sessionId: "s1", type: "extension_ui_request", requestId: "ui-7", method: "confirm", title: "Gone soon" });
  assert.ok(card());
  applyEvent({ v: 1, seq: 8, sessionId: "s1", type: "extension_ui_resolved", requestId: "ui-7" });
  assert.equal(card(), null, "a resolved question goes away");
  applyEvent({ v: 1, seq: 9, sessionId: "sibling", type: "extension_ui_request", requestId: "ui-8", method: "confirm", title: "Elsewhere" });
  assert.equal(card(), null, "only the open conversation's question shows");
  assert.ok(store.state.asks.sibling, "and the other one is kept for its session");
  delete store.state.asks.sibling;
  const project = store.state.projects[0];
  const session = project.sessions.find(item => item.id === "s1");
  const originalSession = { ...session };
  project.contexts.push({ id: "ctx-missing", branch: null, path: "/tmp/missing", kind: "unavailable", dirty: null, status: "unavailable", sessions: [session] });
  Object.assign(session, { contextId: "ctx-missing", branch: null, workspacePath: "/tmp/missing" });
  openSessionPicker("p1", { mode: "switch", sourceSessionId: "s1" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(root.querySelector("[data-act='apply-session-branch'][data-mode='switch']"), null, "switch action is removed");
  root.querySelector("[data-act='close-session-picker']").click();
  Object.assign(session, originalSession);
  project.contexts.pop();
  store.notify("state");

  store.state.transcripts.sibling = { records: [], streaming: true, seq: -1 };
  store.notify("transcript");
  const send = root.querySelector(".send-btn");
  assert.equal(send.disabled, false);
  const composerTextarea = root.querySelector(".composer textarea");
  Object.defineProperty(composerTextarea, "scrollHeight", {
    configurable: true,
    get: () => composerTextarea.value.length > 20 ? 180 : 50,
  });
  composerTextarea.value = "A long message that wraps in the composer.";
  composerTextarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const composerExpand = root.querySelector(".composer-expand-btn");
  assert.equal(Number.parseInt(composerTextarea.style.height, 10), 180, "the editor grows with its draft, no button needed");
  assert.equal(composerExpand.classList.contains("hidden"), true, "desktop has no expand control");
  Object.defineProperty(composerTextarea, "scrollHeight", { configurable: true, get: () => composerTextarea.value.length > 20 ? 2000 : 50 });
  composerTextarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const capped = Number.parseInt(composerTextarea.style.height, 10);
  assert.ok(capped < 2000 && capped >= 180, "growth stops at the cap, then the editor scrolls");
  assert.equal(composerTextarea.style.overflowY, "auto");
  dom.setNarrowViewport(true);
  composerTextarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(composerExpand.classList.contains("hidden"), false, "phones offer the full editor past the cap");
  composerExpand.click();
  assert.equal(composerExpand.getAttribute("aria-expanded"), "true");
  assert.ok(Number.parseInt(composerTextarea.style.height, 10) >= capped, "the full editor is at least as tall as the capped one");
  composerTextarea.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(composerExpand.getAttribute("aria-expanded"), "false", "Escape collapses the expanded editor");
  dom.setNarrowViewport(false);
  composerTextarea.value = "";
  composerTextarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.ok(Number.parseInt(composerTextarea.style.height, 10) < 180, "an empty draft shrinks back");
  assert.doesNotMatch(root.querySelector(".composer textarea").placeholder, /Another session/);
  assert.equal(root.querySelector("[data-id='sibling']").classList.contains("streaming"), true);
  assert.equal(root.querySelector("pi-header [data-act='settings']"), null);
  assert.equal(root.querySelector("pi-sidebar .rail-foot").tagName, "BUTTON", "the whole sidebar footer row is the settings button");
  root.querySelector("pi-sidebar .rail-foot").click();
  assert.equal(store.state.view, "settings");
  assert.ok(root.querySelector("pi-settings"));
  assert.equal(root.querySelector("main.col").classList.contains("settings-open"), true);
  assert.equal(root.querySelectorAll("pi-settings .settings-nav-head .settings-close").length, 1, "the list header has one back control");
  store.set({ view: "chat" });
  assert.equal(root.querySelector("main.col").classList.contains("settings-open"), false);
  store.set({ view: "chat" });
  root.querySelector("pi-header [data-act='session-panel']").click();
  assert.ok(root.querySelector(".session-picker"));
  assert.equal(root.querySelector("[data-act='apply-session-branch'][data-mode='switch']"), null);
  assert.equal(root.querySelector("[data-act='open-fork']").disabled, false, "Fork is an enabled action");
  assert.equal(root.querySelector("[data-act='merge-branch']").disabled, true);
  assert.equal(root.querySelector("[data-act='delete-branch']").disabled, true);
  assert.equal(root.querySelector(".session-picker [data-session-name]"), null, "the session panel no longer edits the name");
  assert.equal(root.querySelector(".session-picker .branch-picker-trigger"), null, "the branch dropdown is replaced by Switch");
  const forkOpener = root.querySelector("[data-act='open-fork']");
  forkOpener.focus();
  const dialog = root.querySelector(".session-picker");
  store.notify("state");
  assert.equal(root.querySelector("[data-act='open-fork']"), forkOpener, "an unchanged picker keeps its nodes");
  assert.equal(root.ownerDocument.activeElement, forkOpener, "an unchanged picker keeps focus");
  store.set({ sessionPickerError: "transient" });
  store.set({ sessionPickerError: null });
  assert.equal(root.querySelector(".session-picker"), dialog, "updates keep the dialog, so its entry animation does not replay");
  const sessionDetails = root.querySelector(".session-branch-actions");
  assert.ok(sessionDetails);
  assert.deepEqual([...sessionDetails.querySelectorAll(".session-detail-row")].map(row => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]), [
    ["Branch", "main"],
    ["Commit", "abcdef12 Initial project commit"],
    ["Workspace", "checkout · /tmp/demo"],
    ["Status", "1 file staged, 2 files unstaged, 1 file untracked"],
  ]);
  assert.match(root.querySelector(".session-picker-actions").textContent, /Session/);
  assert.equal([...root.querySelectorAll(".session-context-heading")].some(node => node.textContent.includes("Workspace")), false);
  assert.ok([...root.querySelectorAll(".session-context-heading")].some(node => node.textContent.includes("Git")));
  assert.equal(root.querySelector("pi-header [data-act='sync-session']"), null, "Sync is no longer a header action");
  assert.equal(root.querySelector(".session-picker [data-act='sync-session']"), null, "Sync is available through slash commands only");
  assert.equal(root.querySelector(".session-picker [data-act='fetch-branches']").textContent, "Fetch");
  root.querySelector(".session-picker [data-act='fetch-branches']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(dom.window.__fetchCalls, 1);
  assert.equal(dom.window.__fetchBody.sessionId, "s1", "a fetch from the panel names its session, so it is logged in that workspace's History");
  assert.match(root.querySelector(".app-toast").textContent, /Fetched Git branches/, "an async result is announced as a toast");
  assert.equal(root.querySelector(".session-picker .session-operation-feed"), null, "no duplicate status line beneath History");
  assert.equal(root.querySelector(".session-branch-actions [data-act='run-hook']"), null);
  const sessionButtons = root.querySelector(".session-picker-session-buttons");
  const checkButton = root.querySelector(".session-picker-actions [data-act='run-hook']");
  const forkButton = root.querySelector(".session-picker-actions [data-act='open-fork']");
  assert.equal(checkButton.textContent, "Check");
  assert.ok(sessionButtons.contains(checkButton));
  assert.equal(forkButton.textContent, "Fork…");
  assert.equal(root.querySelector(".session-picker-actions [data-act='close-session-picker']"), null);
  const gitSection = root.querySelector(".session-branch-actions");
  const sessionSection = root.querySelector(".session-picker-actions");
  assert.ok(sessionSection.compareDocumentPosition(gitSection) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "Session comes before Git");
  assert.deepEqual([...gitSection.querySelector(".session-action-row").querySelectorAll("button")].map(button => button.textContent), ["Fetch", "Pull", "Push", "Switch…"], "Switch sits with the other Git commands");
  const feedNow = Date.now() + 1000;
  store.state.operations.unshift({ id: "feed-test", kind: "fetch", title: "Fetch Git branches", sessionId: "s1", status: "running", startedAt: feedNow - 2, events: [{ at: feedNow - 1, type: "phase", message: "Older fetch event" }, { at: feedNow, type: "result", message: "Latest fetch event" }] });
  store.notify("state");
  const runningEntry = root.querySelector(".history-entry.running");
  assert.match(runningEntry.textContent, /Fetch Git branches/, "a running operation is listed at the top of History");
  runningEntry.querySelector(".history-entry-head").click();
  assert.match(root.querySelector(".history-entry.running .history-output").textContent, /Latest fetch event/);
  store.state.operations[0].status = "success";
  store.notify("state");
  const currentProject = store.state.projects.find(item => item.id === "p1");
  assert.deepEqual([...root.querySelectorAll(".session-branch-actions .session-detail-row")].map(row => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]), [
    ["Branch", "main"],
    ["Commit", "abcdef12 Initial project commit"],
    ["Workspace", "checkout · /tmp/demo"],
    ["Status", "1 file staged, 2 files unstaged, 1 file untracked"],
  ]);
  const syncLabel = () => root.querySelector("pi-header .bar-sub .sync-label");
  assert.equal(syncLabel(), null, "no sync label without a pi-sync status");
  store.state.extensionStatuses.s1 = { "pi-sync": "sync: up to date" };
  store.notify("state");
  assert.equal(syncLabel().textContent, "Sync: up to date", "the pi-sync extension status is the label");
  assert.equal(syncLabel().closest("button, [data-act='sync-detail']"), null, "the sync state is plain text inside the header target");
  assert.ok(syncLabel().closest("[data-act='session-panel']"), "the sync state sits in the one session-menu target");
  store.state.extensionStatuses.s1 = { "pi-sync": "sync: in use by Laptop" };
  store.notify("state");
  assert.ok(root.querySelector("pi-header .sync-label.busy"));
  delete store.state.extensionStatuses.s1;
  store.notify("state");
  root.querySelector("[data-act='close-session-picker']").click();
  // The whole header row is the hit target; its own buttons keep their actions.
  for (const [selector, why] of [["pi-header header.bar", "the header row"], ["pi-header .bar-sub", "blank space on the Git line"], ["pi-header", "a tap left on <pi-header> by a re-render"]]) {
    root.querySelector(selector).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    assert.ok(root.querySelector(".session-picker"), `${why} opens the session panel`);
    root.querySelector("[data-act='close-session-picker']").click();
  }
  root.querySelector("pi-header [data-act='files']").click();
  assert.equal(root.querySelector(".session-picker"), null, "the Files toggle does not open the panel");
  root.querySelector("pi-header [data-act='files']").click();
  root.querySelector("pi-header [data-act='sidebar-toggle']").click();
  assert.equal(root.querySelector(".session-picker"), null, "the sidebar toggle does not open the panel");
  root.querySelector("pi-header [data-act='sidebar-toggle']").click();
  root.querySelector("pi-header .bar-title").click();
  assert.ok(root.querySelector(".session-picker"), "the chat header opens the session panel");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.querySelector(".session-picker .history-entry-head").textContent, /Setup hook/);
  root.querySelector(".session-picker .history-entry-head").click();
  assert.match(root.querySelector(".history-output").textContent, /installed dependencies/, "a history entry expands in place");
  assert.equal(root.querySelector(".history-entry-head").getAttribute("aria-expanded"), "true");
  root.querySelector("[data-act='close-session-picker']").click();
  assert.equal(root.querySelector("pi-header [data-act='refresh-sync']"), null, "Sync refresh is available through slash commands only");
  const readsBeforeSwitch = dom.window.__transcriptReads || 0;
  applyEvent({ v: 1, seq: 100, sessionId: "s1", type: "session_switched", toSessionId: "s1" });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(dom.window.__transcriptReads, readsBeforeSwitch + 1, "a same-ID catch-up reloads the transcript in place");
  assert.equal(store.state.sessionId, "s1");

  const composer = root.querySelector("pi-composer");
  const textarea = composer.querySelector("textarea");
  textarea.value = "draft kept across transcript reload";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await openTranscript("s1");
  assert.equal(textarea.value, "draft kept across transcript reload", "transcript reloads keep the draft");
  textarea.value = "";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

  const originalFileReader = globalThis.FileReader;
  let finishFileRead;
  globalThis.FileReader = class {
    readAsDataURL() { finishFileRead = () => { this.result = "data:image/png;base64,Zm9v"; this.onload(); }; }
  };
  const attachmentFile = new dom.window.File(["image"], "draft.png", { type: "image/png" });
  const fileRead = composer.addFiles([attachmentFile]);
  finishFileRead();
  await fileRead;
  globalThis.FileReader = originalFileReader;
  assert.equal(store.draftAttachments("s1").length, 1);
  textarea.value = "attachment draft";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await composer.send();
  assert.equal(dom.window.__writeRequests.at(-1).body.images[0].data, "Zm9v");
  assert.deepEqual(Object.keys(dom.window.__writeRequests.at(-1).body).sort(), ["clientMessageId", "images", "mode", "text"]);
  assert.equal(store.draftAttachments("s1").length, 0, "a delivered message clears its attachments");
  store.transcript("s1").records = store.transcript("s1").records.filter(record => !record.pending);

  root.querySelector("pi-header [data-act='session-panel']").click();
  assert.equal(root.querySelector("[data-act='run-hook']").textContent, "Check");
  assert.doesNotMatch(root.querySelector(".session-picker").textContent, /Run check/);
  assert.ok(root.querySelector("[data-act='pull-branch']"));
  assert.ok(root.querySelector("[data-act='push-branch']"));
  root.querySelector("[data-act='push-branch']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(root.querySelector(".confirm-modal").textContent, /second commit/);
  assert.match(root.querySelector(".confirm-modal").textContent, /first commit/);
  const confirmActions = root.querySelector(".confirm-actions");
  assert.equal(confirmActions.querySelector(":scope > .confirm-button-row .confirm-back").textContent, "Go back");
  assert.equal(confirmActions.querySelector(":scope > .confirm-button-row .confirm-cta").textContent, "Push commits");
  assert.equal(confirmActions.querySelector(":scope > .confirm-progress"), null);
  root.querySelector(".confirm-modal [data-act='go']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(root.querySelector(".confirm-modal"), null);
  root.querySelector("pi-header [data-act='session-panel']").click();
  root.querySelector("[data-act='run-hook']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(root.querySelector(".operation-modal"), null, "hook output stays out of a terminal modal");
  assert.match(root.querySelector(".app-toast:last-child").textContent, /Check finished/);

  // Fork: a step asking for a name and a branch; empty fields use a unique "(fork)" name and its branch.
  state.projects[0].sessions.push({ id: "old-fork", title: "New session (fork)", contextId: "ctx-main", branch: "main", workspacePath: "/tmp/demo", model: "mock/fast", when: "now", streaming: false, children: [] });
  await refreshState();
  root.querySelector("[data-act='open-fork']").click();
  assert.equal(root.querySelector(".session-picker .modal-title").textContent, "Fork session");
  assert.equal(root.querySelector("[data-fork-name]").placeholder, "New session (fork 2)", "the default name is unique among sessions");
  assert.equal(root.querySelector("[data-fork-branch]").placeholder, "feature/new-session-fork-2");
  root.querySelector("[data-act='back-session-picker']").click();
  assert.ok(root.querySelector("[data-act='open-fork']"), "< returns to the main screen");
  root.querySelector("[data-act='open-fork']").click();
  root.querySelector("[data-act='fork-session']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([dom.window.__forkBody.name, dom.window.__forkBody.branch, dom.window.__forkBody.mode], ["New session (fork 2)", "feature/new-session-fork-2", "fork"]);
  assert.equal(store.state.sessionId, "s-fork", "the copy opens");
  state.projects[0].sessions = state.projects[0].sessions.filter(session => !["old-fork", "s-fork"].includes(session.id));
  await refreshState();
  selectSession("p1", "s1");
  await new Promise(resolve => setTimeout(resolve, 10));

  // Switch: a step listing branches; choosing one moves the session (the dropdown is gone).
  root.querySelector("pi-header [data-act='session-panel']").click();
  root.querySelector("[data-act='open-switch']").click();
  assert.equal(root.querySelector(".session-picker .modal-title").textContent, "Switch branch");
  assert.deepEqual([...root.querySelectorAll(".branch-list .branch-option")].map(button => button.dataset.branch), [
    "main", "develop", "feature/alpha", "feature/beta", "feature/delta", "feature/epsilon", "feature/gamma", "feature/viewer",
  ]);
  assert.equal(root.querySelector(".branch-list [data-branch='main']").disabled, true, "the current branch is not a choice");
  assert.equal(root.querySelector("[data-act='switch-new-branch']").disabled, true);
  const switchBranchInput = root.querySelector("[data-session-new-branch]");
  switchBranchInput.value = "feature/typed";
  switchBranchInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(root.querySelector("[data-act='switch-new-branch']").disabled, false, "naming a new branch enables its switch");
  switchBranchInput.value = "";
  switchBranchInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  root.querySelector(".branch-list [data-branch='develop']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  await refreshState();
  assert.equal(root.querySelector("[data-act='apply-session-branch'][data-mode='switch']"), null);
  assert.equal(store.findSession("s1", store.state.projects[0].sessions).branch, "develop");
  assert.match(root.querySelector("pi-header .workspace-branch").textContent, /develop/);
  assert.doesNotMatch(root.querySelector("pi-header .workspace-trigger").textContent, /CHECKOUT|WORKTREE|demo/, "the header shows branch, commit and state only");
  assert.match(store.state.operations.find(operation => operation.kind === "switch-session").events.at(-1).message, /Switched session s1 to develop/);
  store.state.transcripts.sibling.streaming = false;
  store.notify("transcript");

  store.state.openTree.p1 = false;
  store.notify("state");
  root.querySelector("[data-act='toggle-tree'][data-tree-id='p1']").click();
  assert.equal(store.state.openTree.p1, true);
  root.querySelector("[data-act='session-row'][data-id='sibling']").click();
  assert.equal(store.state.sessionId, "sibling");

  store.state.transcripts.s1 ||= { records: [], streaming: false, seq: -1 };
  store.state.transcripts.s1.streaming = true;
  store.notify("transcript");
  applyEvent({ v: 1, seq: 99, sessionId: "s1", type: "queue_update", followUp: 1 });
  assert.doesNotMatch(root.querySelector(".composer textarea").placeholder, /steering message/);
  applyEvent({ v: 1, seq: 100, sessionId: "s1", type: "turn_end", reason: "done" });
  assert.equal(store.state.queued.s1, undefined);
  assert.equal(send.disabled, false);
  assert.equal(root.querySelector("[data-id='sibling']").classList.contains("streaming"), false);

  const search = root.querySelector(".rail-search");
  search.focus();
  search.value = "d";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(dom.window.document.activeElement, search);

  const newChat = root.querySelector(".chats-head [data-act='new-chat']");
  assert.ok(newChat);
  newChat.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.chatId, "c1");

  const projectNew = root.querySelector("[data-act='project-row'] [data-act='project-new-session']");
  assert.ok(projectNew, "the project row has a + for a new session");
  assert.equal(root.querySelector("[data-act='project-row'] .row-ws"), null, "no worker state on the project row");
  dom.window.__holdSetup = true;
  projectNew.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(root.querySelector(".session-picker"), null, "a new project session opens without a modal");
  assert.equal(dom.window.__newSessionBody.branch, "main", "new sessions start on main");
  assert.equal(dom.window.__newSessionBody.pull, "background", "main is updated after the session opens");
  assert.equal(store.state.sessionId, "s2");
  assert.equal(root.querySelector("pi-sidebar [data-id='s2']"), null, "a new session is not listed until its first prompt");
  // A backend without the draft flag (preview UI on production data) still hides it.
  const s2 = store.findSession("s2", store.state.projects[0].sessions);
  const titled = s2.title;
  delete s2.draft; s2.title = "New session"; s2.name = null;
  store.notify("state");
  assert.equal(root.querySelector("pi-sidebar [data-id='s2']"), null, "an unnamed 'New session' without a draft flag is hidden");
  s2.draft = true; s2.title = titled;
  assert.equal(dom.window.__setupStarted, true, "setup starts after the returned session is selected");
  assert.equal(dom.window.__setupCalls, 1, "automatic setup uses the existing hook endpoint");
  assert.equal(root.querySelector(".send-btn").disabled, false, "composer remains usable during setup");
  assert.ok(root.querySelector(".bar-operation-hint .operation-dot"), "background setup appears in the title hint");
  assert.equal(root.querySelector(".operation-row-hint"), null, "sidebar operation hints are removed");
  assert.equal(root.querySelector(".operation-modal"), null, "session creation stays non-blocking");
  root.querySelector("pi-header [data-act='session-panel']").click();
  assert.equal(root.querySelector(".bar-operation-hint"), null, "opening the picker removes the title hint space");
  assert.match(root.querySelector(".history-entry.running")?.textContent || "", /Setup/, "running setup is listed in History until it finishes");
  assert.equal(root.querySelector(".session-picker .session-operation-feed"), null);
  root.querySelector("[data-act='close-session-picker']").click();
  openSessionPicker("p1", { mode: "switch", sourceSessionId: "s1" });
  dom.window.__setupFails = true;
  dom.window.__resolveSetup();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(store.state.sessionPicker.sourceSessionId, "s1", "a background setup failure leaves a newer picker open");
  assert.equal(store.state.sessionPickerError, null, "a background setup failure does not leak into another picker");
  assert.match(store.state.error, /http_502|Setup failed/);
  root.querySelector("[data-act='close-session-picker']").click();
  store.set({ error: null });
  dom.window.__holdSetup = false;
  dom.window.__setupFails = false;

  root.querySelector("[data-act='repo-picker']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  const sourceToggle = root.querySelector("[data-source-toggle]");
  assert.ok(sourceToggle);
  sourceToggle.click();
  assert.ok(root.querySelector("[data-source='github']"));
  root.querySelector("[data-source='github']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.querySelector("pi-repo-picker").textContent, /bry-guy\/pi-ez-web/);
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.repoPickerOpen, false, "Escape closes the repository picker");

  root.querySelector("[data-act='repo-picker']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  root.querySelector("[data-source-toggle]").click();
  assert.equal(root.querySelector("[data-source='local']"), null, "local repositories are not a source");
  root.querySelector("[data-source='github']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  const filter = root.querySelector(".modal-filter");
  filter.focus();
  filter.value = "pi-ez";
  filter.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(dom.window.document.activeElement, filter);
  root.querySelector("pi-repo-picker [data-repo='bry-guy/pi-ez-web']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(store.state.repoPickerOpen, false, "project picker closes before background setup");
  assert.equal(store.state.operations.find(operation => operation.kind === "create-project")?.status, "success");

  store.state.repositorySources.sources.find(source => source.id === "github").owner = null;
  store.set({ repoPickerOpen: true, repoPickerSource: "github" });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.querySelector("pi-repo-picker").textContent, /Set a GitHub owner.*or sign in/i);
  root.querySelector("pi-repo-picker [data-act='close']").click();
  await new Promise(resolve => setTimeout(resolve, 10));

  store.set({ view: "settings", settingsCategory: "defaults" });
  assert.match(root.querySelector("pi-settings").textContent, /Default model/);
  assert.match(root.querySelector("pi-settings").textContent, /Default thinking mode/);
  assert.equal(root.querySelector("pi-settings [data-setting='defaultThinkingLevel']").value, "xhigh");
  store.set({ settingsCategory: "providers" });
  assert.match(root.querySelector("pi-settings").textContent, /Anthropic/);
  assert.doesNotMatch(root.querySelector("pi-settings").textContent, /Default model/, "only the active category renders");
  store.set({ settingsCategory: "pi" });
  assert.match(root.querySelector("pi-settings").textContent, /todo-discipline/);
  assert.doesNotMatch(root.querySelector("pi-settings").textContent, /Pi profile & extensions/);
  assert.match(root.querySelector("pi-settings").textContent, /Dotfiles profile/);
  assert.match(root.querySelector("pi-settings").textContent, /Optional: enter a local path or HTTPS URL/);
  assert.doesNotMatch(root.querySelector("pi-settings").textContent, /configured GitHub user's|Automatic GitHub dotfiles profile/);
  const settingsText = root.querySelector("pi-settings").textContent;
  assert.doesNotMatch(settingsText, /1Password/);
  assert.equal(root.querySelector("[data-onepassword-token]"), null);
  assert.equal(root.querySelector("[data-act='connect-onepassword']"), null);
  assert.equal(root.querySelector("[data-act='disconnect-onepassword']"), null);
  assert.equal(root.querySelectorAll("pi-settings .pi-loaded-list").length, 2);
  assert.match(root.querySelector("pi-settings .pi-resource-scroll").textContent, /context-mode|todo-discipline/);
  assert.equal(root.querySelector("[data-setting='piProfile']").value, "https://github.com/bry-guy/dotfiles");
  assert.match(root.querySelector("[data-setting='piPackages']").value, /npm:context-mode/);
  const applyProfile = root.querySelector("pi-settings [data-act='save-pi-configuration']");
  assert.ok(applyProfile);
  assert.equal(applyProfile.textContent, "Save & reload");
  assert.equal(root.querySelector("pi-settings [data-act='refresh-pi-configuration']"), null);
  applyProfile.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.querySelector("pi-settings").textContent, /Pi profile applied/);
  store.set({ settingsCategory: "providers" });
  assert.match(root.querySelector("pi-settings").textContent, /OpenAI API key/);
  store.set({ settingsCategory: "pi" });
  assert.doesNotMatch(root.querySelector("pi-settings").textContent, /GitHub OAuth client ID/);
  assert.doesNotMatch(root.querySelector("pi-settings").textContent, /Agent endpoint|Streaming over SSE|Mode/);

  state.piConfiguration = {
    config: { profile: null, profileSource: "disabled", packages: ["npm:kept"], extensions: ["./kept.ts"] },
    profile: { status: "none", source: null, error: null },
    warnings: [],
    runtime: null,
  };
  store.set({ piConfiguration: state.piConfiguration, view: "settings", settingsCategory: "pi" });
  assert.equal(root.querySelector("[data-setting='piProfile']").value, "");
  root.querySelector("pi-settings [data-act='save-pi-configuration']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(dom.window.__settingsPatches.at(-1).pi, {
    profile: null,
    profileSource: "disabled",
    packages: ["npm:kept"],
    extensions: ["./kept.ts"],
  });

  store.set({ settingsCategory: "repositories" });
  root.querySelector("pi-settings [data-act='save-repository-settings']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(root.querySelector("pi-settings").textContent, /Repository settings saved/);
  assert.equal(store.state.operations.some(operation => operation.kind === "repository-settings"), false);
  store.state.repositorySources.sources.find(source => source.id === "github").configured = true;
  root.querySelector("pi-settings [data-act='open-github-picker']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(root.querySelector("pi-repo-picker").textContent, /TEST-CODE/, "Settings sign-in begins GitHub Device Flow directly");
  root.querySelector("pi-repo-picker [data-github-cancel]").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  root.querySelector("pi-repo-picker [data-act='close']").click();
  await new Promise(resolve => setTimeout(resolve, 10));

  state.repositorySources.sources.find(source => source.id === "github").configured = true;
  state.settings.githubOwner.value = null;
  await refreshState();
  dom.window.__settingsPatches = [];
  const piOperationsBeforeLogin = store.state.operations.filter(operation => operation.kind === "pi-profile").length;
  const githubOwnerRefreshed = new Promise((resolve, reject) => {
    let unsubscribe;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error("GitHub login did not refresh the owner"));
    }, 1000);
    unsubscribe = store.subscribe(what => {
      if (what !== "state" || store.state.settings?.githubOwner?.value !== "logged-owner") return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
  dom.window.__githubLoginComplete = true;
  root.querySelector("pi-settings [data-act='open-github-picker']").click();
  await githubOwnerRefreshed;
  assert.equal(state.settings.githubOwner.value, "logged-owner");
  assert.equal(store.state.settings.githubOwner.value, "logged-owner");
  assert.deepEqual(dom.window.__settingsPatches, [{ githubOwner: "logged-owner" }]);
  assert.equal(store.state.operations.filter(operation => operation.kind === "pi-profile").length, piOperationsBeforeLogin);
  await root.querySelector("pi-repo-picker").dismiss();
  dom.window.__githubLoginComplete = false;
  store.set({ settingsCategory: "defaults" });
  const defaultToggle = root.querySelector("pi-settings pi-model-picker[data-mode='default'] [data-model-toggle]");
  defaultToggle.focus();
  defaultToggle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(dom.window.document.activeElement?.hasAttribute("data-model-automatic"), true, "Automatic is first in keyboard navigation");
  defaultToggle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(store.state.view, "settings", "closing the model picker does not leave Settings");
  root.querySelector("pi-settings [data-act='close-settings']").click();
  assert.equal(store.state.view, "chat", "Settings closes back to chat with its close control");
  store.set({ view: "settings" });
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(store.state.view, "chat", "Escape closes Settings");

  // Settings pages open at their hash; Workers lists and acts on live workers.
  dom.window.__workers = {
    usageAvailable: false,
    workspaces: [
      { name: "app", repository: "bry-guy/app", state: "running", keepAwake: true, busy: false, lastUsed: Date.now() - 60_000, resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: null, memory: "4Gi" } }, usage: null, grant: { name: "operator", description: "", namespace: "ops", serviceAccount: "op", egress: "open", env: ["OP_TOKEN"] } },
      { name: "scratch", repository: "bry-guy/scratch", state: "sleeping", keepAwake: false, busy: false, lastUsed: null, resources: null, usage: null, grant: null },
    ],
  };
  store.set({ view: "settings", settingsCategory: "workers" });
  assert.equal(dom.window.location.hash, "#settings/workers");
  await new Promise(resolve => setTimeout(resolve, 10));
  const workersPage = () => root.querySelector("pi-settings").textContent;
  assert.match(workersPage(), /Never put to sleep automatically/);
  assert.match(workersPage(), /OP_TOKEN/, "grants show env variable names");
  assert.match(workersPage(), /n\/a/, "usage is n/a without live metrics");
  assert.equal(root.querySelector("[data-act='reload-worker'][data-name='scratch']").disabled, true, "a sleeping worker cannot reload");
  root.querySelector("[data-act='restart-worker'][data-name='app']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.confirm?.type, "restartWorker");
  root.querySelector("pi-confirm [data-act='go']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(dom.window.__workerCalls.at(-1), { name: "app", action: "restart", body: {} });
  assert.equal(store.state.confirm, null, "a finished restart closes its dialog");

  dom.window.__workerError = "workspace_busy";
  root.querySelector("[data-act='reset-worker'][data-name='app']").click();
  const resetGo = () => root.querySelector("pi-confirm [data-act='go']");
  assert.equal(resetGo().disabled, true, "reset waits for the worker name");
  const typed = root.querySelector("pi-confirm [data-confirm-typed]");
  typed.value = "app";
  typed.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(resetGo().disabled, false);
  resetGo().click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(dom.window.__workerCalls.at(-1), { name: "app", action: "reset", body: { confirm: "app" } });
  assert.match(root.querySelector("pi-confirm .confirm-error").textContent, /This worker is busy/, "a refused reset explains why");
  dom.window.__workerError = null;
  store.set({ confirm: null });

  root.querySelector("[data-act='reload-all-workers']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(workersPage(), /scratch: This worker is busy/, "reload all reports each worker");

  dom.window.history.replaceState(null, "", "#settings/sync");
  dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
  assert.equal(store.state.settingsCategory, "sync", "Back and forward move between category hashes");
  store.set({ settingsCategory: null });

  store.set({
    model: "mock/fast",
    requestedModel: "anthropic/claude-opus-5-5",
    modelFallback: true,
    modelUnavailable: false,
  });
  const fallbackPicker = root.querySelector("pi-model-picker[data-mode='session']");
  fallbackPicker.open = true;
  fallbackPicker.render();
  assert.match(fallbackPicker.querySelector("[data-model-toggle]").textContent, /Mock Fast/);
  assert.match(fallbackPicker.querySelector(".model-unavailable").textContent, /claude-opus-5-5 is unavailable/);
  assert.match(fallbackPicker.querySelector(".model-unavailable").textContent, /Using Mock Fast/);
  fallbackPicker.close();

  root.querySelector(".model-chip").click();
  assert.ok(root.querySelector(".model-popover"));
  root.querySelector(".model-option[data-model='mock/smart']").click();
  assert.equal(store.state.model, "mock/smart");

  const picker = root.querySelector("pi-model-picker[data-mode='session']");
  picker.open = true;
  picker.render();
  picker.querySelector("[data-model-toggle]").getBoundingClientRect = () => ({ top: 260, bottom: 292, right: 360 });
  Object.defineProperty(dom.window, "innerHeight", { value: 300, configurable: true });
  picker.positionPopover();
  assert.ok(Number.parseInt(picker.querySelector(".model-list").style.maxHeight, 10) <= 220);
  assert.ok(Number.parseInt(picker.querySelector(".model-popover").style.maxHeight, 10) <= 276);

  const sessionRow = root.querySelector("[data-id='s1']");
  sessionRow.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(store.state.sessionId, "s1");

  root.querySelector("pi-header [data-act='files']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  let fileTarget = root.querySelector(".file-target");
  assert.ok(root.querySelector(".file-tree-target"));
  assert.equal(fileTarget.getAttribute("aria-label"), "Diff target");
  assert.equal(fileTarget.value, "origin");
  assert.match(fileTarget.selectedOptions[0].textContent, /vs origin/);
  assert.ok(root.querySelector("pi-files [data-file='README.md']"));
  assert.ok(root.querySelector("pi-files .file-row.status-new[data-file='new.js']"));
  const initialFileRow = root.querySelector("pi-files [data-file='README.md']");
  const initialFileCalls = dom.window.__fileListCalls;
  await refreshState();
  assert.equal(dom.window.__fileListCalls, initialFileCalls, "state refresh does not invalidate the file tree");
  assert.equal(root.querySelector("pi-files [data-file='README.md']"), initialFileRow, "state refresh preserves the file tree DOM");
  await root.ensureFiles(true);
  assert.equal(dom.window.__fileListCalls, initialFileCalls + 1, "explicit file revalidation still runs");
  assert.equal(root.querySelector("pi-files [data-file='README.md']"), initialFileRow, "unchanged file data does not replace the tree DOM");
  fileTarget = root.querySelector(".file-target");
  fileTarget.value = "primary";
  fileTarget.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.fileTarget, "primary");
  const readmeRow = root.querySelector("pi-files [data-file='README.md']");
  assert.ok(readmeRow);
  assert.equal(readmeRow.classList.contains("status-modified"), false);
  assert.ok(root.querySelector("pi-files .file-row.status-new[data-file='new.js']"));
  assert.ok(root.querySelector("pi-files .file-row.status-removed"));
  assert.ok(root.querySelector("pi-files .file-row.dir.status-modified[data-dir='src']"));
  root.querySelector("pi-files [data-dir='src']").click();
  assert.ok(root.querySelector("pi-files [data-file='src/untouched.js']"));
  assert.ok(root.querySelector("pi-files .file-row.status-modified[data-file='src/app.js']"));
  const treeScroll = root.querySelector(".files-scroll");
  treeScroll.scrollTop = 37;
  treeScroll.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
  // A file replaces the chat pane in place: the tree stays beside it and Back returns to the chat.
  root.querySelector("pi-files [data-file='src/app.js']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.filePath, "src/app.js");
  assert.equal(root.querySelector("[data-screen='chat']").classList.contains("covered"), true);
  assert.equal(root.querySelector("[data-screen='file']").classList.contains("hidden"), false);
  assert.equal(dom.window.location.hash, "#file/src%2Fapp.js");
  assert.ok(root.querySelector("pi-files .files"), "the file tree stays beside the file");
  assert.equal(root.querySelector(".file-viewer"), null, "files are a pane, not a modal");
  assert.equal(dom.window.document.activeElement?.getAttribute("aria-label"), "Back to chat");
  assert.equal(root.querySelector("pi-file-view .file-target"), null);
  assert.equal(root.querySelector("pi-file-view .file-section-head")?.textContent, "Diff");
  assert.match(root.querySelector(".file-diff-body")?.textContent || "", /const answer/);
  assert.match(root.querySelector(".file-diff-meta")?.textContent || "", /vs main/);
  root.querySelector("[data-act='close-file']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.filePath, null);
  assert.equal(root.querySelector("[data-screen='chat']").classList.contains("covered"), false);
  assert.equal(root.querySelector("pi-files [data-act='close']").getAttribute("aria-label"), "Collapse files");
  assert.equal(root.querySelector(".files-scroll").scrollTop, 37, "the tree keeps its scroll position");
  fileTarget = root.querySelector(".file-target");
  fileTarget.value = "origin";
  fileTarget.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(root.querySelector("pi-files [data-file='README.md']"));
  root.querySelector("pi-files [data-file='src/app.js']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(root.querySelector(".file-code .hljs-keyword"));
  assert.equal(root.querySelector(".file-diff-body"), null);
  const viewerScroll = root.querySelector(".file-view-scroll");
  viewerScroll.scrollTop = 73;
  viewerScroll.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
  assert.equal(viewerScroll.scrollTop, 73);
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.filePath, null, "Escape returns to chat");
  root.querySelector("pi-files [data-file='src/app.js']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(root.querySelector(".file-view-scroll").scrollTop, 73, "reopening restores the file's scroll position");
  root.querySelector("[data-act='close-file']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.filePath, null);
  // Dot-names sort first among folders and among files.
  assert.deepEqual([...root.querySelectorAll("pi-files .files-scroll > .file-row")].map(row => row.querySelector(".fname").textContent), [".github", "src", "app.js", ".env", "new.js", "README.md"]);
  root.querySelector("pi-files [data-act='close']").click();

  // Files opens, closes and opens again with the same tree: an identical reopen used to stay empty.
  const filesToggle = () => root.querySelector("pi-header [data-act='files']");
  filesToggle().click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(root.querySelector("pi-files [data-file='README.md']"), "Files opens");
  filesToggle().click();
  assert.equal(root.querySelector("pi-files .files"), null, "Files closes");
  filesToggle().click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(root.querySelector("pi-files [data-file='README.md']"), "Files opens again");
  root.querySelector("pi-files [data-file='src/app.js']").click();
  await new Promise(resolve => setTimeout(resolve, 10));
  filesToggle().click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.filePath, null);
  assert.equal(dom.window.location.hash, "", "closing Files leaves the #file/ address");
  filesToggle().click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(root.querySelector("pi-files [data-file='README.md']"), "Files opens after closing it over a file");
  assert.equal(root.querySelector("pi-header [data-act='files'] svg path:last-child").getAttribute("d"), "m11.4 4-2.8 12", "the Files toggle is a </> code symbol");

  // Settings → Appearance → Show hidden files (on by default) hides dot-names from the tree.
  assert.equal(store.state.showHiddenFiles, true);
  store.set({ view: "settings", settingsCategory: "appearance" });
  const hiddenSwitch = root.querySelector("pi-settings [data-act='toggle-hidden-files']");
  assert.equal(hiddenSwitch.getAttribute("aria-checked"), "true");
  globalThis.localStorage = dom.window.localStorage;
  hiddenSwitch.click();
  delete globalThis.localStorage;
  assert.equal(store.state.showHiddenFiles, false);
  assert.equal(dom.window.localStorage.getItem("pi-show-hidden-files"), "false", "the choice is stored in this browser");
  assert.equal(root.querySelector("pi-settings [data-act='toggle-hidden-files']").getAttribute("aria-checked"), "false");
  store.set({ view: "chat", settingsCategory: null });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(root.querySelector("pi-files [data-dir='.github']"), null, "hidden folders are left out");
  assert.equal(root.querySelector("pi-files [data-file='.env']"), null, "hidden files are left out");
  assert.ok(root.querySelector("pi-files [data-file='README.md']"));
  store.set({ view: "settings", settingsCategory: "appearance" });
  root.querySelector("pi-settings [data-act='toggle-hidden-files']").click();
  store.set({ view: "chat", settingsCategory: null });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(root.querySelector("pi-files [data-dir='.github']"), "turning the setting back on shows them again");
  root.querySelector("pi-files [data-act='close']").click();

  const sidebar = root.querySelector("pi-sidebar");
  root.querySelector("pi-header [data-act='sidebar-toggle']").click();
  assert.equal(store.state.railOpen, false);
  assert.equal(sidebar.dataset.layout, "mini");
  root.querySelector("pi-header [data-act='sidebar-toggle']").click();
  assert.equal(store.state.railOpen, true);
  assert.equal(sidebar.dataset.layout, "rail");
  assert.equal(sidebar.querySelector("[data-act='projects']"), null, "projects has no separate navigation entry");
  assert.equal(root.querySelector("[data-screen='projects']"), null, "projects has no separate screen");
  store.set({ view: "chat" });

  applyEvent({ v: 1, seq: 101, sessionId: "sibling", type: "user_record", record: { id: "u-sibling", role: "user", text: "recent sibling" } });
  assert.equal(store.state.projects[0].sessions[0].id, "sibling");

  textarea.value = "foo";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  root.querySelector("[data-id='sibling']").click();
  assert.equal(textarea.value, "", "a different session starts with its own draft");
  root.querySelector("[data-id='s1']").click();
  assert.equal(textarea.value, "foo", "returning to a session restores its draft");
  const shiftEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
  textarea.dispatchEvent(shiftEnter);
  assert.equal(shiftEnter.defaultPrevented, false, "desktop Shift+Enter inserts a newline");
  assert.equal(store.transcript("s1").records.some(record => record.pending), false);
  const composingEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
  textarea.dispatchEvent(composingEnter);
  assert.equal(composingEnter.defaultPrevented, false, "IME Enter confirms composition without sending");

  dom.setNarrowViewport(true);
  const mobileEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  textarea.dispatchEvent(mobileEnter);
  assert.equal(mobileEnter.defaultPrevented, false, "mobile Enter inserts a newline");
  assert.equal(store.transcript("s1").records.some(record => record.pending), false, "mobile Enter does not send");

  dom.setNarrowViewport(false);
  const desktopEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  textarea.dispatchEvent(desktopEnter);
  assert.equal(desktopEnter.defaultPrevented, true, "desktop Enter sends");
  assert.equal(store.transcript("s1").records.some(record => record.pending), true);
  while (composer.sendingIds.has("s1")) await new Promise(resolve => setImmediate(resolve));

  dom.setNarrowViewport(true);
  const pendingBeforeButton = store.transcript("s1").records.filter(record => record.pending).length;
  textarea.value = "mobile button send";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  composer.querySelector(".send-btn").click();
  assert.equal(store.transcript("s1").records.filter(record => record.pending).length, pendingBeforeButton + 1);
  while (composer.sendingIds.has("s1")) await new Promise(resolve => setImmediate(resolve));
  dom.setNarrowViewport(false);

  textarea.value = "/";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(composer.querySelector(".command-popover").classList.contains("hidden"), false);
  textarea.value = "/na";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(composer.querySelectorAll(".command-option").length, 1);
  assert.match(composer.querySelector(".command-option").textContent, /\/name/);
  composer.querySelector(".command-option").click();
  assert.equal(textarea.value, "/name ");

  store.state.transcripts.s1 = {
    records: [{ id: "md1", role: "assistant", text: "## A readable reply\n\nA **bold** point and `inline code`.\n\n- one\n- two", streaming: true }],
    streaming: true,
    seq: 101,
  };
  store.set({ chatId: null, projectId: "p1", sessionId: "s1", view: "chat" });
  assert.equal(root.querySelector(".markdown-content h2")?.textContent, "A readable reply");
  assert.equal(root.querySelector(".markdown-content strong")?.textContent, "bold");
  assert.equal(root.querySelectorAll(".markdown-content li").length, 2);
  applyEvent({ v: 1, seq: 102, sessionId: "s1", type: "text_delta", messageId: "md1", delta: "\n\n> Streaming stays formatted." });
  assert.match(root.querySelector(".markdown-content blockquote")?.textContent || "", /Streaming stays formatted/);

  store.state.unread = {};
  store.set({ view: "settings" });
  applyEvent({ v: 1, seq: 103, sessionId: "sibling", type: "turn_end", reason: "done" });
  assert.equal(store.state.unread.sibling, true);
  store.set({ view: "chat", projectId: "p1", sessionId: "sibling", chatId: null });
  store.markRead("sibling");
  assert.equal(store.state.unread.sibling, undefined);

  // Project-level actions live in the Project menu, opened by clicking the sidebar's project row; the session menu keeps per-conversation ones.
  store.set({ view: "chat", projectId: "p1", sessionId: "s1", chatId: null, railOpen: true, query: "" });
  root.querySelector("pi-header [data-act='session-panel']").click();
  assert.equal(root.querySelector("pi-session-picker [data-act='end-idle']"), null, "End idle is not a session action");
  assert.equal(root.querySelector("pi-session-picker .worker-card"), null, "the worker is not in the session menu");
  assert.equal(root.querySelector("pi-session-picker [data-act='delete-branch']")?.textContent, "Delete branch");
  assert.equal(root.querySelector("pi-session-picker [data-act='open-project-menu']"), null, "no Project entry in the session menu");
  root.querySelector("[data-act='close-session-picker']").click();
  root.querySelector("pi-sidebar [data-act='project-row'][data-id='p1']").click();
  assert.ok(root.querySelector("pi-project-menu [data-act='end-idle']"));
  assert.ok(root.querySelector("pi-project-menu [data-act='remove-project']"));
  root.querySelector("pi-project-menu [data-act='close-project-menu']").click();
  store.state.projects[0].ended = [{ id: "old1", title: "Old work", when: "2d", updatedAt: 1 }];
  store.notify("state");
  assert.equal(root.querySelector("pi-sidebar [data-act='toggle-ended']"), null, "the sidebar has no Ended list");
  root.querySelector("pi-sidebar [data-act='project-row'][data-id='p1']").click();
  assert.ok(store.state.projectMenu, "clicking the project row opens the Project menu");
  assert.equal(store.state.sessionId, "s1", "and does not start a new session");
  // A past session previews first, like a History entry; Open appears only under the preview.
  assert.equal(root.querySelector("pi-project-menu [data-act='open-past']"), null, "no Open before a preview");
  const pastRow = root.querySelector("pi-project-menu [data-act='toggle-preview'][data-key='past:old1']");
  assert.match(pastRow.textContent, /Old work/);
  dom.window.__transcriptResponse = { sessionId: "old1", seq: 0, streaming: false, records: [{ id: "u", role: "user", text: "Old question" }, { id: "a", role: "assistant", text: "Old answer" }, { id: "t", role: "tool", tool: "bash" }] };
  pastRow.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  delete dom.window.__transcriptResponse;
  assert.equal(root.querySelector("pi-project-menu [data-key='past:old1']").getAttribute("aria-expanded"), "true");
  assert.deepEqual([...root.querySelectorAll("pi-project-menu .convo-preview-msg p")].map(node => node.textContent), ["Old question", "Old answer"], "the preview shows the conversation's messages");
  assert.ok(root.querySelector("pi-project-menu .convo-preview [data-act='open-past'][data-id='old1']"), "Open sits under the preview");
  root.querySelector("pi-project-menu [data-key='past:old1']").click();
  assert.equal(root.querySelector("pi-project-menu .convo-preview"), null, "clicking the row again hides it");
  root.querySelector("pi-project-menu [data-act='remove-project']").click();
  assert.equal(store.state.confirm?.type, "removeProject");
  const escape = () => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  store.set({ projectMenu: { projectId: "p1" } });
  escape();
  assert.equal(store.state.confirm, null, "Esc closes the confirmation first");
  assert.ok(store.state.projectMenu);
  escape();
  assert.equal(store.state.projectMenu, null, "then the Project menu");
  root.querySelector("pi-header [data-act='session-panel']").click();
  root.querySelector("pi-session-picker").showScreen("fork");
  escape();
  assert.equal(store.state.sessionPicker?.screen, "main", "a session-panel step goes back first");
  escape();
  assert.equal(store.state.sessionPicker, null, "then the session panel closes");
  delete store.state.projects[0].ended;

  // One copy row per turn, on its last reply; "Copy Turn" only when the turn had several.
  store.state.transcripts.s1.streaming = false;
  store.state.transcripts.s1.records = [
    { id: "u1", role: "user", text: "go" },
    { id: "r1", role: "assistant", text: "First note." },
    { id: "t1", role: "tool", name: "bash", args: {} },
    { id: "r2", role: "assistant", text: "Second note." },
    { id: "u2", role: "user", text: "again" },
    { id: "r3", role: "assistant", text: "Only reply." },
  ];
  store.set({ view: "chat", projectId: "p1", sessionId: "s1", chatId: null });
  const rec = id => root.querySelector(`[data-rec="${id}"]`);
  assert.equal(rec("r1").querySelector("[data-copy]"), null);
  assert.ok(rec("r1").classList.contains("reply-mid"));
  assert.ok(rec("r2").querySelector("[data-copy]:not([data-copy-turn])"));
  assert.equal(rec("r2").querySelector("[data-copy]:not([data-copy-turn])").dataset.tip, "Copy Response");
  assert.equal(rec("r2").querySelector("[data-copy-turn]")?.dataset.tip, "Copy Turn");
  assert.equal(rec("u1").querySelector("[data-copy]").dataset.tip, "Copy Message");
  assert.equal(rec("r3").querySelector("[data-copy-turn]"), null);
  let copied = null;
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async text => { copied = text; } } });
  rec("r2").querySelector("[data-copy-turn]").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(copied, "First note.\n\nSecond note.");
  rec("r2").querySelector("[data-copy]:not([data-copy-turn])").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(copied, "Second note.");
  delete globalThis.navigator.clipboard;

  store.set({ view: "chat", projectId: "p1", sessionId: "s1", chatId: null });
  store.state.transcripts.s1.records = [{
    id: "activity:agent:solo", role: "activity", kind: "agent", key: "agent:solo", status: "running",
    title: "Solo", summary: "Working without todos", items: [], source: "test",
  }];
  store.notify("transcript");
  assert.match(root.querySelector(".activity-stack .agent-panel")?.textContent || "", /Working without todos/);
  store.state.transcripts.s1.records = [];
  store.notify("transcript");
  applyEvent({ v: 1, seq: 104, sessionId: "s1", type: "activity", record: {
    id: "activity:todo:1", role: "activity", kind: "todo", key: "todo", status: "in_progress",
    title: "Todos", summary: "1/2 complete", source: "test",
    items: [
      { id: "1", subject: "done", status: "completed", activeForm: "", blockedBy: [] },
      { id: "2", subject: "<safe>", status: "in_progress", activeForm: "checking", blockedBy: [] },
    ],
  } });
  assert.match(root.querySelector(".todo-panel")?.textContent || "", /1\/2/);
  assert.equal(root.querySelector(".todo-panel .activity-body"), null);
  assert.equal(root.querySelector(".todo-panel safe"), null);
  root.querySelector(".todo-panel [data-activity-toggle]").click();
  assert.ok(root.querySelector(".todo-panel .activity-body"));
  assert.match(root.querySelector(".todo-panel")?.textContent || "", /checking/);
  applyEvent({ v: 1, seq: 105, sessionId: "s1", type: "turn_end", reason: "done" });
  assert.equal(root.querySelector(".todo-panel .activity-body"), null);
  applyEvent({ v: 1, seq: 106, sessionId: "s1", type: "activity", record: {
    id: "activity:agent:a1", role: "activity", kind: "agent", key: "agent:a1", status: "running",
    title: "Explore", summary: "Checking files…", items: [], source: "test",
  } });
  assert.match(root.querySelector(".activity-stack .agent-panel")?.textContent || "", /Checking files/);
  assert.equal(root.querySelector(".activity-inline .bh-name"), null);
  applyEvent({ v: 1, seq: 107, sessionId: "s1", type: "activity", record: {
    id: "activity:agent:a1", role: "activity", kind: "agent", key: "agent:a1", runId: "a1",
    groupId: "group-1", parentMessageId: "assistant-1", revision: 2, status: "completed",
    title: "Explore", activity: "", summary: "Found the files.", toolCount: 2,
    createdAt: "2026-08-22T00:00:00.000Z", startedAt: "2026-08-22T00:00:00.000Z",
    endedAt: "2026-08-22T00:00:01.000Z", items: [], source: "test",
  } });
  assert.equal(root.querySelector(".subagent-panel"), null, "completed agents leave the live activity surface");
  assert.match(root.querySelector(".activity-inline .bh-name")?.textContent || "", /Explore/);
  assert.doesNotMatch(root.querySelector(".activity-inline")?.textContent || "", /Found the files/);
  root.querySelector(".activity-inline [data-activity-toggle]").click();
  assert.match(root.querySelector(".activity-inline")?.textContent || "", /Found the files/);
  assert.match(root.querySelector(".activity-inline")?.textContent || "", /completed/);

  store.state.transcripts.s1.records.unshift({ id: "pending-1", pendingId: "client-1", role: "user", text: "optimistic", pending: true });
  store.notify("transcript");
  applyEvent({ v: 1, seq: 108, sessionId: "s1", type: "user_record", clientMessageId: "client-1", record: { id: "u-1", role: "user", text: "optimistic" } });
  assert.equal(root.querySelector(".delivery-status"), null);
  assert.ok(root.querySelector(".user-message-content"));
  assert.equal(store.state.transcripts.s1.records.some(record => record.pending), false);
  store.state.transcripts.s1.records.push({ id: "pending-2", pendingId: "client-2", role: "user", text: "refused elsewhere", pending: true });
  applyEvent({ v: 1, seq: 108.5, sessionId: "s1", type: "prompt_handled", clientMessageId: "client-2" });
  assert.equal(store.state.transcripts.s1.records.some(record => record.pendingId === "client-2"), false, "a handled prompt leaves no bubble");
  store.state.transcripts.s1.records.push({ id: "failed-1", role: "user", text: "failed", deliveryError: "provider unavailable" });
  store.notify("transcript");
  assert.equal(root.querySelector(".delivery-status")?.textContent, "ERROR: Unable to send.");
  applyEvent({ v: 1, seq: 109, sessionId: "s1", type: "activity", record: {
    id: "activity:compaction", role: "activity", kind: "status", key: "compaction", status: "running",
    title: "Compacting", summary: "context…", items: [], source: "pi",
  } });
  assert.equal(root.querySelector(".activity-status strong")?.textContent, "Compacting");
  assert.equal(root.querySelector(".activity-status span:last-child")?.textContent, "context…");
  assert.ok(root.querySelector(".activity-inline .activity-status"));
  assert.equal(root.querySelector(".activity-stack .activity-status"), null);
  assert.equal(store.state.transcripts.s1.compacting, true);
  assert.equal(root.querySelector(".send-btn").disabled, true);
  assert.match(root.querySelector("textarea").placeholder, /Compacting context/);

  store.state.projects[0].sessions[0].branch = "feat/ship";
  store.state.transcripts.s1.compacting = false;
  store.notify("state");
  applyEvent({ v: 1, seq: 110, sessionId: "s1", type: "turn_start", turnId: "t-error" });
  applyEvent({ v: 1, seq: 111, sessionId: "s1", type: "message_start", messageId: "a-error", role: "assistant" });
  applyEvent({ v: 1, seq: 112, sessionId: "s1", type: "turn_end", turnId: "t-error", reason: "errored", error: "Insufficient quota." });
  assert.equal(store.transcript("s1").streaming, false);
  assert.equal(root.querySelector(".turn-error")?.textContent, "ERROR: Insufficient quota.");
  assert.equal(root.querySelector(".pi-think"), null);

  const scroller = root.querySelector(".scrollable");
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
  store.state.transcripts.s1 = {
    records: [{ id: "latest", role: "assistant", text: "latest" }],
    streaming: false, seq: 1, scrollToLatest: true,
  };
  store.notify("transcript");
  assert.equal(scroller.scrollTop, 1200);

  const longRecords = Array.from({ length: 1020 }, (_, index) => ({
    id: `long-${index}`, role: "assistant", text: `message ${index}`,
  }));
  store.state.transcripts.s1 = { records: longRecords, streaming: false, seq: 320 };
  store.notify("transcript");
  const thread = root.querySelector("pi-thread");
  const initialRendered = thread.querySelectorAll(".assist").length;
  assert.ok(initialRendered < longRecords.length);
  assert.match(thread.textContent, /message 1019/);
  assert.doesNotMatch(thread.textContent, /message 0/);
  assert.equal(thread.querySelector("[data-load-earlier]"), null);
  scroller.scrollTop = 0;
  scroller.dispatchEvent(new dom.window.Event("scroll"));
  assert.ok(thread.querySelectorAll(".assist").length > initialRendered);

  // Unchanged state must not rebuild the transcript: rebuilding drops taps
  // and costs a full layout on every background refresh.
  const firstNode = thread.querySelector("[data-rec]");
  assert.ok(firstNode);
  store.notify("state");
  store.notify("transcript");
  assert.equal(thread.querySelector("[data-rec]"), firstNode);
  // A real change still re-renders.
  longRecords.at(-1).text = "message changed";
  store.state.transcripts.s1 = { ...store.state.transcripts.s1, records: [...longRecords] };
  store.notify("transcript");
  assert.match(thread.textContent, /message changed/);


  scroller.scrollTop = 240;
  store.state.transcripts.s1 = { records: [...longRecords], streaming: false, seq: 321, scrollToLatest: false };
  store.notify("transcript");
  assert.equal(scroller.scrollTop, 240, "background transcript reload keeps the user's scroll position");

  root.querySelector("pi-header [data-act='session-panel']")?.click();
  assert.ok(root.querySelector(".session-picker"));
  assert.equal(root.querySelector("[data-act='apply-session-branch'][data-mode='switch']"), null);
  root.querySelector("[data-act='close-session-picker']")?.click();

  dom.window.__holdMerge = true;
  store.set({ view: "chat", projectId: "p1", sessionId: "s1", chatId: null, sessionPicker: null, confirm: null });
  root.querySelector("pi-header [data-act='session-panel']").click();
  root.querySelector("[data-act='merge-branch']").click();
  root.querySelector(".confirm-modal [data-act='go']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(root.querySelector(".confirm-progress .operation-dot"));
  const mergeOperation = store.state.operations.find(operation => operation.kind === "merge" && operation.sessionId === "s1");
  applyEvent({ type: "operation_log", operationId: mergeOperation.id, event: { at: Date.now(), type: "phase", message: "Running git merge." } });
  assert.match(root.querySelector(".confirm-progress").textContent, /Running git merge/);
  assert.equal(root.querySelector(".confirm-progress").parentElement.classList.contains("confirm-actions"), true);
  assert.equal(root.querySelector(".confirm-progress").previousElementSibling.classList.contains("confirm-button-row"), true);
  dom.window.__mergeFails = true;
  root.querySelector(".confirm-modal [data-act='cancel']").click();
  assert.equal(root.querySelector(".confirm-modal"), null);
  dom.window.__resolveMerge();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(root.querySelector(".confirm-modal"), null, "a dismissed merge does not resurrect its error modal");
  assert.match(store.state.error, /http_502/);
  dom.window.__holdMerge = false;
  dom.window.__mergeFails = false;

  const closeButton = root.querySelector("[data-id='sibling'] .row-close");
  assert.ok(closeButton);
  closeButton.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(store.state.confirm, null, "Closing a session does not open a warning modal");
  assert.equal(root.querySelector(".confirm-modal"), null);
  assert.equal(root.querySelector(".operation-modal"), null, "closing a session does not open a terminal modal");
  store.set({ settingsCategory: "diagnostics" });
  root.querySelector("pi-settings [data-act='open-logs']").click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(root.querySelector(".logs-modal").textContent, /Session closed/);
  assert.doesNotMatch(root.querySelector(".logs-modal").textContent, /pi close/);
  root.querySelector("[data-act='close-logs']").click();

  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "visible" });
  store.transcript("s1").streaming = false;
  store.transcript("s1").compacting = false;
  store.clearDraft("s1");
  composer.attachments = [];
  composer.renderAttachments();
  textarea.value = "";
  store.set({ view: "chat", projectId: "p1", sessionId: "s1", chatId: null, sessionPicker: null, error: null });
  await new Promise(resolve => setTimeout(resolve, 20));
  applyEvent({ v: 1, seq: 102, sessionId: "sibling", type: "session_switched", toSessionId: "sync-target" });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.sessionId, "s1", "switches from another conversation do not move this tab");

  textarea.value = "same-id draft";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  applyEvent({ v: 1, seq: 103, sessionId: "s1", type: "session_switched", toSessionId: "s1" });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.state.sessionId, "s1");
  assert.equal(textarea.value, "same-id draft", "a same-ID catch-up keeps the draft");
  assert.doesNotMatch(root.querySelector(".command-notice")?.textContent || "", /replacement is ready/);
  textarea.value = "";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(store.state.sessionId, "s1", "same-ID catch-up reloads without reselection");
  assert.equal(store.state.commandNotice, null);

  dom.window.__addSyncTargetOnStateRefresh = true;
  textarea.value = "source draft";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  applyEvent({ v: 1, seq: 104, sessionId: "s1", type: "session_switched", toSessionId: "sync-target" });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(store.state.sessionId, "sync-target", "a replacement opens without waiting for the source draft");
  assert.equal(store.draft("s1"), "source draft", "the source draft stays with its conversation");
  store.clearDraft("s1");

  selectSession("p1", "s1");
  await new Promise(resolve => setTimeout(resolve, 20));
  dom.window.__holdState = true;
  applyEvent({ v: 1, seq: 105, sessionId: "s1", type: "session_switched", toSessionId: "sync-target" });
  for (let i = 0; i < 10 && !dom.window.__resolveState; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(typeof dom.window.__resolveState, "function", "switch waits for state discovery");
  selectSession("p1", "sibling");
  dom.window.__holdState = false;
  dom.window.__resolveState();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(store.state.sessionId, "sibling", "selection changes during state refresh prevent stale SSE navigation");

  selectSession("p1", "s1");
  textarea.value = "first submission";
  textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  dom.window.__holdMessage = true;
  const sending = composer.send();
  store.setDraft("newer unsent text", "s1");
  store.setDraftAttachments([{ type: "image", data: "Zm9v", mimeType: "image/png", name: "later.png" }], "s1");
  dom.window.__releaseMessage();
  await sending;
  assert.equal(store.draft("s1"), "newer unsent text", "a completed send cannot clear newer text");
  assert.equal(store.draftAttachments("s1").length, 1, "a completed send cannot clear newer attachments");
  assert.equal(textarea.value, "newer unsent text");

  dom.window.__failWrites = true;
  const failing = composer.send();
  store.setDraft("latest unsent text", "s1");
  store.setDraftAttachments([{ type: "image", data: "YmFy", mimeType: "image/png", name: "latest.png" }], "s1");
  dom.window.__releaseMessage();
  await failing;
  assert.equal(store.draft("s1"), "latest unsent text", "a failed send cannot restore over newer text");
  assert.equal(store.draftAttachments("s1")[0].name, "latest.png", "a failed send cannot restore over newer attachments");
  dom.window.__holdMessage = false;
  dom.window.__failWrites = false;
  store.clearDraft("s1");
  state.chats.push({ id: "fallback-chat", title: "Standalone chat", streaming: false });

  selectSession("p1", "s1");
  await new Promise(resolve => setTimeout(resolve, 30));
  Object.assign(state.chats[0], {
    model: "mock/smart",
    requestedModel: "anthropic/claude-opus-5-5",
    modelFallback: true,
    modelUnavailable: false,
  });
  dom.window.__addSyncTargetOnStateRefresh = false;
  state.projects[0].sessions = [];
  await refreshState();
  assert.equal(store.state.sessionId, "s1");
  assert.equal(state.chats[0].id, "fallback-chat");
  applyEvent({ v: 1, seq: 200, sessionId: "s1", type: "session_closed" });
  assert.equal(store.transcript("s1").seq, 200);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(store.state.chatId, "fallback-chat", "closing the last project session falls back to a chat");
  assert.deepEqual({
    model: store.state.model,
    requestedModel: store.state.requestedModel,
    modelFallback: store.state.modelFallback,
    modelUnavailable: store.state.modelUnavailable,
  }, {
    model: "mock/smart",
    requestedModel: "anthropic/claude-opus-5-5",
    modelFallback: true,
    modelUnavailable: false,
  }, "fallback navigation replaces all active model metadata");


  // Chat activity: custom-element registration is per process, so this runs inside the gate's window.
  {
    store.set({ view: "chat", projectId: "p1", sessionId: "s1", chatId: null });
    const T = 1_000_000;
    store.state.transcripts.s1 = { streaming: false, seq: 0, records: [
      { id: "u1", role: "user", text: "fix files.js", at: T },
      { id: "a:u1", role: "assistant", text: "Done.", thinking: "Read the file first.", toolIds: ["t1"], at: T + 1000 },
      { id: "t1", role: "tool", tool: "read", arg: "src/files.js", meta: "2ms", out: "contents", at: T + 1000 },
      { id: "sum1", role: "summary", text: "Read files.js", toolCallIds: ["t1"], at: T + 42000 },
    ] };
    store.notify("transcript");
    const thread = root.querySelector("pi-thread");

    assert.match(thread.textContent, /Done\./);
    assert.doesNotMatch(thread.textContent, /Read the file first/, "thinking is never shown inline");
    assert.equal(thread.querySelector(".block"), null, "tool calls are not inline");
    assert.equal(thread.querySelector(".busy-row"), null, "an idle chat has no busy line");
    assert.equal(thread.querySelector(".turn-done-row").textContent.trim(), "Worked 42s · 1 step›");

    store.state.transcripts.s1.streaming = true;
    store.state.transcripts.s1.records.push({ id: "t2", role: "tool", tool: "bash", arg: "npm test", meta: "", out: "", at: T + 43000, running: true });
    store.notify("transcript");
    assert.equal(thread.querySelector(".busy-text").textContent, "Working…");
    assert.equal(thread.querySelectorAll(".busy-dots i").length, 6, "the spinner is a 2×3 dot grid");
    const litDots = new Set();
    for (let sample = 0; sample < 14; sample++) {
      thread.querySelectorAll(".busy-dots i").forEach((dot, index) => { if (dot.classList.contains("on")) litDots.add(index); });
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    assert.equal(litDots.size, 6, "every spinner dot lights in some frame");
    assert.equal(thread.querySelector(".turn-done-row"), null, "a running turn has no finished row");

    applyEvent({ v: 1, seq: 1, sessionId: "s1", type: "extension_ui_working", message: "Summarizing the test run" });
    assert.equal(thread.querySelector(".busy-text").textContent, "Summarizing the test run", "the extension's live line wins");

    applyEvent({ v: 1, seq: 2, sessionId: "s1", type: "turn_end", reason: "done" }, true);
    assert.equal(thread.querySelector(".busy-row"), null);
    assert.equal(thread.querySelector(".turn-done-row").textContent.trim(), "Worked 43s · 2 steps›");

    thread.querySelector(".turn-done-row").click();
    assert.equal(location.hash, "#steps=u1");
    assert.ok(thread.querySelector(".steps-view"), "steps replace the chat in place");
    assert.equal(thread.querySelector(".turn-done-row"), null);
    assert.match(thread.querySelector(".step-summary").textContent, /Read files\.js/);
    assert.equal(thread.querySelector(".step-group-body"), null, "summaries start collapsed");
    thread.querySelector(".step-summary").click();
    assert.match(thread.querySelector(".step-group-body").textContent, /src\/files\.js/);
    thread.querySelector('[data-toggle="think:a:u1"]').click();
    assert.match(thread.querySelector(".step-thinking").textContent, /Read the file first\./);

    thread.querySelector("[data-steps-back]").click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(thread.querySelector(".steps-view"), null);
    assert.ok(thread.querySelector(".turn-done-row"), "the chat returns with its turn row");
    assert.equal(location.hash, "");
  }

  dom.window.close();
});
