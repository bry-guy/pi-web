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
// Same shape as the browser's own calls; only a JSON answer is needed back.
const asJson = { json: (body, status = 200) => ({ status, body }) };

/** The prime's project worker under its grant: woken, or created. */
export async function ensureWorker(remote, entry) {
  const existing = (await remote.list()).find(w => w.repository === `project:${entry.project}`);
  if (existing && (existing.grant || "default") !== entry.grant) throw fail(409, "grant_mismatch", `project ${entry.project} runs under another grant`);
  // A role's worker must be a sandbox: one of that name from before its grant was one is refused, never woken.
  if (existing && entry.provider && existing.provider !== entry.provider) throw fail(409, "provider_mismatch", `project ${entry.project} exists and is not an ${entry.provider} sandbox; remove that project first`);
  if (existing) {
    await remote.workspaceAction(existing.name, "wake");
    await remote.waitReady(existing.name);
    return existing.name;
  }
  const { status, body } = await remote.createProject(asJson, { project: entry.project, grant: entry.grant });
  if (status >= 300) throw fail(502, "run_failed", `could not create the project's worker (${body.error || status})`);
  return body.workspace;
}

export function createRunDoor({ entries, remote, publicUrl = "", log = console.log, readyTimeoutMs = 180_000, now = () => new Date() }) {
  const app = new Hono();
  const worker = entry => ensureWorker(remote, entry);

  // A worker that just started may still be fetching its project folder or finishing its wake.
  async function createSession(name, entry, title) {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const { status, body } = await remote.createSession(name, `pp-${entry.project}`, { name: title, agent: entry.agent, kind: "run" });
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
    let id = null;
    try {
      const name = await worker(entry);
      // Checked before the session exists, so a bad model leaves no empty hidden run behind.
      if (model) {
        const list = await remote.workerGet(name, "/models");
        // A worker that failed to answer is worker trouble (502), not a bad model (400).
        if (list.status >= 300 || !Array.isArray(list.body.models)) throw fail(502, "run_failed", `could not list the worker's models (${list.body.error || list.status})`);
        if (!(list.body.models || []).some(m => m.id === model)) throw fail(400, "model_unavailable", `unknown model ${model}`);
      }
      id = await createSession(name, entry, `${entry.agent}: ${now().toISOString().slice(0, 16).replace("T", " ")}`);
      if (model) {
        const set = await remote.sessionPost(id, "/model", { model });
        if (set.status >= 300) throw fail(502, "run_failed", `could not set the model (${set.body.error || set.status})`);
      }
      const sent = await remote.sessionPost(id, "/message", { text: brief });
      if (sent.status >= 300) throw fail(502, "run_failed", `could not send the brief (${sent.body.error || sent.status})`);
      log(`pi-ez-web: run door started ${entry.agent} in ${entry.project} (session ${id})`);
      return c.json({ session: id, ...(publicUrl ? { url: `${publicUrl.replace(/\/+$/, "")}/?s=${id}` } : {}) }, 202);
    } catch (e) {
      log(`pi-ez-web: run door could not start ${entry.agent}: ${e.message}${id ? ` (run ${id} is marked reported, so it is not checked again)` : ""}`);
      // The run never got its brief: nothing to report, and reconcile must not re-check it forever.
      if (id) remote.markReported(id);
      return c.json({ error: e.error || "run_failed", message: e.error ? e.message : `could not start the run${typeof e.code === "string" ? ` (${e.code})` : ""}` }, e.status || 502);
    }
  });
  app.notFound(c => c.json({ error: "not_found" }, 404));
  return app;
}

const PRIME_TURN_ENDS = new Set(["done", "errored", "stopped"]);
const STOPPED = { reason: "errored", error: "stopped before it finished" };
const RUN_RETENTION_MS = 30 * 24 * 3600_000;
const MAX_REPORT = 120 * 1024; // UTF-8 bytes; under the worker's 256 KB /note cap even if JSON escaping doubles it

/** `text` cut to MAX_REPORT UTF-8 bytes, never inside a character. */
function truncate(text) {
  const buf = Buffer.from(text);
  if (buf.length <= MAX_REPORT) return text;
  let end = MAX_REPORT;
  while ((buf[end] & 0xc0) === 0x80) end--; // a continuation byte: back up to the character's start
  return `${buf.subarray(0, end).toString("utf8")}\n\n…(truncated, open the run)`;
}

