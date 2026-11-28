import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteWorkspaces } from "../server/remote-workspaces.js";
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
  assert.equal(standing(copyFacts(entries("e1", "e2"))), "on laptop · 2h", "one entry behind is behind: no margin of time");
  assert.equal(standing(copyFacts(entries("e1", "e2", "x9"))), "on laptop · 2h", "both went on: the server has what this copy lacks");
  assert.equal(standing(copyFacts(entries("e1", "e2", "e3", link("d1", true)))), "not synced", "detached here, whatever the heads say");
  assert.equal(standing(copyFacts(entries("e1", link("d1", true), "e2", link("d2", false), "e3"))), "synced", "attached again since");
  assert.equal(syncStanding(items, "other", copyFacts(entries("e1"))), "not synced", "not on the server");
  assert.equal(standing(null), null, "a copy that was not read gets no words");
  assert.equal(standing(copyFacts([])), null);
  // The head pi reports wins over the last line (a conversation rewound to an earlier entry).
  assert.equal(standing(copyFacts(entries("e1", "e2", "e3", "e4"), "e3")), "synced");
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

test("state gets each session's words, and an ended copy continued elsewhere becomes that device's conversation", () => {
  const copies = {
    same: copyFacts(entries("a1", "a2")),
    fork: copyFacts(entries("a1", "f1")),
    moved: copyFacts(entries("m1", link("m2", true))),
    "ended-same": copyFacts(entries("s1", link("s2", true))),
    "ended-local": copyFacts(entries("l1")),
  };
  const projects = [{ id: "pp-eco", sessions: [{ id: "same", children: [{ id: "fork", children: [] }] }, { id: "unread", children: [] }], ended: [
    { id: "moved", title: "primes-impl" }, { id: "ended-same", title: "Done here" }, { id: "ended-local", title: "Never shared" },
  ] }, { id: "broken", error: "no git" }];
  const items = new Map([served("same", "a2"), served("moved", "m9"), served("ended-same", "s1")]);
  labelProjects(projects, { items, self: "web" }, id => copies[id] || null);
  const [project] = projects;
  assert.deepEqual([project.sessions[0].sync, project.sessions[0].children[0].sync], ["synced", "not synced"]);
  assert.equal("sync" in project.sessions[1], false);
  assert.deepEqual(project.moved.map(({ updatedAt, ...shown }) => shown), [{ id: "moved", title: "primes-impl", where: "on laptop", when: "2h" }]);
  assert.deepEqual(project.ended.map(item => item.id), ["ended-same", "ended-local"], "it is no longer a past session");
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

test("web passes a session's sync words on only from a worker that just answered", async () => {
  let state = "running";
  const project = { id: "pp-eco", sessions: [{ id: "s1", sync: "synced", children: [{ id: "s2", sync: "not uploaded yet", children: [] }] }], ended: [], moved: [{ id: "m1", title: "Moved", where: "on laptop", when: "1h" }] };
  const fetchImpl = async url => {
    if (String(url).endsWith("/v1/workspaces")) return Response.json({ workspaces: [{ name: "ws-eco", repository: "project:eco", state }] });
    if (String(url).endsWith("/api/state")) return Response.json({ projects: [project] });
    return new Response("{}", { status: 503 });
  };
  const remote = createRemoteWorkspaces({ url: "http://workspaced", hub: new EventHub(), fetchImpl, modelAuthSyncMs: 0 });
  try {
    const [awake] = (await remote.refresh()).projects;
    assert.deepEqual([awake.sessions[0].sync, awake.sessions[0].children[0].sync, awake.moved.length], ["synced", "not uploaded yet", 1]);
    state = "sleeping";
    const [asleep] = (await remote.refresh()).projects;
    assert.equal(asleep.sessions.length, 1, "the kept snapshot still lists it");
    assert.deepEqual(["sync" in asleep.sessions[0], "sync" in asleep.sessions[0].children[0]], [false, false], "but says nothing of a copy it cannot read now");
  } finally { remote.stop(); }
});
