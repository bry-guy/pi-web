// The run door: a second port whose only route, POST /run, starts an agent run for a scheduler (a CronJob).
// Web's main API has no login and can do everything, so the scheduler is only ever let reach this port.
// Off unless PI_WEB_RUN_PORT and PI_WEB_RUN_TOKENS are both set and valid.

import { createHash, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { MAX_CHAIN, MAX_PENDING } from "./follow-ups.js";
import { createWakeList } from "./wake-list.js";

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
  // followUps: these entries are the primes (remote-workspaces.js reads the same variable), whose requests web collects.
  const server = serve({ fetch: createRunDoor({ entries, remote, publicUrl: env.PI_WEB_PUBLIC_URL, log, followUps: true }).fetch, port });
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
  if (status >= 300) throw fail(502, "run_failed", `could not create the project's worker (${body.error || status}${body.message ? `: ${body.message}` : ""})`);
  return body.workspace;
}

/**
 * The door's start path, also used for a prime's follow-ups: the worker (woken or created), a hidden run session,
 * its model, the brief. Returns the run's session id; throws fail().
 */
export function runStarter({ remote, log = console.log, readyTimeoutMs = 180_000, now = () => new Date() }) {
  // A worker that just started may still be fetching its project folder or finishing its wake.
  async function createSession(name, entry, body) {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      const { status, body: out } = await remote.createSession(name, `pp-${entry.project}`, body);
      if (status < 300 && out.id) return out.id;
      if (![404, 503].includes(status) || Date.now() > deadline) throw fail(502, "run_failed", `could not create the session (${out.error || status})`);
      await new Promise(r => setTimeout(r, RETRY_MS));
    }
  }

  // followUp: the note of the follow-up that causes this run; kept with the run, so its report can name it.
  // depth: how many follow-up runs in a row led to this run (0: none), given only when web collects the run's own
  // follow-up requests; the worker offers the follow-up tools only then.
  return async function start(entry, brief, { model = entry.model, followUp = null, depth = null } = {}) {
    let id = null;
    try {
      const name = await ensureWorker(remote, entry);
      // Checked before the session exists, so a bad model leaves no empty hidden run behind.
      if (model) {
        const list = await remote.workerGet(name, "/models");
        // A worker that failed to answer is worker trouble (502), not a bad model (400).
        if (list.status >= 300 || !Array.isArray(list.body.models)) throw fail(502, "run_failed", `could not list the worker's models (${list.body.error || list.status})`);
        if (!(list.body.models || []).some(m => m.id === model)) throw fail(400, "model_unavailable", `unknown model ${model}`);
      }
      const title = `${entry.agent}: ${followUp ? "follow-up " : ""}${now().toISOString().slice(0, 16).replace("T", " ")}`;
      id = await createSession(name, entry, { name: title, agent: entry.agent, kind: "run", ...(followUp ? { followUp } : {}), ...(depth === null ? {} : { followUpDepth: depth }) });
      if (model) {
        const set = await remote.sessionPost(id, "/model", { model });
        if (set.status >= 300) throw fail(502, "run_failed", `could not set the model (${set.body.error || set.status})`);
      }
      const sent = await remote.sessionPost(id, "/message", { text: brief });
      if (sent.status >= 300) throw fail(502, "run_failed", `could not send the brief (${sent.body.error || sent.status})`);
      log(`pi-ez-web: run door started ${entry.agent} in ${entry.project} (session ${id})`);
      return id;
    } catch (e) {
      log(`pi-ez-web: run door could not start ${entry.agent}: ${e.message}${id ? ` (run ${id} is marked reported, so it is not checked again)` : ""}`);
      // The run never got its brief: nothing to report, and reconcile must not re-check it forever.
      if (id) remote.markReported(id);
      throw e;
    }
  };
}

