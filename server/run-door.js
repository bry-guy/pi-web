// The run door: a second port whose only route, POST /run, starts an agent run for a scheduler (a CronJob).
// Web's main API has no login and can do everything, so the scheduler is only ever let reach this port.
// Off unless PI_WEB_RUN_PORT and PI_WEB_RUN_TOKENS are both set and valid.

import { createHash, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const MAX_BRIEF = 64 * 1024;
const RETRY_MS = 2_000;
const UNAUTHORIZED = { error: "unauthorized" };

/** The door's entries, or null (with a reason) when it is off. */
export function runDoorConfig(env) {
  const port = env.PI_WEB_RUN_PORT, raw = env.PI_WEB_RUN_TOKENS;
  if (!port && !raw) return { entries: null };
  if (!port || !raw) return { entries: null, error: "PI_WEB_RUN_PORT and PI_WEB_RUN_TOKENS must both be set" };
  if (!/^\d+$/.test(port) || Number(port) > 65535) return { entries: null, error: "PI_WEB_RUN_PORT is not a port number" };
  let entries;
  try { entries = JSON.parse(raw); } catch { return { entries: null, error: "PI_WEB_RUN_TOKENS is not valid JSON" }; }
  const text = v => typeof v === "string" && v.trim() !== "";
  if (!Array.isArray(entries) || !entries.length) return { entries: null, error: "PI_WEB_RUN_TOKENS must be a non-empty array" };
  const bad = entries.findIndex(e => !e || !text(e.agent) || !text(e.project) || !text(e.grant) || !/^[0-9a-f]{64}$/i.test(e.sha256 ?? "") || (e.model !== undefined && !text(e.model)));
  if (bad >= 0) return { entries: null, error: `PI_WEB_RUN_TOKENS entry ${bad} needs agent, project, grant and a 64-hex sha256 (model, if given, a model id)` };
  return { port: Number(port), entries: entries.map(e => ({ agent: e.agent.trim(), project: e.project.trim(), grant: e.grant.trim(), model: e.model?.trim() || null, hash: Buffer.from(e.sha256, "hex") })) };
}

export function runDoorFromEnv(env, remote, { log = console.log } = {}) {
  const { port, entries, error } = runDoorConfig(env);
  if (error) log(`pi-ez-web: run door off: ${error}`);
  if (!entries) return null;
  const server = serve({ fetch: createRunDoor({ entries, remote, publicUrl: env.PI_WEB_PUBLIC_URL, log }).fetch, port });
  server.unref();
  server.on("error", e => log(`pi-ez-web: run door could not listen on ${port}: ${e.message}`));
  server.once("listening", () => log(`pi-ez-web: run door on port ${port}`));
  return server;
}

function entryFor(entries, header) {
  const token = /^Bearer (\S+)$/.exec(header || "")?.[1];
  if (!token) return null;
  const hash = createHash("sha256").update(token).digest();
  let found = null;
  for (const e of entries) if (timingSafeEqual(hash, e.hash) && !found) found = e;
  return found;
}

async function readCapped(stream) {
  const chunks = [];
  let size = 0;
  if (stream) for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_BRIEF) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const fail = (status, error, message) => Object.assign(new Error(message), { status, error });

export function createRunDoor({ entries, remote, publicUrl = "", log = console.log, readyTimeoutMs = 180_000, now = () => new Date() }) {
  const app = new Hono();
  // Same shape as the browser's own calls; only a JSON answer is needed back.
  const asJson = { json: (body, status = 200) => ({ status, body }) };

  async function worker(entry) {
    const existing = (await remote.list()).find(w => w.repository === `project:${entry.project}`);
    if (existing && (existing.grant || "default") !== entry.grant) throw fail(409, "grant_mismatch", `project ${entry.project} runs under another grant`);
    if (existing) {
      await remote.workspaceAction(existing.name, "wake");
      await remote.waitReady(existing.name);
      return existing.name;
    }
    const { status, body } = await remote.createProject(asJson, { project: entry.project, grant: entry.grant });
    if (status >= 300) throw fail(502, "run_failed", `could not create the project's worker (${body.error || status})`);
    return body.workspace;
  }

  // A worker that just started may still be fetching its project folder or finishing its wake.
  async function createSession(name, entry, title) {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const { status, body } = await remote.createSession(name, `pp-${entry.project}`, { name: title, agent: entry.agent });
      if (status < 300 && body.id) return body.id;
      if (![404, 503].includes(status) || Date.now() > deadline) throw fail(502, "run_failed", `could not create the session (${body.error || status})`);
      await new Promise(r => setTimeout(r, RETRY_MS));
    }
  }

  app.post("/run", async c => {
    const entry = entryFor(entries, c.req.header("authorization"));
    if (!entry) return c.json(UNAUTHORIZED, 401);
    const brief = await readCapped(c.req.raw.body);
    if (brief === null) return c.json({ error: "brief_too_large", message: "the brief is capped at 64 KB" }, 413);
    if (!brief.trim()) return c.json({ error: "empty_brief" }, 400);
    const model = c.req.query("model") || entry.model;
    try {
      const name = await worker(entry);
      const id = await createSession(name, entry, `${entry.agent}: ${now().toISOString().slice(0, 16).replace("T", " ")}`);
      if (model) {
        const set = await remote.sessionPost(id, "/model", { model });
        if (set.status === 400) throw fail(400, set.body.error || "model_unavailable", `unknown model ${model}`);
        if (set.status >= 300) throw fail(502, "run_failed", `could not set the model (${set.body.error || set.status})`);
      }
      const sent = await remote.sessionPost(id, "/message", { text: brief });
      if (sent.status >= 300) throw fail(502, "run_failed", `could not send the brief (${sent.body.error || sent.status})`);
      log(`pi-ez-web: run door started ${entry.agent} in ${entry.project} (session ${id})`);
      return c.json({ session: id, ...(publicUrl ? { url: `${publicUrl.replace(/\/+$/, "")}/?s=${id}` } : {}) }, 202);
    } catch (e) {
      log(`pi-ez-web: run door could not start ${entry.agent}: ${e.message}`);
      return c.json({ error: e.error || "run_failed", message: e.error ? e.message : `could not start the run${typeof e.code === "string" ? ` (${e.code})` : ""}` }, e.status || 502);
    }
  });
  app.notFound(c => c.json({ error: "not_found" }, 404));
  return app;
}

