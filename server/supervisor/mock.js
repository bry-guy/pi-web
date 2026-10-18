// Mock supervisor: same interface as the real one, scripted turns.
// Exercises the full event contract (thinking -> deltas -> tool -> diff ->
// done, stop/steer/followUp, bang) and persists transcripts under the app
// home so snapshot/reconnect and discovery are tested for real.
import fs from "node:fs";
import path from "node:path";
import { appHome, loadConfig, newId } from "../config.js";
import { WEB_PI_COMMANDS, parseSlashCommand } from "../commands.js";
import { PiConfiguration } from "../pi-configuration.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MOCK_MODELS = [
  { id: "mock/fast", provider: "mock", label: "Mock Fast" },
  { id: "mock/smart", provider: "mock", label: "Mock Smart" },
];

const THINK_MS = () => Number(process.env.PI_WEB_MOCK_THINK_MS ?? 900);
const DELTA_MS = () => Number(process.env.PI_WEB_MOCK_DELTA_MS ?? 18);
const TOOL_MS = () => Number(process.env.PI_WEB_MOCK_TOOL_MS ?? 350);

const dir = () => path.join(appHome(), "mock-sessions");
const fileOf = id => path.join(dir(), id + ".json");

export class MockSupervisor {
  constructor(hub) {
    this.hub = hub;
    this.live = new Map(); // id -> { timers, queue, streaming }
    this.piConfiguration = new PiConfiguration();
  }

  // ---- storage ----
  _load(id) {
    try { return JSON.parse(fs.readFileSync(fileOf(id), "utf8")); } catch { return null; }
  }
  _save(s) {
    s.modified = new Date().toISOString();
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(fileOf(s.id), JSON.stringify(s));
  }

  // ---- interface ----
  async listSessions(cwd) {
    let files = [];
    try { files = fs.readdirSync(dir()); } catch { return []; }
    return files.map(f => this._load(path.basename(f, ".json")))
      .filter(s => s && s.cwd === cwd)
      .map(s => ({
        id: s.id, cwd: s.cwd, name: s.name,
        parentSessionId: s.parentSessionId || null,
        created: s.created, modified: s.modified,
        firstMessage: (s.records.find(r => r.role === "user") || {}).text || "",
        model: s.model || this.defaultModel(),
      }));
  }

