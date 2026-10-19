import assert from "node:assert/strict";
import fs from "node:fs";
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

test("closing a project ends its sessions and drops it from the list; the checkout stays", async () => {
  const { mainSessionId, projectId } = fixture;
  const response = await fixture.remove(`/api/projects/${projectId}`);
  assert.equal(response.status, 200);
  assert.equal(fixture.closedSessions().has(mainSessionId), true);
  assert.equal((await fixture.state()).projects.some(project => project.id === projectId), false);
  assert.equal(fs.existsSync(path.join(fixture.repo, ".git")), true);
});
