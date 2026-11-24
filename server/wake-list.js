// The wake-up list: "start a run of prime P at time T with note N". A prime sets these for itself with its
// follow-up tools (follow-ups.js on its worker; run-door.js copies its requests here). One JSON file, written
// atomically and read again at start. Delivery is at least once: a record goes only after its run has started,
// so a crash in between costs one duplicate run.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { LATEST_MS, MAX_NOTE_BYTES, MAX_PENDING, SOONEST_MS } from "./follow-ups.js";

const TICK_MS = 30_000;
const RETRY_MS = 5 * 60_000;
const GIVE_UP_MS = 24 * 3600_000;

const shaped = r => !!r && [r.id, r.agent, r.due, r.note, r.from].every(v => typeof v === "string" && v) && /^[\w-]{1,64}$/.test(r.id)
  && Number.isFinite(Date.parse(r.due)) && Buffer.byteLength(r.note) <= MAX_NOTE_BYTES;

/** `start(record)` starts the run; it throws when it could not, with `gone: true` when it never can. */
export function createWakeList({ path = null, start, log = console.log, now = Date.now }) {
  let records = [];
  try { records = path ? JSON.parse(readFileSync(path, "utf8")).filter(shaped) : []; } catch { records = []; }
  const starting = new Set();
  const failing = new Map(); // id → { since, next }: a start that failed is tried again every RETRY_MS

  function save() {
    if (!path) return true;
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(records), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      return true;
    } catch (e) { log(`pi-ez-web: could not save wake-list.json: ${e.message}`); return false; }
  }

  /** A prime's pending wake-ups, soonest first. */
  const pending = agent => records.filter(r => r.agent === agent).sort((a, b) => Date.parse(a.due) - Date.parse(b.due));

  /**
   * Adds { id, agent, due, note, from }: "added", "duplicate" (that id is known: nothing changes), "full",
   * "invalid", or "unsaved" (the file could not be written, so the record was not taken).
   * What arrives was written on a worker's disk, so every limit is checked again here.
   */
  function add(record) {
    if (!shaped(record) || Date.parse(record.due) > now() + LATEST_MS) return "invalid";
    if (records.some(r => r.id === record.id)) return "duplicate";
    if (pending(record.agent).length >= MAX_PENDING) return "full";
    // Never sooner than SOONEST_MS from now, whatever the request says: a prime cannot wake itself in a loop.
    const due = new Date(Math.max(Date.parse(record.due), now() + SOONEST_MS)).toISOString();
    records.push({ id: record.id, agent: record.agent, due, note: record.note, from: record.from });
    if (save()) return "added";
    records.pop();
    return "unsaved";
  }

  /** Removes `agent`'s own wake-up `id`; false when it has none by that id, or its run is starting. */
  function cancel(agent, id) {
    const at = records.findIndex(r => r.id === id && r.agent === agent);
    if (at < 0 || starting.has(id)) return false;
    records.splice(at, 1);
    failing.delete(id);
    save();
    return true;
  }

  async function fire(record) {
    starting.add(record.id);
    const error = await Promise.resolve().then(() => start(record)).then(() => null, e => e);
    starting.delete(record.id);
    const since = failing.get(record.id)?.since ?? now();
    if (error && !error.gone && now() - since < GIVE_UP_MS) {
      failing.set(record.id, { since, next: now() + RETRY_MS });
      return log(`pi-ez-web: ${record.agent}'s follow-up ${record.id} did not start (${error.message}); trying again in ${RETRY_MS / 60_000} minutes`);
    }
    if (error) log(`pi-ez-web: ${record.agent}'s follow-up ${record.id} is dropped: ${error.message}`);
    records = records.filter(r => r.id !== record.id);
    failing.delete(record.id);
    save();
  }

  /** Starts every due wake-up that is not already starting or waiting to be retried. */
  function tick() {
    const t = now();
    return Promise.all(records.filter(r => Date.parse(r.due) <= t && !starting.has(r.id) && !(failing.get(r.id)?.next > t)).map(fire));
  }

  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();

  return { add, cancel, pending, tick, stop: () => clearInterval(timer) };
}
