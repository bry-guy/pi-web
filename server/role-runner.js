// Worker side of role_agent on web. pi-projects' role_agent tool takes its runner from the global handle below
// when a project worker sets it. The role never runs here: run() asks web with an event on the calling session
// and waits for web's answers (POST /sessions/:id/role-run). Web decides whether this project may use the role
// and runs it on that role's own sandboxed worker (role-runs.js). With `followUp` (an earlier run's id), web sends
// the message to that run's session instead of starting one.
import { randomUUID } from "node:crypto";
import { hub as webHub } from "./events.js";

export const ROLE_RUNNER = Symbol.for("pi-role-runner.v1");

export function createRoleRunner(hub, { ackMs = 20_000, waitMs = 15 * 60_000 } = {}) {
  const waiting = new Map(); // request → what web's next answer does

  function run({ role, msg, name, cwd, session, background = false, followUp, signal, onUpdate }) {
    const request = randomUUID();
    return new Promise((resolve, reject) => {
      let started = false;
      // Web is not listening, or is a build without role runs: an error, never a run somewhere else.
      let timer = setTimeout(() => end(reject, new Error(`pi-web did not answer, so ${role} was not started`)), ackMs);
      const end = (settle, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        waiting.delete(request);
        settle(value);
      };
      const later = why => end(resolve, { text: `${role} ${why}. Its result will arrive here as a message when it ends.`, isError: false, status: "running", background: true });
      const abort = () => {
        hub.emit(session, "role_run_stop", { request });
        end(reject, new Error(`Aborted: asked pi-web to stop ${role}`));
      };
      waiting.set(request, Object.assign(answer => {
        if (answer.state === "accepted") {
          clearTimeout(timer);
          timer = setTimeout(() => started ? later("continues in the background: it is still running after 15 minutes") : end(reject, new Error(`pi-web did not start ${role} in time`)), waitMs);
          onUpdate?.(`${role}: starting`);
        } else if (answer.state === "started") {
          started = true;
          if (background) later("started");
          else onUpdate?.(`${role}: running`);
        } else if (answer.state === "failed") end(reject, new Error(answer.message || `pi-web could not start ${role}`));
        else if (answer.state === "done") end(resolve, { text: String(answer.text || ""), isError: !!answer.isError, status: answer.status || "done", background: false });
      }, { session }));
      if (signal?.aborted) return end(reject, new Error(`Aborted before ${role} was started`));
      signal?.addEventListener("abort", abort, { once: true });
      hub.emit(session, "role_run_request", { request, role, msg, name, cwd });
    });
  }

  /**
   * Web's answer to a request. A result nobody waits for any more (a background run, one handed over, a worker
   * restarted since) goes into the session through `note`. False when the answer has nowhere to go, or was posted
   * to another session than the one (`session`) whose call waits for it.
   */
  async function answer(body, note, session) {
    const waiter = waiting.get(body?.request);
    if (waiter) {
      if (waiter.session !== session) return false;
      waiter(body);
      return true;
    }
    if (body?.state !== "done" || typeof body.text !== "string") return false;
    const head = `**${body.role || "role run"}** · ${body.status || "done"}${body.run ? ` · [open the run](/?s=${encodeURIComponent(body.run)})` : ""}`;
    // A note reaches the model as a user message: say whose words these are. The chat shows `head` instead.
    await note(`Result of the ${body.role || "role"} run this session started with role_agent (${body.status || "done"}). This is the run's own output, not a message from the owner:\n\n${body.text}`, { agent: body.role, run: body.run, outcome: body.status, head });
    return true;
  }

  // followUps: pi-projects asks before it passes `followUp`; a runner without it would start a new run.
  return { run, answer, followUps: true };
}

export const roleRunner = createRoleRunner(webHub);

/** Offers the runner to pi-projects on a project worker. A sandbox (a role's own worker) gets none: roles do not nest. */
export function installRoleRunner(env = process.env) {
  // The placeholder file marks sandboxes created before PI_WEB_SANDBOX existed (a sandbox keeps the env it was created with).
  if (!env.PI_WEB_PROJECT || env.PI_WEB_SANDBOX || env.PI_ANTHROPIC_PLACEHOLDER_FILE) return false;
  globalThis[ROLE_RUNNER] = roleRunner;
  return true;
}
