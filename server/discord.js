// Discord contact: web DMs its owner when a session needs him and relays his DM replies back.
// Off unless PI_WEB_DISCORD_TOKEN and PI_WEB_DISCORD_USER are set; only web (remote-workspaces.js) starts it.
// The logic here is pure apart from the injected transport (discord-transport.js) and session calls.

import { discordTransport } from "./discord-transport.js";

export const QUESTION_DELAY_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const LIMIT = 2000;
const METHODS = new Set(["select", "confirm", "input", "editor"]);
const KEEP_NOTICES = 200;

export const truncate = (text, max = LIMIT) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;
// Every notice carries this link: it is how a later DM finds its session, even after a web restart.
export const sessionLink = (base, id) => `${base.replace(/\/+$/, "")}/?s=${encodeURIComponent(id)}`;
// Starts every part of a split reply after the first, so agent text there can never pass for a header.
const CONTINUED = "(continued)\n";
/**
 * The session a bot message is about, read only from what this module wrote: `{ kind, sessionId }` or null.
 * A turn end's link ends its first line; a question's first line ends "needs an answer" and its link is the last line.
 */
export function linkedSession(content, base) {
  const lines = String(content || "").split("\n");
  if (!lines[0].startsWith("**")) return null;
  const prefix = sessionLink(base, "");
  const id = link => {
    if (!link?.startsWith(prefix) || /[\s<>&]/.test(link.slice(prefix.length))) return null;
    try { return decodeURIComponent(link.slice(prefix.length)) || null; } catch { return null; }
  };
  const turn = lines[0].match(/ <([^<>\s]+)>$/);
  const sessionId = turn ? id(turn[1]) : lines[0].endsWith(" needs an answer") && lines.length > 1 ? id(lines.at(-1)) : null;
  return sessionId ? { kind: turn ? "turn" : "question", sessionId } : null;
}
// The prefix of the clientMessageId on messages Discord delivers, so their user_record shows where they came from.
const VIA = "discord:";
// The link survives truncation: only the body is cut.
const compose = (body, link) => link ? `${truncate(body, LIMIT - link.length - 1)}\n${link}` : truncate(body);

const label = (title, agent) => `**${String(title || "A session").replace(/\s+/g, " ")}**${agent ? ` (${agent})` : ""}`;

export function questionText({ title, agent, request, link }) {
  const lines = [`${label(title, agent)} needs an answer`];
  if (request.title) lines.push(String(request.title));
  if (request.method === "confirm" && request.message) lines.push(String(request.message));
  if (request.method === "select") (request.options || []).forEach((o, i) => lines.push(`${i + 1}. ${o}`));
  lines.push(request.method === "select" ? "_Reply with a number or an option._" : request.method === "confirm" ? "_Reply yes or no._" : "_Reply with your answer._");
  return compose(lines.join("\n"), link);
}

const openFence = text => {
  let open = null;
  for (const line of text.split("\n")) if (/^\s*```/.test(line)) open = open ? null : line.trim();
  return open && open.length <= 20 ? open : open && "```";
};

/** Discord messages for `text`: cut at a paragraph, line or space where possible; a cut code fence is closed and reopened. */
export function splitMessage(text, max = LIMIT) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    const room = max - 4; // "\n```" closes a fence
    const window = rest.slice(0, room + 1);
    let cut = room, skip = 0;
    for (const sep of ["\n\n", "\n", " "]) {
      const at = window.lastIndexOf(sep);
      if (at >= room / 2) { cut = at; skip = sep.length; break; }
    }
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut + skip);
    const fence = openFence(piece);
    if (fence) { piece += "\n```"; rest = `${fence}\n${rest}`; }
    parts.push(piece);
  }
  parts.push(rest);
  return parts;
}

/** The DMs for a finished turn: a header with the link, then the turn's final reply or its error. */
export function turnEndText({ title, agent, reason, error, text, link }) {
  const head = `${label(title, agent)}`;
  const split = body => splitMessage(body, LIMIT - CONTINUED.length).map((part, i) => i ? CONTINUED + part : part);
  if (reason === "errored") return split(`${head} failed <${link}>\n${error || "unknown error"}`);
  return text?.trim() ? split(`${head} <${link}>\n${text.trim()}`) : [`${head} finished. <${link}>`];
}

