// Web side of role_agent (role-runner.js is the worker side). A project session asks for a role run with an event
// on its worker's stream. Web decides whether that project may use the role, starts a hidden run on the role's own
// sandboxed worker, and posts the run's final reply back to the calling session. A request that names an earlier
// run (`run`) is a follow-up: its message goes to that run's session, on the same worker, as the next turn.
//
// The role's worker is a project worker like any other: project "<calling project>-<grant name>", under a grant
// in workspaced's grants that names the role, is an OpenShell sandbox and lists that project in `repos`. So what a
// project may hand to which role is decided where grants are (deploy), and workspaced checks it again.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRunDoor, ensureWorker, finalReply } from "./run-door.js";

const ENDS = new Set(["done", "errored", "stopped"]);
const MAX_REPLY = 6000; // characters, as pi-projects cuts a laptop run's reply
const GIVE_UP_MS = 24 * 3600_000;

export function createRoleRuns({ remote, path = null, log = console.log, now = Date.now }) {
  // Runs started and not yet delivered: run session id → { parent, request, role, at, result?, turns? }. Kept on disk,
  // so a run that ends while web is down is delivered when web next connects to its worker. `turns`: a follow-up's
  // count of the messages the run had before it.
  let open = {};
  try { open = path ? JSON.parse(readFileSync(path, "utf8")) : {}; } catch { open = {}; }
  function save() {
    if (!path) return;
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(open), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch (e) { log(`pi-ez-web: could not save open role runs: ${e.message}`); }
  }
  const delivering = new Set();
  const stopped = new Set(); // requests aborted before their run existed
  const answer = (session, body) => remote.sessionPost(session, "/role-run", body);
  const forget = run => { remote.markReported(run); delete open[run]; save(); };

  /** The role worker's project and grant for `role` asked from `session`; throws the refusal. */
  async function target(session, role) {
    // The project is the calling worker's own, never something the request says.
    const name = await remote.owner("session", session);
    const worker = name ? (await remote.list()).find(w => w.name === name) : null;
    const project = worker?.repository?.startsWith("project:") ? worker.repository.slice(8) : null;
    if (!project) throw new Error("role_agent needs a pi project session");
    const all = await remote.grants();
    if (all.find(g => g.name === (worker.grant || "default"))?.role) throw new Error("a role run cannot start another role run");
    const usable = all.filter(g => g.role && g.provider === "openshell" && g.repos?.includes(`project:${project}-${g.name}`));
    const grant = usable.find(g => g.role === role);
    if (!grant) throw new Error(`${role} is not granted to ${project} on pi-web${usable.length ? ` (granted: ${usable.map(g => g.role).join(", ")})` : ""}. Role grants are in pi-web's deploy/k8s/workspaced/grants.json.`);
    return { project: `${project}-${grant.name}`, grant: grant.name };
  }

  /**
   * Sends `msg` to the earlier run `id` as its next message, and returns how many messages it had before. Throws
   * the refusal. `entry` is the role's worker for the calling project (target).
   */
  async function followUp(entry, role, id, msg) {
    // Both from web's own files, never from a worker: agent-sessions.json says whose run this is and on which
    // worker web created it; workspaced says which worker is this project's for the role.
    const flag = typeof id === "string" && id ? remote.agentOf(id) : null;
    const worker = (await remote.list()).find(w => w.repository === `project:${entry.project}`);
    if (flag?.kind !== "run" || flag.agent !== role || !worker || flag.worker !== worker.name) {
      throw new Error(flag || (typeof id === "string" && await remote.owner("session", id)) ? `it is not a run of ${role} in this project` : "that run cannot be found");
    }
    if (open[id]) throw new Error(`${role} is still running there${open[id].result ? " (its last result has not reached its caller yet)" : ""}`);
    // Refuses a worker that is no longer this grant's sandbox, and wakes it.
    await ensureWorker(remote, { ...entry, provider: "openshell" });
    const at = `/sessions/${encodeURIComponent(id)}`;
    const t = await remote.workerGet(worker.name, `${at}/transcript`);
    if (t.status === 404) throw new Error("that run cannot be found on its worker");
    if (t.status !== 200 || !Array.isArray(t.body?.records)) throw new Error(`the run could not be read (${t.body?.error || t.status})`);
    if (t.body.streaming) throw new Error(`${role} is still running there`);
    // To the worker web created the run on, whichever worker claims the session now.
    const sent = await remote.workerPost(worker.name, `${at}/message`, { text: msg });
    if (sent.status >= 300) throw new Error(sent.body?.error === "session_busy" ? `${role} is still running there` : `could not send the message (${sent.body?.error || sent.status})`);
    return t.body.records.filter(r => r.role === "user").length;
  }

  async function start(session, { request, role, msg, name, cwd, run: earlier }) {
    if (![request, role, msg].every(v => typeof v === "string" && v)) return;
    // First, so the caller knows web heard it; creating a worker can take minutes.
    await answer(session, { request, state: "accepted" });
    const again = earlier !== undefined;
    let run = null;
    try {
      const entry = await target(session, role);
      let id = earlier, turns = 0;
      {
        const model = (await remote.sessionGet(session, "/meta")).body?.model || null;
        const brief = cwd && cwd !== "." ? `${msg}\n\n(The caller asked for ${cwd}. This run starts in the project folder of a separate worker with its own disk.)` : msg;
        // The run door's own handler does the rest (wake or create the worker, hidden run session, model, brief).
        // The token only lets this one call through the door's check.
        const token = randomBytes(24).toString("hex");
        const door = createRunDoor({ entries: [{ agent: role, ...entry, provider: "openshell", model, hash: createHash("sha256").update(token).digest() }], remote, log });
        const res = await door.fetch(new Request("http://role-runs/run", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: brief }));
        const out = await res.json().catch(() => ({}));
        if (res.status !== 202 || !out.session) throw new Error(out.message || out.error || `status ${res.status}`);
        id = out.session;
      }
      if (stopped.delete(request)) {
        remote.markReported(id);
        await remote.sessionPost(id, "/stop", {});
        return;
      }
      open[id] = { parent: session, request, role, at: now(), ...(again ? { turns } : {}) };
      save();
      // The door titles a run by its time; a role run is known by its task.
      if (!again && typeof name === "string" && name.trim()) await remote.sessionPost(id, "/name", { name: name.trim().slice(0, 120) }).catch(() => {});
      run = id;
    } catch (e) {
      stopped.delete(request);
      log(`pi-ez-web: role run ${role} for session ${session} was not ${again ? "sent a follow-up" : "started"}: ${e.message}`);
      await answer(session, { request, state: "failed", message: `${again ? `Can't follow up on ${earlier}` : `Can't start ${role}`}: ${e.message}` });
      return;
    }
    // Outside the try: the run is live, so a lost "started" must not read as "Can't start" (a retry would run it twice).
    await answer(session, { request, state: "started", run }).catch(e => log(`pi-ez-web: role run ${run} (${role}) started, but its caller was not told: ${e.message}`));
    // Its turn may have ended before it was recorded here.
    await check(run);
  }

  async function stop(request) {
    const run = Object.keys(open).find(id => open[id].request === request);
    if (!run) { stopped.add(request); return; }
    // The caller gave up waiting: nothing is delivered.
    forget(run);
    await remote.sessionPost(run, "/stop", {});
  }

  async function deliver(run, { reason, error } = {}, transcript = null) {
    const o = open[run];
    if (!o || delivering.has(run)) return;
    delivering.add(run);
    try {
      if (!o.result) {
        let reply = "";
        if (reason === "done") {
          const t = transcript || await remote.sessionGet(run, "/transcript");
          // An unreadable transcript is not an empty run: try again at the next connect.
          if (t.status !== 200 || !Array.isArray(t.body?.records)) throw new Error(`its transcript could not be read (${t.body?.error || t.status})`);
          reply = finalReply(t.body.records);
        }
        if (reply.length > MAX_REPLY) reply = `…${reply.slice(-MAX_REPLY)}`;
        const status = reason === "done" ? "done" : reason === "stopped" ? "stopped" : "error";
        // Kept with the open run, so the calling worker's next connect can retry without the role's worker.
        o.result = { status, text: `${o.role} run ${status} (run: ${run})${error ? `\nError: ${error}` : ""}\n\n${reply || "(no reply)"}` };
        save();
      }
      const { status, text } = o.result;
      const sent = await answer(o.parent, { request: o.request, state: "done", status, isError: status !== "done", text, role: o.role, run });
      if (sent.status >= 300) throw new Error(`the calling session did not take it (${sent.body?.error || sent.status})`);
      forget(run);
    } catch (e) {
      const old = now() - o.at > GIVE_UP_MS;
      log(`pi-ez-web: role run ${run} (${o.role}) was not delivered: ${e.message}${old ? "; given up after a day" : ""}`);
      if (old) forget(run);
    } finally { delivering.delete(run); }
  }

  // Reads a run's transcript and delivers it if its turn is over (the same reading as createPrimes' reconcile).
  async function check(run) {
    const t = await remote.sessionGet(run, "/transcript").catch(() => null);
    if (t?.status !== 200 || t.body.streaming || !Array.isArray(t.body.records)) return;
    const records = t.body.records;
    // A follow-up just sent may not be in the transcript yet: what ends it then is the turn before.
    if (records.filter(r => r.role === "user").length <= (open[run]?.turns || 0)) return;
    const brief = records.findLastIndex(r => r.role === "user");
    const last = brief < 0 ? null : records.slice(brief + 1).findLast(r => ["assistant", "error", "tool"].includes(r.role));
    if (!last) return;
    const outcome = last.role === "error" ? { reason: "errored", error: last.text }
      : last.role === "tool" || last.toolIds?.length ? { reason: "errored", error: "interrupted: the worker stopped before the run finished" }
      : { reason: "done" };
    await deliver(run, outcome, t);
  }

  // Workers keep no event backlog: runs on a worker that just connected are checked once. So is a result its
  // caller did not take, when the caller's worker connects.
  async function reconcile(workspace) {
    for (const run of Object.keys(open)) {
      if (await remote.owner("session", run) === workspace) await check(run);
      else if (open[run]?.result && await remote.owner("session", open[run].parent) === workspace) await deliver(run);
    }
  }

  /** Returns the work it started (for tests); callers need not wait. */
  function event(sessionId, type, data = {}) {
    const work = type === "role_run_request" && sessionId ? start(sessionId, data)
      : type === "role_run_stop" && typeof data.request === "string" ? stop(data.request)
      : type === "worker_connected" ? reconcile(data.workspace)
      // Only a turn's final end: a failed attempt pi retries ends again.
      : type === "turn_end" && open[sessionId] && !data.willRetry && ENDS.has(data.reason) ? deliver(sessionId, data)
      : null;
    return work?.catch(e => log(`pi-ez-web: role run handling failed (${type}): ${e.message}`));
  }

  // Connecting to the workers' events is what finds runs that ended while web was down.
  if (Object.keys(open).length) remote.refresh().catch(() => {});

  return { event };
}
