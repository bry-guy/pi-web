// Controller adapter for pi-syncd's stateless remote-control relay (/v1/remote/*).
// Active only when PI_SYNC_SERVER_URL (or config sync.serverUrl) and PI_SYNC_REMOTE_TOKEN are set.
// Never runs on workers; exposes live laptop sessions alongside projects and chats on the same SSE hub.

import { randomUUID } from "node:crypto";
import { loadConfig, syncConfig } from "./config.js";
import { entriesToRecords, renderToolResult, summarizeArgs, summaryRecord } from "./supervisor/real.js";

const CUSTOM_OPTION = "Type something…";
const DEFAULT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function compactCwd(cwd) {
  if (!cwd) return "";
  return String(cwd).replace(/^\/(?:Users|home)\/[^/]+(?=$|\/)/, "~");
}

function sessionDisplayTitle(meta) {
  const title = typeof meta?.title === "string" ? meta.title.trim() : "";
  if (title) return title;
  const cwd = compactCwd(meta?.cwd);
  return cwd || `Session ${String(meta?.sessionId || "").slice(-8)}`;
}

export function createRemoteSessions({ baseUrl, token, hub, onEvent = null, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const root = String(baseUrl || "").replace(/\/+$/, "");
  const live = new Map(); // sessionId -> normalized SessionMeta
  const known = new Map(); // sessionId -> last-seen SessionMeta (for offline banners)
  const runtime = new Map(); // sessionId -> { msgId, toolStarts: Map, turnId }
  const steppers = new Map(); // sessionId -> { toolCallId, questions, index, answers, awaitingCustom, requestId, currentEvent }
  let stopped = false;
  let sseAbort = null;
  let loopPromise = null;

  const headers = (json = false) => ({
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  });

  function normalizeMeta(raw) {
    return {
      id: raw.sessionId,
      sessionId: raw.sessionId,
      device: raw.device || "device",
      cwd: raw.cwd || "",
      cwdShort: compactCwd(raw.cwd),
      title: sessionDisplayTitle(raw),
      model: raw.model || null,
      thinkingLevel: raw.thinkingLevel || null,
      thinkingLevels: Array.isArray(raw.thinkingLevels) && raw.thinkingLevels.length ? raw.thinkingLevels : null,
      context: raw.context && typeof raw.context === "object" ? raw.context : null,
      streaming: !!raw.streaming,
      waitingDialog: raw.waitingDialog || null,
      pendingQuestion: raw.pendingQuestion || null,
      updatedAt: raw.updatedAt || new Date().toISOString(),
      online: true,
    };
  }

  function list() {
    return [...live.values()].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  function emitSessions() {
    hub?.emit(null, "remote_sessions", { sessions: list() });
  }

  function emitEvent(sessionId, type, data = {}) {
    const evt = hub?.emit(sessionId, type, data);
    onEvent?.({ sessionId, type, ...data });
    return evt;
  }

  function clearStepper(sessionId, notifyResolved = true) {
    const cur = steppers.get(sessionId);
    if (!cur) return;
    steppers.delete(sessionId);
    if (notifyResolved && cur.requestId) {
      emitEvent(sessionId, "extension_ui_resolved", { requestId: cur.requestId });
    }
  }

  function emitCurrentQuestion(sessionId, stepper) {
    const q = stepper.questions[stepper.index];
    if (!q) return;
    const requestId = `remote-q:${randomUUID().slice(0, 12)}`;
    stepper.requestId = requestId;
    const stepPrefix = stepper.questions.length > 1 ? `(${stepper.index + 1}/${stepper.questions.length}) ` : "";
    const title = `${stepPrefix}${q.question || q.header || "Question"}`;
    const options = Array.isArray(q.options) ? q.options.map(o => (typeof o === "string" ? o : o?.label)).filter(Boolean) : [];
    const useInput = stepper.awaitingCustom || options.length === 0 || !!q.multiSelect;
    const event = useInput
      ? {
          requestId,
          method: "input",
          title: q.multiSelect && options.length
            ? `${title}\nOptions: ${options.map((o, i) => `${i + 1}. ${o}`).join(" · ")}`
            : title,
          placeholder: "Type your answer…",
          timeout: 600_000,
        }
      : {
          requestId,
          method: "select",
          title,
          options: [...options, CUSTOM_OPTION],
          timeout: 600_000,
        };
    stepper.currentEvent = event;
    emitEvent(sessionId, "extension_ui_request", event);
  }

  function startQuestion(sessionId, toolCallId, questions) {
    if (!toolCallId || !Array.isArray(questions) || questions.length === 0) return;
    const existing = steppers.get(sessionId);
    if (existing && existing.toolCallId === toolCallId) return;
    clearStepper(sessionId, true);
    const stepper = { toolCallId, questions, index: 0, answers: [], awaitingCustom: false, requestId: null, currentEvent: null };
    steppers.set(sessionId, stepper);
    emitCurrentQuestion(sessionId, stepper);
  }

  function replayPendingQuestion(sessionId) {
    const stepper = steppers.get(sessionId);
    if (stepper?.currentEvent) {
      hub?.emit(sessionId, "extension_ui_request", stepper.currentEvent);
    }
  }

  async function postAnswerToHost(sessionId, toolCallId, body) {
    const res = await fetchImpl(`${root}/v1/remote/sessions/${encodeURIComponent(sessionId)}/extension-ui/${encodeURIComponent(toolCallId)}`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ toolCallId, ...body }),
      signal: AbortSignal.timeout(16_000),
    });
    const out = await res.json().catch(() => ({}));
    return { status: res.status, body: out };
  }

  async function respondQuestion(sessionId, requestId, body = {}) {
    const stepper = steppers.get(sessionId);
    if (!stepper || stepper.requestId !== requestId) {
      return { status: 409, body: { error: "stale_extension_ui_request", message: "This prompt is no longer waiting for an answer." } };
    }
    if (body?.cancelled === true) {
      clearStepper(sessionId, true);
      return postAnswerToHost(sessionId, stepper.toolCallId, { cancel: true });
    }
    const q = stepper.questions[stepper.index];
    const options = Array.isArray(q?.options) ? q.options.map(o => (typeof o === "string" ? o : o?.label)).filter(Boolean) : [];
    const value = typeof body?.value === "string" ? body.value : "";

    if (stepper.currentEvent?.method === "select") {
      if (value === CUSTOM_OPTION) {
        emitEvent(sessionId, "extension_ui_resolved", { requestId });
        stepper.awaitingCustom = true;
        emitCurrentQuestion(sessionId, stepper);
        return { status: 200, body: { ok: true } };
      }
      const idx = options.indexOf(value);
      if (idx < 0) return { status: 400, body: { error: "invalid_extension_ui_response", message: "Selected option is invalid." } };
      stepper.answers.push({ questionIndex: stepper.index, optionIndexes: [idx] });
    } else {
      const trimmed = value.trim();
      if (!trimmed) return { status: 400, body: { error: "invalid_extension_ui_response", message: "A non-empty answer is required." } };
      stepper.answers.push({ questionIndex: stepper.index, text: trimmed });
    }

    emitEvent(sessionId, "extension_ui_resolved", { requestId });
    stepper.awaitingCustom = false;
    stepper.index += 1;
    if (stepper.index < stepper.questions.length) {
      emitCurrentQuestion(sessionId, stepper);
      return { status: 200, body: { ok: true } };
    }
    steppers.delete(sessionId);
    return postAnswerToHost(sessionId, stepper.toolCallId, { answers: stepper.answers });
  }

  async function cancelQuestion(sessionId, requestId) {
    return respondQuestion(sessionId, requestId, { cancelled: true });
  }

  function handleSessionsSnapshot(rawSessions) {
    const nextIds = new Set();
    for (const raw of rawSessions || []) {
      if (!raw?.sessionId) continue;
      const meta = normalizeMeta(raw);
      nextIds.add(meta.id);
      live.set(meta.id, meta);
      known.set(meta.id, meta);
      if (meta.pendingQuestion?.toolCallId && Array.isArray(meta.pendingQuestion?.questions)) {
        startQuestion(meta.id, meta.pendingQuestion.toolCallId, meta.pendingQuestion.questions);
      }
    }
    for (const id of [...live.keys()]) {
      if (!nextIds.has(id)) {
        live.delete(id);
        runtime.delete(id);
        clearStepper(id, true);
      }
    }
    emitSessions();
  }

  function stateFor(sessionId) {
    let st = runtime.get(sessionId);
    if (!st) {
      st = { msgId: null, turnId: null, toolStarts: new Map() };
      runtime.set(sessionId, st);
    }
    return st;
  }

  function handleSessionEvent(sessionId, evt) {
    if (!sessionId || !evt || typeof evt !== "object") return;
    const st = stateFor(sessionId);
    const meta = live.get(sessionId);
    switch (evt.type) {
      case "user_message": {
        const record = {
          id: `u:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`,
          role: "user",
          text: typeof evt.text === "string" ? evt.text : "",
          images: Array.isArray(evt.images) ? evt.images : [],
          at: evt.at || Date.now(),
        };
        emitEvent(sessionId, "user_record", { record, ...(evt.clientMessageId ? { clientMessageId: evt.clientMessageId } : {}) });
        break;
      }
      case "turn_start":
        st.turnId = `rt:${sessionId}:${Date.now().toString(36)}`;
        if (meta) { meta.streaming = true; meta.updatedAt = new Date().toISOString(); }
        emitEvent(sessionId, "turn_start", { turnId: st.turnId });
        break;
      case "message_start":
        if (evt.role === "assistant") {
          st.msgId = `ra:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`;
          emitEvent(sessionId, "message_start", { messageId: st.msgId, role: "assistant" });
        }
        break;
      case "text_delta":
        if (evt.delta && st.msgId) emitEvent(sessionId, "text_delta", { messageId: st.msgId, delta: evt.delta });
        break;
      case "thinking_delta":
        if (evt.delta && st.msgId) emitEvent(sessionId, "thinking_delta", { messageId: st.msgId, delta: evt.delta });
        break;
      case "message_end":
        if (evt.role === "assistant" && st.msgId) {
          emitEvent(sessionId, "message_end", { messageId: st.msgId });
          st.msgId = null;
        }
        break;
      case "tool_start":
        if (evt.toolId) {
          st.toolStarts.set(evt.toolId, Date.now());
          emitEvent(sessionId, "tool_start", {
            toolId: evt.toolId,
            name: evt.name || "tool",
            argsSummary: summarizeArgs(evt.name || "tool", evt.args),
          });
        }
        break;
      case "tool_end":
        if (evt.toolId) {
          const started = st.toolStarts.get(evt.toolId);
          st.toolStarts.delete(evt.toolId);
          const durationMs = started ? Date.now() - started : 0;
          emitEvent(sessionId, "tool_end", {
            toolId: evt.toolId,
            ok: evt.ok !== false,
            output: renderToolResult(evt.result),
            meta: "",
            durationMs,
          });
        }
        break;
      case "turn_end":
        if (meta) { meta.streaming = false; meta.updatedAt = new Date().toISOString(); }
        emitEvent(sessionId, "turn_end", { ok: evt.ok !== false });
        emitSessions();
        break;
      case "ask_user_prompt":
        startQuestion(sessionId, evt.toolCallId, evt.questions);
        break;
      case "ask_user_cleared":
        clearStepper(sessionId, true);
        break;
      case "waiting_dialog":
        if (meta) {
          meta.waitingDialog = evt.title || null;
          emitSessions();
        }
        break;
      case "working_message":
        emitEvent(sessionId, "extension_ui_working", { message: evt.message || null });
        break;
      case "summary": {
        const record = evt.entry ? summaryRecord(evt.entry) : null;
        if (record) emitEvent(sessionId, "summary", { record });
        break;
      }
      case "session_meta":
        if (meta) {
          if (typeof evt.title === "string" && evt.title.trim()) meta.title = evt.title.trim();
          if (evt.model !== undefined) meta.model = evt.model;
          if (typeof evt.thinkingLevel === "string" && evt.thinkingLevel) meta.thinkingLevel = evt.thinkingLevel;
          if (Array.isArray(evt.thinkingLevels) && evt.thinkingLevels.length) meta.thinkingLevels = evt.thinkingLevels;
          if (evt.context && typeof evt.context === "object") meta.context = evt.context;
          emitEvent(sessionId, "session_meta", {
            ...(meta.model ? { model: meta.model } : {}),
            ...(meta.thinkingLevel ? { thinkingLevel: meta.thinkingLevel } : {}),
          });
          emitSessions();
        }
        break;
      default:
        break;
    }
  }

  async function consumeSSE(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "";
    let dataLines = [];
    const dispatch = () => {
      if (!dataLines.length && !eventName) return;
      const raw = dataLines.join("\n");
      const name = eventName || "message";
      eventName = "";
      dataLines = [];
      if (!raw) return;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return; }
      if (name === "sessions") handleSessionsSnapshot(parsed.sessions);
      else if (name === "session_event") handleSessionEvent(parsed.sessionId, parsed.event);
      else if (name === "resync") {
        void refresh().catch(() => {});
        hub?.emit(null, "events_resync", {});
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buffer.indexOf("\n");
          if (nl < 0) break;
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          if (line === "") dispatch();
          else if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function sseLoop() {
    let backoffMs = 500;
    while (!stopped) {
      sseAbort = new AbortController();
      try {
        const res = await fetchImpl(`${root}/v1/remote/events`, {
          method: "GET",
          headers: headers(),
          signal: sseAbort.signal,
        });
        if (!res.ok || !res.body) {
          if (res.status === 404) {
            // Remote control not enabled on pi-syncd yet; back off quietly.
            backoffMs = Math.min(15_000, backoffMs * 2);
          }
          await sleep(backoffMs, sseAbort.signal);
          backoffMs = Math.min(10_000, backoffMs * 2);
          continue;
        }
        backoffMs = 500;
        await consumeSSE(res.body);
      } catch {
        if (stopped) return;
      }
      if (live.size > 0) {
        live.clear();
        emitSessions();
      }
      await sleep(backoffMs, sseAbort?.signal);
      backoffMs = Math.min(10_000, backoffMs * 2);
    }
  }

  async function refresh() {
    const res = await fetchImpl(`${root}/v1/remote/sessions`, {
      method: "GET",
      headers: headers(),
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return list();
    const body = await res.json().catch(() => ({}));
    if (Array.isArray(body.sessions)) handleSessionsSnapshot(body.sessions);
    return list();
  }

  async function transcript(sessionId) {
    const seq = hub ? hub.currentSeq() : 0;
    const res = await fetchImpl(`${root}/v1/remote/sessions/${encodeURIComponent(sessionId)}/transcript`, {
      method: "GET",
      headers: headers(),
      signal: AbortSignal.timeout(16_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { status: res.status, body };
    const records = entriesToRecords(Array.isArray(body.entries) ? body.entries : []);
    if (body.pendingQuestion?.toolCallId && Array.isArray(body.pendingQuestion?.questions)) {
      startQuestion(sessionId, body.pendingQuestion.toolCallId, body.pendingQuestion.questions);
    }
    replayPendingQuestion(sessionId);
    const meta = live.get(sessionId);
    if (meta) {
      if (body.model !== undefined) meta.model = body.model;
      if (typeof body.thinkingLevel === "string" && body.thinkingLevel) meta.thinkingLevel = body.thinkingLevel;
      if (Array.isArray(body.thinkingLevels) && body.thinkingLevels.length) meta.thinkingLevels = body.thinkingLevels;
      if (body.context && typeof body.context === "object") meta.context = body.context;
    }
    return {
      status: 200,
      body: {
        sessionId,
        seq,
        streaming: !!body.streaming,
        compacting: false,
        queue: { steering: [], followUp: [] },
        records,
        remote: {
          device: body.device || meta?.device || "device",
          cwd: body.cwd || meta?.cwd || "",
          cwdShort: compactCwd(body.cwd || meta?.cwd || ""),
          online: true,
          waitingDialog: body.waitingDialog || meta?.waitingDialog || null,
        },
      },
    };
  }

  async function proxyPost(sessionId, subpath, body) {
    if (!live.has(sessionId)) {
      const prev = known.get(sessionId);
      return { status: 503, body: { error: "host_offline", message: `${prev?.device || "Device"} is offline.` } };
    }
    const res = await fetchImpl(`${root}/v1/remote/sessions/${encodeURIComponent(sessionId)}${subpath}`, {
      method: "POST",
      headers: headers(true),
      body: body !== undefined ? JSON.stringify(body) : "{}",
      signal: AbortSignal.timeout(16_000),
    });
    const out = await res.json().catch(() => ({}));
    return { status: res.status, body: out };
  }

  function start() {
    if (loopPromise || stopped) return;
    loopPromise = sseLoop();
    log(`pi-ez-web: remote sessions enabled (${root})`);
  }

  function stop() {
    stopped = true;
    sseAbort?.abort();
  }

  return {
    start,
    stop,
    refresh,
    list,
    owns: id => live.has(id),
    wasKnown: id => known.has(id),
    get: id => live.get(id) || known.get(id) || null,
    sessionTitle: id => (live.get(id) || known.get(id))?.title || null,
    transcript,
    context: id => {
      const m = live.get(id) || known.get(id);
      if (m?.context) return m.context;
      return { window: null, used: null, remaining: null, percent: null, input: 0, cacheRead: 0, cacheWrite: 0, model: m?.model || null };
    },
    thinking: id => {
      const m = live.get(id) || known.get(id);
      const levels = m?.thinkingLevels || DEFAULT_THINKING_LEVELS;
      return { level: m?.thinkingLevel || "off", levels, supported: levels.length > 1 };
    },
    setThinking: async (id, body) => {
      const out = await proxyPost(id, "/thinking", body);
      const m = live.get(id);
      if (out.status === 200 && m && typeof out.body?.level === "string") {
        m.thinkingLevel = out.body.level;
        if (Array.isArray(out.body.levels) && out.body.levels.length) m.thinkingLevels = out.body.levels;
        emitSessions();
      }
      return out;
    },
    setModel: async (id, body) => {
      const out = await proxyPost(id, "/model", body);
      const m = live.get(id);
      if (out.status === 200 && m && typeof out.body?.model === "string") {
        m.model = out.body.model;
        emitSessions();
      }
      return out;
    },
    message: (id, body) => proxyPost(id, "/message", body),
    stopTurn: id => proxyPost(id, "/stop", {}),
    respondQuestion,
    cancelQuestion,
    sessionPost: async (id, subpath, body) => {
      if (subpath === "/message") return proxyPost(id, "/message", body);
      if (subpath === "/stop") return proxyPost(id, "/stop", {});
      const extMatch = /^\/extension-ui\/([^/]+)$/.exec(subpath || "");
      if (extMatch) return respondQuestion(id, decodeURIComponent(extMatch[1]), body);
      return { status: 404, body: { error: "not_found" } };
    },
  };
}

export function remoteSessionsFromEnv(env = process.env, deps = {}) {
  const token = env.PI_SYNC_REMOTE_TOKEN?.trim();
  if (!token) return null;
  const baseUrl = env.PI_SYNC_SERVER_URL?.trim() || env.PI_SYNC_URL?.trim() || syncConfig(loadConfig()).serverUrl;
  if (!baseUrl) return null;
  const client = createRemoteSessions({ baseUrl, token, ...deps });
  client.start();
  return client;
}

export function registerRemoteSessionRoutes(api, remoteSessions) {
  api.get("/sessions/:id/transcript", async (c, next) => {
    const id = c.req.param("id");
    if (!remoteSessions.owns(id)) {
      if (remoteSessions.wasKnown(id)) {
        const prev = remoteSessions.get(id);
        return c.json({ error: "host_offline", message: `${prev?.device || "Device"} is offline.` }, 503);
      }
      return next();
    }
    const { status, body } = await remoteSessions.transcript(id);
    return c.json(body, status);
  });

  api.get("/sessions/:id/meta", async (c, next) => {
    const id = c.req.param("id");
    if (!remoteSessions.owns(id) && !remoteSessions.wasKnown(id)) return next();
    const m = remoteSessions.get(id);
    return c.json({
      id,
      cwd: m?.cwd || "",
      name: m?.title || null,
      model: m?.model || null,
      remote: true,
      device: m?.device || null,
      online: remoteSessions.owns(id),
    });
  });

  api.get("/sessions/:id/context", async (c, next) => {
    const id = c.req.param("id");
    if (!remoteSessions.owns(id) && !remoteSessions.wasKnown(id)) return next();
    return c.json(remoteSessions.context(id));
  });

  api.get("/sessions/:id/thinking", async (c, next) => {
    const id = c.req.param("id");
    if (!remoteSessions.owns(id) && !remoteSessions.wasKnown(id)) return next();
    return c.json(remoteSessions.thinking(id));
  });

  api.post("/sessions/:id/thinking", async (c, next) => {
    const id = c.req.param("id");
    if (!remoteSessions.owns(id) && !remoteSessions.wasKnown(id)) return next();
    const body = await c.req.json().catch(() => ({}));
    const { status, body: out } = await remoteSessions.setThinking(id, body);
    return c.json(out, status);
  });

  api.post("/sessions/:id/model", async (c, next) => {
    const id = c.req.param("id");
    if (!remoteSessions.owns(id) && !remoteSessions.wasKnown(id)) return next();
    const body = await c.req.json().catch(() => ({}));
    const { status, body: out } = await remoteSessions.setModel(id, body);
    return c.json(out, status);
  });

  api.post("/sessions/:id/message", async (c, next) => {
    const id = c.req.param("id");
    if (!remoteSessions.owns(id) && !remoteSessions.wasKnown(id)) return next();
    const body = await c.req.json().catch(() => ({}));
    const { status, body: out } = await remoteSessions.message(id, body);
    return c.json(out, status);
  });

  api.post("/sessions/:id/stop", async (c, next) => {
    const id = c.req.param("id");
    if (!remoteSessions.owns(id) && !remoteSessions.wasKnown(id)) return next();
    const { status, body: out } = await remoteSessions.stopTurn(id);
    return c.json(out, status);
  });

  api.post("/sessions/:id/extension-ui/:requestId", async (c, next) => {
    const id = c.req.param("id");
    if (!remoteSessions.owns(id) && !remoteSessions.wasKnown(id)) return next();
    const body = await c.req.json().catch(() => ({}));
    const { status, body: out } = await remoteSessions.respondQuestion(id, c.req.param("requestId"), body);
    return c.json(out, status);
  });

  api.delete("/sessions/:id/extension-ui/:requestId", async (c, next) => {
    const id = c.req.param("id");
    if (!remoteSessions.owns(id) && !remoteSessions.wasKnown(id)) return next();
    const { status, body: out } = await remoteSessions.cancelQuestion(id, c.req.param("requestId"));
    return c.json(out, status);
  });
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