  listModels() { return MOCK_MODELS.map(m => ({ ...m })); }
  defaultModel() {
    const configured = loadConfig().defaultModel || null;
    return configured ? (MOCK_MODELS.some(m => m.id === configured) ? configured : null) : MOCK_MODELS[0].id;
  }
  modelState() {
    const configuredDefault = loadConfig().defaultModel || null;
    const effectiveDefault = configuredDefault
      ? (MOCK_MODELS.some(m => m.id === configuredDefault) ? configuredDefault : null)
      : MOCK_MODELS[0].id;
    return {
      models: this.listModels(),
      configuredDefault,
      effectiveDefault,
      status: configuredDefault ? (effectiveDefault === configuredDefault ? "available" : "unavailable") : "automatic",
      error: null,
    };
  }
  listProviders() {
    return [{
      id: "mock",
      name: "Mock provider",
      configured: true,
      source: "runtime",
      sourceLabel: "Scripted",
      authType: null,
      authMethods: [],
      availableModels: MOCK_MODELS.length,
      canLogout: false,
      error: null,
    }];
  }
  async loginProvider() { throw Object.assign(new Error("unsupported_auth_type"), { code: "unsupported_auth_type" }); }
  async logoutProvider() { throw Object.assign(new Error("unsupported_auth_type"), { code: "unsupported_auth_type" }); }
  assertPiConfigurationReloadable() {
    if ([...this.live.values()].some(state => state.streaming)) {
      throw Object.assign(new Error("pi_configuration_busy"), { code: "pi_configuration_busy" });
    }
  }
  async reloadPiConfiguration({ report = null } = {}) {
    this.assertPiConfigurationReloadable();
    report?.({ type: "phase", phase: "runtime-load", message: "Reloading mock Pi profile settings and resources." });
    this.piConfiguration.invalidate();
    return this.piConfiguration.state({ force: true, report });
  }
  piConfigurationState() { return this.piConfiguration.state(); }
  async commands() { return WEB_PI_COMMANDS.map(command => ({ ...command })); }
  async exportSession(id, format = "html") {
    const s = this._load(id);
    if (!s) throw new Error("unknown session " + id);
    const jsonl = `${JSON.stringify({ type: "session", id: s.id, cwd: s.cwd })}\n${(s.records || []).map(record => JSON.stringify(record)).join("\n")}\n`;
    const html = `<!doctype html><meta charset="utf-8"><title>Pi session</title><pre>${jsonl.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</pre>`;
    return {
      body: Buffer.from(format === "jsonl" ? jsonl : html),
      filename: `${s.id}.${format === "jsonl" ? "jsonl" : "html"}`,
      contentType: format === "jsonl" ? "application/jsonl; charset=utf-8" : "text/html; charset=utf-8",
    };
  }
  async shareSession(id) { return { url: `https://gist.github.com/mock/${id}` }; }
  async command(id, text) {
    const parsed = parseSlashCommand(text);
    if (!parsed) throw Object.assign(new Error("invalid_slash_command"), { code: "invalid_slash_command" });
    const arg = String(parsed.args || "").trim();
    if (parsed.name === "settings" || parsed.name === "login" || parsed.name === "logout") return { action: "settings" };
    if (parsed.name === "model" || parsed.name === "scoped-models") {
      if (parsed.name === "model" && arg) {
        await this.setModel(id, arg);
        return { action: "session_meta", model: arg };
      }
      return { action: "model-picker" };
    }
    if (parsed.name === "name") {
      if (!arg) return { action: "notice", title: "Session name", message: this._load(id)?.name || "No session name set." };
      await this.setName(id, arg);
      return { action: "session_meta", name: arg };
    }
    if (parsed.name === "export") {
      if (arg && !["html", "jsonl"].includes(arg.toLowerCase()) && !/\.(html|jsonl)$/i.test(arg)) {
        throw Object.assign(new Error("usage: /export [html|jsonl]"), { code: "command_usage" });
      }
      return { action: "download", format: /jsonl$/i.test(arg) || arg.toLowerCase() === "jsonl" ? "jsonl" : "html" };
    }
    if (parsed.name === "copy") {
      const textToCopy = [...(this._load(id)?.records || [])].reverse().find(record => record.role === "assistant")?.text;
      if (!textToCopy) throw Object.assign(new Error("No agent messages to copy yet."), { code: "command_usage" });
      return { action: "copy", text: textToCopy };
    }
    if (parsed.name === "share") return { action: "share", ...(await this.shareSession(id)) };
    if (parsed.name === "session") {
      const s = this._load(id);
      return { action: "notice", title: "Session info", stats: { id, file: null, messages: s.records.length, user: s.records.filter(r => r.role === "user").length, assistant: s.records.filter(r => r.role === "assistant").length, tools: 0, toolResults: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 } };
    }
    if (parsed.name === "changelog") return { action: "notice", title: "Changelog", message: "Mock mode has no separate Pi changelog." };
    if (parsed.name === "hotkeys") return { action: "notice", title: "Web shortcuts", message: "Enter send · Shift+Enter newline · Alt+Enter follow-up · !command shell · /command Pi command." };
    if (["tree", "resume"].includes(parsed.name)) return { action: "sidebar" };
    if (parsed.name === "trust") return { action: "notice", title: "Project trust", message: "Mock sessions use the configured web trust policy." };
    if (parsed.name === "new") return { action: "new" };
    if (parsed.name === "fork") return { action: "fork" };
    if (parsed.name === "compact") return { action: "refresh", message: "Session context compacted.", notice: false };
    if (parsed.name === "reload") return { action: "refresh", message: "Pi resources reloaded." };
    if (parsed.name === "quit") return { action: "quit" };
    if (parsed.name === "debug") return { action: "notice", title: "Pi diagnostics", message: `Session ${id} · mock` };
    if (parsed.name === "import") throw Object.assign(new Error("Use /export to download a session; importing files from the browser is not enabled yet."), { code: "command_usage" });
    throw Object.assign(new Error("unknown_slash_command"), { code: "unknown_slash_command" });
  }