/** The last reply of a transcript's last turn, or "". */
export const finalReply = records => {
  const turn = (records || []).slice((records || []).findLastIndex(r => r.role === "user") + 1);
  return turn.findLast(r => r.role === "assistant" && r.text?.trim())?.text.trim() || "";
};

/**
 * Primes: each run-door agent has one visible conversation session; its runs stay out of the lists and
 * report into it. The conversation is created at the first report, on the run's worker, and recorded in
 * web's agent-sessions.json (kind "conversation"), so a restart finds it.
 */
export function createPrimes({ entries, remote, dm = () => {}, log = console.log, now = () => new Date() }) {
  const pending = new Map(); // agent → the conversation id being checked or created
  const reporting = new Map(); // run id → its report in flight, so a live turn end and a reconcile report once
  const entryOf = runId => {
    const flag = remote.agentOf(runId);
    return flag?.kind === "run" ? entries.find(e => e.agent === flag.agent) || null : null;
  };

  // runId: the run reporting (the conversation goes on its worker); null when the owner opens the prime first.
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
    const name = runId ? await remote.owner("session", runId) : await ensureWorker(remote, entry);
    if (!name) throw new Error(`no worker for run ${runId}`);
    const model = (runId && (await remote.sessionGet(runId, "/meta")).body?.model) || entry.model;
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
    return entry ? conversationOf(entry, runId) : Promise.resolve(null);
  }
  function conversationOf(entry, runId = null) {
    if (!pending.has(entry.agent)) pending.set(entry.agent, ensure(entry, runId).finally(() => pending.delete(entry.agent)));
    return pending.get(entry.agent);
  }
  /** The prime's conversation for the sidebar (created, with its worker, if needed), or null for an unknown agent. */
  function openConversation(agent) {
    const entry = entries.find(e => e.agent === agent);
    return entry ? conversationOf(entry) : Promise.resolve(null);
  }

  /** The sidebar's Primes section: each prime, its conversation (null until there is one) and its runs. */
  const list = () => entries.map(e => ({ agent: e.agent, project: e.project, conversation: remote.conversationOf(e.agent), runs: remote.runsOf(e.agent) }));

  // Deletes runs older than RUN_RETENTION_MS that are reported (so ended), on awake workers only: a sleeping
  // worker is skipped until the next sweep. Conversations and agent sessions are never runs, so never deleted.
  // reconcile() also deletes them, so a worker asleep at every sweep still loses its old runs.
  const oldRuns = () => {
    const cutoff = now().getTime() - RUN_RETENTION_MS;
    return remote.runIds().filter(id => remote.agentOf(id).reported && Date.parse(remote.agentOf(id).started) < cutoff);
  };
  async function deleteRun(id) {
    const res = await remote.sessionPost(id, "/delete", {});
    // Any other 404 (a worker without the route) keeps the run's flag, or it would list as a visible session.
    if (res.status < 300 || res.body?.error === "no_such_session") remote.markAgent(id, null);
    else log(`pi-ez-web: old run ${id} was not deleted (${res.body?.error || res.status})`);
  }
  async function sweep() {
    try {
      const old = oldRuns();
      if (!old.length) return;
      const awake = new Set((await remote.list()).filter(w => (w.state ? w.state === "running" : w.ready)).map(w => w.name));
      for (const id of old) if (awake.has(await remote.owner("session", id))) await deleteRun(id);
    } catch (e) { log(`pi-ez-web: deleting old runs failed: ${e.message}`); }
  }

  // Posts the report into the conversation and DMs it. Marked reported only once the note is stored; the DM is
  // recorded apart (`dmed`), so a later reconcile retries the note without DMing again.
  async function report(entry, runId, { reason, error }, transcript = null) {
    const [meta, t] = await Promise.all([
      remote.sessionGet(runId, "/meta"),
      reason === "done" ? transcript || remote.sessionGet(runId, "/transcript") : null,
    ]);
    // An unreadable transcript is not an empty run: leave it for the next reconcile.
    if (reason === "done" && (t?.status !== 200 || !Array.isArray(t.body?.records))) throw new Error(`its transcript could not be read (${t?.body?.error || t?.status})`);
    const text = reason === "done" ? finalReply(t.body.records) : "";
    const body = truncate(reason === "errored" ? `Failed: ${error || "unknown error"}` : text || "Finished with no reply.");
    const when = now().toISOString().slice(0, 16).replace("T", " ");
    const name = String(meta.body?.name || entry.agent).replace(/\s+/g, " ");
    const head = `**${name}** · ended ${when} UTC · [open the run](/?s=${encodeURIComponent(runId)})`;
    // A custom message reaches the model as a user message: say whose words these are. The chat shows `head` instead.
    const label = `Automated report from this agent's scheduled run "${name}" (${reason === "done" ? "finished" : "failed"}, ${when} UTC). This is the run's own output, not a message from the owner, and it does not ask for a reply:`;
    let target = runId;
    try {
      const id = await conversationFor(runId);
      const sent = await remote.sessionPost(id, "/note", { text: `${label}\n\n${body}`, details: { agent: entry.agent, run: runId, outcome: reason, head } });
      if (sent.status >= 300) throw new Error(`the conversation refused it (${sent.body.error || sent.status})`);
      target = id;
      remote.markReported(runId, "reported", reason);
    } catch (e) { log(`pi-ez-web: ${entry.agent}'s run ${runId} was not reported: ${e.message}`); }
    if (remote.agentOf(runId)?.dmed) return;
    remote.markReported(runId, "dmed");
    await dm(runId, { reason, error, text, target });
  }

  function settle(runId, outcome, transcript) {
    const entry = entryOf(runId);
    if (!entry || remote.agentOf(runId).reported || reporting.has(runId)) return reporting.get(runId);
    const done = report(entry, runId, outcome, transcript)
      .catch(e => log(`pi-ez-web: ${entry.agent}'s run ${runId} was not reported: ${e.message}`))
      .finally(() => reporting.delete(runId));
    reporting.set(runId, done);
    return done;
  }

  // Workers keep no event backlog: a run that ended while web was down or not listening is found here.
  // Only runs on `workspace`, which just connected (so is running: nothing here wakes a worker), one read each.
  async function reconcile(workspace) {
    for (const id of remote.unreportedRuns()) {
      if (reporting.has(id) || await remote.owner("session", id) !== workspace) continue;
      const t = await remote.sessionGet(id, "/transcript").catch(() => null);
      // Still running (the live turn_end reports it), unreadable, or no brief yet: next time.
      if (t?.status !== 200 || t.body.streaming || !Array.isArray(t.body.records)) continue;
      const records = t.body.records;
      const brief = records.findLastIndex(r => r.role === "user");
      const last = brief < 0 ? null : records.slice(brief + 1).findLast(r => ["assistant", "error", "tool"].includes(r.role));
      // A brief with nothing after it, and the turn over: the run ended (or was stopped) with no reply.
      if (brief < 0) continue;
      log(`pi-ez-web: run ${id} ended while web was not listening; reporting it now`);
      // A turn that ends in a tool call never got its final reply: the worker stopped mid-turn.
      const outcome = !last ? { reason: "done" }
        : last.role === "error" ? { reason: "errored", error: last.text }
        : last.role === "tool" || last.toolIds?.length ? { reason: "errored", error: "interrupted: the worker stopped before the run finished" }
        : { reason: "done" };
      await settle(id, outcome, t);
    }
    for (const id of oldRuns()) if (await remote.owner("session", id) === workspace) await deleteRun(id);
  }

  function event(sessionId, type, data = {}) {
    // Returns the work it started (for tests); callers need not wait.
    if (type === "worker_connected") return reconcile(data.workspace).catch(e => log(`pi-ez-web: checking for unreported runs failed: ${e.message}`));
    // Only a turn's final end: a failed attempt pi retries reports through the retry's own end.
    if (type !== "turn_end" || data.willRetry || !PRIME_TURN_ENDS.has(data.reason)) return;
    return settle(sessionId, data.reason === "stopped" ? STOPPED : data);
  }

  return { event, conversationFor, openConversation, list, sweep };
}
