// Real supervisor: pi SDK in-process. The adapter deliberately keeps Pi's
// session-entry ids as the canonical transcript identity. The web event ids
// are derived from those entries (or their known parent while an entry is
// streaming), so a snapshot and its replay address the same records.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportSyncEnvironment, loadBindings, loadConfig, prepareSessionVisibilityReplacement } from "../config.js";
import { commandInfo, parseSlashCommand } from "../commands.js";
import { activityFromEntry, activityFromToolResult, normalizeActivity } from "../activity.js";
import { SubagentActivityStore } from "../subagent-activity.js";
import { PiConfiguration, WEB_SUBAGENT_EXTENSION, publicError } from "../pi-configuration.js";
import { GitHubClient } from "../github.js";
import { findProjectByWorkspace } from "../lifecycle.js";
import { gitCredentialEnvironment } from "../git-credentials.js";
import { resolveProjectEnvironment } from "../project-environment.js";
import { activePiSyncExtensionPath } from "../pi-sync.js";
import { ExtensionUiHost } from "../extension-ui.js";
import { writeLog } from "../logging.js";

function errorDetails(error) {
  const parts = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current.stack || current.message) parts.push(current.stack || current.message);
    if (current.stderr) parts.push(current.stderr);
    current = current.cause;
  }
  return publicError(parts.join("\nCaused by: "));
}

function packageFailureMessage(error, configured, failed) {
  const total = configured.length;
  const count = failed.length || (total ? 1 : 0);
  const affected = total
    ? ` for ${count} of ${total} configured package${total === 1 ? "" : "s"}`
    : "";
  const detail = errorDetails(failed.at(-1)?.error || error);
  return `Pi package setup failed${affected}; affected packages were skipped. ${detail}`;
}

export function isPackageSetupFailure(error) {
  return /\b(?:npm|pnpm|bun|git)\b[\s\S]*\b(?:failed with (?:code|signal)|ENOENT)\b/i.test(errorDetails(error));
}

let sdk = null;
async function SDK() {
  if (!sdk) sdk = await import("@earendil-works/pi-coding-agent");
  return sdk;
}

function persistManager(manager, code = "session_persistence_unavailable") {
  const file = manager.getSessionFile?.();
  if (!file) throw Object.assign(new Error(code), { code });
  if (!fs.existsSync(file)) {
    if (typeof manager._rewriteFile !== "function") {
      throw Object.assign(new Error(code), { code });
    }
    manager._rewriteFile();
    // Pi 0.84 defers a new session file until its first assistant message.
    // Marking it flushed makes subsequent custom/session-info entries append.
    manager.flushed = true;
  }
  return file;
}

function commandArgument(args) {
  const value = String(args || "").trim();
  return value || null;
}

function exportFormat(args) {
  const value = commandArgument(args)?.toLowerCase();
  if (!value) return "html";
  if (value === "html" || value.endsWith(".html")) return "html";
  if (value === "jsonl" || value.endsWith(".jsonl")) return "jsonl";
  throw Object.assign(new Error("usage: /export [html|jsonl]"), { code: "command_usage" });
}

async function dirStamp(dir) {
  try {
    const names = (await fs.promises.readdir(dir)).filter(name => name.endsWith(".jsonl")).sort();
    const stats = await Promise.all(names.map(name => fs.promises.stat(path.join(dir, name)).then(st => `${name}:${st.mtimeMs}:${st.size}`, () => name)));
    return stats.join("|");
  } catch { return null; }
}

export class RealSupervisor {
  constructor(hub) {
    this.hub = hub;
    this.extensionUi = new ExtensionUiHost({ hub, supervisor: this }); // binds dialogs and status for every SDK session
    this.live = new Map();       // sessionId -> attached runtime state
    this.paths = new Map();      // sessionId -> session file path
    this.info = new Map();       // sessionId -> discovered SessionInfo metadata
    this.sessionSummaries = new Map(); // session file -> { stamp, cwd, model }; re-read when mtime/size change
    this.runtime = null;         // shared ModelRuntime for all attached sessions
    this.runtimePromise = null;   // prevents concurrent runtime initialization
    this.attachPromises = new Map(); // sessionId -> in-flight attach
    this.pendingPrompts = new Map();
    this.preferredPaths = new Map();
    this.sessionCreateTail = Promise.resolve(); // serialize SDK resource setup
    this.models = null;
    this.modelError = null;
    this.packageSetupError = null;
    this.packageSources = null;
    this.packageStatus = null;
    this.piConfiguration = new PiConfiguration();
  }

  async _modelRuntime() {
    if (this.runtime) return this.runtime;
    if (!this.runtimePromise) {
      const initializing = (async () => {
        const { ModelRuntime } = await SDK();
        const runtime = await ModelRuntime.create();
        this.runtime = runtime;
        return runtime;
      })();
      this.runtimePromise = initializing;
      initializing.catch(() => {
        if (this.runtimePromise === initializing) this.runtimePromise = null;
      });
    }
    return this.runtimePromise;
  }