  async createSession({ cwd, name, model }) {
    const s = {
      id: newId("s"), cwd, name: name || null, model: model || this.defaultModel(), thinkingLevel: "medium",
      parentSessionId: null, created: new Date().toISOString(), records: [],
    };
    this._save(s);
    (this.opened ??= new Set()).add(s.id);
    return { id: s.id };
  }

  async allSessions() {
    let files = [];
    try { files = fs.readdirSync(dir()); } catch { return []; }
    return files.map(f => this._load(path.basename(f, ".json"))).filter(Boolean).map(s => ({
      id: s.id, cwd: s.cwd, name: s.name, parentSessionId: s.parentSessionId || null,
      created: s.created, modified: s.modified, firstMessage: (s.records.find(r => r.role === "user") || {}).text || "",
    }));
  }

  async sessionFile(id) { return this._load(id) ? fileOf(id) : null; }

  async transcript(id) {
    const s = this._load(id);
    return s ? s.records : [];
  }
  async meta(id) {
    const s = this._load(id);
    return s ? { id: s.id, cwd: s.cwd, name: s.name, model: s.model, parentSessionId: s.parentSessionId } : null;
  }
  isStreaming(id) { return !!this.live.get(id)?.streaming; }
  isOpen(id) { return !!this.opened?.has(id) || this.live.has(id); }
  isLive(id) { return this.live.has(id); }
  isCompacting(id) { return !!this.live.get(id)?.compacting; }
  async rehome(id, newCwd) {
    const s = this._load(id);
    if (!s) throw new Error("no such session");
    s.cwd = newCwd;
    this._save(s);
  }

  async setModel(id, model) {
    const s = this._load(id);
    if (!s || !MOCK_MODELS.some(m => m.id === model)) {
      throw Object.assign(new Error("model_unavailable"), { code: "model_unavailable" });
    }
    s.model = model;
    this._save(s);
    this.hub.emit(id, "session_meta", { model });
  }

  async context(id) {
    const s = this._load(id);
    if (!s) throw new Error("no such session");
    const window = 128_000;
    // Mock transcripts do not receive provider token usage, so use a stable
    // approximation solely to exercise the same UI contract.
    const used = Math.min(window, 2_048 + Math.ceil(JSON.stringify(s.records || []).length / 4));
    return {
      window, used, remaining: window - used, percent: Math.round((used / window) * 100),
      input: used, cacheRead: 0, cacheWrite: 0, model: s.model,
    };
  }

  async thinking(id) {
    const s = this._load(id);
    if (!s) throw new Error("no such session");
    return { level: s.thinkingLevel || "medium", levels: THINKING_LEVELS, supported: true };
  }

  async setThinking(id, level) {
    const s = this._load(id);
    const levels = THINKING_LEVELS;
    if (!s || !levels.includes(level)) throw Object.assign(new Error("invalid_thinking_level"), { code: "invalid_thinking_level" });
    s.thinkingLevel = level;
    this._save(s);
    this.hub.emit(id, "session_meta", { thinkingLevel: level });
    return this.thinking(id);
  }

  async setName(id, name) {
    const s = this._load(id);
    s.name = name;
    this._save(s);
    this.hub.emit(id, "session_meta", { name });
  }

