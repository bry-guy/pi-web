import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadBindings, loadClosed, saveBindings, saveClosed } from "../server/config.js";
import { projectState } from "../server/domain.js";
import { RealSupervisor, effectiveModelInfo, isPackageSetupFailure } from "../server/supervisor/real.js";

const script = `
  import { startServer } from './server/index.js';
  const { server } = startServer(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const providersResponse = await fetch(base + '/api/providers');
  const providers = await providersResponse.json();
  const created = await (await fetch(base + '/api/chats', { method: 'POST' })).json();
  const commandsResponse = await fetch(base + '/api/sessions/' + created.id + '/commands');
  const commands = await commandsResponse.json();
  const message = await fetch(base + '/api/sessions/' + created.id + '/message', {
    method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({text:'hello'})
  });
  const transcript = await (await fetch(base + '/api/sessions/' + created.id + '/transcript')).json();
  console.log(JSON.stringify({providersStatus: providersResponse.status, providers, created, commandsStatus: commandsResponse.status, commands, messageStatus: message.status, message: await message.json(), transcript}));
  server.closeAllConnections?.(); server.close();
`;

test("effective model metadata never presents an unavailable recorded model as active", () => {
  const available = new Set(["openai-codex/gpt-6-luna"]);
  assert.deepEqual(
    effectiveModelInfo("anthropic/claude-opus-5-5", null, available, "openai-codex/gpt-6-luna"),
    {
      model: "openai-codex/gpt-6-luna",
      requestedModel: "anthropic/claude-opus-5-5",
      modelFallback: true,
    },
  );
  assert.deepEqual(
    effectiveModelInfo("anthropic/claude-opus-5-5", null, available, null),
    {
      model: null,
      requestedModel: "anthropic/claude-opus-5-5",
      modelUnavailable: true,
    },
  );
  assert.deepEqual(
    effectiveModelInfo("anthropic/claude-opus-5-5", "openai-codex/gpt-6-sol", available, "openai-codex/gpt-6-luna"),
    {
      model: "openai-codex/gpt-6-sol",
      requestedModel: "anthropic/claude-opus-5-5",
      modelFallback: true,
    },
  );
  assert.deepEqual(
    effectiveModelInfo("openai-codex/gpt-6-luna", null, available, null),
    { model: "openai-codex/gpt-6-luna" },
  );
});

test("unavailable recorded models attach with the explicit web default", async () => {
  const fallback = { provider: "openai-codex", id: "gpt-6-luna", api: "openai-codex-responses" };
  const runtime = {
    getModel(provider, id) {
      return provider === fallback.provider && id === fallback.id ? fallback : undefined;
    },
  };
  const supervisor = new RealSupervisor({ emit() {} });
  supervisor._modelRuntime = async () => runtime;
  supervisor.defaultModel = async () => "openai-codex/gpt-6-luna";
  supervisor._createConfiguredSession = async ({ model }) => {
    assert.equal(model, fallback);
    return { session: {
      sessionId: "synced-session",
      sessionFile: "/tmp/synced-session.jsonl",
      sessionName: null,
      sessionManager: { getBranch: () => [] },
      model,
      subscribe: () => () => {},
    } };
  };

  const state = await supervisor._attach(null, "/tmp", "anthropic/claude-opus-5-5");
  assert.equal(state.session.model, fallback);
  assert.deepEqual(supervisor.info.get("synced-session"), {
    id: "synced-session",
    path: "/tmp/synced-session.jsonl",
    cwd: "/tmp",
    model: "openai-codex/gpt-6-luna",
    requestedModel: "anthropic/claude-opus-5-5",
    modelFallback: true,
  });
});

test("ChatGPT OAuth continues to use device-code login", async () => {
  let selected;
  const runtime = {
    async login(_provider, _type, interaction) {
      selected = await interaction.prompt({
        type: "select",
        options: [
          { id: "browser", label: "Browser" },
          { id: "device_code", label: "Device code" },
        ],
      });
    },
    async refresh() {},
    async getAvailable() { return []; },
  };
  const supervisor = new RealSupervisor({});
  supervisor._modelRuntime = async () => runtime;
  await supervisor.loginProvider("openai-codex", "oauth", {
    prompt: async () => "browser",
  });
  assert.equal(selected, "device_code");
});

