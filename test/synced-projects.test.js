import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteWorkspaces } from "../server/remote-workspaces.js";
import { EventHub } from "../server/events.js";

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

test("each session says where it stands against the sync server, and an ended copy continued elsewhere is that device's", async () => {
  const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
  const project = { id: "pp-eco", name: "eco", kind: "folder", sessions: [
    { id: "same", writtenAt: ago(60), children: [{ id: "fork", writtenAt: ago(60), children: [] }] },
    { id: "behind", writtenAt: ago(600), children: [] },
    { id: "held", writtenAt: ago(1), children: [] },
    { id: "running", writtenAt: ago(1), streaming: true, children: [] },
    { id: "renamed", updatedAt: ago(600), writtenAt: ago(60), children: [] },
  ], ended: [
    { id: "moved", title: "primes-impl", when: "1d", writtenAt: ago(3 * 24 * 60) },
    { id: "ended-same", title: "Done here", when: "1h", writtenAt: ago(59) },
    { id: "ended-local", title: "Never shared", when: "2h", writtenAt: ago(120) },
  ] };
  const fetchImpl = async url => {
    if (String(url).endsWith("/v1/workspaces")) return Response.json({ workspaces: [{ name: "ws-eco", repository: "project:eco", state: "running" }] });
    if (String(url).endsWith("/api/state")) return Response.json({ projects: [project] });
    return new Response("{}", { status: 503 });
  };
  const item = (sessionId, minutes, extra = {}) => [sessionId, { sessionId, updatedAt: ago(minutes), device: "laptop", leaseHolder: null, ...extra }];
  let answer = new Map([item("same", 60), item("behind", 120), item("held", 1, { leaseHolder: "phone" }), item("running", 1, { leaseHolder: "ws-eco" }), item("renamed", 59), item("moved", 180), item("ended-same", 60)]);
  const syncedConversations = async () => { if (answer instanceof Error) throw answer; return answer; };
  const remote = createRemoteWorkspaces({ url: "http://workspaced", hub: new EventHub(), fetchImpl, modelAuthSyncMs: 0, syncedConversations, syncedTtlMs: 0 });
  try {
    const [listed] = (await remote.refresh()).projects;
    const words = Object.fromEntries(listed.sessions.map(node => [node.id, node.sync]));
    assert.deepEqual(words, { same: "synced", behind: "on laptop · 2h", held: "on phone · 1m", running: "synced", renamed: "synced" });
    assert.equal(listed.sessions[0].children[0].sync, "not synced", "a fork the server does not have");
    assert.deepEqual(listed.moved.map(({ updatedAt, ...shown }) => shown), [{ id: "moved", title: "primes-impl", where: "on laptop", when: "3h" }]);
    assert.deepEqual(listed.ended.map(item => item.id), ["ended-same", "ended-local"], "it is no longer a past session");

    // No answer, or no sync server: no words at all, and nothing moves.
    for (const none of [new Error("pi-sync down"), null]) {
      answer = none;
      const [plain] = (await remote.refresh()).projects;
      assert.equal(plain.sessions.some(node => "sync" in node), false);
      assert.deepEqual([plain.ended.length, plain.moved], [3, []]);
    }
  } finally { remote.stop(); }
});
