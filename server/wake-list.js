// The wake-up list: "start a run of prime P at time T with note N". A prime sets these for itself with its
// follow-up tools (follow-ups.js on its worker; run-door.js copies its requests here). One JSON file, written
// atomically and read again at start. Delivery is at least once: a record goes only after its run has started,
// so a crash in between costs one duplicate run.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { LATEST_MS, MAX_CHAIN, MAX_NOTE_BYTES, MAX_PENDING, SOONEST_MS } from "./follow-ups.js";

const TICK_MS = 30_000;
const RETRY_MS = 5 * 60_000;
const GIVE_UP_MS = 24 * 3600_000;

const shaped = r => !!r && [r.id, r.agent, r.due, r.note, r.from].every(v => typeof v === "string" && v) && /^[\w-]{1,64}$/.test(r.id)
  && Number.isFinite(Date.parse(r.due)) && Buffer.byteLength(r.note) <= MAX_NOTE_BYTES;

/**
 * `start(record)` starts the run; it throws when it could not, with `gone: true` when it never can.
 * `started(record)` is told once the run runs and its record is gone.
 */
export function createWakeList({ path = null, start, started = () => {}, log = console.log, now = Date.now }) {
  let records = [];
  if (path && existsSync(path)) {
    try { records = JSON.parse(readFileSync(path, "utf8")).filter(shaped); } catch (e) {
      // Kept aside, never overwritten: its follow-ups are lost to this start, and the file says which.
      const aside = `${path}.corrupt-${now()}`;
      try { renameSync(path, aside); } catch { /* the log line below still says it was unreadable */ }
      log(`pi-ez-web: wake-list.json could not be read (${e.message}); its follow-ups are dropped and the file is kept as ${aside}`);
    }
  }
  const starting = new Set();
  // Every id taken since web started: a request the worker never saw acknowledged comes again with each pull,
  // and must not be scheduled a second time after its run has started.
  // shortcut: forgotten at a restart, so such a request can run once more per restart; keep fired ids in the file if that is ever seen.
  const taken = new Set(records.map(r => r.id));
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
   * Adds { id, agent, due, note, from, depth }: "added", "duplicate" (that id is known: nothing changes), "full",
   * "invalid", "chain" (depth, its run's place in a row of follow-up runs, is past MAX_CHAIN), or "unsaved" (the
   * file could not be written, so the record was not taken).
   * What arrives was written on a worker's disk, so every limit is checked again here.
   */
  function add(record) {
    if (!shaped(record) || Date.parse(record.due) > now() + LATEST_MS) return "invalid";
    if (taken.has(record.id)) return "duplicate";
    const depth = Number.isInteger(record.depth) && record.depth > 0 ? record.depth : 1;
    if (depth > MAX_CHAIN) return "chain";
    if (pending(record.agent).length >= MAX_PENDING) return "full";
    // Never sooner than SOONEST_MS from now, whatever the request says: a prime cannot wake itself in a loop.
    const due = new Date(Math.max(Date.parse(record.due), now() + SOONEST_MS)).toISOString();
    records.push({ id: record.id, agent: record.agent, due, note: record.note, from: record.from, depth });
    if (!save()) { records.pop(); return "unsaved"; }
    taken.add(record.id);
    return "added";
  }

  /**
   * Removes `agent`'s own wake-up `id`: "cancelled", "missing" (it has none by that id, or its run is starting),
   * or "unsaved" (the file could not be written, so the wake-up stays).
   */
  function cancel(agent, id) {
    const at = records.findIndex(r => r.id === id && r.agent === agent);
    if (at < 0 || starting.has(id)) return "missing";
    const [record] = records.splice(at, 1);
    if (!save()) { records.splice(at, 0, record); return "unsaved"; }
    failing.delete(id);
    return "cancelled";
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
    if (!error) await Promise.resolve().then(() => started(record)).catch(e => log(`pi-ez-web: after ${record.agent}'s follow-up ${record.id} started: ${e.message}`));
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
