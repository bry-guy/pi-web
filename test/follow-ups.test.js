import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The store reads PI_WEB_HOME on each call; every test gets its own.
const { acknowledgeFollowUps, followUpRequests, listFollowUps, requestCancel, requestFollowUp } = await import("../server/follow-ups.js");
const { default: followUpExtension } = await import("../server/extensions/follow-up.js");

const NOW = Date.parse("2026-11-24T12:00:00Z");
const MIN = 60_000;
const iso = ms => new Date(ms).toISOString();
const fresh = () => { process.env.PI_WEB_HOME = mkdtempSync(path.join(tmpdir(), "follow-ups-")); };
const ask = (over, now = NOW) => requestFollowUp({ session: "conv", note: "Check the deploy.", ...over }, now);

test("the follow-up tool's limits: one time, with a zone, 10 minutes to 30 days away, a short note, 5 pending", () => {
  fresh();
  assert.throws(() => ask({}), /Give either in_minutes or at/);
  assert.throws(() => ask({ in_minutes: 30, at: "2026-11-24T18:00:00Z" }), /Give either in_minutes or at/);
  assert.throws(() => ask({ at: "2026-11-24T18:00:00" }), /needs a date, a time and a zone/);
  assert.throws(() => ask({ at: "soon Z" }), /That is not a time\. It is 2026-11-24T12:00:00\.000Z now\./);
  assert.throws(() => ask({ in_minutes: "soon" }), /That is not a time/);
  assert.throws(() => ask({ in_minutes: 9 }), /at least 10 minutes away/);
  assert.throws(() => ask({ at: "2026-11-24T12:09:59Z" }), /at least 10 minutes away/);
  assert.throws(() => ask({ in_minutes: 30 * 24 * 60 + 1 }), /at most 30 days away/);
  assert.throws(() => ask({ in_minutes: 30, note: "  " }), /The note is empty/);
  assert.throws(() => ask({ in_minutes: 30, note: "é".repeat(2049) }), /capped at 4096 bytes/);
  assert.deepEqual(followUpRequests(), [], "a refused request leaves nothing behind");

  assert.equal(ask({ in_minutes: 10 }).due, iso(NOW + 10 * MIN));
  assert.equal(ask({ at: "2026-11-24T20:00:00+02:00", note: " trimmed " }).due, "2026-11-24T18:00:00.000Z");
  assert.equal(ask({ in_minutes: 30 * 24 * 60 }).due, iso(NOW + 30 * 24 * 60 * MIN));
  ask({ in_minutes: 60 });
  ask({ in_minutes: 61 });
  assert.throws(() => ask({ in_minutes: 62 }), /5 follow-ups are already pending, which is the limit\. Cancel one first\./);
  const requests = followUpRequests();
  assert.equal(requests.length, 5);
  assert.deepEqual({ ...requests[1], id: null }, { id: null, session: "conv", due: "2026-11-24T18:00:00.000Z", note: "trimmed" });
  assert.equal(new Set(requests.map(r => r.id)).size, 5);
});

test("the worker's list is web's last acknowledgement plus what web has not taken; cancels follow the same road", () => {
  fresh();
  const a = ask({ in_minutes: 30 }), b = ask({ in_minutes: 20 });
  assert.deepEqual(listFollowUps(NOW).map(f => [f.id, f.scheduled]), [[b.id, false], [a.id, false]], "soonest first");

  // Web takes both; a request made while it did stays for the next pull.
  const c = ask({ in_minutes: 40 });
  const scheduled = [b, a].map(({ id, due, note }) => ({ id, due, note }));
  acknowledgeFollowUps([a.id, b.id], scheduled);
  assert.deepEqual(followUpRequests().map(r => r.id), [c.id]);
  assert.deepEqual(listFollowUps(NOW).map(f => [f.id, f.scheduled]), [[b.id, true], [a.id, true], [c.id, false]]);
  assert.deepEqual(listFollowUps(NOW + 25 * MIN).map(f => f.id), [a.id, c.id], "one whose time has come is no longer pending");

  // One web never took is dropped here; one on web's list becomes a cancel request, and is hidden meanwhile.
  requestCancel({ session: "run1", id: c.id }, NOW);
  assert.deepEqual(followUpRequests(), []);
  requestCancel({ session: "run1", id: a.id }, NOW);
  assert.deepEqual(followUpRequests().map(r => [r.session, r.cancel]), [["run1", a.id]]);
  assert.deepEqual(listFollowUps(NOW).map(f => f.id), [b.id]);
  assert.throws(() => requestCancel({ session: "run1", id: a.id }, NOW), /No pending follow-up has the id/);
  assert.throws(() => requestCancel({ session: "run1", id: "nope" }, NOW), /No pending follow-up has the id nope/);
  assert.equal(JSON.parse(readFileSync(path.join(process.env.PI_WEB_HOME, "follow-ups.json"), "utf8")).pending.length, 2);
});

test("the extension registers the three tools, which write requests for the calling session and call nobody", async () => {
  fresh();
  const tools = {};
  followUpExtension({ registerTool: t => { tools[t.name] = t; } });
  assert.deepEqual(Object.keys(tools), ["follow_up", "list_follow_ups", "cancel_follow_up"]);
  const ctx = { sessionManager: { getSessionId: () => "run7" } };
  const call = (name, params) => tools[name].execute("call", params, undefined, undefined, ctx).then(r => r.content[0].text);

  assert.equal(await call("list_follow_ups", {}), "No follow-ups are pending.");
  assert.match(await call("follow_up", { in_minutes: 45, note: "Look at the\nbackup job again." }), /^Follow-up [0-9a-f-]{36} is requested for 20\d\d-.*pi-web schedules it when this turn ends/);
  const [request] = followUpRequests();
  assert.equal(request.session, "run7");
  assert.equal(await call("list_follow_ups", {}), `${request.id} · due ${request.due} · pi-web takes it when this turn ends · Look at the backup job again.`);
  await assert.rejects(call("follow_up", { in_minutes: 5, note: "too soon" }), /at least 10 minutes away/);
  await assert.rejects(call("follow_up", { note: "no time" }), /Give either in_minutes or at/);
  await assert.rejects(call("cancel_follow_up", { id: "nope" }), /No pending follow-up/);
  assert.match(await call("cancel_follow_up", { id: ` ${request.id} ` }), /is cancelled/);
  assert.deepEqual(followUpRequests(), []);
});