  // Fork transcript at (before) a user message; new session in newCwd.
  async fork(parentId, atRecordId, { cwd, name }) {
    const p = this._load(parentId);
    const idx = atRecordId ? p.records.findIndex(r => r.id === atRecordId) : -1;
    const kept = atRecordId ? (idx > 0 ? p.records.slice(0, idx) : []) : [...p.records];
    const s = {
      id: newId("s"), cwd, name: name || null, model: p.model, thinkingLevel: p.thinkingLevel || "medium",
      parentSessionId: parentId, created: new Date().toISOString(),
      records: kept,
    };
    this._save(s);
    return { id: s.id };
  }

  async message(id, text, mode, _images = [], clientMessageId = null) {
    const st = this.live.get(id) || { timers: [], queue: [], streaming: false };
    this.live.set(id, st);
    if (st.streaming) {
      if (mode === "followUp") { st.queue.push({ text, clientMessageId }); this.hub.emit(id, "queue_update", { steering: 0, followUp: st.queue.length }); return; }
      // steer: cut the current stream, answer the steer next.
      this._finishTurn(id, "done", `\n\n(steered)`);
      this._startTurn(id, text, true, clientMessageId);
      return;
    }
    this._startTurn(id, text, false, clientMessageId);
  }

  async stop(id) {
    const st = this.live.get(id);
    if (!st || !st.streaming) return;
    for (const t of st.timers) clearTimeout(t);
    st.timers = [];
    const s = this._load(id);
    const last = s.records[s.records.length - 1];
    if (last && last.role === "assistant" && !last.text) {
      s.records.pop(); // stop during thinking: remove the empty turn entirely
    } else if (last && last.role === "assistant") {
      delete last.streaming;
    }
    this._save(s);
    st.streaming = false;
    st.queue = [];
    this.hub.emit(id, "turn_end", { turnId: st.turnId, reason: "stopped" });
  }

  async bangRecord(id, rec) {
    const s = this._load(id);
    s.records.push(rec);
    this._save(s);
  }

  // ---- scripted turn ----
  _startTurn(id, userText, steered, clientMessageId = null) {
    const st = this.live.get(id);
    const s = this._load(id);
    const userRec = { id: newId("m"), role: "user", text: userText, at: Date.now() };
    s.records.push(userRec);
    const msgId = newId("m");
    s.records.push({ id: msgId, role: "assistant", text: "", streaming: true, at: Date.now() });
    this._save(s);

    st.streaming = true;
    st.turnId = newId("t");
    st.msgId = msgId;
    this.hub.emit(id, "user_record", { record: userRec, ...(clientMessageId ? { clientMessageId } : {}) });
    this.hub.emit(id, "turn_start", { turnId: st.turnId });
    this.hub.emit(id, "message_start", { messageId: msgId, role: "assistant" });

    const wantsDiff = /edit|diff|fix|change/i.test(userText);
    const wantsTool = /read|grep|look|file|edit|diff|fix/i.test(userText) || wantsDiff;
    const wantsTodoActivity = /todo/i.test(userText);
    const wantsAgentActivity = /subagent|background agent/i.test(userText);
    const full = steered
      ? `Steering acknowledged — switching to: ${userText}`
      : `mock: I'd run that against ${path.basename(s.cwd)} — reading first, then proposing an edit. (${userText.slice(0, 60)})`;

    // Prompts that mention a summary also exercise pi-summarize: a working line and a summary entry.
    const summarize = /summar|working/i.test(userText);
    const thought = "Checking how the session list is built before answering. ";
    const startText = () => {
      let i = 0;
      const tick = () => {
        if (!st.streaming || st.msgId !== msgId) return;
        i += 3;
        const chunk = full.slice(0, i);
        const cur = this._load(id);
        const rec = cur.records.find(r => r.id === msgId);
        if (!rec) return;
        const delta = chunk.slice(rec.text.length);
        rec.text = chunk;
        if (i >= full.length) delete rec.streaming;
        this._save(cur);
        if (delta) this.hub.emit(id, "text_delta", { messageId: msgId, delta });
        if (i >= full.length) this._finishTurn(id, "done");
        else st.timers.push(setTimeout(tick, DELTA_MS()));
      };
      tick();
    };
    const afterThinking = () => {
      if (wantsTool) this._emitTool(id, s.cwd, { withDiff: wantsDiff, summary: summarize, done: startText });
      else startText();
    };
    const think = (i = 0) => {
      if (!st.streaming || st.msgId !== msgId) return;
      const piece = thought.slice(i, i + 4);
      const cur = this._load(id);
      const rec = cur.records.find(r => r.id === msgId);
      if (!rec) return;
      rec.thinking = (rec.thinking || "") + piece;
      this._save(cur);
      this.hub.emit(id, "thinking_delta", { messageId: msgId, delta: piece });
      if (i + 4 < thought.length) st.timers.push(setTimeout(() => think(i + 4), DELTA_MS()));
      else afterThinking();
    };

    const t0 = setTimeout(() => {
      if (summarize) this.hub.emit(id, "extension_ui_working", { message: "Reading the session list…" });
      if (wantsTodoActivity) this._emitActivity(id, "todo");
      if (wantsAgentActivity) this._emitActivity(id, "agent");
      think();
    }, THINK_MS());
    st.timers.push(t0);
  }