test("Anthropic OAuth uses headless copy-code login", async () => {
  let selected;
  const runtime = {
    async login(provider, type, interaction) {
      assert.equal(provider, "anthropic");
      assert.equal(type, "oauth");
      selected = await interaction.prompt({
        type: "select",
        options: [
          { id: "browser", label: "Browser" },
          { id: "copy_code", label: "Copy code" },
        ],
      });
      assert.equal(await interaction.prompt({ type: "manual_code" }), "pasted-code");
    },
    async refresh() {},
    async getAvailable() { return []; },
  };
  const supervisor = new RealSupervisor({});
  supervisor._modelRuntime = async () => runtime;
  await supervisor.loginProvider("anthropic", "oauth", {
    prompt: async prompt => prompt.type === "manual_code" ? "pasted-code" : "browser",
  });
  assert.equal(selected, "copy_code");
});

test("package command failures are eligible for package-free runtime fallback", () => {
  assert.equal(isPackageSetupFailure(new Error("/usr/local/bin/npm --include=dev install failed with code 1")), true);
  assert.equal(isPackageSetupFailure(new Error("git clone failed with signal SIGTERM")), true);
  assert.equal(isPackageSetupFailure(new Error("Extension path does not exist")), false);
});

test("model-less session attachment resolves the configured default before creating Pi's session", async () => {
  const supervisor = new RealSupervisor({});
  supervisor.paths.set("session-1", "/tmp/session-1.jsonl");
  supervisor._discover = async () => true;
  supervisor._boundCwd = () => "/tmp";
  supervisor._preferredModel = async () => "openai-codex/gpt-5.6-luna";
  let attached;
  supervisor._attach = async (...args) => { attached = args; return { session: {} }; };

  await supervisor._attachById("session-1");
  assert.deepEqual(attached, ["session-1", "/tmp", "openai-codex/gpt-5.6-luna"]);
});

test("overlapping prompt admission is rejected before SDK streaming begins", async () => {
  let settle;
  const supervisor = new RealSupervisor({});
  supervisor.live.set("same-id", { session: {
    model: { provider: "test", id: "model", api: "test" },
    isStreaming: false,
    prompt: () => new Promise(resolve => { settle = resolve; }),
  }, pendingMessages: [] });
  await supervisor.message("same-id", "one", "prompt");
  await assert.rejects(supervisor.message("same-id", "two", "prompt"), error => error.code === "session_busy");
  await new Promise(resolve => setImmediate(resolve));
  settle();
  await new Promise(resolve => setImmediate(resolve));
});

