import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";

let fixture;

beforeEach(async () => {
  fixture = await createIsolatedServerFixture();
});

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

test("close a worktree session: archives only and leaves Git context intact", async () => {
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

test("close a checkout session: archival only — nothing in git is touched", async () => {
  const sessionId = await fixture.checkoutSession();
  const before = fixture.git(fixture.repo, "rev-parse", "HEAD").trim();
  const response = await fixture.post(`/api/sessions/${sessionId}/close`);
  assert.equal(response.status, 200);
  assert.equal(fixture.git(fixture.repo, "branch", "--list", "main").trim(), "* main");
  assert.equal(fixture.git(fixture.repo, "rev-parse", "HEAD").trim(), before);
  assert.equal(fixture.git(fixture.repo, "status", "--porcelain").trim(), "");
  assert.equal(fixture.closedSessions().has(sessionId), true);
});

test("closing a parent also archives its child sessions", async () => {
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

test("restore undoes an end", async () => {
  const { mainSessionId } = fixture;
  await fixture.post(`/api/sessions/${mainSessionId}/close`);
  const response = await fixture.post(`/api/sessions/${mainSessionId}/restore`);
  assert.deepEqual(await response.json(), { ok: true, restored: true });
  assert.equal(fixture.closedSessions().has(mainSessionId), false);
});

// A sync server that lists `ids` (pi-sync's GET /v1/sessions), and the /sync commands the supervisor was given.
async function withSyncServer(ids, run) {
  const at = "2026-11-27T10:00:00.000Z";
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ formatVersion: 1, sessions: ids.map(sessionId => ({ sessionId, title: "Shared", createdAt: at, updatedAt: at, headEntryId: "head", etag: "etag", leaseHolder: null })) }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.PI_SYNC_SERVER_URL;
  process.env.PI_SYNC_SERVER_URL = `http://127.0.0.1:${server.address().port}`;
  const commands = [];
  fixture.supervisor.command = async (id, text) => { commands.push([id, text]); return { action: "handled" }; };
  try { await run(commands, () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })); } finally {
    if (previous === undefined) delete process.env.PI_SYNC_SERVER_URL;
    else process.env.PI_SYNC_SERVER_URL = previous;
    server.closeAllConnections();
    server.close();
  }
}

test("restoring a session the sync server has attaches it again; one it does not have stays local", async () => {
  const { mainSessionId } = fixture;
  const local = await fixture.checkoutSession();
  await withSyncServer([mainSessionId], async (commands, stopServer) => {
    await fixture.post(`/api/sessions/${mainSessionId}/close`);
    await fixture.post(`/api/sessions/${local}/close`);
    commands.length = 0;
    assert.deepEqual(await (await fixture.post(`/api/sessions/${mainSessionId}/restore`)).json(), { ok: true, restored: true, attached: [mainSessionId] });
    assert.deepEqual(commands, [[mainSessionId, "/sync attach"]], "an end detached it; without the attach its next message would stay local");
    assert.deepEqual(await (await fixture.post(`/api/sessions/${local}/restore`)).json(), { ok: true, restored: true, attached: [] });
    assert.equal(commands.length, 1, "a conversation that was never shared is not shared by a restore");

    // The sync server does not answer: the restore still happens, and says the conversation is not syncing.
    await fixture.post(`/api/sessions/${mainSessionId}/close`);
    commands.length = 0;
    await stopServer();
    const offline = await (await fixture.post(`/api/sessions/${mainSessionId}/restore`)).json();
    assert.equal(offline.restored, true);
    assert.deepEqual(offline.attached, []);
    assert.match(offline.syncError, /sync server did not answer/);
    assert.deepEqual(commands, []);
  });
});

test("opening a synchronized conversation that ended here attaches its own copy instead of writing a second one", async () => {
  const { mainSessionId } = fixture;
  await withSyncServer([mainSessionId], async commands => {
    await fixture.post(`/api/sessions/${mainSessionId}/close`);
    commands.length = 0;
    const before = (await fixture.supervisor.allSessions()).length;
    const response = await fixture.post(`/api/projects/${fixture.projectId}/sessions`, { mode: "synced", syncSessionId: mainSessionId });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, mainSessionId);
    assert.deepEqual(commands, [[mainSessionId, "/sync attach"]], "not /sync open in a new session");
    assert.equal((await fixture.supervisor.allSessions()).length, before, "no second session");
    assert.equal(fixture.closedSessions().has(mainSessionId), false, "and it is listed again");
  });
});

test("ending the last session on a clean, merged worktree offers to delete its branch", async () => {
  const clean = await fixture.createWorktreeSession("feat/done");
  const cleanup = (await (await fixture.post(`/api/sessions/${clean.sessionId}/close`)).json()).cleanup;
  assert.deepEqual(cleanup, { projectId: fixture.projectId, branch: "feat/done", primaryBranch: "main" });

  const dirty = await fixture.createWorktreeSession("feat/wip");
  fs.writeFileSync(path.join(dirty.workspacePath, "wip.txt"), "wip\n");
  assert.equal((await (await fixture.post(`/api/sessions/${dirty.sessionId}/close`)).json()).cleanup, null);
});

test("end idle ends only session trees with no activity for a day", async () => {
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
  assert.deepEqual(project.ended.map(item => item.id), [old]);
});

test("removing a project ends its sessions and drops it from the list; the checkout stays", async () => {
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
