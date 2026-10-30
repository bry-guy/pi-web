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
