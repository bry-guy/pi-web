import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWakeList } from "../server/wake-list.js";

const T0 = Date.parse("2026-11-24T12:00:00Z");
const MIN = 60_000;
const iso = ms => new Date(ms).toISOString();
const record = (id, over = {}) => ({ id, agent: "labrat", due: iso(T0 + 20 * MIN), note: `note ${id}`, from: "conv1", ...over });

function setup(t, { file = path.join(mkdtempSync(path.join(tmpdir(), "wake-")), "wake-list.json"), start = null } = {}) {
  const clock = { t: T0 }, started = [], logs = [];
  const wake = createWakeList({ path: file, now: () => clock.t, log: l => logs.push(l), start: start || (async r => { started.push(r); }) });
  t.after(() => wake.stop());
  return { wake, clock, started, logs, file, saved: () => JSON.parse(readFileSync(file, "utf8")) };
}

test("a wake-up starts its run once it is due, and goes only after the start succeeded", async t => {
  const { wake, clock, started, saved } = setup(t);
  assert.equal(wake.add(record("f1")), "added");
  assert.deepEqual(saved(), [record("f1")]);
  clock.t = T0 + 19 * MIN;
  await wake.tick();
  assert.deepEqual(started, [], "not due yet");
  clock.t = T0 + 20 * MIN;
  await wake.tick();
  await wake.tick();
  assert.deepEqual(started, [record("f1")], "started once");
  assert.deepEqual(wake.pending("labrat"), []);
  assert.deepEqual(saved(), []);
});

test("a pending wake-up survives a restart and still fires", async t => {
  const first = setup(t);
  first.wake.add(record("f1"));
  first.wake.stop();
  const second = setup(t, { file: first.file });
  assert.deepEqual(second.wake.pending("labrat"), [record("f1")]);
  second.clock.t = T0 + 3 * 24 * 60 * MIN; // web was down past the due time
  await second.wake.tick();
  assert.deepEqual(second.started, [record("f1")]);
  assert.deepEqual(setup(t, { file: first.file }).wake.pending("labrat"), [], "and is gone after the next restart");
});

test("a start that fails keeps the wake-up and is retried later; one that never can, or fails for a day, is dropped", async t => {
  let fault = new Error("worker unavailable");
  const attempts = [];
  const { wake, clock, logs, saved } = setup(t, { start: async r => { attempts.push(r.id); if (fault) throw fault; } });
  wake.add(record("f1"));
  wake.add(record("f2", { agent: "gone" }));
  clock.t = T0 + 20 * MIN;
  await wake.tick();
  await wake.tick();
  assert.deepEqual(attempts, ["f1", "f2"], "no second try inside the retry wait");
  assert.deepEqual(saved().map(r => r.id), ["f1", "f2"]);
  assert.match(logs[0], /follow-up f1 did not start \(worker unavailable\); trying again in 5 minutes/);
  fault = Object.assign(new Error("gone is not a prime any more"), { gone: true });
  clock.t += 5 * MIN;
  await wake.tick();
  assert.deepEqual(saved(), [], "gone: dropped at once");
  assert.match(logs.at(-1), /follow-up f2 is dropped: gone is not a prime any more/);

  wake.add(record("f3", { due: iso(clock.t + 10 * MIN) }));
  fault = new Error("still down");
  clock.t += 10 * MIN;
  await wake.tick();
  clock.t += 24 * 60 * MIN;
  await wake.tick();
  assert.deepEqual(saved(), [], "given up after a day of failing");
  assert.match(logs.at(-1), /follow-up f3 is dropped: still down/);
});

test("a wake-up whose run is starting is not started twice and cannot be cancelled", async t => {
  let release;
  const attempts = [];
  const { wake, clock } = setup(t, { start: r => { attempts.push(r.id); return new Promise(r => { release = r; }); } });
  wake.add(record("f1"));
  clock.t = T0 + 20 * MIN;
  const first = wake.tick();
  await wake.tick();
  assert.equal(wake.cancel("labrat", "f1"), false);
  release();
  await first;
  assert.deepEqual(attempts, ["f1"]);
  assert.deepEqual(wake.pending("labrat"), []);
});

test("an id that is already known changes nothing", t => {
  const { wake, saved } = setup(t);
  assert.equal(wake.add(record("f1")), "added");
  assert.equal(wake.add(record("f1", { note: "another note" })), "duplicate");
  assert.equal(wake.add(record("f1", { agent: "other" })), "duplicate", "nor can another prime take the id over");
  assert.deepEqual(saved(), [record("f1")]);
});

test("a request that comes again after its run started is not scheduled a second time", async t => {
  const { wake, clock, started } = setup(t);
  wake.add(record("f1"));
  clock.t = T0 + 20 * MIN;
  await wake.tick();
  assert.equal(wake.add(record("f1")), "duplicate");
  assert.equal(wake.cancel("labrat", "f1"), false);
  clock.t = T0 + 60 * MIN;
  await wake.tick();
  assert.equal(started.length, 1);
});

test("a prime holds at most 5 pending wake-ups, counted per prime", t => {
  const { wake } = setup(t);
  for (let i = 1; i <= 5; i++) assert.equal(wake.add(record(`f${i}`, { due: iso(T0 + (60 - i) * MIN) })), "added");
  assert.equal(wake.add(record("f6")), "full");
  assert.equal(wake.add(record("o1", { agent: "other" })), "added");
  assert.deepEqual(wake.pending("labrat").map(r => r.id), ["f5", "f4", "f3", "f2", "f1"], "soonest first");
  assert.equal(wake.cancel("labrat", "f3"), true);
  assert.equal(wake.add(record("f6")), "added");
});

test("cancel reaches only the named prime's own wake-ups", t => {
  const { wake, saved } = setup(t);
  wake.add(record("f1"));
  wake.add(record("o1", { agent: "other" }));
  assert.equal(wake.cancel("labrat", "o1"), false);
  assert.equal(wake.cancel("labrat", "nope"), false);
  assert.deepEqual(saved().map(r => r.id), ["f1", "o1"]);
  assert.equal(wake.cancel("labrat", "f1"), true);
  assert.deepEqual(saved().map(r => r.id), ["o1"]);
});

test("limits are checked again: never sooner than 10 minutes, never past 30 days, a capped note, a plain id", t => {
  const { wake } = setup(t);
  assert.equal(wake.add(record("soon", { due: iso(T0 + MIN) })), "added");
  assert.equal(wake.pending("labrat")[0].due, iso(T0 + 10 * MIN), "moved to the soonest allowed time");
  assert.equal(wake.add(record("late", { due: iso(T0 + 30 * 24 * 60 * MIN + 1) })), "invalid");
  assert.equal(wake.add(record("big", { note: "x".repeat(4 * 1024 + 1) })), "invalid");
  assert.equal(wake.add(record("../etc", {})), "invalid");
  assert.equal(wake.add(record("when", { due: "tomorrow" })), "invalid");
  assert.equal(wake.add({ id: "bare" }), "invalid");
  assert.deepEqual(wake.pending("labrat").map(r => r.id), ["soon"]);
});

test("a wake-up that could not be written is not taken", t => {
  const { wake, logs } = setup(t, { file: path.join(tmpdir(), "no-such-dir-wake-list", "wake-list.json") });
  assert.equal(wake.add(record("f1")), "unsaved");
  assert.deepEqual(wake.pending("labrat"), []);
  assert.match(logs[0], /could not save wake-list\.json/);
});
