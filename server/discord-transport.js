// Discord REST v10 and gateway with Node's global fetch and WebSocket: one DM channel, DM messages in.
// Never logs the token or message contents.

const API = "https://discord.com/api/v10";
const DIRECT_MESSAGES = 1 << 12;
// Close codes a reconnect cannot fix (bad token, intents, version).
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
// Close codes after which the session cannot be resumed.
const NO_RESUME = new Set([4007, 4009]);

export function discordTransport({ token, userId, onMessage, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, timers = globalThis, random = Math.random, log = console.log, api = API }) {
  const headers = { authorization: `Bot ${token}`, "user-agent": "DiscordBot (https://github.com/bry-guy/pi-web, 1)", "content-type": "application/json" };
  const later = (fn, ms) => { const t = timers.setTimeout(fn, ms); t?.unref?.(); return t; };
  const sleep = ms => new Promise(r => later(r, ms));

  async function rest(method, route, body, retries = 3) {
    const res = await fetchImpl(`${api}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (res.status === 429 && retries > 0) {
      const wait = Number((await res.json().catch(() => ({}))).retry_after ?? res.headers?.get?.("retry-after") ?? 1);
      await sleep(Math.min(Number.isFinite(wait) ? wait : 1, 60) * 1000);
      return rest(method, route, body, retries - 1);
    }
    if (!res.ok) throw new Error(`${method} ${route.replace(/\d{5,}/g, ":id")} answered ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  let channel = null;
  function dmChannel() {
    channel ??= rest("POST", "/users/@me/channels", { recipient_id: userId }).then(c => c.id);
    channel.catch(() => { channel = null; });
    return channel;
  }

  async function send(content, { replyTo } = {}) {
    const id = await dmChannel();
    return rest("POST", `/channels/${id}/messages`, {
      content: content.length > 2000 ? `${content.slice(0, 1999)}…` : content,
      allowed_mentions: { parse: [] },
      ...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
    });
  }

  async function react(messageId, emoji) {
    await rest("PUT", `/channels/${await dmChannel()}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }

  // Newest first.
  async function recent(limit = 50) {
    return rest("GET", `/channels/${await dmChannel()}/messages?limit=${limit}`);
  }

  // Gateway
  let ws = null;
  let gatewayUrl = null;
  let resumeUrl = null;
  let sessionId = null;
  let seq = null;
  let beat = null;
  let acked = true;
  let retry = null;
  let attempt = 0;
  let stopped = false;

  const put = (socket, payload) => { if (socket.readyState === 1) socket.send(JSON.stringify(payload)); };
  const clearBeat = () => { timers.clearTimeout(beat); beat = null; };

  function schedule(resume, delay) {
    if (stopped) return;
    timers.clearTimeout(retry);
    retry = later(() => { retry = null; open(resume); }, delay ?? Math.min(1000 * 2 ** attempt++, 60_000));
  }

  async function open(resume) {
    if (stopped) return;
    try {
      if (!resume || !resumeUrl) gatewayUrl = (await rest("GET", "/gateway/bot")).url;
      if (stopped) return;
      const base = (resume && resumeUrl ? resumeUrl : gatewayUrl).replace(/\/+$/, "");
      const socket = new WebSocketImpl(`${base}/?v=10&encoding=json`);
      ws = socket;
      socket.addEventListener("message", e => { if (ws === socket) frame(socket, e.data, resume); });
      socket.addEventListener("close", e => { if (ws === socket) closed(e.code); });
      socket.addEventListener("error", () => {}); // a close event follows
    } catch (e) {
      log(`pi-ez-web: Discord gateway connect failed: ${e.message}`);
      schedule(false);
    }
  }

  // Drop this socket (its close event is ignored) and connect again.
  function reconnect(socket, resume, delay) {
    clearBeat();
    if (ws === socket) ws = null;
    try { socket.close(resume ? 4000 : 1000); } catch { /* already closed */ }
    schedule(resume && !!sessionId, delay);
  }

  function closed(code) {
    clearBeat();
    ws = null;
    if (stopped) return;
    if (FATAL.has(code)) return log(`pi-ez-web: Discord gateway closed with ${code}; Discord contact stops until restart`);
    if (NO_RESUME.has(code)) sessionId = null;
    log(`pi-ez-web: Discord gateway closed (${code}); reconnecting`);
    schedule(!!sessionId);
  }

  function heartbeat(socket, interval) {
    clearBeat();
    acked = true;
    const tick = () => {
      if (!acked) {
        log("pi-ez-web: Discord heartbeat not acknowledged; reconnecting");
        return reconnect(socket, true);
      }
      acked = false;
      put(socket, { op: 1, d: seq });
      beat = later(tick, interval);
    };
    beat = later(tick, Math.floor(interval * random()));
  }

  function frame(socket, data, resume) {
    let p;
    try { p = JSON.parse(String(data)); } catch { return; }
    if (p.s != null) seq = p.s;
    switch (p.op) {
      case 10:
        heartbeat(socket, p.d.heartbeat_interval);
        if (resume && sessionId) put(socket, { op: 6, d: { token, session_id: sessionId, seq } });
        else put(socket, { op: 2, d: { token, intents: DIRECT_MESSAGES, properties: { os: process.platform, browser: "pi-ez-web", device: "pi-ez-web" } } });
        break;
      case 11: acked = true; break;
      case 1: put(socket, { op: 1, d: seq }); break;
      case 7: reconnect(socket, true); break;
      case 9:
        if (!p.d) { sessionId = null; seq = null; }
        reconnect(socket, !!p.d, 1000 + Math.floor(random() * 4000));
        break;
      case 0:
        if (p.t === "READY") { sessionId = p.d.session_id; resumeUrl = p.d.resume_gateway_url || null; attempt = 0; }
        else if (p.t === "RESUMED") attempt = 0;
        else if (p.t === "MESSAGE_CREATE") {
          try { Promise.resolve(onMessage?.(p.d)).catch(() => {}); } catch { /* the notifier logs its own failures */ }
        }
        break;
    }
  }

  return {
    send, react, recent, rest,
    start() { stopped = false; open(false); },
    stop() {
      stopped = true;
      clearBeat();
      timers.clearTimeout(retry);
      const socket = ws;
      ws = null;
      try { socket?.close(1000); } catch { /* already closed */ }
    },
  };
}