  async _withSessionCreateLock(task) {
    const previous = this.sessionCreateTail;
    let release;
    this.sessionCreateTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  // Chats this process created or is running stay listed before their first prompt.
  isOpen(id) { return this.live.has(id) || !!this.opened?.has(id); }
  isLive(id) { return this.live.has(id); }

  async listSessions(cwd) {
    const { SessionManager } = await SDK();
    const infos = this._selectSessionInfos(await this._listInfos(SessionManager, cwd));
    const modelState = await this.modelState().catch(() => ({ models: [], effectiveDefault: null }));
    const availableModels = new Set((modelState.models || []).map(model => model.id));
    for (const info of infos) this.paths.set(info.id, info.path);
    return infos.map(info => {
      const { cwd: openedCwd, model: requestedModel } = this._sessionSummary(SessionManager, info.path);
      const liveModel = modelRef(this.live.get(info.id)?.session.model);
      const model = effectiveModelInfo(requestedModel, liveModel, availableModels, modelState.effectiveDefault);
      const recordedCwd = info.cwd || openedCwd || cwd;
      const item = {
        id: info.id,
        cwd: recordedCwd,
        name: info.name || null,
        parentSessionId: info.parentSessionPath ? this._idFromPath(info.parentSessionPath) : null,
        created: info.created,
        modified: info.modified,
        firstMessage: info.firstMessage || "",
        ...model,
      };
      this.info.set(info.id, { ...item, path: info.path, parentSessionPath: info.parentSessionPath || null });
      return item;
    });
  }

  // SessionManager.list parses every session file; /api/state polls it, so re-list only when a file changed.
  async _listInfos(SessionManager, cwd) {
    this.listCache ||= new Map();
    const cached = this.listCache.get(cwd);
    const stamp = cached?.dir ? await dirStamp(cached.dir) : null;
    if (cached && stamp !== null && stamp === cached.stamp) return cached.infos;
    const infos = await SessionManager.list(cwd);
    const dir = infos[0] ? path.dirname(infos[0].path) : null;
    this.listCache.set(cwd, { infos, dir, stamp: dir ? await dirStamp(dir) : null });
    return infos;
  }

  _sessionSummary(SessionManager, filePath) {
    let stamp = null;
    try { const stat = fs.statSync(filePath); stamp = `${stat.mtimeMs}:${stat.size}`; } catch { /* removed session */ }
    const cached = this.sessionSummaries.get(filePath);
    if (stamp && cached?.stamp === stamp) return cached;
    let manager;
    try { manager = SessionManager.open(filePath); } catch { /* malformed/removed session */ }
    const summary = { stamp, cwd: manager?.getCwd?.() || null, model: modelRefFromEntries(manager?.getBranch?.() || []) };
    if (stamp) this.sessionSummaries.set(filePath, summary);
    else this.sessionSummaries.delete(filePath);
    return summary;
  }

  _selectSessionInfos(infos) {
    const selected = new Map();
    for (const info of infos || []) {
      const current = selected.get(info.id);
      const preferred = this.preferredPaths.get(info.id);
      if (!current || info.path === preferred || (current.path !== preferred && (info.modified || 0) > (current.modified || 0))) selected.set(info.id, info);
    }
    return [...selected.values()];
  }

  _idFromPath(filePath) {
    for (const [id, fp] of this.paths) if (fp === filePath) return id;
    return path.basename(filePath).replace(/\.jsonl$/, "");
  }

  _boundCwd(id, fallback) {
    const bindings = loadBindings();
    return bindings[id]?.workspacePath || this.live.get(id)?.cwd || this.info.get(id)?.cwd || fallback || null;
  }

  async _discover(id) {
    if (this.paths.has(id) || this.info.has(id)) return true;
    const { SessionManager } = await SDK();
    const infos = this._selectSessionInfos(await SessionManager.listAll());
    for (const info of infos) this.paths.set(info.id, info.path);
    const info = infos.find(item => item.id === id);
    if (!info) return false;
    this.info.set(info.id, {
      id: info.id, path: info.path, cwd: info.cwd || null,
      name: info.name || null,
      parentSessionId: info.parentSessionPath ? this._idFromPath(info.parentSessionPath) : null,
      created: info.created, modified: info.modified, firstMessage: info.firstMessage || "",
    });
    return true;
  }

  _managerFor(id, cwd) {
    const { SessionManager } = sdk || {};
    const file = this.paths.get(id) || this.info.get(id)?.path;
    if (!file || !SessionManager) throw new Error("unknown session " + id);
    const resolved = this._boundCwd(id, cwd);
    return SessionManager.open(file, undefined, resolved || undefined);
  }

  async _resolveModel(modelRef, runtime) {
    if (!modelRef) return undefined;
    runtime ||= await this._modelRuntime();
    const [provider, ...rest] = String(modelRef).split("/");
    const model = runtime.getModel(provider, rest.join("/"));
    if (!model) throw Object.assign(new Error("model_unavailable"), { code: "model_unavailable" });
    return model;
  }

  async _createConfiguredSession({ cwd, sessionManager, modelRuntime, model, sessionStartEvent = undefined }) {
    const SDKModule = await SDK();
    const runtime = modelRuntime || await this._modelRuntime();
    try {
      const agentDir = SDKModule.getAgentDir();
      exportSyncEnvironment();
      const syncExtensionPath = await activePiSyncExtensionPath();
      const extensionPaths = [WEB_SUBAGENT_EXTENSION, ...(syncExtensionPath ? [syncExtensionPath] : [])];
      const resolved = await this.piConfiguration.resolve();
      const configuredPackages = Array.isArray(resolved.settings?.packages) ? resolved.settings.packages : [];
      const loadResources = async (loadPackages, packageSources, resolveOnly = false) => {
        const { settingsManager } = await this.piConfiguration.createSettingsManager(
          cwd,
          agentDir,
          SDKModule.SettingsManager,
          { loadPackages, ...(packageSources !== undefined ? { packageSources } : {}) },
        );
        const resourceLoader = new SDKModule.DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          additionalExtensionPaths: extensionPaths,
          ...(syncExtensionPath ? { extensionsOverride: result => ({
            ...result,
            extensions: result.extensions.filter(extension =>
              !extension.commands?.has("sync") ||
              path.resolve(extension.path || "") === path.resolve(syncExtensionPath) ||
              !/(?:^|[/\\])pi-sync[/\\](?:.*[/\\])?extensions[/\\]sync\.[jt]s$/.test(extension.path || "")
            ),
          }) } : {}),
        });
        if (resolveOnly) {
          const packageManager = new SDKModule.DefaultPackageManager({ cwd, agentDir, settingsManager });
          await packageManager.resolve();
        } else await resourceLoader.reload();
        return { settingsManager, resourceLoader };
      };

      let resources;
      if (this.packageSetupError && Array.isArray(this.packageSources)) {
        try {
          resources = await loadResources(true, this.packageSources);
          this.packageStatus = {
            configured: configuredPackages.length,
            loaded: this.packageSources.length,
            failed: Math.max(0, configuredPackages.length - this.packageSources.length),
          };
        } catch (error) {
          if (!isPackageSetupFailure(error)) throw error;
          this.packageSources = [];
          this.packageSetupError = packageFailureMessage(error, configuredPackages, [{ error }]);
          this.packageStatus = { configured: configuredPackages.length, loaded: 0, failed: configuredPackages.length ? 1 : 0 };
          resources = await loadResources(false);
        }
      } else {
        try {
          resources = await loadResources(true);
          this.packageSources = configuredPackages;
          this.packageSetupError = null;
          this.packageStatus = { configured: configuredPackages.length, loaded: configuredPackages.length, failed: 0 };
        } catch (error) {
          if (!isPackageSetupFailure(error)) throw error;
          const workingPackages = [];
          const failedPackages = [];
          for (const source of configuredPackages) {
            try {
              await loadResources(true, [source], true);
              workingPackages.push(source);
            } catch (packageError) {
              failedPackages.push({ source, error: packageError });
            }
          }
          this.packageSources = workingPackages;
          this.packageSetupError = packageFailureMessage(error, configuredPackages, failedPackages);
          this.packageStatus = {
            configured: configuredPackages.length,
            loaded: workingPackages.length,
            failed: failedPackages.length || (configuredPackages.length && !workingPackages.length ? 1 : 0),
          };
          console.error("pi-ez-web Pi package setup failed; skipping affected packages", this.packageSetupError);
          try {
            resources = await loadResources(true, workingPackages);
          } catch (finalError) {
            this.packageSources = [];
            this.packageSetupError = packageFailureMessage(finalError, configuredPackages, [...failedPackages, { error: finalError }]);
            this.packageStatus = { configured: configuredPackages.length, loaded: 0, failed: configuredPackages.length ? 1 : 0 };
            resources = await loadResources(false);
          }
        }
      }
      const { settingsManager, resourceLoader } = resources;
      const bash = SDKModule.createBashToolDefinition(cwd, {
        shellPath: settingsManager.getShellPath(),
        commandPrefix: settingsManager.getShellCommandPrefix(),
        spawnHook: context => {
          const project = findProjectByWorkspace(context.cwd)?.project;
          const projectEnvironment = resolveProjectEnvironment(project?.environment);
          return {
            ...context,
            env: gitCredentialEnvironment({ ...context.env, ...projectEnvironment }),
          };
        },
      });
      const hasThinkingLevel = (sessionManager.getBranch?.() || []).some(entry => entry.type === "thinking_level_change");
      const result = await SDKModule.createAgentSession({
        cwd,
        sessionManager,
        modelRuntime: runtime,
        settingsManager,
        resourceLoader,
        customTools: [bash],
        ...(model ? { model } : {}),
        // Without a web setting, Pi applies the profile's defaultThinkingLevel / per-model levels itself.
        ...(!hasThinkingLevel && loadConfig().defaultThinkingLevel ? { thinkingLevel: loadConfig().defaultThinkingLevel } : {}),
        ...(sessionStartEvent ? { sessionStartEvent } : {}),
      });
      await result.session.bindExtensions(this.extensionUi.extensionBindings(result.session.sessionId));
      const packageErrors = this.packageSetupError
        ? [{ path: "<pi-packages>", error: this.packageSetupError }]
        : [];
      this.piConfiguration.recordRuntime(resourceLoader, result.extensionsResult, result.session.sessionId, cwd, packageErrors, this.packageStatus);
      return result;
    } catch (error) {
      const detail = errorDetails(error);
      console.error("pi-ez-web Pi resource setup failed", detail);
      this.piConfiguration.recordRuntimeError(new Error(detail));
      throw error;
    }
  }

  async _attach(id, cwd, requestedModel) {
    const cached = id && this.live.get(id);
    if (cached) return cached;
    const { SessionManager } = await SDK();
    const file = id && (this.paths.get(id) || this.info.get(id)?.path);
    const resolvedCwd = cwd || (id && this._boundCwd(id)) || process.cwd();
    const sessionManager = file
      ? SessionManager.open(file, undefined, resolvedCwd)
      : SessionManager.create(resolvedCwd);
    const runtime = await this._modelRuntime();
    // A conversation synchronized from another device may name a model this host lacks; open it with the web default.
    let unavailableModel = null;
    let selectedModel = requestedModel || await this.defaultModel();
    let model = await this._resolveModel(selectedModel, runtime).catch(error => {
      if (error?.code === "model_unavailable") { unavailableModel = requestedModel; return undefined; }
      throw error;
    });
    if (unavailableModel) {
      selectedModel = await this.defaultModel();
      model = await this._resolveModel(selectedModel, runtime);
    }
    const { session } = await this._withSessionCreateLock(() => this._createConfiguredSession({
      cwd: resolvedCwd,
      sessionManager,
      modelRuntime: runtime,
      model,
    }));
    const actualModel = modelRef(session.model);
    const fallback = unavailableModel && actualModel !== unavailableModel;
    this.paths.set(session.sessionId, session.sessionFile);
    this._registerLiveSession(session, resolvedCwd, {
      model: actualModel,
      ...(fallback ? { requestedModel: unavailableModel, modelFallback: true } : {}),
      ...(!actualModel && unavailableModel ? { requestedModel: unavailableModel, modelUnavailable: true } : {}),
    });
    // Once per conversation: in-place catch-ups reattach often.
    if (unavailableModel && !(this.modelFallbackNoticed ||= new Set()).has(session.sessionId)) {
      this.modelFallbackNoticed.add(session.sessionId);
      const wanted = String(unavailableModel);
      const using = actualModel || "no model";
      this.hub?.emit(session.sessionId, "extension_ui_notify", { message: `${wanted} is not available here; using ${using}.`, level: "info" });
    }
    return this.live.get(session.sessionId);
  }

  _endTurnWithError(id, st, error) {
    if (st.turnEnded) return;
    st.turnEnded = true;
    st.pendingMessages = [];
    const message = turnErrorMessage(error);
    const record = st.msgId && st.liveRecords?.get(st.msgId);
    if (record) delete record.streaming;
    if (st.msgId) this.hub.emit(id, "message_end", { messageId: st.msgId });
    this.hub.emit(id, "turn_end", { turnId: st.turnId, reason: "errored", error: message });
  }

  // ---- pi AgentEvent -> wire contract ----
  _onEvent(id, st, evt) {
    const hub = this.hub;
    switch (evt.type) {
      case "entry_appended": {
        const entry = evt.entry;
        if (entry?.type === "message" && entry.message?.role === "user") {
          const record = { id: entry.id, role: "user", text: contentText(entry.message.content), images: contentImages(entry.message.content), at: entryTime(entry) || Date.now() };
          st.liveRecords.clear();
          st.liveRecords.set(record.id, record);
          st.assistantParent = entry.id;
          const pending = st.pendingMessages.shift();
          hub.emit(id, "user_record", { record, ...(pending?.clientMessageId ? { clientMessageId: pending.clientMessageId } : {}) });
        }
        const summary = entry?.type === "custom" && entry.customType === "pi-summarize" ? summaryRecord(entry) : null;
        if (summary) {
          st.liveRecords.set(summary.id, summary);
          hub.emit(id, "summary", { record: summary });
        }
        const activity = activityFromEntry(entry);
        if (activity) {
          if (activity.kind === "agent" && activity.runId) {
            st.subagents ||= new SubagentActivityStore();
            const accepted = st.subagents.apply(activity, { revisionProvided: entryHasSubagentRevision(entry) });
            if (!accepted) break;
            hub.emit(id, "activity", { record: accepted });
          } else {
            st.liveRecords.set(activity.id, activity);
            hub.emit(id, "activity", { record: activity });
          }
        }
        break;
      }
      case "compaction_start": {
        const record = compactionStartActivity();
        st.liveRecords.set(record.id, record);
        hub.emit(id, "activity", { record });
        break;
      }
      case "compaction_end": {
        const record = compactionEndActivity(evt);
        st.liveRecords.set(record.id, record);
        hub.emit(id, "activity", { record });
        break;
      }
      case "agent_start":
        st.turnId = `t:${id}:${Date.now().toString(36)}`;
        st.turnEnded = false;
        hub.emit(id, "turn_start", { turnId: st.turnId });
        break;
      case "message_start":
        if (evt.message?.role === "assistant") {
          const parentId = st.session.sessionManager.getLeafId?.() || st.assistantParent || st.turnId;
          st.assistantParent = parentId;
          st.msgId = assistantRecordId(parentId);
          const record = { id: st.msgId, role: "assistant", text: "", streaming: true, at: Date.now() };
          st.liveRecords.set(st.msgId, record);
          hub.emit(id, "message_start", { messageId: st.msgId, role: "assistant" });
        }
        break;
      case "message_update": {
        const e = evt.assistantMessageEvent;
        if (e?.type === "error") {
          this._endTurnWithError(id, st, e.error);
          break;
        }
        if (e?.type === "thinking_delta" && e.delta && st.msgId) {
          const record = st.liveRecords.get(st.msgId);
          if (record) record.thinking = (record.thinking || "") + e.delta;
          hub.emit(id, "thinking_delta", { messageId: st.msgId, delta: e.delta });
          break;
        }
        if (e?.type === "text_delta" && e.delta && st.msgId) {
          const record = st.liveRecords.get(st.msgId);
          if (record) record.text += e.delta;
          hub.emit(id, "text_delta", { messageId: st.msgId, delta: e.delta });
        }
        break;
      }
      case "turn_end": {
        const error = st.aborted ? "" : assistantErrorMessage(evt.message);
        if (error) this._endTurnWithError(id, st, error);
        break;
      }
      case "message_end":
        if (evt.message?.role === "assistant" && st.msgId) {
          const record = st.liveRecords.get(st.msgId);
          if (record) delete record.streaming;
          hub.emit(id, "message_end", { messageId: st.msgId });
        }
        break;
      case "tool_execution_start": {
        st.toolMeta.set(evt.toolCallId, { name: evt.toolName, t0: Date.now(), args: evt.args });
        const record = toolStartRecord(evt);
        st.liveRecords.set(record.id, record);
        hub.emit(id, "tool_start", {
          toolId: evt.toolCallId, name: evt.toolName,
          argsSummary: summarizeArgs(evt.toolName, evt.args),
        });
        break;
      }
      case "tool_execution_end": {
        const m = st.toolMeta.get(evt.toolCallId) || {};
        const durationMs = m.t0 ? Date.now() - m.t0 : 0;
        const output = renderToolResult(evt.result);
        const activity = activityFromToolResult(evt.result, evt.toolCallId);
        if (activity) {
          st.liveRecords.set(activity.id, activity);
          hub.emit(id, "activity", { record: activity });
        }
        const record = st.liveRecords.get(evt.toolCallId);
        if (record) {
          record.out = output;
          record.meta = toolResultMeta(evt.isError, durationMs);
          delete record.running;
        }
        hub.emit(id, "tool_end", {
          toolId: evt.toolCallId, ok: !evt.isError, output,
          meta: "", durationMs,
        });
        const diff = maybeDiff(evt.toolName, m.args, evt.result);
        if (diff) {
          const diffRecord = toolDiffRecord(evt.toolCallId, diff);
          st.liveRecords.set(diffRecord.id, diffRecord);
          hub.emit(id, "diff", { toolId: evt.toolCallId, ...diff });
        }
        break;
      }
      case "agent_end": {
        const error = st.aborted ? "" : [...(evt.messages || [])].reverse().map(assistantErrorMessage).find(Boolean);
        if (error) {
          this._endTurnWithError(id, st, error);
          break;
        }
        if (st.turnEnded) break;
        const reason = st.aborted ? "stopped" : "done";
        st.aborted = false;
        st.turnEnded = true;
        hub.emit(id, "turn_end", { turnId: st.turnId, reason });
        break;
      }
      case "session_info_changed":
        hub.emit(id, "session_meta", { name: st.session.sessionName });
        break;
      case "queue_update":
        hub.emit(id, "queue_update", {
          steering: evt.steering?.length ?? 0,
          followUp: evt.followUp?.length ?? 0,
        });
        break;
      default: break;
    }
  }

  _registerLiveSession(session, cwd, extra = {}) {
    const st = {
      session,
      cwd,
      msgId: null,
      turnId: null,
      assistantParent: null,
      liveRecords: new Map(),
      pendingMessages: [],
      toolMeta: new Map(),
      subagents: new SubagentActivityStore(),
    };
    seedSubagentState(st);
    st.unsubscribe = session.subscribe(evt => this._onEvent(session.sessionId, st, evt));
    this.live.set(session.sessionId, st);
    this.info.set(session.sessionId, {
      ...(this.info.get(session.sessionId) || {}),
      ...extra,
      id: session.sessionId,
      path: session.sessionFile,
      cwd,
    });
    return st;
  }

  async allSessions() {
    const { SessionManager } = await SDK();
    const infos = this._selectSessionInfos(await SessionManager.listAll());
    for (const info of infos) this.paths.set(info.id, info.path);
    return infos.map(info => ({
      id: info.id,
      cwd: info.cwd || null,
      name: info.name || null,
      parentSessionId: info.parentSessionPath ? this._idFromPath(info.parentSessionPath) : null,
      created: info.created,
      modified: info.modified,
      firstMessage: info.firstMessage || "",
    }));
  }

  async sessionFile(id) {
    if (!await this._discover(id)) return null;
    return this.live.get(id)?.session?.sessionFile || this.paths.get(id) || this.info.get(id)?.path || null;
  }

  async createSession({ cwd, name }) {
    const { SessionManager } = await SDK();
    const manager = SessionManager.create(cwd);
    if (name) manager.appendSessionInfo(name);
    const file = persistManager(manager);
    const id = manager.getSessionId();
    this.paths.set(id, file);
    this.info.set(id, {
      id, path: file, cwd, name: name || null, parentSessionId: null,
    });
    (this.opened ??= new Set()).add(id);
    return { id };
  }

  async message(id, text, mode, images = [], clientMessageId = null) {
    const st = await this._attachById(id);
    if (this.pendingPrompts.has(id) && !st.session.isStreaming) throw Object.assign(new Error("The conversation is busy."), { code: "session_busy" });
    if (!isUsableModel(st.session.model)) {
      throw Object.assign(new Error("model_required"), { code: "model_required" });
    }
    if (clientMessageId) st.pendingMessages.push({ clientMessageId, text });
    if (mode === "steer" && st.session.isStreaming) {
      try { return await st.session.steer(text, images); }
      catch (error) {
        if (clientMessageId) st.pendingMessages = st.pendingMessages.filter(item => item.clientMessageId !== clientMessageId);
        throw error;
      }
    }
    if (mode === "followUp" && st.session.isStreaming) {
      try { return await st.session.followUp(text, images); }
      catch (error) {
        if (clientMessageId) st.pendingMessages = st.pendingMessages.filter(item => item.clientMessageId !== clientMessageId);
        throw error;
      }
    }
    this._startPrompt(id, async () => {
      await st.session.prompt(text, { images });
      // An input handler (e.g. pi-sync refusing while another device runs) can consume the prompt
      // without a user entry; drop its pending bubble so it neither lingers nor claims the next entry.
      if (clientMessageId && st.pendingMessages.some(item => item.clientMessageId === clientMessageId)) {
        st.pendingMessages = st.pendingMessages.filter(item => item.clientMessageId !== clientMessageId);
        this.hub.emit(id, "prompt_handled", { clientMessageId });
      }
    }, err => {
      if (clientMessageId) st.pendingMessages = st.pendingMessages.filter(item => item.clientMessageId !== clientMessageId);
      this._endTurnWithError(id, st, err);
    });
  }

  async commands(id) {
    const st = await this._attachById(id);
    return commandInfo({
      commands: st.session.extensionRunner?.getRegisteredCommands?.() || [],
      prompts: st.session.promptTemplates || [],
      skills: st.session.resourceLoader?.getSkills?.().skills || [],
    });
  }

  async exportSession(id, format = "html") {
    const st = await this._attachById(id);
    const normalized = format === "jsonl" ? "jsonl" : "html";
    // Pi defaults to the process cwd, which is read-only /app in the image.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ez-export-"));
    let file, body;
    try {
      file = normalized === "jsonl"
        ? st.session.exportToJsonl(path.join(dir, `${id}.jsonl`))
        : await st.session.exportToHtml(path.join(dir, `${id}.html`));
      body = fs.readFileSync(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return {
      body,
      filename: path.basename(file),
      contentType: normalized === "jsonl" ? "application/jsonl; charset=utf-8" : "text/html; charset=utf-8",
    };
  }

  async shareSession(id) {
    const exported = await this.exportSession(id, "html");
    if (exported.body.length > 4_000_000) {
      throw Object.assign(new Error("session_export_too_large"), { code: "session_export_too_large" });
    }
    const client = new GitHubClient();
    const response = await client.request("/gists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: "Pi session",
        public: false,
        files: { "session.html": { content: exported.body.toString("utf8") } },
      }),
    });
    const gist = await response.json();
    if (!gist?.html_url) throw Object.assign(new Error("github_unavailable"), { code: "github_unavailable" });
    return { url: gist.html_url };
  }

  async command(id, text, mode) {
    const parsed = parseSlashCommand(text);
    if (!parsed) throw Object.assign(new Error("invalid_slash_command"), { code: "invalid_slash_command" });
    const arg = commandArgument(parsed.args);

    if (parsed.name === "settings" || parsed.name === "login" || parsed.name === "logout") {
      return { action: "settings" };
    }
    if (parsed.name === "model" || parsed.name === "scoped-models") {
      if (parsed.name === "model" && arg) {
        await this.setModel(id, arg);
        return { action: "session_meta", model: arg };
      }
      return { action: "model-picker" };
    }
    if (parsed.name === "name") {
      if (!arg) {
        const st = await this._attachById(id);
        return { action: "notice", title: "Session name", message: st.session.sessionName || "No session name set." };
      }
      const name = await this.setName(id, arg);
      return { action: "session_meta", name };
    }
    if (parsed.name === "export") return { action: "download", format: exportFormat(parsed.args) };
    if (parsed.name === "copy") {
      const st = await this._attachById(id);
      const textToCopy = st.session.getLastAssistantText?.();
      if (!textToCopy) throw Object.assign(new Error("No agent messages to copy yet."), { code: "command_usage" });
      return { action: "copy", text: textToCopy };
    }
    if (parsed.name === "share") return { action: "share", ...(await this.shareSession(id)) };
    if (parsed.name === "session") {
      const st = await this._attachById(id);
      const stats = st.session.getSessionStats();
      return { action: "notice", title: "Session info", stats: {
        id: stats.sessionId, file: stats.sessionFile || null,
        messages: stats.totalMessages, user: stats.userMessages, assistant: stats.assistantMessages,
        tools: stats.toolCalls, toolResults: stats.toolResults, tokens: stats.tokens, cost: stats.cost,
      } };
    }
    if (parsed.name === "changelog") return { action: "notice", title: "Changelog", message: "See the Pi release notes in the configured Pi installation." };
    if (parsed.name === "hotkeys") return { action: "notice", title: "Web shortcuts", message: "Enter send · Shift+Enter newline · Alt+Enter follow-up · !command shell · /command Pi command." };
    if (parsed.name === "tree" || parsed.name === "resume") return { action: "sidebar" };
    if (parsed.name === "trust") return { action: "notice", title: "Project trust", message: "Web sessions run with the server's configured headless trust policy." };
    if (parsed.name === "new") return { action: "new" };
    if (parsed.name === "fork") return { action: "fork" };
    if (parsed.name === "compact") {
      const st = await this._attachById(id);
      try {
        await st.session.compact(arg || undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "Already compacted") {
          return { action: "notice", title: "Compact", message: "Session is already compacted." };
        }
        if (message === "Nothing to compact (session too small)") {
          return { action: "notice", title: "Compact", message: "Nothing to compact yet; the session is too small." };
        }
        throw error;
      }
      return { action: "refresh", message: "Session context compacted.", notice: false };
    }
    if (parsed.name === "reload") {
      const st = await this._attachById(id);
      if (st.session.isStreaming || st.session.isCompacting) {
        throw Object.assign(new Error("Wait for the current response to finish before reloading."), { code: "command_busy" });
      }
      await st.session.reload();
      return { action: "refresh", message: "Pi resources reloaded." };
    }
    if (parsed.name === "quit") return { action: "quit" };
    if (parsed.name === "debug") return { action: "notice", title: "Pi diagnostics", message: `Session ${id} · ${this.live.has(id) ? "attached" : "discovered"}` };
    if (parsed.name === "import") {
      throw Object.assign(new Error("Use /export to download a session; importing files from the browser is not enabled yet."), { code: "command_usage" });
    }

    const st = await this._attachById(id);
    if (this.pendingPrompts.has(id) && !st.session.isStreaming) throw Object.assign(new Error("The conversation is busy."), { code: "session_busy" });
    const extensionCommand = st.session.extensionRunner?.getCommand?.(parsed.name);
    if (extensionCommand) {
      const result = await extensionCommand.handler(parsed.args, st.session.extensionRunner.createCommandContext());
      return { action: "handled", name: parsed.name, ...(result?.outcome ? result : {}) };
    }
    const commands = await this.commands(id);
    const known = commands.some(command => command.name === parsed.name);
    if (!known) throw Object.assign(new Error("unknown_slash_command"), { code: "unknown_slash_command" });
    const options = st.session.isStreaming
      ? { source: "rpc", streamingBehavior: mode === "followUp" ? "followUp" : "steer" }
      : { source: "rpc" };
    this._startPrompt(id, () => st.session.prompt(parsed.text, options), error => this._endTurnWithError(id, st, error));
    return { action: "handled", name: parsed.name };
  }

  _startPrompt(id, task, onError) {
    this.pendingPrompts.set(id, (this.pendingPrompts.get(id) || 0) + 1);
    void Promise.resolve().then(task).catch(onError).finally(() => {
      const remaining = this.pendingPrompts.get(id) - 1;
      if (remaining) this.pendingPrompts.set(id, remaining);
      else this.pendingPrompts.delete(id);
    });
  }

  async waitForIdle(id) {
    const st = await this._attachById(id);
    await st.session.waitForIdle();
  }

  async navigateTreeFromCommand(id, targetId, options) {
    const st = await this._attachById(id);
    return st.session.navigateTree(targetId, options);
  }

  async reloadSession(id) {
    const st = await this._attachById(id);
    await st.session.reload();
  }

  async _replaceLiveSession(fromId, current, targetManager, { reason, withSession, setup, selectedText } = {}) {
    const targetFile = targetManager.getSessionFile();
    const targetId = targetManager.getSessionId();
    const fallbackCwd = targetManager.getCwd() || current.cwd;
    const visibility = prepareSessionVisibilityReplacement(fromId, targetId, fallbackCwd);
    const targetCwd = visibility.workspacePath || fallbackCwd;
    const existingTarget = this.live.get(targetId);
    if (existingTarget && existingTarget !== current) {
      if (this.pendingPrompts.has(targetId)) throw Object.assign(new Error("The target session is busy."), { code: "session_busy" });
      if (existingTarget.session.isStreaming) throw Object.assign(new Error("The target session is still running."), { code: "session_streaming" });
    }

    const snapshot = new Map([fromId, targetId].map(id => [id, {
      live: this.live.get(id),
      hasPath: this.paths.has(id),
      path: this.paths.get(id),
      hasPreferredPath: this.preferredPaths.has(id),
      preferredPath: this.preferredPaths.get(id),
      hasInfo: this.info.has(id),
      info: this.info.get(id),
    }]));
    const disposed = new Set();
    let replacement;
    let committed;
    const restoreMaps = () => {
      for (const [id, previous] of snapshot) {
        if (disposed.has(id)) this.live.delete(id);
        else if (previous.live) this.live.set(id, previous.live);
        else this.live.delete(id);
        if (previous.hasPath) this.paths.set(id, previous.path); else this.paths.delete(id);
        if (previous.hasPreferredPath) this.preferredPaths.set(id, previous.preferredPath); else this.preferredPaths.delete(id);
        if (previous.hasInfo) this.info.set(id, previous.info); else this.info.delete(id);
      }
    };
    const restoreLive = async id => {
      const previous = snapshot.get(id);
      if (!disposed.has(id) || !previous?.live) return;
      try {
        await this._attach(id, this._boundCwd(id, previous.live.cwd), await this._preferredModel(id));
      } catch {}
    };

    try {
      if (existingTarget && existingTarget !== current) {
        await this._disposeLiveState(existingTarget, reason, targetFile);
        this.live.delete(targetId);
        disposed.add(targetId);
      }
      if (current.session.isStreaming) await current.session.abort();
      await this._disposeLiveState(current, reason, targetFile);
      this.live.delete(fromId);
      disposed.add(fromId);
      if (targetFile) {
        this.paths.set(targetId, targetFile);
        this.preferredPaths.set(targetId, targetFile);
      }
      const runtime = await this._modelRuntime();
      const result = await this._withSessionCreateLock(() => this._createConfiguredSession({
        cwd: targetCwd,
        sessionManager: targetManager,
        modelRuntime: runtime,
        model: undefined,
        ...(targetFile ? { sessionStartEvent: {
          type: "session_start",
          reason,
          ...(current.session.sessionFile ? { previousSessionFile: current.session.sessionFile } : {}),
        } } : {}),
      }));
      replacement = result.session;
      this._registerLiveSession(replacement, targetCwd);
      if (setup) {
        await setup(targetManager);
        replacement.agent.state.messages = targetManager.buildSessionContext().messages;
      }
      await withSession?.(replacement.createReplacedSessionContext());
      committed = visibility.commit();
      this.hub.emit(fromId, "session_switched", {
        fromSessionId: fromId,
        toSessionId: targetId,
        cwd: targetCwd,
      });
      return { cancelled: false, ...(selectedText !== undefined ? { selectedText } : {}) };
    } catch (error) {
      const replacementState = replacement && this.live.get(targetId)?.session === replacement
        ? this.live.get(targetId)
        : null;
      if (replacementState) {
        await this._disposeLiveState(replacementState, reason, targetFile);
        if (this.live.get(targetId) === replacementState) this.live.delete(targetId);
      } else {
        try { replacement?.dispose?.(); } catch {}
      }
      const rollbackErrors = Array.isArray(error?.rollbackErrors) ? [...error.rollbackErrors] : [];
      try {
        committed?.rollback?.();
      } catch (rollbackError) {
        rollbackErrors.push(...(rollbackError instanceof AggregateError ? rollbackError.errors : [rollbackError]));
      }
      restoreMaps();
      await restoreLive(fromId);
      if (targetId !== fromId) await restoreLive(targetId);
      if (rollbackErrors.length) {
        if (error && (typeof error === "object" || typeof error === "function")) {
          try { Object.defineProperty(error, "rollbackErrors", { value: rollbackErrors, configurable: true }); } catch {}
        }
        writeLog("error", "session_visibility_recovery_failed", {
          sourceSessionId: fromId,
          failureCount: rollbackErrors.length,
        });
      }
      throw error;
    }
  }

  async switchSessionFromCommand(fromId, sessionPath, options = {}) {
    const current = await this._attachById(fromId);
    if (current.session.isStreaming) throw Object.assign(new Error("Wait for the current response to finish before switching sessions."), { code: "session_streaming" });
    const SDKModule = await SDK();
    const targetManager = SDKModule.SessionManager.open(sessionPath, undefined, options.cwdOverride);
    const before = await current.session.extensionRunner?.emit?.({
      type: "session_before_switch",
      reason: "resume",
      targetSessionFile: targetManager.getSessionFile(),
    });
    if (before?.cancel === true) return { cancelled: true };
    return this._replaceLiveSession(fromId, current, targetManager, {
      reason: "resume",
      withSession: options.withSession,
    });
  }

  async newSessionFromCommand(fromId, options = {}) {
    const current = await this._attachById(fromId);
    const before = await current.session.extensionRunner?.emit?.({ type: "session_before_switch", reason: "new" });
    if (before?.cancel === true) return { cancelled: true };
    const SDKModule = await SDK();
    const manager = current.session.sessionManager.isPersisted()
      ? SDKModule.SessionManager.create(current.cwd, current.session.sessionManager.getSessionDir())
      : SDKModule.SessionManager.inMemory(current.cwd);
    if (options.parentSession) manager.newSession({ parentSession: options.parentSession });
    return this._replaceLiveSession(fromId, current, manager, {
      reason: "new",
      setup: options.setup,
      withSession: options.withSession,
    });
  }

  async forkFromCommand(fromId, entryId, options = {}) {
    const current = await this._attachById(fromId);
    const position = options.position || "before";
    const entry = current.session.sessionManager.getEntry(entryId);
    if (!entry) throw new Error("Invalid entry ID for forking");
    let targetLeafId;
    let selectedText;
    if (position === "at") {
      targetLeafId = entry.id;
    } else {
      if (entry.type !== "message" || entry.message?.role !== "user") throw new Error("Invalid entry ID for forking");
      targetLeafId = entry.parentId;
      selectedText = contentText(entry.message.content);
    }
    const before = await current.session.extensionRunner?.emit?.({
      type: "session_before_fork",
      entryId,
      position,
    });
    if (before?.cancel === true) return { cancelled: true };
    if (!current.session.sessionManager.isPersisted()) return { cancelled: true };
    const SDKModule = await SDK();
    const sourceFile = current.session.sessionFile;
    if (!sourceFile) throw new Error("This session has not been saved yet. Wait for the first assistant response before forking it.");
    let targetManager;
    if (!targetLeafId) {
      targetManager = SDKModule.SessionManager.create(current.cwd, current.session.sessionManager.getSessionDir());
      targetManager.newSession({ parentSession: sourceFile });
    } else {
      const sourceManager = SDKModule.SessionManager.open(sourceFile, current.session.sessionManager.getSessionDir());
      const targetFile = sourceManager.createBranchedSession(targetLeafId);
      if (!targetFile) throw new Error("Failed to create forked session");
      targetManager = SDKModule.SessionManager.open(targetFile, current.session.sessionManager.getSessionDir());
    }
    return this._replaceLiveSession(fromId, current, targetManager, {
      reason: "fork",
      withSession: options.withSession,
      selectedText,
    });
  }

  async _preferredModel(id) {
    const known = this.info.get(id)?.model;
    if (known) return known;
    // `listSessions()` records model changes, but a session reached through a
    // direct route may only have gone through `_discover()`. Preserve an
    // explicit model recorded in that transcript before falling back to the
    // configured default for newly model-less sessions.
    try {
      await SDK();
      const manager = this._managerFor(id);
      const recorded = modelRefFromEntries(manager.getBranch?.() || []);
      if (recorded) {
        this.info.set(id, { ...(this.info.get(id) || {}), model: recorded });
        return recorded;
      }
    } catch { /* default resolution below handles unavailable/malformed state */ }
    return this.defaultModel();
  }

  async _attachById(id) {
    const st = this.live.get(id);
    if (st) return st;
    const pending = this.attachPromises.get(id);
    if (pending) return pending;
    const attaching = this._attachByIdOnce(id);
    this.attachPromises.set(id, attaching);
    try {
      return await attaching;
    } finally {
      if (this.attachPromises.get(id) === attaching) this.attachPromises.delete(id);
    }
  }

  async _attachByIdOnce(id) {
    const st = this.live.get(id);
    if (st) return st;
    await this._discover(id);
    const file = this.paths.get(id) || this.info.get(id)?.path;
    if (!file) throw new Error("unknown session " + id);
    return this._attach(id, this._boundCwd(id), await this._preferredModel(id));
  }

  async stop(id) {
    const st = this.live.get(id);
    if (!st) return;
    st.aborted = true;
    await st.session.abort();
  }

  async _disposeLiveState(st, reason = "quit", targetSessionFile) {
    this.extensionUi.cancelSession(st.session.sessionId);
    const shutdown = Promise.resolve()
      .then(() => st.session.extensionRunner?.emit?.({ type: "session_shutdown", reason, ...(targetSessionFile ? { targetSessionFile } : {}) }))
      .catch(() => {});
    const timeout = new Promise(resolve => {
      const timer = setTimeout(resolve, 5000);
      timer.unref?.();
    });
    await Promise.race([shutdown, timeout]);
    st.unsubscribe?.();
    try { st.session.dispose?.(); } catch {}
  }

  assertPiConfigurationReloadable() {
    if ([...this.live.values()].some(st => st.session.isStreaming)) {
      throw Object.assign(new Error("pi_configuration_busy"), { code: "pi_configuration_busy" });
    }
  }

  async reloadPiConfiguration({ report = null, sessionId = null } = {}) {
    this.assertPiConfigurationReloadable();
    report?.({ type: "phase", phase: "runtime-dispose", message: `Releasing ${this.live.size} idle Pi session runtime${this.live.size === 1 ? "" : "s"}.` });
    for (const st of this.live.values()) await this._disposeLiveState(st, "reload");
    this.live.clear();
    this.packageSetupError = null;
    this.packageSources = null;
    this.packageStatus = null;
    this.piConfiguration.invalidate();
    report?.({ type: "phase", phase: "runtime-load", message: "Reloading Pi profile settings and resources." });
    await this.piConfiguration.state({ force: true, report });
    if (sessionId) {
      try {
        report?.({ type: "phase", phase: "runtime-attach", message: `Attaching the refreshed resource runtime for ${sessionId}.` });
        await this._attachById(sessionId);
      } catch (error) {
        report?.({ type: "warning", phase: "runtime-attach", message: `The selected session was not reattached: ${publicError(error)}` });
      }
    }
    return this.piConfiguration.state({ report });
  }

  piConfigurationState() { return this.piConfiguration.state(); }

  isStreaming(id) { return !!this.live.get(id)?.session?.isStreaming; }
  // Any agent turn, compaction, or queued prompt keeps the worker awake.
  // Load the SDK, model runtime and extensions once after startup so the first
  // message doesn't pay for them. Touches no session, so it never counts as busy.
  async prewarm(cwd) {
    const started = performance.now();
    try {
      const SDKModule = await SDK();
      await this._modelRuntime();
      const agentDir = SDKModule.getAgentDir();
      await this.piConfiguration.resolve();
      const { settingsManager } = await this.piConfiguration.createSettingsManager(cwd, agentDir, SDKModule.SettingsManager, { loadPackages: true });
      exportSyncEnvironment();
      const syncExtensionPath = await activePiSyncExtensionPath();
      await new SDKModule.DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [WEB_SUBAGENT_EXTENSION, ...(syncExtensionPath ? [syncExtensionPath] : [])] }).reload();
      console.log(`pi-ez-web: prewarmed in ${Math.round(performance.now() - started)}ms`);
    } catch (error) {
      console.error("pi-ez-web: prewarm failed (first message will load instead)", publicError(error?.message || String(error)));
    }
  }

  busy() {
    if (this.pendingPrompts.size) return true;
    for (const st of this.live.values()) if (st.session?.isStreaming || st.session?.isCompacting) return true;
    return false;
  }
  isCompacting(id) { return !!this.live.get(id)?.session?.isCompacting; }
  async transcript(id) {
    const st = this.live.get(id);
    if (st) return snapshotRecords(st);
    if (!await this._discover(id)) return [];
    await SDK();
    const manager = this._managerFor(id);
    return entriesToRecords(manager.getBranch?.() || []);
  }

  async meta(id) {
    await this._discover(id);
    const live = this.live.get(id);
    if (live) {
      return {
        id, cwd: this._boundCwd(id, live.cwd), name: live.session.sessionName || null,
        model: modelRef(live.session.model),
        parentSessionId: this.info.get(id)?.parentSessionId || null,
      };
    }
    const file = this.paths.get(id) || this.info.get(id)?.path;
    if (!file) return null;
    try {
      await SDK();
      const manager = this._managerFor(id);
      const branch = manager.getBranch();
      const info = this.info.get(id) || {};
      return {
        id,
        cwd: this._boundCwd(id, manager.getCwd()),
        name: manager.getSessionName?.() || info.name || null,
        model: modelRefFromEntries(branch),
        parentSessionId: info.parentSessionId || null,
      };
    } catch { return null; }
  }

  async rehome(id, newCwd) {
    const st = this.live.get(id);
    if (st) {
      if (st.session.isStreaming) throw Object.assign(new Error("session_streaming"), { code: "session_streaming" });
      await this._disposeLiveState(st, "reload");
      this.live.delete(id);
    }
    if (!await this._discover(id)) throw new Error("unknown session " + id);
    // The durable binding is written by the route immediately after this
    // method. Keep the session header intact; _boundCwd() and meta() already
    // prefer that binding over the original Pi cwd.
    this.info.set(id, { ...(this.info.get(id) || {}), cwd: newCwd });
  }

  async listModels() {
    try {
      const runtime = await this._modelRuntime();
      let models = runtime.getAvailableSnapshot?.() || [];
      if (!models.length) {
        try { models = await runtime.getAvailable(); } catch { /* no configured provider/auth */ }
      }
      this.modelError = runtime.getError?.()
        ? { code: "model_runtime_error", message: "Model discovery reported a provider configuration error." }
        : null;
      this.models = models.map(modelInfo);
    } catch (error) {
      const detail = String(error?.message || error || "unknown error")
        .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
        .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
        .replace(/([?&](?:code|state|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]");
      console.error("pi-ez-web model discovery failed", detail);
      this.modelError = { code: "model_runtime_error", message: "Could not load models. Check Pi provider configuration." };
      this.models = [];
    }
    return this.models.map(m => ({ ...m }));
  }

  async modelState() {
    const configuredDefault = loadConfig().defaultModel || null;
    const models = await this.listModels();
    const configuredAvailable = configuredDefault && models.some(m => m.id === configuredDefault);
    // Without a web default, follow the Pi CLI: the profile's default model, then its first enabled model.
    let profileDefault = null;
    if (!configuredDefault) {
      const settings = (await this.piConfiguration.resolve().catch(() => null))?.settings || {};
      const id = settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : null;
      // shortcut: enabledModels entries match exactly (a ":level" suffix is dropped); globs are skipped.
      const enabled = (Array.isArray(settings.enabledModels) ? settings.enabledModels : []).map(entry => String(entry).replace(/:[a-z]+$/, ""));
      profileDefault = [id, ...enabled].find(candidate => candidate && models.some(m => m.id === candidate)) || null;
    }
    return {
      models,
      configuredDefault,
      effectiveDefault: configuredDefault ? (configuredAvailable ? configuredDefault : null) : (profileDefault || models[0]?.id || null),
      status: configuredDefault ? (configuredAvailable ? "available" : "unavailable") : "automatic",
      error: this.modelError,
    };
  }

  async defaultModel() {
    return (await this.modelState()).effectiveDefault;
  }

  async listProviders() {
    const runtime = await this._modelRuntime();
    const supported = new Set(["anthropic", "openai-codex", "openai"]);
    const models = await this.listModels();
    const availableByProvider = new Map();
    for (const model of models) {
      availableByProvider.set(model.provider, (availableByProvider.get(model.provider) || 0) + 1);
    }
    const providers = [];
    for (const provider of runtime.getProviders()) {
      if (!supported.has(provider.id)) continue;
      const status = runtime.getProviderAuthStatus(provider.id) || {};
      const auth = await runtime.checkAuth(provider.id).catch(() => undefined);
      const authMethods = [];
      if (provider.auth.oauth) authMethods.push({
        id: "oauth",
        label: provider.auth.oauth.name,
        subscription: !!provider.auth.oauth.isSubscription,
      });
      if (provider.auth.apiKey?.login) authMethods.push({
        id: "api_key",
        label: provider.auth.apiKey.name,
        subscription: false,
      });
      const authLabel = auth?.type === "oauth"
        ? (provider.auth.oauth?.name || "OAuth")
        : auth?.type === "api_key"
          ? (provider.auth.apiKey?.name || "API key")
          : null;
      providers.push({
        id: provider.id,
        name: provider.name,
        configured: !!status.configured || !!auth,
        source: status.source || (auth?.source ? "environment" : null),
        sourceLabel: authLabel || status.label || null,
        authType: auth?.type || null,
        authMethods,
        availableModels: availableByProvider.get(provider.id) || 0,
        canLogout: !!auth && status.source === "stored",
        error: this.modelError && !availableByProvider.get(provider.id) ? this.modelError : null,
      });
    }
    return providers;
  }

  async loginProvider(providerId, authType, interaction) {
    const runtime = await this._modelRuntime();
    const headlessMethod = { "openai-codex": "device_code", anthropic: "copy_code" }[providerId];
    const loginInteraction = headlessMethod && authType === "oauth"
      ? {
        ...interaction,
        // The web app may be remote from the browser. Prefer the SDK's
        // headless path so users do not need a localhost callback server.
        prompt: prompt => {
          const device = prompt?.type === "select" && prompt.options?.find(option => option.id === headlessMethod);
          return device ? Promise.resolve(device.id) : interaction.prompt(prompt);
        },
      }
      : interaction;
    await runtime.login(providerId, authType, loginInteraction);
    await runtime.refresh({ providers: [providerId], allowNetwork: true, force: true });
    await runtime.getAvailable(providerId).catch(() => []);
    this.models = null;
    this.modelError = null;
    // A no-model session may have been attached once to render its metadata
    // before the user logged in. Let the next prompt rebuild it with the new
    // runtime availability instead of keeping Pi's "unknown" sentinel.
    for (const [id, state] of this.live) {
      if (!isUsableModel(state.session.model) && !state.session.isStreaming) {
        state.unsubscribe?.();
        state.session.dispose?.();
        this.live.delete(id);
      }
    }
  }

  async logoutProvider(providerId) {
    const runtime = await this._modelRuntime();
    const credentials = await runtime.listCredentials();
    const stored = credentials.some(item => item.providerId === providerId);
    const status = runtime.getProviderAuthStatus(providerId) || {};
    if (!stored && status.configured) {
      throw Object.assign(new Error("credential_managed_by_environment"), { code: "credential_managed_by_environment" });
    }
    await runtime.logout(providerId);
    this.models = null;
    this.modelError = null;
  }

  async setModel(id, modelRef) {
    const st = await this._attachById(id);
    const runtime = st.session.modelRuntime || await this._modelRuntime();
    const model = await this._resolveModel(modelRef, runtime);
    await st.session.setModel(model);
    this.hub.emit(id, "session_meta", { model: modelRef });
  }

  async context(id) {
    const st = await this._attachById(id);
    const model = st.session.model || {};
    const window = Number(model.contextWindow) || null;
    const entry = [...(st.session.sessionManager.getBranch?.() || [])]
      .reverse().find(item => item?.type === "message" && item.message?.role === "assistant" && item.message?.usage);
    const usage = entry?.message?.usage;
    const input = Number(usage?.input) || 0;
    const cacheRead = Number(usage?.cacheRead) || 0;
    const cacheWrite = Number(usage?.cacheWrite) || 0;
    const used = usage ? input + cacheRead + cacheWrite : null;
    return {
      window,
      used,
      remaining: window && used != null ? Math.max(0, window - used) : null,
      percent: window && used != null ? Math.min(100, Math.round((used / window) * 100)) : null,
      input,
      cacheRead,
      cacheWrite,
      model: modelRef(model),
    };
  }

  async thinking(id) {
    const st = await this._attachById(id);
    return {
      level: st.session.thinkingLevel,
      levels: st.session.getAvailableThinkingLevels(),
      supported: st.session.supportsThinking(),
    };
  }

  async setThinking(id, level) {
    const st = await this._attachById(id);
    st.session.setThinkingLevel(String(level || "off"));
    const result = await this.thinking(id);
    this.hub.emit(id, "session_meta", { thinkingLevel: result.level });
    return result;
  }

  async setName(id, name) {
    const normalized = String(name || "").trim();
    const st = this.live.get(id);
    if (st) {
      st.session.setSessionName(normalized);
      this.info.set(id, { ...(this.info.get(id) || {}), name: normalized || null });
      this.hub.emit(id, "session_meta", { name: normalized || null });
      return normalized;
    }
    if (!await this._discover(id)) throw new Error("unknown session " + id);
    await SDK();
    const manager = this._managerFor(id);
    manager.appendSessionInfo(normalized);
    const info = this.info.get(id) || {};
    this.info.set(id, { ...info, name: normalized || null });
    this.hub.emit(id, "session_meta", { name: normalized || null });
    return normalized;
  }

  async fork(parentId, atRecordId, { cwd, name }) {
    const { SessionManager } = await SDK();
    await this._discover(parentId);
    const src = this.paths.get(parentId) || this.info.get(parentId)?.path;
    if (!src) throw new Error("unknown parent session");
    const sm = SessionManager.forkFrom(src, cwd);
    const entry = atRecordId ? sm.getEntry(atRecordId) : null;
    if (atRecordId && (!entry || entry.type !== "message" || entry.message?.role !== "user")) {
      throw Object.assign(new Error("bad_fork_record"), { code: "bad_fork_record" });
    }
    if (entry && !entry.parentId) sm.resetLeaf();
    const runtime = await this._modelRuntime();
    const { session } = await this._withSessionCreateLock(() =>
      this._createConfiguredSession({ cwd, sessionManager: sm, modelRuntime: runtime }),
    );
    if (entry?.parentId) await session.navigateTree(entry.parentId);
    if (name) session.setSessionName(name);
    const id = session.sessionId;
    this.paths.set(id, session.sessionFile);
    this.info.set(id, { id, path: session.sessionFile, cwd, parentSessionId: parentId });
    this._registerLiveSession(session, cwd, { parentSessionId: parentId });
    return { id };
  }

  async bangRecord(id, rec) {
    const st = this.live.get(id);
    if (!st && !await this._discover(id)) throw new Error("unknown session " + id);
    if (!st) await SDK();
    const manager = st?.session.sessionManager || this._managerFor(id);
    manager.appendCustomEntry("pi-web:bang", {
      id: rec.id, cmd: rec.cmd, meta: rec.meta, out: rec.out,
    });
    persistManager(manager, "bang_persistence_unavailable");
  }
}

export function effectiveModelInfo(requestedModel, liveModel, availableModels, defaultModel) {
  const requestedAvailable = requestedModel && availableModels.has(requestedModel);
  const model = liveModel || (requestedAvailable ? requestedModel : defaultModel) || null;
  if (!requestedModel || requestedAvailable || requestedModel === model) return { model };
  return model
    ? { model, requestedModel, modelFallback: true }
    : { model: null, requestedModel, modelUnavailable: true };
}

function isUsableModel(model) {
  return !!model && model.provider !== "unknown" && model.id !== "unknown" && model.api !== "unknown";
}

function modelRef(model) {
  if (!isUsableModel(model)) return null;
  const provider = model.provider;
  const id = model.id ?? model.modelId;
  return provider && id ? `${provider}/${id}` : null;
}

function modelInfo(model) {
  const id = modelRef(model);
  return {
    id,
    provider: model.provider,
    label: model.name || model.label || model.modelId || model.id || id,
  };
}

function modelRefFromEntries(entries) {
  const entry = [...(entries || [])].reverse().find(e => e.type === "model_change");
  return entry ? `${entry.provider}/${entry.modelId}` : null;
}

function assistantRecordId(parentId) { return `a:${parentId || "root"}`; }
function entryHasSubagentRevision(entry) {
  return [entry?.data, entry?.details, entry?.message?.details]
    .some(value => Number.isSafeInteger(Number(value?.revision)) && Number(value.revision) > 0);
}
export function formatDuration(durationMs) {
  return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

function seedSubagentState(st) {
  const branch = st.session.sessionManager.getBranch?.() || [];
  for (const record of entriesToRecords(branch)) {
    if (record.role !== "activity" || record.kind !== "agent" || !record.runId) continue;
    st.subagents.apply(record, { revisionProvided: true });
  }
}

function snapshotRecords(st) {
  const records = entriesToRecords(st.session.sessionManager.getBranch?.() || []);
  for (const record of st.subagents?.snapshot?.() || []) {
    const existing = records.find(item => item.id === record.id);
    if (!existing) records.push(cloneRecord(record));
    else Object.assign(existing, cloneRecord(record));
  }
  for (const record of st.liveRecords.values()) {
    if (record.role === "assistant" && !record.streaming) continue;
    const existing = records.find(r => r.id === record.id);
    if (!existing) records.push(cloneRecord(record));
    else if (record.role === "activity") Object.assign(existing, cloneRecord(record));
    else if (record.streaming) Object.assign(existing, { text: record.text, ...(record.thinking ? { thinking: record.thinking } : {}), streaming: true });
  }
  return records;
}

export function entriesToRecords(entries) {
  const records = [];
  const tools = new Map();
  const subagents = new SubagentActivityStore();
  for (const entry of entries || []) {
    if (entry.type === "custom" && entry.customType === "pi-web:bang") {
      const d = entry.data || {};
      records.push({ id: d.id || entry.id, role: "bang", cmd: d.cmd || "", meta: d.meta || "", out: d.out || "" });
      continue;
    }
    let activity = activityFromEntry(entry);
    if (activity?.kind === "agent" && activity.runId) {
      activity = subagents.apply(activity, { revisionProvided: entryHasSubagentRevision(entry) });
    }
    if (activity) {
      const index = records.findIndex(record => record.id === activity.id);
      if (index >= 0 && activity.key === "compaction") {
        records.splice(index, 1);
        records.push(activity);
      } else if (index >= 0) records[index] = activity;
      else records.push(activity);
    }
    if (entry.type === "custom" && entry.customType === "pi-summarize") {
      const summary = summaryRecord(entry);
      if (summary) records.push(summary);
      continue;
    }
    if (entry.type === "custom" || entry.type === "custom_message") continue;
    if (entry.type !== "message") continue;
    const message = entry.message || {};
    if (message.role === "user") {
      records.push({
        id: entry.id,
        role: "user",
        text: contentText(message.content),
        images: contentImages(message.content),
        at: entryTime(entry),
      });
      continue;
    }
    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const text = contentText(content.filter(c => c?.type === "text"));
      const thinking = content.filter(c => c?.type === "thinking" && c.thinking).map(c => c.thinking).join("\n\n");
      const at = entryTime(entry);
      const toolIds = content.filter(c => c?.type === "toolCall").map(c => c.id);
      if (text || thinking) records.push({ id: assistantRecordId(entry.parentId), role: "assistant", text, ...(thinking ? { thinking } : {}), toolIds, at });
      for (const c of content) {
        if (c?.type === "toolCall") {
          const record = { id: c.id, role: "tool", tool: c.name, arg: summarizeArgs(c.name, c.arguments || c.args), meta: "", out: "", at };
          records.push(record);
          tools.set(c.id, record);
        }
      }
      continue;
    }
    if (message.role === "toolResult" || message.role === "tool_result" || message.role === "tool") {
      const toolId = message.toolCallId || message.tool_call_id || message.id;
      const record = tools.get(toolId) || [...records].reverse().find(r => r.role === "tool" && !r.out);
      if (record) record.out = renderToolResult(message);
    }
  }
  return records;
}

function cloneRecord(record) {
  return { ...record, ...(record.lines ? { lines: record.lines.map(line => ({ ...line })) } : {}) };
}

function compactionStartActivity() {
  return normalizeActivity({
    id: "activity:compaction", kind: "status", key: "compaction", status: "running",
    title: "Compacting", summary: "context…",
  }, { source: "pi" });
}

function compactionEndActivity(evt) {
  const aborted = !!evt.aborted;
  const failed = !aborted && !evt.result;
  return normalizeActivity({
    id: "activity:compaction", kind: "status", key: "compaction",
    status: aborted ? "aborted" : failed ? "failed" : "completed",
    title: aborted ? "Compaction cancelled" : failed ? "Compaction failed" : "Context compacted",
    summary: evt.errorMessage || (aborted ? "Compaction cancelled." : "Session context compacted."),
  }, { source: "pi" });
}

function toolStartRecord(evt) {
  return {
    id: evt.toolCallId, role: "tool", tool: evt.toolName,
    arg: summarizeArgs(evt.toolName, evt.args), meta: "", out: "", at: Date.now(), running: true,
  };
}

// pi-summarize writes a custom session entry that groups the tool calls it summarizes.
// Its title entries (kind "title") are not step summaries.
function summaryRecord(entry) {
  const data = entry.data || {};
  if (data.kind === "title" || !data.text) return null;
  return {
    id: entry.id, role: "summary", text: String(data.text || ""),
    at: timeOf(data.at) || entryTime(entry),
    toolCallIds: Array.isArray(data.toolCallIds) ? data.toolCallIds.map(String) : [],
    ...(data.continues ? { continues: true } : {}),
  };
}

function entryTime(entry) {
  return timeOf(entry?.timestamp ?? entry?.message?.timestamp);
}

function timeOf(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toolResultMeta(isError, durationMs) {
  return [isError ? "error" : "", durationMs ? formatDuration(durationMs) : ""].filter(Boolean).join(" · ");
}

function toolDiffRecord(toolCallId, diff) {
  return { id: `${toolCallId}:d`, role: "diff", file: diff.path, add: `+${diff.adds}`, del: `−${diff.dels}`, lines: flattenHunks(diff.hunks) };
}

function flattenHunks(hunks) {
  return (hunks || []).flatMap(h => [
    ...(h.header ? [{ sign: "", text: h.header }] : []),
    ...(h.lines || []),
  ]);
}

export function summarizeArgs(_toolName, args) {
  if (!args || typeof args !== "object") return "";
  const v = args.path || args.file_path || args.pattern || args.command || args.cmd || Object.values(args)[0];
  return typeof v === "string" ? v : JSON.stringify(v ?? "");
}

export function renderToolResult(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result?.content === "string") return result.content;
  if (Array.isArray(result?.content)) {
    return result.content.map(c => (typeof c === "string" ? c : c.text ?? "")).join("\n");
  }
  if (typeof result?.output === "string") return result.output;
  if (typeof result?.text === "string") return result.text;
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

export function maybeDiff(toolName, args, result) {
  if (toolName !== "edit" && toolName !== "write") return null;
  const filePath = args?.path || args?.file_path;
  const text = renderToolResult(result);
  if (!filePath || !text || !/^[@+\- ]/m.test(text)) return null;
  const lines = [];
  let adds = 0, dels = 0;
  const hunks = [];
  let hunk = null;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("@@")) {
      hunk = { header: raw, lines: [] };
      hunks.push(hunk);
      continue;
    }
    const sign = raw.startsWith("+") ? "+" : raw.startsWith("-") ? "-" : " ";
    if (sign === "+") adds++; else if (sign === "-") dels++;
    const line = { sign, text: raw.replace(/^[+\- ]/, "") };
    (hunk ? hunk.lines : lines).push(line);
  }
  if (!hunks.length && lines.length) hunks.push({ header: "", lines });
  if (!hunks.length) return null;
  return { path: filePath, adds, dels, hunks };
}

function assistantErrorMessage(message) {
  if (!message || message.role !== "assistant") return "";
  if (message.stopReason !== "error" && message.stopReason !== "aborted" && !message.errorMessage) return "";
  return message.errorMessage || contentText(message.content);
}

function turnErrorMessage(error) {
  const raw = typeof error === "string"
    ? error
    : error?.errorMessage || error?.message || error?.code || contentText(error?.content);
  return publicError(raw || "Service unavailable.");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(c => c?.text ?? "").join("");
  return "";
}

function contentImages(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(c => c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string")
    .map(c => ({ type: "image", data: c.data, mimeType: c.mimeType }));
}
