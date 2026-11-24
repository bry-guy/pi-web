// The follow-up tools of a prime's sessions; the supervisor loads this only for them (supervisor/real.js).
// A tool only writes a request to the worker's disk (follow-ups.js): pi-web collects it when the turn ends.
import { Type } from "typebox";
import { LATEST_MS, MAX_PENDING, SOONEST_MS, listFollowUps, requestCancel, requestFollowUp } from "../follow-ups.js";

const reply = text => ({ content: [{ type: "text", text }], details: undefined });
const line = f => `${f.id} · due ${f.due}${f.scheduled ? "" : " · pi-web takes it when this turn ends"} · ${f.note.replace(/\s+/g, " ").slice(0, 200)}`;

export default function followUp(pi) {
  pi.registerTool({
    name: "follow_up",
    label: "Follow up",
    description: `Wake this agent later: at that time pi-web starts a new run of this agent with your note as its brief, and the run's report arrives in the agent's conversation. The run remembers nothing of this session, so the note must say what to do and why; notes.md carries the rest. Between ${SOONEST_MS / 60_000} minutes and ${LATEST_MS / (24 * 3600_000)} days from now, at most ${MAX_PENDING} pending. To wait for the owner's answer with a deadline, ask in the conversation and set a follow-up for the deadline.`,
    promptSnippet: "Wake this agent later with a note (a new run starts then)",
    parameters: Type.Object({
      in_minutes: Type.Optional(Type.Number({ description: "Minutes from now. Give this or `at`." })),
      at: Type.Optional(Type.String({ description: "A time with its zone, ISO 8601, like 2026-11-24T18:00:00Z. Give this or `in_minutes`." })),
      note: Type.String({ description: "The brief of the follow-up run: what to check or do, and why." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const made = requestFollowUp({ session: ctx.sessionManager.getSessionId(), ...params });
      return reply(`Follow-up ${made.id} is requested for ${made.due}. pi-web schedules it when this turn ends, no sooner than ${SOONEST_MS / 60_000} minutes after that.`);
    },
  });
  pi.registerTool({
    name: "list_follow_ups",
    label: "List follow-ups",
    description: "Lists this agent's pending follow-ups (id, due time, note), soonest first, as of the last turn end plus what this turn requested.",
    parameters: Type.Object({}),
    async execute() {
      const all = listFollowUps();
      return reply(all.length ? all.map(line).join("\n") : "No follow-ups are pending.");
    },
  });
  pi.registerTool({
    name: "cancel_follow_up",
    label: "Cancel follow-up",
    description: "Cancels one of this agent's pending follow-ups by the id list_follow_ups shows.",
    parameters: Type.Object({ id: Type.String({ description: "The follow-up's id." }) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = String(params.id).trim();
      requestCancel({ session: ctx.sessionManager.getSessionId(), id });
      return reply(`Follow-up ${id} is cancelled; pi-web drops it from its list when this turn ends.`);
    },
  });
}
