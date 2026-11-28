import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";
import { syncListServer } from "./helpers/sync-list-server.js";

let fixture;

beforeEach(async () => {
  fixture = await createIsolatedServerFixture();
});

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

test("close a worktree session: leaves Git context intact", async () => {
  const { mainSessionId } = fixture;
  const worktreeResponse = await fixture.post(`/api/sessions/${mainSessionId}/worktree`, { branch: "feat/throwaway" });
  const { workspacePath: worktree } = await worktreeResponse.json();
  fs.writeFileSync(path.join(worktree, "junk.txt"), "uncommitted junk\n");

  const response = await fixture.post(`/api/sessions/${mainSessionId}/close`);
  assert.equal(response.status, 200);

  assert.equal(fs.existsSync(worktree), true);
  assert.match(fixture.git(fixture.repo, "branch", "--list"), /feat\/throwaway/);
  assert.equal(fixture.closedSessions().has(mainSessionId), true);
  const transcript = await (await fixture.get(`/api/sessions/${mainSessionId}/transcript`)).json();
  assert.ok(Array.isArray(transcript.records));
});

test("close a checkout session: nothing in git is touched", async () => {
  const sessionId = await fixture.checkoutSession();
  const before = fixture.git(fixture.repo, "rev-parse", "HEAD").trim();
  const response = await fixture.post(`/api/sessions/${sessionId}/close`);
  assert.equal(response.status, 200);
  assert.equal(fixture.git(fixture.repo, "branch", "--list", "main").trim(), "* main");
  assert.equal(fixture.git(fixture.repo, "rev-parse", "HEAD").trim(), before);
  assert.equal(fixture.git(fixture.repo, "status", "--porcelain").trim(), "");
  assert.equal(fixture.closedSessions().has(sessionId), true);
});

test("closing a parent also closes its child sessions", async () => {
  const parent = await fixture.checkoutSession();
  await fixture.post(`/api/sessions/${parent}/message`, { text: "parent transcript" });
  await new Promise(resolve => setTimeout(resolve, 180));
  await fixture.post(`/api/sessions/${parent}/stop`);
  const fork = await (await fixture.post(`/api/sessions/${parent}/worktree`, {
    fork: true,
    branch: "branch/parent-child",
  })).json();
  await fixture.post(`/api/sessions/${parent}/close`);
  const closed = fixture.closedSessions();
  assert.equal(closed.has(parent), true);
  assert.equal(closed.has(fork.id), true);
  const childTranscript = await (await fixture.get(`/api/sessions/${fork.id}/transcript`)).json();
  assert.ok(Array.isArray(childTranscript.records));
});

test("opening a closed conversation puts it back on the sidebar", async () => {
  const { mainSessionId } = fixture;
  await fixture.post(`/api/sessions/${mainSessionId}/close`);
  const response = await fixture.post(`/api/sessions/${mainSessionId}/restore`);
  assert.deepEqual(await response.json(), { ok: true, restored: true });
  assert.equal(fixture.closedSessions().has(mainSessionId), false);
});

// Sync is set up (`url`: the sync server; by default nothing listens), the copies of `detached` carry pi-sync's
// detach marker as an earlier build's End wrote it, and the /sync commands given are recorded.
async function withSync(detached, run, url = "http://127.0.0.1:9") {
  const previous = process.env.PI_SYNC_SERVER_URL;
  process.env.PI_SYNC_SERVER_URL = url;
  const commands = [];
  fixture.supervisor.command = async (id, text) => { commands.push([id, text]); return { action: "handled" }; };
  fixture.supervisor.syncCopy = id => ({ head: "e1", detached: detached.includes(id), has: () => true });
  try { await run(commands); } finally {
    if (previous === undefined) delete process.env.PI_SYNC_SERVER_URL;
    else process.env.PI_SYNC_SERVER_URL = previous;
  }
}

test("closing unloads the conversation and writes nothing into it; opening it again needs nothing from pi-sync", async () => {
  const id = await fixture.checkoutSession();
  await withSync([], async commands => {
    await fixture.post(`/api/sessions/${id}/message`, { text: "hello" });
    assert.equal(fixture.supervisor.isOpen(id), true);
    assert.equal((await fixture.post(`/api/sessions/${id}/close`)).status, 200);
    assert.deepEqual(commands, [], "no /sync detach: the conversation stays shared");
    assert.equal(fixture.supervisor.isOpen(id), false, "nothing here holds it any more");

    const started = Date.now();
    assert.deepEqual(await (await fixture.post(`/api/sessions/${id}/restore`)).json(), { ok: true, restored: true });
    assert.deepEqual(commands, [], "no /sync attach: its binding was never removed");
    assert.ok(Date.now() - started < 2_000, "and nothing waits for the sync server");
    assert.equal(fixture.closedSessions().has(id), false);
  });
});

test("a copy an earlier End detached is attached when it is opened, if the sync server lists it", async () => {
  const { mainSessionId } = fixture;
  const gone = await fixture.checkoutSession();
  const sync = await syncListServer([mainSessionId]);
  try {
    await withSync([mainSessionId, gone], async commands => {
      await fixture.post(`/api/sessions/${mainSessionId}/close`);
      await fixture.post(`/api/sessions/${gone}/close`);
      assert.deepEqual(await (await fixture.post(`/api/sessions/${mainSessionId}/restore`)).json(), { ok: true, restored: true, attached: [mainSessionId] });
      assert.deepEqual(commands, [[mainSessionId, "/sync attach"]], "without the attach its next message would stay local");
      assert.deepEqual(await (await fixture.post(`/api/sessions/${gone}/restore`)).json(), { ok: true, restored: true, attached: [] });
      assert.equal(commands.length, 1, "one the sync server no longer has opens as the local conversation it is");
    }, sync.url);
  } finally { await sync.close(); }
});

