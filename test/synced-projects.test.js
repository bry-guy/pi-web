import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createRemoteWorkspaces, registerRemoteRoutes } from "../server/remote-workspaces.js";
import { EventHub } from "../server/events.js";
import { copyFacts, elsewhere, knownConversations, labelProjects, syncStanding } from "../server/pi-sync.js";

test("web lists pi projects other devices synced, next to project workers, without asking pi-sync on every refresh", async () => {
  const workers = [{ name: "ws-alpha", repository: "project:alpha", state: "sleeping" }];
  const fetchImpl = async url => new Response(JSON.stringify(String(url).endsWith("/v1/workspaces") ? { workspaces: workers } : {}), { status: 200 });
  let calls = 0;
  let answer = [{ name: "alpha", sessions: 1 }, { name: "beta", sessions: 2, lastActive: "2026-10-30T00:00:00Z" }];
  const syncedProjects = async () => { calls++; if (answer instanceof Error) throw answer; return answer; };
  const remote = createRemoteWorkspaces({ url: "http://workspaced", hub: new EventHub(), fetchImpl, modelAuthSyncMs: 0, syncedProjects, syncedTtlMs: 0 });
  try {
    const state = await remote.refresh();
    assert.deepEqual(state.piProjects.map(p => [p.name, p.workspace]), [["alpha", "ws-alpha"], ["beta", null]]);
    assert.deepEqual(state.piProjects[1].synced, { sessions: 2, lastActive: "2026-10-30T00:00:00Z" });

    answer = new Error("pi-sync down");
    const kept = await remote.refresh();
    assert.deepEqual(kept.piProjects.map(p => p.name), ["alpha", "beta"], "a failed pi-sync answer keeps the last list");
  } finally { remote.stop(); }

  calls = 0;
  answer = [{ name: "beta" }];
  const cached = createRemoteWorkspaces({ url: "http://workspaced", hub: new EventHub(), fetchImpl, modelAuthSyncMs: 0, syncedProjects, syncedTtlMs: 60_000 });
  try {
    await cached.refresh();
    await cached.refresh();
    assert.equal(calls, 1, "pi-sync is asked at most once per TTL");
  } finally { cached.stop(); }
});

// A session file's entries as pi writes them: a chain of ids, with pi-sync's detach marker as a custom entry.
const entries = (...ids) => ids.map(id => typeof id === "string" ? { type: "message", id } : id);
const link = (id, detached) => ({ type: "custom", customType: "pi-sync-link", id, data: { detached } });
const served = (sessionId, headEntryId, extra = {}) => [sessionId, { sessionId, headEntryId, updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), devices: ["laptop"], leaseHolder: null, ...extra }];

test("a copy reads synced only when it ends in the entry the sync server's copy ends in", () => {
  const items = new Map([served("c", "e3")]);
  const standing = (copy, self = "web") => syncStanding(items, "c", copy, self);
  assert.equal(standing(copyFacts(entries("e1", "e2", "e3"))), "synced");
  assert.equal(standing(copyFacts(entries("e1", "e2", "e3", "e4"))), "not uploaded yet", "this copy holds turns the server lacks");
  const idle = type => ({ type, id: `s-${type}` });
  assert.equal(standing(copyFacts(entries("e1", "e2", "e3", idle("thinking_level_change"), idle("model_change")))), "synced", "pi-sync holds settings switches for the next turn");
  assert.equal(standing(copyFacts(entries("e1", "e2", "e3", idle("model_change"), "e4"))), "not uploaded yet", "a turn after the switch is not uploaded");
  assert.equal(standing(copyFacts(entries("e1", "e2", "e3", idle("session_info")))), "not uploaded yet", "a rename is uploaded when idle, so it counts");
  assert.equal(standing(copyFacts(entries("e1", "e2"))), "on laptop · 2h", "one entry behind is behind: no margin of time");
  assert.equal(standing(copyFacts(entries("e1", "e2", "x9"))), "on laptop · 2h", "both went on: the server has what this copy lacks");
  assert.equal(standing(copyFacts(entries("e1", "e2", "e3", link("d1", true)))), "not synced", "detached here, and the server has nothing more");
  assert.equal(standing(copyFacts(entries("e1", "e2", link("d1", true)))), "on laptop · 2h", "detached here and continued elsewhere: where it went on says more");
  assert.equal(syncStanding(new Map([served("c", "e3", { leaseHolder: "phone" })]), "c", copyFacts(entries("e1", "e2", "e3", link("d1", true))), "web"), "on phone · 2h", "detached here and held elsewhere");
  assert.equal(standing(copyFacts(entries("e1", link("d1", true), "e2", link("d2", false), "e3"))), "synced", "attached again since");
  assert.equal(syncStanding(items, "other", copyFacts(entries("e1"))), "not synced", "not on the server");
  assert.equal(standing(null), null, "a copy that was not read gets no words");
  assert.equal(standing(copyFacts([])), null);
});