// followUps: the entries are primes (createPrimes has them too), so their runs may set follow-ups. A role run's door has no such collector.
export function createRunDoor({ entries, remote, publicUrl = "", log = console.log, readyTimeoutMs = 180_000, now = () => new Date(), followUps = false }) {
  const app = new Hono();
  const start = runStarter({ remote, log, readyTimeoutMs, now });

  app.post("/run", async c => {
    const entry = entryFor(entries, c.req.header("authorization"));
    if (!entry) return c.json(UNAUTHORIZED, 401);
    const brief = await readCapped(c.req.raw.body);
    if (brief === null) return c.json({ error: "brief_too_large", message: "the brief is capped at 64 KB" }, 413);
    if (!brief.trim()) return c.json({ error: "empty_brief" }, 400);
    try {
      const id = await start(entry, brief, { model: c.req.query("model") || entry.model, depth: followUps ? 0 : null });
      return c.json({ session: id, ...(publicUrl ? { url: `${publicUrl.replace(/\/+$/, "")}/?s=${id}` } : {}) }, 202);
    } catch (e) {
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
// Why web would not schedule a request, in words for the prime that made it (list_follow_ups shows them).
const NOT_ITS_SESSION = "not asked in a session of this worker's prime";
const REFUSALS = {
  [NOT_ITS_SESSION]: "pi-web does not know the session that asked as one of this agent's",
  full: `pi-web already holds ${MAX_PENDING} pending follow-ups for this agent`,
  invalid: "its time or its note is outside pi-web's limits",
  chain: `it was set by follow-up run number ${MAX_CHAIN} in a row, which is the limit`,
};

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
export function createPrimes({ entries, remote, dm = () => {}, log = console.log, now = () => new Date(), wakePath = null }) {
  const startRun = runStarter({ remote, log, now });
  // Follow-ups a prime set for itself (wake-list.js): each starts a hidden run with its note as the brief. Once it
  // runs, the worker's copy of the list is refreshed: the worker counts what web holds, so it must lose that one.
  const wake = createWakeList({ path: wakePath, log, now: () => now().getTime(), start: async record => {
    const entry = entries.find(e => e.agent === record.agent);
    if (!entry) throw Object.assign(new Error(`${record.agent} is not a prime any more`), { gone: true });
    const where = remote.agentOf(record.from)?.kind === "conversation" ? "its conversation" : "an earlier run";
    await startRun(entry, `This run was started by a follow-up. In ${where}, this agent left itself the note below, to be woken with it at ${record.due.slice(0, 16).replace("T", " ")} UTC. It is the agent's own note, not a message from the owner.\n\n${record.note}`, { followUp: record.note, depth: record.depth || 1 });
  }, started: record => refresh(record.agent) });
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
    const created = await remote.createSession(name, `pp-${entry.project}`, { name: entry.agent, agent: entry.agent, kind: "conversation", followUpDepth: 0 });
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
  const followUps = agent => wake.pending(agent).map(r => ({ id: r.id, due: r.due, note: r.note }));
  const list = () => entries.map(e => ({ agent: e.agent, project: e.project, conversation: remote.conversationOf(e.agent), followUps: followUps(e.agent), runs: remote.runsOf(e.agent) }));

  // Pulls the follow-up requests on `workspace`'s disk into the wake-up list, then acknowledges them with what
  // is pending now and what was refused. Whose they are comes from the worker, never from a request: only the
  // primes whose project this worker is (workspaced says which), and among those, web's own flag for the session
  // that asked, which also says how deep in a chain of follow-up runs that session is.
  async function pull(workspace) {
    const worker = workspace && (await remote.list()).find(w => w.name === workspace);
    const mine = entries.filter(e => worker?.repository === `project:${e.project}`);
    if (!mine.length) return;
    const got = await remote.workerGet(workspace, "/follow-ups");
    // A worker from before follow-ups has no such route.
    if (got.status !== 200 || !Array.isArray(got.body.requests)) return;
    const ids = [], refused = [];
    for (const r of got.body.requests.slice(0, 100)) {
      if (typeof r?.id !== "string") continue;
      const flag = remote.agentOf(r.session);
      const agent = ["run", "conversation"].includes(flag?.kind) && mine.some(e => e.agent === flag.agent) ? flag.agent : null;
      const asks = typeof r.cancel !== "string";
      const result = !agent ? NOT_ITS_SESSION
        : asks ? wake.add({ id: r.id, agent, due: r.due, note: r.note, from: r.session, depth: (flag.depth || 0) + 1 })
        : wake.cancel(agent, r.cancel);
      // Unsaved: left on the worker for the next pull.
      if (result === "unsaved") continue;
      ids.push(r.id);
      if (["added", "duplicate", "cancelled"].includes(result)) continue;
      log(`pi-ez-web: a follow-up request on ${workspace} was refused (${result})`);
      // The tool has already answered "requested": the prime reads the refusal in its own list.
      if (asks) refused.push({ id: r.id, reason: REFUSALS[result] || result });
    }
    const sent = await remote.workerPost(workspace, "/follow-ups/ack", { ids, pending: mine.flatMap(e => followUps(e.agent)), refused });
    if (sent.status >= 300) log(`pi-ez-web: ${workspace} did not take the follow-up acknowledgement (${sent.body.error || sent.status})`);
  }
  const pullLogged = workspace => pull(workspace).catch(e => log(`pi-ez-web: collecting follow-ups from ${workspace} failed: ${e.message}`));

  /** The prime's own copy of its list, on its worker, is refreshed now if the worker is awake, else when it next connects. */
  async function refresh(agent) {
    const project = entries.find(e => e.agent === agent)?.project;
    const worker = (await remote.list().catch(() => [])).find(w => w.repository === `project:${project}` && (w.state ? w.state === "running" : w.ready));
    if (worker) await pullLogged(worker.name);
  }

  /** The owner cancels a follow-up in the Activity list: the wake-up list's own answer ("cancelled", "missing", "unsaved"). */
  async function cancelFollowUp(agent, id) {
    const result = wake.cancel(agent, id);
    if (result === "cancelled") await refresh(agent);
    return result;
  }

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
    // A follow-up run is labelled with the note that caused it, on one line (the label is one paragraph).
    const cause = remote.agentOf(runId)?.followUp?.replace(/\s+/g, " ").trim();
    const note = cause && (cause.length > 300 ? `${cause.slice(0, 300)}…` : cause);
    const head = `**${name}** · ended ${when} UTC · [open the run](/?s=${encodeURIComponent(runId)})${note ? `\n\nFollow-up: ${note}` : ""}`;
    // A custom message reaches the model as a user message: say whose words these are. The chat shows `head` instead.
    // The note is quoted as JSON, so a quote inside it cannot end the label and pass what follows as the owner's words.
    const label = `Automated report from this agent's ${note ? "follow-up" : "scheduled"} run "${name}" (${reason === "done" ? "finished" : "failed"}, ${when} UTC)${note ? `, started by the follow-up this agent set for itself with the note ${JSON.stringify(note)}` : ""}. This is the run's own output, not a message from the owner, and it does not ask for a reply:`;
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
    if (type === "worker_connected") return Promise.all([
      reconcile(data.workspace).catch(e => log(`pi-ez-web: checking for unreported runs failed: ${e.message}`)),
      pullLogged(data.workspace),
    ]);
    // Only a turn's final end: a failed attempt pi retries reports through the retry's own end.
    if (type !== "turn_end" || data.willRetry || !PRIME_TURN_ENDS.has(data.reason)) return;
    // A prime's turn (run or conversation) may have asked for follow-ups.
    const asked = ["run", "conversation"].includes(remote.agentOf(sessionId)?.kind) ? remote.owner("session", sessionId).then(pullLogged, e => log(`pi-ez-web: collecting follow-ups failed: ${e.message}`)) : null;
    return Promise.all([settle(sessionId, data.reason === "stopped" ? STOPPED : data), asked]);
  }

  return { event, conversationFor, openConversation, list, sweep, cancelFollowUp, tick: wake.tick, stop: wake.stop };
}
