// A prime's follow-ups, worker side. The follow_up tools (extensions/follow-up.js) write requests to a file on
// the worker's disk and call nobody. Web pulls the requests (GET /follow-ups), copies them into its wake-up list
// (wake-list.js) and acknowledges with what is now scheduled, which is all this side knows of that list.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appHome } from "./config.js";

export const SOONEST_MS = 10 * 60_000;
export const LATEST_MS = 30 * 24 * 3600_000;
export const MAX_PENDING = 5; // per prime; web's wake-up list is what enforces it
export const MAX_NOTE_BYTES = 4 * 1024;

const file = () => path.join(appHome(), "follow-ups.json");
// requests: not yet taken by web, { id, session, due, note } or { id, session, cancel: <follow-up id> }.
// pending: web's list at its last acknowledgement, [{ id, due, note }].
function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
    return { requests: Array.isArray(saved.requests) ? saved.requests : [], pending: Array.isArray(saved.pending) ? saved.pending : [] };
  } catch { return { requests: [], pending: [] }; }
}
function save(state) {
  fs.mkdirSync(appHome(), { recursive: true });
  fs.writeFileSync(`${file()}.tmp`, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(`${file()}.tmp`, file());
}

/** What is scheduled or about to be, soonest first: web's list minus what fired or is being cancelled, plus requests web has not taken. */
export function listFollowUps(now = Date.now()) {
  const { requests, pending } = load();
  const cancelled = new Set(requests.map(r => r.cancel).filter(Boolean));
  return [
    ...pending.filter(p => Date.parse(p.due) > now && !cancelled.has(p.id)).map(p => ({ id: p.id, due: p.due, note: p.note, scheduled: true })),
    ...requests.filter(r => !r.cancel).map(r => ({ id: r.id, due: r.due, note: r.note, scheduled: false })),
  ].sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
}

/** Records a follow-up request made in `session`; throws what the model should read. */
export function requestFollowUp({ session, in_minutes, at, note }, now = Date.now()) {
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
  if (listFollowUps(now).length >= MAX_PENDING) throw new Error(`${MAX_PENDING} follow-ups are already pending, which is the limit. Cancel one first.`);
  const state = load();
  const request = { id: randomUUID(), session, due: new Date(due).toISOString(), note: text };
  state.requests.push(request);
  save(state);
  return request;
}

/** Cancels one of the follow-ups listFollowUps shows; throws for any other id. */
export function requestCancel({ session, id }, now = Date.now()) {
  if (!listFollowUps(now).some(f => f.id === id)) throw new Error(`No pending follow-up has the id ${id}.`);
  const state = load();
  const untaken = state.requests.some(r => r.id === id);
  // One web never took is simply dropped; one on web's list needs web to remove it.
  state.requests = state.requests.filter(r => r.id !== id);
  if (!untaken) state.requests.push({ id: randomUUID(), session, cancel: id });
  save(state);
}

/** For web: the requests it has not acknowledged. */
export const followUpRequests = () => load().requests;

/** Web took `ids`; `pending` is its list now. A request made since web read them stays for the next pull. */
export function acknowledgeFollowUps(ids, pending) {
  const state = load();
  save({ requests: state.requests.filter(r => !ids.includes(r.id)), pending });
}
