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
export const sessionLink = (base, id) => base ? `${base.replace(/\/+$/, "")}/?s=${encodeURIComponent(id)}` : "";
// The link survives truncation: only the body is cut.
const compose = (body, link) => link ? `${truncate(body, LIMIT - link.length - 1)}\n${link}` : truncate(body);

const label = (title, agent) => `**${title || "A session"}**${agent ? ` (${agent})` : ""}`;

export function questionText({ title, agent, request, link }) {
  const lines = [`${label(title, agent)} needs an answer`];
  if (request.title) lines.push(String(request.title));
  if (request.method === "confirm" && request.message) lines.push(String(request.message));
  if (request.method === "select") (request.options || []).forEach((o, i) => lines.push(`${i + 1}. ${o}`));
  lines.push(request.method === "select" ? "_Reply with a number or an option._" : request.method === "confirm" ? "_Reply yes or no._" : "_Reply with your answer._");
  return compose(lines.join("\n"), link);
}

export function turnEndText({ title, agent, reason, error, link }) {
  return compose(reason === "errored" ? `${label(title, agent)} failed: ${error || "unknown error"}` : `${label(title, agent)} finished.`, link);
}

/** What a reply to `notice` does: a POST to the session ({ rest, body }) or a hint to send back. */
export function replyAction(notice, text) {
  const value = text.trim();
  if (notice.kind === "turn") return value ? { rest: "/message", body: { text: value } } : { hint: "Reply with a message for the session." };
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

// transport: { send(content, { replyTo }) → { id }, react(messageId, emoji), start(), stop() }
// post(sessionId, rest, body) → { status, body }: the same session routes the browser uses, through workspaced.
export function createNotifier({ userId, baseUrl = "", transport, post, titleOf = () => null, agentOf = () => null, delayMs = QUESTION_DELAY_MS, timers = globalThis, log = console.log }) {
  const waiting = new Map(); // `${sessionId}:${requestId}` → timer; a question not yet DMed
  const asked = new Set(); // questions already DMed and still open
  const notices = new Map(); // DM message id → notice
  let last = null;
  const fail = what => e => log(`pi-ez-web: Discord ${what} failed: ${e?.message || e}`);

  async function notify(notice, content) {
    const msg = await transport.send(content);
    if (!msg?.id) return;
    notices.set(msg.id, notice);
    if (notices.size > KEEP_NOTICES) notices.delete(notices.keys().next().value);
    last = notice;
  }

  function ask(sessionId, request, retry = true) {
    const key = `${sessionId}:${request.requestId}`;
    waiting.delete(key);
    asked.add(key);
    const notice = { kind: "question", sessionId, requestId: request.requestId, method: request.method, options: (request.options || []).map(String) };
    const content = questionText({ title: titleOf(sessionId), agent: agentOf(sessionId), request, link: sessionLink(baseUrl, sessionId) });
    notify(notice, content).catch(e => {
      fail("message")(e);
      if (!asked.delete(key)) return; // answered meanwhile
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
      } else if (type === "turn_end" && (data.reason === "done" || data.reason === "errored") && agentOf(sessionId)) {
        const content = turnEndText({ title: titleOf(sessionId), agent: agentOf(sessionId), reason: data.reason, error: data.error, link: sessionLink(baseUrl, sessionId) });
        notify({ kind: "turn", sessionId }, content).catch(fail("message"));
      }
    } catch (e) { fail("event")(e); }
  }

  const answer = (message, text) => transport.send(text, { replyTo: message.id }).catch(fail("reply"));

  async function handleMessage(message) {
    try {
      if (!message || message.guild_id || message.author?.bot || message.author?.id !== userId) return;
      const ref = message.message_reference?.message_id;
      const notice = ref ? notices.get(ref) : last;
      if (!notice) return answer(message, "Reply to one of my messages to answer it.");
      const action = replyAction(notice, String(message.content || ""));
      if (action.hint) return answer(message, action.hint);
      const res = await post(notice.sessionId, action.rest, action.body);
      if (res.status < 300) return transport.react(message.id, "✅").catch(fail("reaction"));
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

/** null unless both PI_WEB_DISCORD_TOKEN and PI_WEB_DISCORD_USER are set. */
export function discordFromEnv(env, { post, titleOf, agentOf, log = console.log, transport = null } = {}) {
  const token = env.PI_WEB_DISCORD_TOKEN;
  const userId = env.PI_WEB_DISCORD_USER;
  if (!token || !userId) return null;
  let notifier = null;
  const t = transport || discordTransport({ token, userId, log, onMessage: m => notifier?.handleMessage(m) });
  notifier = createNotifier({ userId, baseUrl: env.PI_WEB_PUBLIC_URL || "", transport: t, post, titleOf, agentOf, log });
  t.start();
  log("pi-ez-web: Discord contact on");
  return { event: notifier.event, handleMessage: notifier.handleMessage, stop() { notifier.stop(); t.stop(); } };
}
