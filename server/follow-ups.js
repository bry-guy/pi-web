// A prime's follow-ups, worker side. The follow_up tools (extensions/follow-up.js) write requests to a file on
// the worker's disk and call nobody. Web pulls the requests (GET /follow-ups), copies them into its wake-up list
// (wake-list.js) and acknowledges with what is now scheduled and what it refused, which is all this side knows
// of that list.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appHome } from "./config.js";

export const SOONEST_MS = 10 * 60_000;
export const LATEST_MS = 30 * 24 * 3600_000;
export const MAX_PENDING = 5; // per prime; web's wake-up list is what enforces it
export const MAX_NOTE_BYTES = 4 * 1024;
// Follow-up runs in a row: a run a follow-up started may set the next, and the third may not, so a prime
// cannot keep waking itself for ever. A conversation or a scheduled run starts a new chain.
export const MAX_CHAIN = 3;
// The custom entry that marks a session web collects follow-ups from; its data is { depth }, the session's place in a chain.
export const PRIME_SESSION = "pi-web:prime-session";
const MAX_REFUSED = 20;

const file = () => path.join(appHome(), "follow-ups.json");
// requests: not yet taken by web, { id, session, due, note } or { id, session, cancel: <follow-up id> }.
// pending: web's list at its last acknowledgement, [{ id, due, note }].
// refused: requests web would not schedule, [{ id, due, note, reason }], kept until the prime cancels them (the newest 20).
function load() {
  const list = v => (Array.isArray(v) ? v : []);
  try {
    const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
    return { requests: list(saved.requests), pending: list(saved.pending), refused: list(saved.refused) };
  } catch { return { requests: [], pending: [], refused: [] }; }
}
function save(state) {
  fs.mkdirSync(appHome(), { recursive: true });
  fs.writeFileSync(`${file()}.tmp`, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(`${file()}.tmp`, file());
}

/**
 * What is scheduled or about to be, soonest first, then what web refused (`refused`: why). Web's list minus what
 * is being cancelled, plus requests web has not taken. One whose time has come stays until web says its run
 * started: web still holds it, and counts it, while it retries.
 */
export function listFollowUps() {
  const { requests, pending, refused } = load();
  const cancelled = new Set(requests.map(r => r.cancel).filter(Boolean));
  return [
    ...pending.filter(p => !cancelled.has(p.id)).map(p => ({ id: p.id, due: p.due, note: p.note, scheduled: true })),
    ...requests.filter(r => !r.cancel).map(r => ({ id: r.id, due: r.due, note: r.note, scheduled: false })),
  ].sort((a, b) => Date.parse(a.due) - Date.parse(b.due)).concat(refused.map(r => ({ id: r.id, due: r.due, note: r.note, refused: r.reason })));
}

/** Records a follow-up request made in `session`; throws what the model should read. */
export function requestFollowUp({ session, depth = 0, in_minutes, at, note }, now = Date.now()) {
  if (false) throw new Error(`This run is follow-up number ${depth} in a row, each set by the run before it, and ${MAX_CHAIN} in a row is the limit, so it cannot set another. Say in your reply what is still open: the conversation or a scheduled run can set the next follow-up.`);
  if ((in_minutes === undefined) === (at === undefined)) throw new Error("Give either in_minutes or at, not both.");
  if (at !== undefined && !/(Z|[+-]\d\d:?\d\d)$/i.test(String(at).trim())) throw new Error("at needs a date, a time and a zone, like 2026-11-24T18:00:00Z.");
  const due = at !== undefined ? Date.parse(String(at).trim()) : now + Number(in_minutes) * 60_000;
  const clock = `It is ${new Date(now).toISOString()} now.`;
  if (!Number.isFinite(due)) throw new Error(`That is not a time. ${clock}`);
  if (due < now + SOONEST_MS) throw new Error(`A follow-up is at least ${SOONEST_MS / 60_000} minutes away. ${clock}`);
  if (due > now + LATEST_MS) throw new Error(`A follow-up is at most ${LATEST_MS / (24 * 3600_000)} days away. ${clock}`);
  const text = typeof note === "string" ? note.trim() : "";
  if (!text) throw new Error("The note is empty: say what the follow-up run should do.");
  if (Buffer.byteLength(text) > MAX_NOTE_BYTES) throw new Error(`The note is capped at ${MAX_NOTE_BYTES} bytes; put the detail in notes.md and point to it.`);
  if (listFollowUps().filter(f => !f.refused).length >= MAX_PENDING) throw new Error(`${MAX_PENDING} follow-ups are already pending, which is the limit. Cancel one first.`);
  const state = load();
  const request = { id: randomUUID(), session, due: new Date(due).toISOString(), note: text };
  state.requests.push(request);
  save(state);
  return request;
}

/** Cancels one of the follow-ups listFollowUps shows; throws for any other id. */
export function requestCancel({ session, id }) {
  if (!listFollowUps().some(f => f.id === id)) throw new Error(`No pending follow-up has the id ${id}.`);
  const state = load();
  const local = [...state.requests, ...state.refused].some(r => r.id === id);
  // One web never took or refused is simply dropped; one on web's list needs web to remove it.
  state.requests = state.requests.filter(r => r.id !== id);
  state.refused = state.refused.filter(r => r.id !== id);
  if (!local) state.requests.push({ id: randomUUID(), session, cancel: id });
  save(state);
}

/** For web: the requests it has not acknowledged. */
export const followUpRequests = () => load().requests;

/**
 * Web took `ids`; `pending` is its list now, and `refused` ([{ id, reason }]) names the ones among `ids` it
 * would not schedule: those stay listed with the reason. A request made since web read them stays for the next pull.
 */
export function acknowledgeFollowUps(ids, pending, refused = []) {
  const state = load();
  const turned = refused.flatMap(x => {
    const r = state.requests.find(r => r.id === x?.id && !r.cancel);
    return r ? [{ id: r.id, due: r.due, note: r.note, reason: String(x.reason || "no reason given").slice(0, 300) }] : [];
  });
  save({ requests: state.requests.filter(r => !ids.includes(r.id)), pending, refused: [...state.refused, ...turned].slice(-MAX_REFUSED) });
}
