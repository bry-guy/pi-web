import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("switch and return-to-main stay responsive and preserve session guards and bindings", { timeout: 120_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-switch-async-"));
  const bin = path.join(tmp, "bin");
  const control = path.join(tmp, "control");
  const marker = path.join(tmp, "marker");
  const release = path.join(tmp, "release");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  let child;
  let output = "";
  const pending = [];
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(control, "");
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
set -eu
mode=$(cat "$PI_TEST_CONTROL")
held=false
case "$mode:$*" in
  read:'status --porcelain') held=true ;;
  switch:'switch '*|fail:'switch '*) held=true ;;
  status-fail:'status --porcelain') echo 'intentional status failure' >&2; exit 42 ;;
esac
if [ "$held" = true ]; then
  : > "$PI_TEST_MARKER"
  i=0
  while [ ! -e "$PI_TEST_RELEASE" ] && [ "$i" -lt 300 ]; do /bin/sleep 0.05; i=$((i + 1)); done
  if [ ! -e "$PI_TEST_RELEASE" ]; then exit 98; fi
  if [ "$mode" = fail ]; then echo 'intentional switch failure' >&2; exit 42; fi
fi
exec "$PI_TEST_REAL_GIT" "$@"
`);
    fs.chmodSync(path.join(bin, "git"), 0o700);
    child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { createIsolatedServerFixture } from ${JSON.stringify(new URL("./helpers/isolated-server-fixture.js", import.meta.url).href)};
      const fixture = await createIsolatedServerFixture();
      const siblingId = await fixture.createBoundSession();
      const health = await fixture.get('/api/health');
      const { hub } = await import(${JSON.stringify(new URL("../server/events.js", import.meta.url).href)});
      const { loadBindings, saveBindings } = await import(${JSON.stringify(new URL("../server/config.js", import.meta.url).href)});
      const events = [];
      const emit = hub.emit.bind(hub);
      hub.emit = (id, type, data) => { if (['session_meta', 'workspace_switched', 'session_returned'].includes(type)) events.push({ id, type, data }); return emit(id, type, data); };
      const original = fixture.supervisor.isStreaming.bind(fixture.supervisor);
      let streaming = null;
      fixture.supervisor.isStreaming = id => id === streaming || original(id);
      process.on('message', async message => {
        if (message.observe) return process.send({ bindings: loadBindings(), events, cwd: (await fixture.supervisor.meta(fixture.mainSessionId)).cwd });
        if (message.worktree) return process.send(await fixture.createWorktreeSession(message.worktree));
        streaming = message.streaming || null;
        if (message.cwd) {
          const id = message.id || fixture.mainSessionId;
          await fixture.supervisor.rehome(id, message.cwd);
          const bindings = loadBindings();
          bindings[id] = { ...bindings[id], workspacePath: message.cwd, branch: message.branch };
          saveBindings(bindings);
        }
        process.send({ acknowledged: true });
      });
      process.once('SIGTERM', () => fixture.close().then(() => process.exit(0)));
      process.send({ base: new URL(health.url).origin, repo: fixture.repo, projectId: fixture.projectId, sessionId: fixture.mainSessionId, siblingId });
    `], {
      env: {
        PATH: `${bin}${path.delimiter}${path.dirname(realGit)}:/usr/bin:/bin`, HOME: tmp,
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
        PI_WEB_UI_ONLY: "0", PI_WEB_PRESTART_COMMAND: "",
        PI_TEST_CONTROL: control, PI_TEST_MARKER: marker, PI_TEST_RELEASE: release, PI_TEST_REAL_GIT: realGit,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    const ready = await Promise.race([once(child, "message"), delay(10_000).then(() => { throw new Error(`startup timeout: ${output}`); })]);
    const { base, repo, projectId, sessionId, siblingId } = ready[0];
    const request = async (route, body) => {
      const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(30_000) });
      return { status: response.status, body: await response.json() };
    };
    const command = async message => {
      const acknowledged = once(child, "message");
      child.send(message);
      return (await acknowledged)[0];
    };
    const snapshot = () => ({ refs: git(repo, "show-ref"), worktrees: git(repo, "worktree", "list", "--porcelain"), readme: fs.readFileSync(path.join(repo, "README.md"), "utf8") });
    const switchRoute = `/api/sessions/${sessionId}/switch`;
    const held = async (mode, body, change = null) => {
      for (const file of [marker, release]) fs.rmSync(file, { force: true });
      fs.writeFileSync(control, mode);
      const operation = request(switchRoute, body).then(value => ({ value }), error => ({ error }));
      pending.push(operation);
      const deadline = Date.now() + 8_000;
      while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await delay(10);
      assert.ok(fs.existsSync(marker), output);
      const health = await fetch(base + "/api/health", { signal: AbortSignal.timeout(2_000) });
      assert.equal(health.status, 200);
      assert.equal(fs.existsSync(release), false);
      const before = snapshot();
      const conflict = await request(`/api/projects/${projectId}/fetch`);
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.error, "repository_busy");
      assert.deepEqual(snapshot(), before);
      if (change) await command(change);
      fs.writeFileSync(control, "");
      fs.writeFileSync(release, "go");
      const outcome = await operation;
      assert.equal(outcome.error, undefined, outcome.error?.stack || output);
      const available = await request(`/api/projects/${projectId}/fetch`);
      assert.equal(available.status, 200, JSON.stringify(available.body));
      return outcome.value;
    };
    git(repo, "branch", "other");
    git(repo, "branch", "failing");
    const switched = await held("switch", { branch: "other" });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(switched.body.switched, true);
    const observed = await command({ observe: true });
    for (const id of [sessionId, siblingId]) {
      assert.equal(observed.bindings[id].branch, "other");
      assert.equal(observed.bindings[id].workspacePath, repo);
      assert.ok(observed.events.some(event => event.id === id && event.type === "workspace_switched" && event.data.branch === "other"));
    }
    const noop = await request(switchRoute, { branch: "other" });
    assert.equal(noop.status, 200);
    assert.equal(noop.body.switched, false);
    const beforeFailure = snapshot();
    const failed = await held("fail", { branch: "failing" });
    assert.equal(failed.status, 409);
    assert.equal(failed.body.error, "git_switch_failed");
    assert.match(failed.body.detail, /intentional switch failure/);
    assert.deepEqual(snapshot(), beforeFailure);
    const streamed = await held("read", { branch: "failing" }, { streaming: siblingId });
    assert.equal(streamed.status, 409);
    assert.equal(streamed.body.error, "sessions_active");
    assert.deepEqual(snapshot(), beforeFailure);
    await command({ streaming: null });
    const worktree = await command({ worktree: "feature-isolated" });
    const movedSibling = await held("switch", { branch: "failing" }, { id: siblingId, cwd: worktree.workspacePath, branch: "feature-isolated" });
    assert.equal(movedSibling.status, 200, JSON.stringify(movedSibling.body));
    const afterSibling = await command({ observe: true });
    assert.equal(afterSibling.bindings[siblingId].workspacePath, worktree.workspacePath);
    assert.equal(afterSibling.bindings[siblingId].branch, "feature-isolated");
    assert.ok(!afterSibling.events.some(event => event.id === siblingId && event.type === "workspace_switched" && event.data.branch === "failing"));
    const beforeMove = snapshot();
    const changed = await held("read", { branch: "other" }, { cwd: worktree.workspacePath, branch: "feature-isolated" });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error, "repository_changed");
    assert.deepEqual(snapshot(), beforeMove);
    assert.equal((await command({ observe: true })).bindings[sessionId].workspacePath, worktree.workspacePath);
    const beforeReturn = snapshot();
    const streamingReturn = await held("read", { branch: "main" }, { streaming: sessionId });
    assert.equal(streamingReturn.status, 409);
    assert.equal(streamingReturn.body.error, "session_streaming");
    assert.deepEqual(snapshot(), beforeReturn);
    assert.equal((await command({ observe: true })).cwd, worktree.workspacePath);
    await command({ streaming: null });
    const returned = await held("switch", { branch: "main" });
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    assert.equal(returned.body.returned, true);
    assert.equal(returned.body.workspacePath, repo);
    assert.equal((await command({ observe: true })).cwd, repo);
    await command({ id: worktree.sessionId, cwd: repo, branch: "main" });
    git(repo, "branch", "trunk");
    git(repo, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    const trunk = await held("switch", { branch: "trunk" });
    assert.equal(trunk.status, 200, JSON.stringify(trunk.body));
    assert.equal(trunk.body.branch, "trunk");
    assert.equal(trunk.body.returned, false);
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "trunk");
    const afterTrunk = await command({ observe: true });
    assert.equal(afterTrunk.bindings[worktree.sessionId].branch, "trunk");
    fs.writeFileSync(path.join(repo, "README.md"), "preserve tracked change\n");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "preserve untracked change\n");
    const beforeDirty = snapshot();
    const dirty = await request(switchRoute, { branch: "other" });
    assert.equal(dirty.status, 409);
    assert.equal(dirty.body.error, "workspace_dirty");
    assert.deepEqual(snapshot(), beforeDirty);
    fs.writeFileSync(control, "status-fail");
    const unavailable = await request(switchRoute, { branch: "other" });
    assert.equal(unavailable.status, 409);
    assert.equal(unavailable.body.error, "git_status_unavailable");
    assert.deepEqual(snapshot(), beforeDirty);
    assert.equal(fs.readFileSync(path.join(repo, "untracked.txt"), "utf8"), "preserve untracked change\n");
  } finally {
    fs.writeFileSync(control, "");
    fs.writeFileSync(release, "go");
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      if (!await Promise.race([exited.then(() => true), delay(2_000).then(() => false)])) { child.kill("SIGKILL"); await exited; }
    }
    await Promise.allSettled(pending);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
