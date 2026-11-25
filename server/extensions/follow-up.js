// The follow-up tools of a prime's sessions; the supervisor loads this only for them (supervisor/real.js).
// A tool only writes a request to the worker's disk (follow-ups.js): pi-web collects it when the turn ends.
import { LATEST_MS, MAX_CHAIN, MAX_PENDING, PRIME_SESSION, SOONEST_MS, listFollowUps, requestCancel, requestFollowUp } from "../follow-ups.js";

const reply = text => ({ content: [{ type: "text", text }], details: undefined });
const state = f => (f.refused ? ` · REFUSED by pi-web (${f.refused}): it will not run, and cancel_follow_up clears this line`
  : !f.scheduled ? " · pi-web takes it when this turn ends"
  : Date.parse(f.due) <= Date.now() ? " · pi-web is starting its run" : "");
const line = f => `${f.id} · due ${f.due}${state(f)} · ${String(f.note).replace(/\s+/g, " ").slice(0, 200)}`;
// How many follow-up runs in a row led to this session; the worker wrote it into the session's mark when web created the session.
const depthOf = ctx => Number(ctx.sessionManager.getEntries?.().find(e => e.type === "custom" && e.customType === PRIME_SESSION)?.data?.depth) || 0;

export default function followUp(pi) {
  pi.registerTool({
    name: "follow_up",
    label: "Follow up",
    description: `Wake this agent later: at that time pi-web starts a new run of this agent with your note as its brief, and the run's report arrives in the agent's conversation. The run remembers nothing of this session, so the note must say what to do and why; notes.md carries the rest. Between ${SOONEST_MS / 60_000} minutes and ${LATEST_MS / (24 * 3600_000)} days from now, at most ${MAX_PENDING} pending. A run a follow-up started can set the next one, up to ${MAX_CHAIN} follow-up runs in a row. To wait for the owner's answer with a deadline, ask in the conversation and set a follow-up for the deadline.`,
    promptSnippet: "Wake this agent later with a note (a new run starts then)",
    parameters: { type: "object", required: ["note"], properties: {
      in_minutes: { type: "number", description: "Minutes from now. Give this or `at`." },
      at: { type: "string", description: "A time with its zone, ISO 8601, like 2026-11-24T18:00:00Z. Give this or `in_minutes`." },
      note: { type: "string", description: "The brief of the follow-up run: what to check or do, and why." },
    } },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Whose request it is comes from the session, never from what the model sent.
      const made = requestFollowUp({ in_minutes: params.in_minutes, at: params.at, note: params.note, session: ctx.sessionManager.getSessionId(), depth: depthOf(ctx) });
      return reply(`Follow-up ${made.id} is requested for ${made.due}. pi-web schedules it when this turn ends, no sooner than ${SOONEST_MS / 60_000} minutes after that; if it refuses the request, list_follow_ups says so in a later turn or run.`);
    },
  });
  pi.registerTool({
    name: "list_follow_ups",
    label: "List follow-ups",
    description: "Lists this agent's pending follow-ups (id, due time, note), soonest first, as of the last turn end plus what this turn requested, then any request pi-web refused, with the reason.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const all = listFollowUps();
      return reply(all.length ? all.map(line).join("\n") : "No follow-ups are pending.");
    },
  });
  pi.registerTool({
    name: "cancel_follow_up",
    label: "Cancel follow-up",
    description: "Cancels one of this agent's pending follow-ups, or clears a refused one, by the id list_follow_ups shows.",
    parameters: { type: "object", required: ["id"], properties: { id: { type: "string", description: "The follow-up's id." } } },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = String(params.id).trim();
      requestCancel({ session: ctx.sessionManager.getSessionId(), id });
      return reply(`Follow-up ${id} is cancelled; if pi-web holds it, it drops it from its list when this turn ends.`);
    },
  });
}