  _emitActivity(id, kind) {
    if (kind === "agent") return this._startMockAgents(id);
    const s = this._load(id);
    const ai = s.records.findIndex(r => r.role === "assistant" && r.streaming);
    const activity = {
      id: newId("activity"), role: "activity", kind: "todo", key: "todo", status: "in_progress",
      title: "Todos", summary: "1/2 complete · 1 active", source: "mock",
      items: [
        { id: "1", subject: "Inspect activity", description: "", status: "completed", activeForm: "", blockedBy: [] },
        { id: "2", subject: "Render activity", description: "", status: "in_progress", activeForm: "rendering activity", blockedBy: [] },
      ],
    };
    s.records.splice(ai < 0 ? s.records.length : ai, 0, activity);
    this._save(s);
    this.hub.emit(id, "activity", { record: activity });
  }

  _startMockAgents(id) {
    const st = this.live.get(id);
    const s = this._load(id);
    if (!st || !s) return;
    st.agentTimers ||= [];
    const parentMessageId = st.msgId || "mock-parent";
    const groupId = "mock:parallel";
    const createdAt = new Date().toISOString();
    const runs = [
      { runId: "mock-explore", title: "Explore routes", status: "running", activity: "searching files" },
      { runId: "mock-tests", title: "Review tests", status: "running", activity: "reading tests" },
      { runId: "mock-package", title: "Inspect package setup", status: "queued", activity: "waiting for a worker" },
    ];
    for (const run of runs) this._upsertMockAgent(id, {
      ...run, groupId, parentMessageId, createdAt, revision: 1, toolCount: 0, summary: "",
    });
    const updates = [
      [60, "mock-explore", { activity: "checking routes", toolCount: 1 }],
      [95, "mock-tests", { activity: "comparing test coverage", toolCount: 1 }],
      [140, "mock-package", { status: "running", activity: "reading package files", startedAt: new Date(Date.now() + 140).toISOString() }],
      [210, "mock-tests", { status: "completed", activity: "", summary: "Found the relevant activity and DOM tests.", endedAt: new Date(Date.now() + 210).toISOString(), toolCount: 2 }],
      [320, "mock-explore", { status: "completed", activity: "", summary: "Located the supervisor and transcript bridge.", endedAt: new Date(Date.now() + 320).toISOString(), toolCount: 3 }],
      [430, "mock-package", { status: "completed", activity: "", summary: "Confirmed the extension package is loaded by the preview profile.", endedAt: new Date(Date.now() + 430).toISOString(), toolCount: 2 }],
    ];
    for (const [delay, runId, patch] of updates) {
      st.agentTimers.push(setTimeout(() => this._upsertMockAgent(id, { runId, ...patch }), delay));
    }
  }