test("a detached copy that cannot be attached stays closed, and says why", async () => {
  const { mainSessionId } = fixture;
  const sync = await syncListServer([mainSessionId]);
  try {
    await withSync([mainSessionId], async () => {
      await fixture.post(`/api/sessions/${mainSessionId}/close`);
      fixture.supervisor.command = async () => { throw new Error("The sync server did not answer"); };
      const unloaded = [];
      fixture.supervisor.unload = async id => { unloaded.push(id); };
      const answer = await (await fixture.post(`/api/sessions/${mainSessionId}/restore`)).json();
      assert.equal(answer.restored, false);
      assert.deepEqual(answer.attached, []);
      assert.match(answer.syncError, /not syncing: The sync server did not answer/);
      assert.equal(fixture.closedSessions().has(mainSessionId), true, "the stale copy is not put up for typing");
      assert.deepEqual(unloaded, [mainSessionId], "and the failed attach leaves nothing loaded");
    }, sync.url);
  } finally { await sync.close(); }
  // No answer from the sync server at all: whether it has the conversation is not known.
  await withSync([mainSessionId], async commands => {
    const answer = await (await fixture.post(`/api/sessions/${mainSessionId}/restore`)).json();
    assert.equal(answer.restored, false);
    assert.match(answer.syncError, /sync server did not answer/);
    assert.deepEqual(commands, []);
    assert.equal(fixture.closedSessions().has(mainSessionId), true);
  });
});

test("opening a synchronized conversation that is closed here opens its own copy instead of writing a second one", async () => {
  const { mainSessionId } = fixture;
  await withSync([], async commands => {
    await fixture.post(`/api/sessions/${mainSessionId}/close`);
    const before = (await fixture.supervisor.allSessions()).length;
    const response = await fixture.post(`/api/projects/${fixture.projectId}/sessions`, { mode: "synced", syncSessionId: mainSessionId });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, mainSessionId);
    assert.deepEqual(commands, [], "neither /sync open in a new session nor an attach it does not need");
    assert.equal((await fixture.supervisor.allSessions()).length, before, "no second session");
    assert.equal(fixture.closedSessions().has(mainSessionId), false, "and it is on the sidebar again");
  });
});

test("closing the last session on a clean, merged worktree offers to delete its branch", async () => {
  const clean = await fixture.createWorktreeSession("feat/done");
  const cleanup = (await (await fixture.post(`/api/sessions/${clean.sessionId}/close`)).json()).cleanup;
  assert.deepEqual(cleanup, { projectId: fixture.projectId, branch: "feat/done", primaryBranch: "main" });

  const dirty = await fixture.createWorktreeSession("feat/wip");
  fs.writeFileSync(path.join(dirty.workspacePath, "wip.txt"), "wip\n");
  assert.equal((await (await fixture.post(`/api/sessions/${dirty.sessionId}/close`)).json()).cleanup, null);
});

test("close idle closes only session trees with no activity for a day", async () => {
  const old = fixture.mainSessionId;
  const fresh = await fixture.checkoutSession();
  const file = path.join(process.env.PI_WEB_HOME, "mock-sessions", `${old}.json`);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  // Prompted so it is listed; last touched two days ago.
  stored.records.push({ role: "user", text: "hi" });
  stored.modified = new Date(Date.now() - 2 * 86_400_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(stored));

  const { ended } = await (await fixture.post(`/api/projects/${fixture.projectId}/end-idle`)).json();
  assert.deepEqual(ended, [old]);
  assert.equal(fixture.closedSessions().has(fresh), false);
  const project = (await fixture.state()).projects.find(item => item.id === fixture.projectId);
  assert.deepEqual(project.closed.map(item => item.id), [old]);
});

test("removing a project closes its sessions and drops it from the list; the checkout stays", async () => {
  const { mainSessionId, projectId } = fixture;
  const response = await fixture.remove(`/api/projects/${projectId}`);
  assert.equal(response.status, 200);
  assert.equal(fixture.closedSessions().has(mainSessionId), true);
  assert.equal((await fixture.state()).projects.some(project => project.id === projectId), false);
  assert.equal(fs.existsSync(path.join(fixture.repo, ".git")), true);
});

test("a new session never switches a checkout another session is working in", async () => {
  const holder = await fixture.checkoutSession();
  const file = path.join(process.env.PI_WEB_HOME, "mock-sessions", `${holder}.json`);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.records.push({ role: "user", text: "working on a branch here" });
  fs.writeFileSync(file, JSON.stringify(stored));
  fixture.git(fixture.repo, "checkout", "-q", "-b", "feat/by-hand");

  const response = await fixture.post(`/api/projects/${fixture.projectId}/sessions`, { branch: "main", pull: "background" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.branch, "feat/by-hand", "the new session starts where the checkout is");
  assert.match(body.notice, /not switched to main/);
  await new Promise(resolve => setTimeout(resolve, 200)); // let the background update run
  assert.equal(fixture.git(fixture.repo, "branch", "--show-current").trim(), "feat/by-hand");

  // With nobody working there, a new session brings the checkout back to main as before.
  await fixture.post(`/api/sessions/${holder}/close`);
  await fixture.post(`/api/sessions/${body.id}/close`);
  await fixture.post(`/api/sessions/${fixture.mainSessionId}/close`);
  // The earlier background update may still hold the repository briefly under load.
  let again;
  for (let attempt = 0; attempt < 50; attempt++) {
    again = await (await fixture.post(`/api/projects/${fixture.projectId}/sessions`, { branch: "main" })).json();
    if (again.error !== "repository_busy") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(again.branch, "main", JSON.stringify(again));
  assert.equal(fixture.git(fixture.repo, "branch", "--show-current").trim(), "main");
});