test("the device named as elsewhere is the lease holder, else another device, never this one", () => {
  const behind = copyFacts(entries("e1"));
  const same = copyFacts(entries("e1", "e2"));
  const where = (extra, copy, self) => elsewhere(served("c", "e2", extra)[1], copy, self)?.where;
  assert.equal(where({ devices: ["web", "laptop"] }, behind, "web"), "on laptop", "this worker read it last, but did not write it");
  assert.equal(where({ devices: ["web"] }, behind, "web"), "on another device");
  assert.equal(where({ devices: ["laptop"], leaseHolder: "phone" }, behind, "web"), "on phone");
  assert.equal(where({ leaseHolder: "phone" }, same, "web"), "on phone", "held elsewhere, even with the same entries");
  assert.equal(where({ leaseHolder: "web" }, same, "web"), undefined, "this device's own lease is not elsewhere");
  assert.equal(where({ leaseHolder: "phone" }, null, "web"), "on phone");
  assert.equal(where({}, null, "web"), undefined, "an unread copy is not called behind");
});

test("state gets each session's words, open or closed; a closed copy continued elsewhere names that device", () => {
  const copies = {
    same: copyFacts(entries("a1", "a2")),
    fork: copyFacts(entries("a1", "f1")),
    moved: copyFacts(entries("m1", link("m2", true))),
    "closed-same": copyFacts(entries("s1")),
    "closed-local": copyFacts(entries("l1")),
  };
  const projects = [{ id: "pp-eco", sessions: [{ id: "same", children: [{ id: "fork", children: [] }] }, { id: "unread", children: [] }], closed: [
    { id: "moved", title: "primes-impl", children: [] }, { id: "closed-same", title: "Done here", children: [] }, { id: "closed-local", title: "Never shared", children: [] },
  ] }, { id: "broken", error: "no git" }];
  const items = new Map([served("same", "a2"), served("moved", "m9"), served("closed-same", "s1")]);
  labelProjects(projects, { items, self: "web" }, id => copies[id] || null);
  const [project] = projects;
  assert.deepEqual([project.sessions[0].sync, project.sessions[0].children[0].sync], ["synced", "not synced"]);
  assert.equal("sync" in project.sessions[1], false);
  assert.deepEqual(project.closed.map(item => [item.id, item.sync]), [["moved", "on laptop · 2h"], ["closed-same", "synced"], ["closed-local", "not synced"]], "closed ones stay in one list");
  assert.equal("moved" in project, false);
});