  _upsertMockAgent(id, patch) {
    const s = this._load(id);
    if (!s || !patch.runId) return;
    let existing = s.records.find(record => record.role === "activity" && record.kind === "agent" && record.runId === patch.runId);
    if (!existing) {
      const at = s.records.findIndex(record => record.role === "assistant" && record.streaming);
      existing = {
        id: `activity:agent:${patch.runId}`,
        role: "activity", kind: "agent", key: `agent:${patch.runId}`,
        runId: patch.runId, groupId: patch.groupId || "mock:parallel",
        parentMessageId: patch.parentMessageId || "mock-parent", revision: 0,
        status: patch.status || "running", title: patch.title || "Background agent",
        activity: patch.activity || "", toolCount: patch.toolCount || 0,
        createdAt: patch.createdAt || new Date().toISOString(), summary: "", items: [], source: "mock",
      };
      s.records.splice(at < 0 ? s.records.length : at, 0, existing);
    }
    const next = {
      ...existing,
      ...patch,
      revision: (Number(existing.revision) || 0) + 1,
      status: patch.status || existing.status,
      activity: patch.activity ?? existing.activity ?? "",
      summary: patch.summary ?? existing.summary ?? "",
      items: [],
    };
    Object.assign(existing, next);
    this._save(s);
    this.hub.emit(id, "activity", { record: { ...existing } });
  }

  _emitTool(id, cwd, { withDiff, summary, done }) {
    const toolId = newId("tc");
    const toolRec = {
      id: toolId, role: "tool", tool: "grep",
      arg: `"sessions list" ${path.basename(cwd)}/src`, meta: "", out: "", at: Date.now(), running: true,
    };
    const s = this._load(id);
    // tool/diff/summary records precede the assistant message record in the transcript
    const message = s.records.find(r => r.id === this.live.get(id).msgId);
    message.toolIds = [...(message.toolIds || []), toolId];
    s.records.splice(s.records.indexOf(message), 0, toolRec);
    this._save(s);
    this.hub.emit(id, "tool_start", { toolId, name: toolRec.tool, argsSummary: toolRec.arg });
    this.live.get(id).timers.push(setTimeout(() => this._finishTool(id, toolId, { withDiff, summary, done }), TOOL_MS()));
  }

  _finishTool(id, toolId, { withDiff, summary, done }) {
    const toolOut = "src/commands/sessions.ts:42  export async function sessionsList(\nsrc/cli.ts:130  .command(\"sessions list\")";
    const s = this._load(id);
    const toolRec = s.records.find(r => r.id === toolId);
    if (!toolRec) return;
    Object.assign(toolRec, { meta: "3 matches · 0.2s", out: toolOut });
    delete toolRec.running;
    this.hub.emit(id, "tool_end", { toolId, ok: true, output: toolOut, meta: "3 matches", durationMs: TOOL_MS() });
    const beforeAssistant = () => s.records.findIndex(r => r.id === this.live.get(id).msgId);
    if (withDiff) {
      const diffId = newId("df");
      const diffRec = {
        id: diffId, role: "diff", file: "src/commands/sessions.ts", add: "+3", del: "−1",
        lines: [
          { sign: "", text: "@@ -40,4 +40,6 @@" },
          { sign: " ", text: "export async function sessionsList(opts) {" },
          { sign: "-", text: "  console.log(rows);" },
          { sign: "+", text: "  if (opts.json) return printJson(rows);" },
          { sign: "+", text: "  console.table(rows);" },
        ],
      };
      s.records.splice(beforeAssistant(), 0, diffRec);
      this.hub.emit(id, "diff", {
        toolId: diffId, path: diffRec.file, adds: 3, dels: 1,
        hunks: [{ header: "@@ -40,4 +40,6 @@", lines: diffRec.lines.slice(1) }],
      });
    }
    if (summary) {
      const summaryRec = { id: newId("sum"), role: "summary", text: "Searched the session list before answering.", at: Date.now(), toolCallIds: [toolId] };
      s.records.splice(beforeAssistant(), 0, summaryRec);
      this.hub.emit(id, "summary", { record: summaryRec });
    }
    this._save(s);
    done?.();
  }