const PRIME_TURN_ENDS = new Set(["done", "errored"]);

/** The last reply of a transcript's last turn, or "". */
const finalReply = records => {
  const turn = (records || []).slice((records || []).findLastIndex(r => r.role === "user") + 1);
  return turn.findLast(r => r.role === "assistant" && r.text?.trim())?.text.trim() || "";
};

/**
 * Primes: each run-door agent has one visible conversation session; its runs stay out of the lists and
 * report into it. The conversation is created at the first report, on the run's worker, and recorded in
 * web's agent-sessions.json (kind "conversation"), so a restart finds it.
 */
export function createPrimes({ entries, remote, log = console.log, now = () => new Date() }) {
  const pending = new Map(); // agent → the conversation id being checked or created
  const entryOf = runId => {
    const flag = remote.agentOf(runId);
    return flag?.kind === "run" ? entries.find(e => e.agent === flag.agent) || null : null;
  };

  async function ensure(entry, runId) {
    const known = remote.conversationOf(entry.agent);
    if (known) {
      const meta = await remote.sessionGet(known, "/meta");
      if (meta.status < 300) {
        // End idle may have archived it; restoring a live session does nothing.
        await remote.sessionPost(known, "/restore", {});
        return known;
      }
      if (meta.status !== 404) throw new Error(`conversation ${known} unavailable (${meta.body.error || meta.status})`);
    }
    // None yet, or its worker no longer knows it (a reset disk): a new one replaces it.
    const name = await remote.owner("session", runId);
    if (!name) throw new Error(`no worker for run ${runId}`);
    const model = (await remote.sessionGet(runId, "/meta")).body?.model || entry.model;
    const created = await remote.createSession(name, `pp-${entry.project}`, { name: entry.agent, agent: entry.agent, kind: "conversation" });
    if (created.status >= 300 || !created.body.id) throw new Error(`could not create the conversation (${created.body.error || created.status})`);
    if (known) remote.markAgent(known, null);
    if (model) {
      const set = await remote.sessionPost(created.body.id, "/model", { model });
      if (set.status >= 300) log(`pi-ez-web: ${entry.agent}'s conversation has no model (${set.body.error || set.status})`);
    }
    log(`pi-ez-web: ${entry.agent}'s conversation is ${created.body.id}`);
    return created.body.id;
  }

  /** The conversation a run reports into (created if needed), or null for a session that is not a prime's run. */
  function conversationFor(runId) {
    const entry = entryOf(runId);
    if (!entry) return Promise.resolve(null);
    if (!pending.has(entry.agent)) pending.set(entry.agent, ensure(entry, runId).finally(() => pending.delete(entry.agent)));
    return pending.get(entry.agent);
  }

  async function report(entry, runId, { reason, error }) {
    const [meta, transcript] = await Promise.all([
      remote.sessionGet(runId, "/meta"),
      reason === "done" ? remote.sessionGet(runId, "/transcript") : null,
    ]);
    const body = reason === "errored" ? `Failed: ${error || "unknown error"}` : finalReply(transcript?.body?.records) || "Finished with no reply.";
    const when = now().toISOString().slice(0, 16).replace("T", " ");
    const head = `**${meta.body?.name || entry.agent}** · ended ${when} UTC · [open the run](/?s=${encodeURIComponent(runId)})`;
    const id = await conversationFor(runId);
    const sent = await remote.sessionPost(id, "/note", { text: `${head}\n\n${body}`, details: { agent: entry.agent, run: runId, outcome: reason } });
    if (sent.status >= 300) throw new Error(`the conversation refused it (${sent.body.error || sent.status})`);
  }

  function event(sessionId, type, data = {}) {
    // Only a turn's final end: a failed attempt pi retries reports through the retry's own end.
    if (type !== "turn_end" || data.willRetry || !PRIME_TURN_ENDS.has(data.reason)) return;
    const entry = entryOf(sessionId);
    if (entry) report(entry, sessionId, data).catch(e => log(`pi-ez-web: ${entry.agent}'s run ${sessionId} was not reported: ${e.message}`));
  }

  return { event, conversationFor };
}