test("replacement commits project visibility before announcing the target", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-replacement-"));
  const previousHome = process.env.PI_WEB_HOME;
  process.env.PI_WEB_HOME = path.join(tmp, "web");
  fs.mkdirSync(process.env.PI_WEB_HOME, { recursive: true });
  try {
    const sourceId = "source-session";
    const targetId = "target-session";
    const repo = path.join(tmp, "workspace-b");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "README.md"), "test\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
    const sourceFile = path.join(tmp, "sessions", `${sourceId}.jsonl`);
    const targetFile = path.join(tmp, "sessions", `${targetId}.jsonl`);
    const sourceBinding = { projectId: "project-1", workspacePath: repo };
    const disposed = [];
    const events = [];
    const targetManager = {
      getSessionFile: () => targetFile,
      getSessionId: () => targetId,
      getCwd: () => path.join(tmp, "workspace-a"),
      getBranch: () => [],
      buildSessionContext: () => ({ messages: [] }),
    };
    const makeSession = (id, file, sessionManager) => ({
      sessionId: id,
      sessionFile: file,
      sessionManager,
      model: { provider: "test", id: "model", api: "test" },
      isStreaming: false,
      extensionRunner: { emit: async () => undefined },
      subscribe: () => () => {},
      dispose: () => disposed.push(id),
      createReplacedSessionContext: () => ({}),
      agent: { state: { messages: [] } },
    });
    const sourceManager = { getBranch: () => [] };
    const current = {
      cwd: path.join(tmp, "workspace-a"),
      session: makeSession(sourceId, sourceFile, sourceManager),
    };
    const supervisor = new RealSupervisor({
      emit: (id, type, data) => events.push({ id, type, data, bindings: loadBindings() }),
    });
    supervisor.live.set(sourceId, current);
    supervisor.paths.set(sourceId, sourceFile);
    supervisor.info.set(sourceId, { id: sourceId, path: sourceFile, cwd: current.cwd, model: "test/model" });
    supervisor._modelRuntime = async () => ({});
    let createdCwd;
    supervisor._createConfiguredSession = async ({ cwd, sessionManager }) => {
      createdCwd = cwd;
      return { session: makeSession(targetId, targetFile, sessionManager) };
    };
    saveBindings({ [sourceId]: sourceBinding });
    saveClosed(new Set([targetId]));

    await supervisor._replaceLiveSession(sourceId, current, targetManager, { reason: "resume" });

    assert.equal(createdCwd, sourceBinding.workspacePath);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].bindings, { [sourceId]: sourceBinding, [targetId]: sourceBinding });
    assert.deepEqual(loadBindings(), { [sourceId]: sourceBinding, [targetId]: sourceBinding });
    assert.deepEqual([...loadClosed()], []);
    assert.equal(supervisor.live.has(sourceId), false);
    assert.equal(supervisor.live.has(targetId), true);
    assert.deepEqual(disposed, [sourceId]);

    supervisor.listSessions = async () => [];
    supervisor.meta = async id => [sourceId, targetId].includes(id)
      ? { id, cwd: repo, name: null, model: "test/model", parentSessionId: null }
      : null;
    const state = await projectState({ id: "project-1", name: "demo", repoPath: repo }, supervisor);
    const visibleTarget = state.sessions.find(session => session.id === targetId);
    assert.equal(visibleTarget.workspacePath, repo);
    assert.equal(visibleTarget.contextId, state.contexts.find(context => context.path === repo).id);
  } finally {
    if (previousHome === undefined) delete process.env.PI_WEB_HOME;
    else process.env.PI_WEB_HOME = previousHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("failed replacement restores source bookkeeping and emits no switch", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-replacement-failure-"));
  const previousHome = process.env.PI_WEB_HOME;
  process.env.PI_WEB_HOME = path.join(tmp, "web");
  fs.mkdirSync(process.env.PI_WEB_HOME, { recursive: true });
  try {
    const sourceId = "source-session";
    const targetId = "target-session";
    const sourceFile = path.join(tmp, `${sourceId}.jsonl`);
    const targetFile = path.join(tmp, `${targetId}.jsonl`);
    const sourceBinding = { projectId: "project-1", workspacePath: path.join(tmp, "workspace-b") };
    const sourceManager = { getBranch: () => [] };
    const sourceSession = {
      sessionId: sourceId,
      sessionFile: sourceFile,
      sessionManager: sourceManager,
      model: { provider: "test", id: "model", api: "test" },
      isStreaming: false,
      extensionRunner: { emit: async () => undefined },
      subscribe: () => () => {},
      dispose() {},
    };
    const current = { cwd: path.join(tmp, "workspace-a"), session: sourceSession };
    const targetManager = {
      getSessionFile: () => targetFile,
      getSessionId: () => targetId,
      getCwd: () => current.cwd,
    };
    const events = [];
    const supervisor = new RealSupervisor({ emit: (...args) => events.push(args) });
    supervisor.live.set(sourceId, current);
    supervisor.paths.set(sourceId, sourceFile);
    supervisor.info.set(sourceId, { id: sourceId, path: sourceFile, cwd: current.cwd, model: "test/model" });
    supervisor._modelRuntime = async () => ({});
    supervisor._createConfiguredSession = async () => { throw new Error("target setup failed"); };
    const restored = [];
    supervisor._attach = async (id, cwd, model) => {
      restored.push({ id, cwd, model });
      supervisor.live.set(id, current);
      return current;
    };
    saveBindings({ [sourceId]: sourceBinding });
    saveClosed(new Set([targetId]));

    await assert.rejects(
      supervisor._replaceLiveSession(sourceId, current, targetManager, { reason: "resume" }),
      /target setup failed/,
    );

    assert.equal(events.length, 0);
    assert.deepEqual(loadBindings(), { [sourceId]: sourceBinding });
    assert.deepEqual([...loadClosed()], [targetId]);
    assert.equal(supervisor.live.get(sourceId), current);
    assert.equal(supervisor.paths.get(sourceId), sourceFile);
    assert.equal(supervisor.paths.has(targetId), false);
    assert.equal(restored.length, 1);
    assert.deepEqual(restored[0], { id: sourceId, cwd: sourceBinding.workspacePath, model: "test/model" });
  } finally {
    if (previousHome === undefined) delete process.env.PI_WEB_HOME;
    else process.env.PI_WEB_HOME = previousHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("compaction events become visible status activities", () => {
  const events = [];
  const supervisor = new RealSupervisor({ emit: (id, type, data) => events.push({ id, type, data }) });
  const st = { liveRecords: new Map(), pendingMessages: [] };
  supervisor._onEvent("session-1", st, { type: "compaction_start", reason: "manual" });
  assert.deepEqual(st.liveRecords.get("activity:compaction"), {
    id: "activity:compaction", role: "activity", kind: "status", key: "compaction", status: "running",
    title: "Compacting", summary: "context…", items: [], source: "pi",
  });
  supervisor._onEvent("session-1", st, { type: "compaction_end", reason: "manual", result: {}, aborted: false });
  assert.equal(st.liveRecords.get("activity:compaction").status, "completed");
  assert.deepEqual(events.map(event => [event.type, event.data.record.status]), [
    ["activity", "running"], ["activity", "completed"],
  ]);
  st.pendingMessages.push({ clientMessageId: "client-1", text: "hello" });
  supervisor._onEvent("session-1", st, { type: "entry_appended", entry: {
    id: "user-1", type: "message", message: { role: "user", content: "hello" },
  } });
  assert.equal(events.at(-1).data.clientMessageId, "client-1");
});

test("forked live state accepts client message ids", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-fork-live-"));
  try {
    const script = `
      import fs from "node:fs";
      import { RealSupervisor } from "./server/supervisor/real.js";
      const cwd = process.env.TEST_CWD;
      fs.mkdirSync(cwd, { recursive: true });
      const events = [];
      const supervisor = new RealSupervisor({ emit: (id, type, data) => events.push({ id, type, data }) });
      const parent = await supervisor.createSession({ cwd });
      supervisor._createConfiguredSession = async ({ sessionManager }) => ({ session: {
        sessionId: sessionManager.getSessionId(), sessionFile: sessionManager.getSessionFile(), sessionManager,
        model: { provider: "test", id: "model", api: "test" }, isStreaming: false,
        subscribe() { return () => {}; }, prompt: async () => {}, setSessionName() {},
      }});
      const child = await supervisor.fork(parent.id, null, { cwd });
      const state = supervisor.live.get(child.id);
      await supervisor.message(child.id, "hello", "prompt", [], "client-1");
      supervisor._onEvent(child.id, state, { type: "entry_appended", entry: {
        id: "user-1", type: "message", message: { role: "user", content: "hello" },
      }});
      console.log(JSON.stringify({ pending: state.pendingMessages, event: events.at(-1).data }));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve("."),
      env: { ...process.env, PI_CODING_AGENT_DIR: path.join(tmp, "pi"), TEST_CWD: path.join(tmp, "cwd") },
      encoding: "utf8",
      timeout: 60_000,
    });
    const result = JSON.parse(output.trim().split("\n").at(-1));
    assert.deepEqual(result.pending, []);
    assert.equal(result.event.clientMessageId, "client-1");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("web subagent entries become revisioned grouped activity", () => {
  const events = [];
  const supervisor = new RealSupervisor({ emit: (id, type, data) => events.push({ id, type, data }) });
  const st = { liveRecords: new Map(), pendingMessages: [], subagents: undefined };
  supervisor._onEvent("session-1", st, {
    type: "entry_appended",
    entry: {
      id: "entry-agent-1", parentId: "assistant-1", type: "custom", customType: "pi-web:subagent",
      data: {
        runId: "agent-1", groupId: "group-1", revision: 1, status: "queued",
        description: "Explore", createdAt: "2026-01-01T00:00:00Z",
      },
    },
  });
  assert.equal(st.subagents.snapshot()[0].status, "queued");
  assert.equal(st.subagents.snapshot()[0].parentMessageId, "assistant-1");
  supervisor._onEvent("session-1", st, {
    type: "entry_appended",
    entry: {
      id: "entry-agent-2", parentId: "assistant-1", type: "custom", customType: "pi-web:subagent",
      data: {
        runId: "agent-1", groupId: "group-1", revision: 2, status: "completed",
        description: "Explore", summary: "Found it.", createdAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:00:01Z",
      },
    },
  });
  assert.equal(st.subagents.snapshot()[0].status, "completed");
  assert.equal(st.subagents.snapshot()[0].summary, "Found it.");
  assert.deepEqual(events.filter(event => event.type === "activity").map(event => event.data.record.revision), [1, 2]);
});

test("completed live assistant records do not duplicate persisted messages after transcript refresh", async () => {
  const supervisor = new RealSupervisor({});
  const entries = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } },
    { type: "model_change", id: "m1", parentId: "u1", provider: "test", modelId: "model" },
    { type: "thinking_level_change", id: "t1", parentId: "m1", thinkingLevel: "high" },
    { type: "message", id: "a1", parentId: "t1", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ];
  supervisor.live.set("session-1", {
    session: { sessionManager: { getBranch: () => entries } },
    liveRecords: new Map([["a:u1", { id: "a:u1", role: "assistant", text: "answer" }]]),
  });

  const transcript = await supervisor.transcript("session-1");
  assert.deepEqual(transcript.filter(record => record.role === "assistant"), [
    { id: "a:t1", role: "assistant", text: "answer", toolIds: [], at: 0 },
  ]);
});

test("provider error events end the turn with a public error", () => {
  const events = [];
  const supervisor = new RealSupervisor({ emit: (id, type, data) => events.push({ id, type, data }) });
  const st = {
    liveRecords: new Map([["assistant-1", { id: "assistant-1", role: "assistant", text: "", streaming: true }]]),
    pendingMessages: [], msgId: "assistant-1", turnId: "turn-1", turnEnded: false,
  };
  supervisor._onEvent("session-1", st, {
    type: "message_update",
    assistantMessageEvent: {
      type: "error",
      error: { role: "assistant", stopReason: "error", errorMessage: "Insufficient quota." },
    },
  });
  assert.equal(st.turnEnded, true);
  assert.equal(st.liveRecords.get("assistant-1").streaming, undefined);
  assert.deepEqual(events.map(event => [event.type, event.data.reason, event.data.error]), [
    ["message_end", undefined, undefined], ["turn_end", "errored", "Insufficient quota."],
  ]);
  supervisor._onEvent("session-1", st, { type: "agent_end", messages: [] });
  assert.equal(events.length, 2);
});

test("manual compact reports expected no-op states instead of an internal error", async () => {
  const supervisor = new RealSupervisor({});
  for (const [message, expected] of [
    ["Already compacted", "Session is already compacted."],
    ["Nothing to compact (session too small)", "Nothing to compact yet; the session is too small."],
  ]) {
    supervisor._attachById = async () => ({ session: { compact: async () => { throw new Error(message); } } });
    assert.deepEqual(await supervisor.command("session-1", "/compact"), {
      action: "notice", title: "Compact", message: expected,
    });
  }
});

test("extension command failures propagate through the web supervisor", async () => {
  const failure = Object.assign(new Error("sync failed"), { code: "sync_failure" });
  const supervisor = new RealSupervisor({});
  supervisor._attachById = async () => ({ session: {
    extensionRunner: {
      getCommand: name => name === "sync" ? { handler: async () => { throw failure; } } : undefined,
      createCommandContext: () => ({}),
    },
  } });
  await assert.rejects(supervisor.command("session-1", "/sync refresh"), error => error === failure);
});

test("configured extensions load commands and session_start tools", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-extension-"));
  try {
    const webHome = path.join(tmp, "web");
    const agentDir = path.join(tmp, "pi");
    const cwd = path.join(tmp, "cwd");
    const extension = path.join(tmp, "configured-extension.ts");
    fs.mkdirSync(webHome, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(extension, `
      export default function (pi) {
        pi.registerCommand("configured-command", { description: "configured", async handler() {} });
        pi.on("session_start", () => pi.registerTool({
          name: "startup_tool", label: "Startup", description: "registered at session_start",
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; }
        }));
      }
    `);
    fs.writeFileSync(path.join(webHome, "config.json"), JSON.stringify({
      pi: { profile: null, packages: [], extensions: [extension] },
    }));
    const extensionScript = `
      import { EventHub } from './server/events.js';
      import { RealSupervisor } from './server/supervisor/real.js';
      const supervisor = new RealSupervisor(new EventHub());
      const created = await supervisor.createSession({ cwd: process.env.TEST_CWD });
      const commands = await supervisor.commands(created.id);
      const tools = supervisor.live.get(created.id).session.getAllTools().map(tool => tool.name);
      console.log(JSON.stringify({ commands: commands.map(command => command.name), tools, pi: await supervisor.piConfigurationState() }));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", extensionScript], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        PI_WEB_HOME: webHome,
        PI_CODING_AGENT_DIR: agentDir,
        TEST_CWD: cwd,
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    const result = JSON.parse(output.trim().split("\n").at(-1));
    assert.ok(result.commands.includes("configured-command"));
    assert.ok(result.tools.includes("startup_tool"));
    assert.ok(result.pi.runtime.extensions.some(item => item.path === extension));
    assert.ok(result.pi.runtime.extensions.some(item => item.path.endsWith("server/extensions/subagent-telemetry.js")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the registered real bash tool refreshes mappings after reattachment", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-project-environment-real-"));
  try {
    const webHome = path.join(tmp, "web");
    const agentDir = path.join(tmp, "pi");
    const home = path.join(tmp, "home");
    const profile = path.join(tmp, "profile");
    const shellPath = path.join(tmp, "test-shell");
    const cwd = path.join(tmp, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd, stdio: "ignore" });
    fs.writeFileSync(path.join(cwd, "README.md"), "test\n");
    execFileSync("git", ["add", "README.md"], { cwd, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
    fs.mkdirSync(webHome, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(shellPath, "#!/bin/sh\nprintf shell-used > \"$TEST_SHELL_MARKER\"\nexec /bin/sh \"$@\"\n", { mode: 0o755 });
    const configPath = path.join(webHome, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      reposRoot: path.join(tmp, "repos"),
      worktreeRoot: path.join(webHome, "worktrees"),
      projects: [{
        id: "project-1", name: "repo", repoPath: cwd, source: { type: "local" }, hooks: {},
        environment: {
          PROJECT_TOOL_VALUE: "PROJECT_SOURCE_A",
          PI_WEB_GITHUB_TOKEN: "PROJECT_TOOL_TOKEN",
          GIT_ASKPASS: "PROJECT_TOOL_TOKEN",
        },
      }],
      pi: { profile, packages: [], extensions: [] },
    }));
    fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
      shellPath,
      shellCommandPrefix: "export PROJECT_PREFIX_VALUE=prefix-value",
    }));
    const gitCommand = "printf '%s/%s/' \"$PROJECT_TOOL_VALUE\" \"$PROJECT_PREFIX_VALUE\"; if [ -z \"${GIT_ASKPASS-}\" ] && printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill | grep -q 'password=synthetic-token'; then printf git-ok; else printf git-fail; fi";
    const valueCommand = "printf '%s' \"$PROJECT_TOOL_VALUE\"";
    const emptyCommand = "printf 'value:%s' \"$PROJECT_TOOL_VALUE\"";
    const missingCommand = 'printf spawned > "$TEST_MARKER"';
    const missingValueCommand = "printf '%s' \"${PROJECT_TOOL_VALUE:-missing}\"";
    const script = `
      import fs from "node:fs";
      import { EventHub } from "./server/events.js";
      import { RealSupervisor } from "./server/supervisor/real.js";
      const supervisor = new RealSupervisor(new EventHub());
      const created = await supervisor.createSession({ cwd: process.env.TEST_CWD });
      await supervisor.commands(created.id);
      const state = supervisor.live.get(created.id);
      const bash = state.session.getToolDefinition("bash");
      const execute = async (target, command, id) => {
        const result = await target.execute("call-" + id, { command }, new AbortController().signal, undefined, undefined);
        return result.content?.[0]?.text || "";
      };
      const before = { ...process.env };
      const first = await execute(bash, ${JSON.stringify(gitCommand)}, 1);
      const unchangedAfterFirst = JSON.stringify({ ...process.env }) === JSON.stringify(before);
      const config = JSON.parse(fs.readFileSync(process.env.TEST_CONFIG, "utf8"));
      config.projects[0].environment.PROJECT_TOOL_VALUE = "PROJECT_SOURCE_B";
      fs.writeFileSync(process.env.TEST_CONFIG, JSON.stringify(config));
      process.env.PROJECT_SOURCE_B = "tool-beta";
      const second = await execute(bash, ${JSON.stringify(valueCommand)}, 2);
      const afterSecond = { ...process.env };
      await supervisor.rehome(created.id, process.env.TEST_CWD);
      await supervisor.commands(created.id);
      const reattachedState = supervisor.live.get(created.id);
      const reattachedBash = reattachedState.session.getToolDefinition("bash");
      const reattached = await execute(reattachedBash, ${JSON.stringify(valueCommand)}, 3);
      const unchangedAfterReattach = JSON.stringify({ ...process.env }) === JSON.stringify(afterSecond);
      process.env.PROJECT_SOURCE_C = "";
      config.projects[0].environment.PROJECT_TOOL_VALUE = "PROJECT_SOURCE_C";
      fs.writeFileSync(process.env.TEST_CONFIG, JSON.stringify(config));
      const empty = await execute(reattachedBash, ${JSON.stringify(emptyCommand)}, 4);
      config.projects[0].environment.PROJECT_TOOL_VALUE = "PROJECT_SOURCE_MISSING";
      fs.writeFileSync(process.env.TEST_CONFIG, JSON.stringify(config));
      let missingError = "";
      try { await execute(reattachedBash, ${JSON.stringify(missingCommand)}, 5); }
      catch (error) { missingError = error?.message || String(error); }
      const missingMarker = fs.existsSync(process.env.TEST_MARKER);
      config.projects[0].environment = {};
      fs.writeFileSync(process.env.TEST_CONFIG, JSON.stringify(config));
      const removed = await execute(reattachedBash, ${JSON.stringify(missingValueCommand)}, 6);
      console.log(JSON.stringify({
        first, second, reattached, empty, removed, missingError, missingMarker, shellMarker: fs.existsSync(process.env.TEST_SHELL_MARKER), bashName: bash?.name,
        hasRead: state.session.getAllTools().some(tool => tool.name === "read"),
        unchangedAfterFirst, unchangedAfterReattach, sourceB: afterSecond.PROJECT_SOURCE_B,
      }));
      reattachedState.session.dispose();
    `;
    const childEnv = { ...process.env };
    for (const name of ["PROJECT_TOOL_VALUE", "PROJECT_PREFIX_VALUE", "PI_WEB_GITHUB_TOKEN", "GIT_ASKPASS", "GIT_ASKPASS_REQUIRE", "PROJECT_SOURCE_B", "PROJECT_SOURCE_C", "PROJECT_SOURCE_MISSING"]) delete childEnv[name];
    Object.assign(childEnv, {
      PI_WEB_HOME: webHome,
      PI_CODING_AGENT_DIR: agentDir,
      HOME: home,
      TEST_CWD: cwd,
      TEST_CONFIG: configPath,
      TEST_MARKER: path.join(tmp, "must-not-run.txt"),
      TEST_SHELL_MARKER: path.join(tmp, "shell-used.txt"),
      PROJECT_SOURCE_A: "tool-alpha",
      PROJECT_TOOL_TOKEN: "synthetic-token",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
    });
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve("."),
      env: childEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    const result = JSON.parse(output.trim().split("\n").at(-1));
    assert.equal(result.first, "tool-alpha/prefix-value/git-ok");
    assert.equal(result.second, "tool-beta");
    assert.equal(result.reattached, "tool-beta");
    assert.equal(result.empty, "value:");
    assert.equal(result.removed, "missing");
    assert.equal(result.missingError, "Project environment source is missing.");
    assert.equal(result.missingMarker, false);
    assert.equal(result.shellMarker, true);
    assert.equal(result.bashName, "bash");
    assert.equal(result.hasRead, true);
    assert.equal(result.unchangedAfterFirst, true);
    assert.equal(result.unchangedAfterReattach, true);
    assert.equal(result.sourceB, "tool-beta");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a failed Pi package install falls back to the core session runtime", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-package-fallback-"));
  try {
    const webHome = path.join(tmp, "web");
    const agentDir = path.join(tmp, "pi");
    const cwd = path.join(tmp, "cwd");
    const profile = path.join(tmp, "profile");
    fs.mkdirSync(webHome, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
      packages: ["npm:package-that-must-not-install"],
      npmCommand: ["/missing/npm"],
    }));
    fs.writeFileSync(path.join(webHome, "config.json"), JSON.stringify({
      pi: { profile, packages: [], extensions: [] },
    }));
    const fallbackScript = `
      import { EventHub } from './server/events.js';
      import { RealSupervisor } from './server/supervisor/real.js';
      const supervisor = new RealSupervisor(new EventHub());
      const created = await supervisor.createSession({ cwd: process.env.TEST_CWD });
      const commands = await supervisor.commands(created.id);
      console.log(JSON.stringify({ commands: commands.map(command => command.name), pi: await supervisor.piConfigurationState() }));
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", fallbackScript], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        PI_WEB_HOME: webHome,
        PI_CODING_AGENT_DIR: agentDir,
        TEST_CWD: cwd,
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    const result = JSON.parse(output.trim().split("\n").at(-1));
    assert.ok(result.commands.includes("settings"));
    assert.deepEqual(result.pi.runtime.packageStatus, { configured: 1, loaded: 0, failed: 1 });
    assert.match(result.pi.runtime.errors.find(error => error.path === "<pi-packages>")?.error || "", /ENOENT/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("real sessions can be created without provider credentials", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-real-"));
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        PI_WEB_HOME: path.join(tmp, "web"),
        PI_CODING_AGENT_DIR: path.join(tmp, "pi"),
        PI_WEB_MODE: "real",
        PI_WEB_REPOS_ROOT: path.join(tmp, "repos"),
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    const result = JSON.parse(output.trim().split("\n").at(-1));
    assert.equal(result.providersStatus, 200);
    assert.ok(result.providers.providers.some(provider => provider.id === "anthropic"));
    assert.ok(result.created.id);
    assert.equal(result.commandsStatus, 200);
    assert.ok(result.commands.commands.some(command => command.name === "settings"));
    assert.ok(result.commands.commands.some(command => command.name === "name"));
    assert.equal(result.messageStatus, 409);
    assert.equal(result.message.error, "model_required");
    assert.deepEqual(result.transcript.records, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("session summaries are reused until the session file changes", () => {
  const supervisor = new RealSupervisor({});
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-summary-")), "s.jsonl");
  fs.writeFileSync(file, "a\n");
  let opens = 0;
  let cwd = "/one";
  const SessionManager = { open: () => { opens++; return { getCwd: () => cwd, getBranch: () => [] }; } };
  assert.equal(supervisor._sessionSummary(SessionManager, file).cwd, "/one");
  assert.equal(supervisor._sessionSummary(SessionManager, file).cwd, "/one");
  assert.equal(opens, 1);
  cwd = "/two";
  fs.appendFileSync(file, "b\n");
  assert.equal(supervisor._sessionSummary(SessionManager, file).cwd, "/two");
  assert.equal(opens, 2);
});