  _finishTurn(id, reason, suffix = "") {
    const st = this.live.get(id);
    if (!st) return;
    for (const t of st.timers) clearTimeout(t);
    st.timers = [];
    if (suffix) {
      const s = this._load(id);
      const rec = s.records.find(r => r.id === st.msgId);
      if (rec) { rec.text += suffix; delete rec.streaming; this._save(s); }
    } else {
      const s = this._load(id);
      const rec = s.records.find(r => r.id === st.msgId);
      if (rec) { delete rec.streaming; this._save(s); }
    }
    st.streaming = false;
    this.hub.emit(id, "message_end", { messageId: st.msgId });
    this.hub.emit(id, "turn_end", { turnId: st.turnId, reason });
    const next = st.queue.shift();
    if (next !== undefined) this._startTurn(id, next.text, false, next.clientMessageId);
  }
}

// Settings → Workers in mock mode: fixed workers that answer like workspaced's routes.
export function registerMockWorkers(api) {
  const resources = { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: null, memory: "4Gi" } };
  const grant = { name: "default", description: "", namespace: "pi", serviceAccount: "default", egress: "open", runtimeClass: null, env: ["GITHUB_TOKEN"] };
  const workers = [
    { name: "pi-ez-web", repository: "bry-guy/pi-ez-web", state: "running", keepAwake: true, busy: false, lastUsed: Date.now() - 4_000, resources, usage: { cpuMillicores: 120, memoryBytes: 734_003_200 }, grant },
    { name: "scratch", repository: "bry-guy/scratch", state: "running", keepAwake: false, busy: true, lastUsed: Date.now() - 90_000, resources, usage: { cpuMillicores: 15, memoryBytes: 104_857_600 }, grant },
    { name: "dotfiles", repository: "bry-guy/dotfiles", state: "sleeping", keepAwake: false, busy: false, lastUsed: Date.now() - 3_600_000, resources, usage: null, grant: { ...grant, name: "operator", namespace: "ops", env: [] } },
  ];
  const find = c => workers.find(w => w.name === c.req.param("name"));
  const refusal = (c, w, force) => w.state === "sleeping"
    ? c.json({ error: "asleep", name: w.name, message: "This project is asleep. Wake it first." }, 409)
    : !force && w.busy ? c.json({ error: "workspace_busy", name: w.name, message: "This project is busy. Try again when it is idle, or force it." }, 409) : null;
  api.get("/remote-workspaces", c => c.json({ usageAvailable: true, workspaces: workers }));
  api.put("/remote-workspaces/:name/pin", async c => {
    const w = find(c);
    if (!w) return c.json({ error: "not_found" }, 404);
    w.keepAwake = !!(await c.req.json().catch(() => ({}))).pinned;
    return c.json({ ok: true, pinned: w.keepAwake });
  });
  api.post("/remote-workspaces/reload", c => c.json({ results: workers.filter(w => w.state === "running").map(w => ({ name: w.name, ok: true, status: 200, error: null })) }));
  api.post("/remote-workspaces/:name/reload", c => {
    const w = find(c);
    if (!w) return c.json({ error: "not_found" }, 404);
    return refusal(c, w, false) || c.json({ ok: true });
  });
  api.post("/remote-workspaces/:name/restart", c => {
    const w = find(c);
    if (!w) return c.json({ error: "not_found" }, 404);
    const no = refusal(c, w, c.req.query("force") === "1");
    if (no) return no;
    Object.assign(w, { state: "running", lastUsed: Date.now() });
    return c.json({ ok: true });
  });
  api.post("/remote-workspaces/:name/reset", async c => {
    const w = find(c);
    if (!w) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (body?.confirm !== w.name) return c.json({ error: "confirm_required", message: `Send {"confirm": "${w.name}"} to wipe this project's data.` }, 400);
    const no = refusal(c, w, c.req.query("force") === "1");
    if (no) return no;
    Object.assign(w, { state: "running", lastUsed: Date.now() });
    return c.json({ ok: true });
  });
}