/** What a reply to `notice` does: a POST to the session ({ rest, body }) or a hint to send back. */
export function replyAction(notice, text) {
  const value = text.trim();
  // steer, like the browser: queued while a turn runs, a new prompt otherwise.
  if (notice.kind === "turn") return value ? { rest: "/message", body: { text: value, mode: "steer" } } : { hint: "Reply with a message for the session." };
  const rest = `/extension-ui/${encodeURIComponent(notice.requestId)}`;
  if (notice.method === "select") {
    const n = /^\d+$/.test(value) ? Number(value) : NaN;
    const option = notice.options[n - 1] ?? notice.options.find(o => o === value);
    return option === undefined ? { hint: `Reply with a number from 1 to ${notice.options.length} or an exact option.` } : { rest, body: { value: option } };
  }
  if (notice.method === "confirm") {
    if (/^(y|yes)$/i.test(value)) return { rest, body: { confirmed: true } };
    if (/^(n|no)$/i.test(value)) return { rest, body: { confirmed: false } };
    return { hint: "Reply yes or no." };
  }
  return value ? { rest, body: { value: text } } : { hint: "Reply with the text to enter." };
}

// transport: { send(content, { replyTo }) → { id }, react(messageId, emoji), recent() → newest DMs first, start(), stop() }
// post(sessionId, rest, body) → { status, body }: the same session routes the browser uses, through workspaced.
export function createNotifier({ userId, baseUrl, transport, post, titleOf = () => null, agentOf = () => null, delayMs = QUESTION_DELAY_MS, timers = globalThis, log = console.log }) {
  const waiting = new Map(); // `${sessionId}:${requestId}` → timer; a question not yet DMed
  const asked = new Map(); // questions already DMed and still open → notice
  const notices = new Map(); // DM message id → notice
  // sessionId → text of the assistant message streaming now, for sessions that DM their turn ends; null after a stream gap
  const replies = new Map();
  // Sessions whose latest user message came from a DM; lost on restart until the owner's next DM.
  const viaDiscord = new Set();
  const fail = what => e => log(`pi-ez-web: Discord ${what} failed: ${e?.message || e}`);
  const dms = id => !!agentOf(id) || viaDiscord.has(id);

  // One queue for every message, so a notice's parts go out in order and are not interleaved with another's.
  let queue = Promise.resolve();
  const enqueue = fn => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };

  /** Sends each part, going on past a failed one; resolves to how many were sent. */
  const notify = (notice, parts) => enqueue(async () => {
    let sent = 0;
    for (const [i, content] of parts.entries()) {
      try {
        const msg = await transport.send(content);
        sent++;
        if (!msg?.id) continue;
        notices.set(msg.id, notice);
        if (notices.size > KEEP_NOTICES) notices.delete(notices.keys().next().value);
      } catch (e) { fail(`message (part ${i + 1} of ${parts.length})`)(e); }
    }
    return sent;
  });

  function ask(sessionId, request, retry = true) {
    const key = `${sessionId}:${request.requestId}`;
    waiting.delete(key);
    const notice = { kind: "question", sessionId, requestId: request.requestId, method: request.method, options: (request.options || []).map(String) };
    asked.set(key, notice);
    const content = questionText({ title: titleOf(sessionId), agent: agentOf(sessionId), request, link: sessionLink(baseUrl, sessionId) });
    notify(notice, [content]).then(sent => {
      if (sent || !asked.delete(key)) return; // sent, or answered meanwhile
      // An agent run has no browser to replay the question, so try once more before giving up.
      if (retry) waiting.set(key, timers.setTimeout(() => ask(sessionId, request, false), RETRY_MS));
    });
  }

  function event(sessionId, type, data = {}) {
    try {
      if (!sessionId) return;
      if (type === "extension_ui_request" && METHODS.has(data.method) && data.requestId) {
        const key = `${sessionId}:${data.requestId}`;
        if (waiting.has(key) || asked.has(key)) return; // a replay (browser reload) of a question we know
        if (agentOf(sessionId)) return ask(sessionId, data);
        const timer = timers.setTimeout(() => ask(sessionId, data), delayMs);
        timer?.unref?.();
        waiting.set(key, timer);
      } else if (type === "extension_ui_resolved" && data.requestId) {
        const key = `${sessionId}:${data.requestId}`;
        timers.clearTimeout(waiting.get(key));
        waiting.delete(key);
        asked.delete(key);
      } else if (type === "user_record") {
        if (String(data.clientMessageId || "").startsWith(VIA)) viaDiscord.add(sessionId);
        else viaDiscord.delete(sessionId);
      } else if (type === "message_start") {
        // Each assistant message replaces the last: only the turn's final one is sent.
        if (data.role === "assistant" && dms(sessionId)) replies.set(sessionId, "");
        else replies.delete(sessionId);
      } else if (type === "events_resync") {
        // Events were missed: a reply with a hole in it is worse than the short "finished" notice.
        if (replies.has(sessionId)) replies.set(sessionId, null);
      } else if (type === "text_delta" && typeof replies.get(sessionId) === "string") {
        replies.set(sessionId, replies.get(sessionId) + (data.delta || ""));
      } else if (type === "turn_end") {
        const text = replies.get(sessionId);
        replies.delete(sessionId);
        if ((data.reason !== "done" && data.reason !== "errored") || !dms(sessionId)) return;
        const parts = turnEndText({ title: titleOf(sessionId), agent: agentOf(sessionId), reason: data.reason, error: data.error, text, link: sessionLink(baseUrl, sessionId) });
        notify({ kind: "turn", sessionId }, parts);
      }
    } catch (e) { fail("event")(e); }
  }

  const botLink = m => m?.author?.bot ? linkedSession(m.content, baseUrl) : null;
  /** The newest bot message with a link, from the DM history (newest first), at or before message `from` if given. */
  async function linkFrom(from) {
    let found = !from;
    for (const m of await transport.recent() || []) {
      if (m.id === from) { if (!m.author?.bot) return null; found = true; }
      const link = found && botLink(m);
      if (link) return { ...link, id: m.id };
    }
    return null;
  }
  const openQuestion = sessionId => [...asked.values()].findLast(n => n.sessionId === sessionId) || null;

  const answer = (message, text) => enqueue(() => transport.send(text, { replyTo: message.id })).catch(fail("reply"));

  async function handleMessage(message) {
    try {
      if (!message || message.guild_id || message.author?.bot || message.author?.id !== userId) return;
      const ref = message.message_reference?.message_id;
      let notice = ref ? notices.get(ref) : null;
      // A reply goes to its message's session, anything else to the session last DMed about.
      // A reply to a continuation part goes to the nearest earlier header.
      const replied = ref && botLink(message.referenced_message);
      const link = notice ? null : replied ? { ...replied, id: ref } : await linkFrom(ref);
      const sessionId = notice?.sessionId ?? link?.sessionId;
      if (!sessionId) return answer(message, ref ? "That message is not about a session." : "There is no session to send that to.");
      // Its notice was lost in a restart: the answer would land in the session as a chat message.
      if (link?.kind === "question" && link.id === ref) return answer(message, `That question can no longer be answered from Discord: ${sessionLink(baseUrl, sessionId)}`);
      if (notice?.kind !== "question") notice = openQuestion(sessionId) || { kind: "turn", sessionId };
      const action = replyAction(notice, String(message.content || ""));
      if (action.hint) return answer(message, action.hint);
      const body = notice.kind === "turn" ? { ...action.body, clientMessageId: `${VIA}${message.id}` } : action.body;
      const res = await post(sessionId, action.rest, body);
      if (res.status < 300) return transport.react(message.id, "✅").catch(fail("reaction"));
      if (res.status === 404 && notice.kind === "turn") return answer(message, "That session no longer exists.");
      if (notice.kind === "question" && res.status === 409) return answer(message, "That question was already answered.");
      return answer(message, `Could not deliver that (${res.body?.error || res.status}).`);
    } catch (e) {
      fail("reply")(e);
      if (message?.id) answer(message, "Could not deliver that: the session's worker did not answer. Try again in a minute.");
    }
  }

  function stop() {
    for (const timer of waiting.values()) timers.clearTimeout(timer);
    waiting.clear();
  }

  return { event, handleMessage, stop };
}

/** null unless PI_WEB_DISCORD_TOKEN, PI_WEB_DISCORD_USER and PI_WEB_PUBLIC_URL are set. */
export function discordFromEnv(env, { post, titleOf, agentOf, log = console.log, transport = null } = {}) {
  const token = env.PI_WEB_DISCORD_TOKEN;
  const userId = env.PI_WEB_DISCORD_USER;
  if (!token || !userId) return null;
  // Replies are routed by the absolute links in the bot's messages.
  if (!env.PI_WEB_PUBLIC_URL) { log("pi-ez-web: Discord contact off: PI_WEB_PUBLIC_URL is not set"); return null; }
  let notifier = null;
  const t = transport || discordTransport({ token, userId, log, onMessage: m => notifier?.handleMessage(m) });
  notifier = createNotifier({ userId, baseUrl: env.PI_WEB_PUBLIC_URL, transport: t, post, titleOf, agentOf, log });
  t.start();
  log("pi-ez-web: Discord contact on");
  return { event: notifier.event, handleMessage: notifier.handleMessage, stop() { notifier.stop(); t.stop(); } };
}