test("the sync server's list is read without waiting, and is unknown after no answer", async () => {
  const items = new Map([served("c", "e1")]);
  let answer = items, calls = 0;
  const list = async () => { calls++; if (answer instanceof Error) throw answer; return answer; };
  const read = now => knownConversations({ list, device: async () => "web", now });
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  const t0 = Date.now() + 3600_000;
  assert.equal(read(t0), null, "the first reading only starts the fetch");
  await settle();
  // The fetch stamps its answer with the clock, so later readings are placed after it.
  const t1 = Date.now();
  assert.deepEqual(read(t1), { items, self: "web" });
  assert.equal(calls, 1);
  answer = new Error("pi-sync down");
  assert.deepEqual(read(t1 + 31_000), { items, self: "web" }, "an answer under a minute old still serves while the next is fetched");
  await settle();
  assert.equal(calls, 2);
  assert.equal(read(Date.now()), null, "no answer: nothing is known, the old list is not kept");
  answer = null;
  read(Date.now() + 31_000);
  await settle();
  assert.equal(read(Date.now()), null, "no sync server set");
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test("web passes sync words on from a worker's answer under a minute old, and never keeps them on disk", async () => {
  let state = "running";
  let delay = 0;
  const project = { id: "pp-eco", sessions: [{ id: "s1", sync: "synced", children: [{ id: "s2", sync: "not uploaded yet", children: [] }] }], closed: [{ id: "c1", title: "Closed", sync: "on laptop · 1h", children: [] }] };
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/v1/workspaces")) return Response.json({ workspaces: [{ name: "ws-eco", repository: "project:eco", state }] });
    if (String(url).endsWith("/api/state")) {
      if (delay) await new Promise((resolve, reject) => { setTimeout(resolve, delay); init.signal?.addEventListener("abort", () => reject(init.signal.reason)); });
      return Response.json({ projects: [project] });
    }
    return new Response("{}", { status: 503 });
  };
  const cachePath = path.join(mkdtempSync(path.join(tmpdir(), "piweb-sync-words-")), "remote-projects.json");
  const words = p => [p.sessions[0]?.sync, p.sessions[0]?.children[0].sync, p.closed[0]?.sync];
  const remote = createRemoteWorkspaces({ url: "http://workspaced", hub: new EventHub(), fetchImpl, modelAuthSyncMs: 0, cachePath, stateTimeoutMs: 40, stateFreshMs: 300 });
  try {
    const [awake] = (await remote.refresh()).projects;
    assert.deepEqual(words(awake), ["synced", "not uploaded yet", "on laptop · 1h"]);
    assert.doesNotMatch(readFileSync(cachePath, "utf8"), /"sync"/, "the kept snapshot holds no sync words");

    // The worker turns slow: it misses the wait, but its last answer is under the age limit.
    delay = 120;
    const started = Date.now();
    const [slow] = (await remote.refresh()).projects;
    assert.ok(Date.now() - started < 110, "the sidebar does not wait for a slow worker");
    assert.deepEqual(words(slow), ["synced", "not uploaded yet", "on laptop · 1h"], "an answer under the age limit still speaks");
    // Its late answer is not thrown away: the next call has it, though that call's own request is late too.
    project.sessions[0].sync = "on phone · 1m";
    await pause(400);
    const [aged] = (await remote.refresh()).projects;
    assert.deepEqual(words(aged), [undefined, undefined, undefined], "an answer over the age limit says nothing of sync");
    assert.equal(aged.sessions.length, 1, "though it still lists the sessions");
    await pause(150);
    const [late] = (await remote.refresh()).projects;
    assert.equal(late.sessions[0].sync, "on phone · 1m", "the answer that came after the wait serves the next call");

    delay = 0;
    await pause(150);
    await remote.refresh();
    state = "sleeping";
    const [asleep] = (await remote.refresh()).projects;
    assert.equal(asleep.sessions.length, 1, "the kept snapshot still lists it");
    assert.deepEqual(words(asleep), [undefined, undefined, undefined], "but says nothing of a copy it cannot read now");
  } finally { remote.stop(); }

  // A new web process has only the snapshot, and a worker that does not answer in time.
  delay = 5_000;
  state = "running";
  const restarted = createRemoteWorkspaces({ url: "http://workspaced", hub: new EventHub(), fetchImpl, modelAuthSyncMs: 0, cachePath, stateTimeoutMs: 40, stateLimitMs: 200 });
  try {
    const [kept] = (await restarted.refresh()).projects;
    assert.deepEqual([kept.sessions.length, ...words(kept)], [1, undefined, undefined, undefined]);
    await pause(250);
  } finally { restarted.stop(); }
});

test("a worker is asked for its state once at a time, and an answer from before a close is dropped", async () => {
  let asked = 0, release;
  const sessions = [{ id: "s1", children: [] }, { id: "s2", children: [] }];
  const fetchImpl = async (url, init) => {
    const p = new URL(url).pathname;
    if (p === "/v1/workspaces") return Response.json({ workspaces: [{ name: "ws-eco", repository: "project:eco", state: "running" }] });
    if (p.endsWith("/api/state")) {
      asked++;
      const listed = [...sessions];
      if (asked > 1) await new Promise(resolve => { release = resolve; });
      return Response.json({ projects: [{ id: "pp-eco", sessions: listed, closed: [] }] });
    }
    if (p.endsWith("/api/sessions/s2/close") && init?.method === "POST") return Response.json({ ok: true });
    return new Response("{}", { status: 503 });
  };
  const remote = createRemoteWorkspaces({ url: "http://workspaced", hub: new EventHub(), fetchImpl, modelAuthSyncMs: 0, stateTimeoutMs: 20 });
  const api = new Hono();
  registerRemoteRoutes(api, remote);
  const shown = async () => (await remote.refresh()).projects[0].sessions.map(s => s.id);
  try {
    assert.deepEqual(await shown(), ["s1", "s2"]);
    assert.deepEqual(await shown(), ["s1", "s2"], "the second request is still out; the last answer shows");
    assert.deepEqual(await shown(), ["s1", "s2"]);
    assert.equal(asked, 2, "one request in flight per worker");
    // s2 is closed while that request, which still lists it, is out.
    sessions.pop();
    assert.equal((await api.request("/sessions/s2/close", { method: "POST" })).status, 200);
    release();
    await pause(20);
    assert.deepEqual(await shown(), ["s1"], "the late answer must not put the closed session back");
  } finally { release?.(); remote.stop(); }
});
