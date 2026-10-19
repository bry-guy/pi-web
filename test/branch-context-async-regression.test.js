import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import * as ws from "../server/workspaces.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("branch-context creation stays responsive and holds admission through preparation, rehome, and failure", { timeout: 90_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-branch-async-"));
  const bin = path.join(tmp, "bin");
  const control = path.join(tmp, "control");
  const marker = path.join(tmp, "marker");
  const release = path.join(tmp, "release");
  const trace = path.join(tmp, "git-trace");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  let child;
  let output = "";
  const pending = [];
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(control, "");
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
set -eu
mode=
IFS= read -r mode < "$PI_TEST_CONTROL" || :
printf '%s:%s\\n' "$mode" "$*" >> "$PI_TEST_TRACE"
held=false
case "$mode:$*" in
  read:'status --porcelain') held=true ;;
  create:'worktree add '*|fail:'worktree add '*|stream:'worktree add '*) held=true ;;
  status-fail:'status --porcelain') echo 'intentional status failure' >&2; exit 42 ;;
esac
if [ "$held" = true ]; then
  printf 'HOLD:%s:%s\\n' "$mode" "$*" >> "$PI_TEST_TRACE"
  : > "$PI_TEST_MARKER"
  i=0
  while [ ! -e "$PI_TEST_RELEASE" ] && [ "$i" -lt 300 ]; do /bin/sleep 0.05; i=$((i + 1)); done
  if [ ! -e "$PI_TEST_RELEASE" ]; then exit 98; fi
  if [ "$mode" = fail ]; then echo 'intentional worktree failure' >&2; exit 42; fi
fi
exec "$PI_TEST_REAL_GIT" "$@"
`);
    fs.chmodSync(path.join(bin, "git"), 0o700);
    child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { createIsolatedServerFixture } from ${JSON.stringify(new URL("./helpers/isolated-server-fixture.js", import.meta.url).href)};
      const fixture = await createIsolatedServerFixture();
      const health = await fixture.get('/api/health');
      const { hub } = await import(${JSON.stringify(new URL("../server/events.js", import.meta.url).href)});
      const { loadBindings, saveBindings } = await import(${JSON.stringify(new URL("../server/config.js", import.meta.url).href)});
      const emit = hub.emit.bind(hub);
      const completed = new Map();
      hub.emit = (id, type, data) => { if (type === 'operation_complete') completed.set(data.operationId, data.operation); return emit(id, type, data); };
      // While "unheld", the checkout's session is not open, so moving the checkout back to main is allowed.
      let unheld = false;
      const originalOpen = fixture.supervisor.isOpen.bind(fixture.supervisor);
      fixture.supervisor.isOpen = id => !unheld && originalOpen(id);
      const original = fixture.supervisor.isStreaming.bind(fixture.supervisor);
      let streaming = false;
      fixture.supervisor.isStreaming = id => (streaming && id === fixture.mainSessionId) || original(id);
      process.on('message', async message => {
        if (message.operationId) return process.send({ completed: completed.get(message.operationId) });
        streaming = message.streaming || false;
        unheld = message.unheld || false;
        if (message.cwd) {
          await fixture.supervisor.rehome(fixture.mainSessionId, message.cwd);
          const bindings = loadBindings();
          bindings[fixture.mainSessionId] = { ...bindings[fixture.mainSessionId], workspacePath: message.cwd };
          saveBindings(bindings);
        }
        process.send({ acknowledged: true });
      });
      process.once('SIGTERM', () => fixture.close().then(() => process.exit(0)));
      process.send({ base: new URL(health.url).origin, repo: fixture.repo, projectId: fixture.projectId, sessionId: fixture.mainSessionId });
    `], {
      env: {
        PATH: `${bin}${path.delimiter}${path.dirname(realGit)}:/usr/bin:/bin`,
        HOME: tmp,
        GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
        PI_WEB_UI_ONLY: "0", PI_WEB_PRESTART_COMMAND: "",
        PI_TEST_CONTROL: control, PI_TEST_MARKER: marker, PI_TEST_RELEASE: release, PI_TEST_REAL_GIT: realGit, PI_TEST_TRACE: trace,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    child.on("error", error => { output += `child error: ${error.stack}\n`; });
    child.on("exit", (code, signal) => { output += `child exit: ${code}, ${signal}\n`; });
    const ready = await Promise.race([once(child, "message"), delay(10_000).then(() => { throw new Error(`startup timeout: ${output}`); })]);
    const { base, repo, projectId, sessionId } = ready[0];
    const request = async (route, body) => {
      const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(30_000) });
      return { status: response.status, body: await response.json() };
    };
    const waitHeld = async (outcome, phase, startedAt) => {
      const deadline = Date.now() + 30_000; // matches the request timeout; git spawns are slow under parallel suite load
      while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await delay(10);
      assert.ok(fs.existsSync(marker), `phase: ${phase}, elapsed: ${Date.now() - startedAt}ms\n${output}\nrequest: ${outcome()?.error?.stack || JSON.stringify(outcome()) || "pending"}\ngit trace:\n${fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "absent"}`);
    };
    const snapshot = () => ({ refs: git(repo, "show-ref"), worktrees: git(repo, "worktree", "list", "--porcelain"), readme: fs.readFileSync(path.join(repo, "README.md"), "utf8") });
    const command = async message => {
      const acknowledged = once(child, "message");
      child.send(message);
      return (await acknowledged)[0];
    };
    const held = async (mode, route, body, change = null) => {
      for (const file of [marker, release]) fs.rmSync(file, { force: true });
      fs.writeFileSync(control, mode);
      let outcome;
      const startedAt = Date.now();
      const operation = request(route, body).then(value => (outcome = { value }), error => (outcome = { error }));
      pending.push(operation);
      await waitHeld(() => outcome, `${mode} ${route}`, startedAt);
      console.log(`hold ${mode} ready in ${Date.now() - startedAt}ms`);
      const response = await fetch(base + "/api/health", { signal: AbortSignal.timeout(2_000) });
      assert.equal(response.status, 200);
      assert.equal(fs.existsSync(release), false);
      const before = snapshot();
      const conflict = await request(`/api/projects/${projectId}/fetch`);
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.error, "repository_busy");
      assert.deepEqual(snapshot(), before);
      if (change) await command(change);
      fs.writeFileSync(control, "");
      fs.writeFileSync(release, "go");
      outcome = await operation;
      assert.equal(outcome.error, undefined, outcome.error?.stack || output);
      const available = await request(`/api/projects/${projectId}/fetch`);
      assert.equal(available.status, 200, JSON.stringify(available.body));
      return outcome.value;
    };
    for (const name of ["feature/async", " spaced "]) assert.equal(await ws.validateBranchNameAsync(name), ws.validateBranchName(name));
    for (const name of ["-bad", "bad..name", "bad/"]) await assert.rejects(ws.validateBranchNameAsync(name), error => error.code === "bad_branch");
    assert.deepEqual(await ws.prepareMainAsync(repo, { fetch: false }), ws.prepareMain(repo, { fetch: false }));
    git(repo, "switch", "-c", "checkout-other");
    await command({ unheld: true });
    const created = await held("read", `/api/projects/${projectId}/sessions`, { branch: "created-async", baseBranch: "main" });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.branch, "created-async");
    assert.equal(git(created.body.workspacePath, "symbolic-ref", "--short", "HEAD"), "created-async");
    const moved = await held("create", `/api/sessions/${sessionId}/branch-context`, { branch: "moved-async", baseBranch: "main" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.id, sessionId);
    assert.equal(moved.body.branch, "moved-async");
    const failed = await held("fail", `/api/projects/${projectId}/sessions`, { branch: "failed-async", baseBranch: "main" });
    assert.equal(failed.status, 500);
    assert.equal(git(repo, "branch", "--list", "failed-async"), "");
    const streamed = await held("stream", `/api/sessions/${sessionId}/branch-context`, { branch: "streamed-async", baseBranch: "main" }, { streaming: true });
    assert.equal(streamed.status, 409);
    assert.equal(streamed.body.error, "session_streaming");
    assert.equal(streamed.body.operation.status, "error");
    assert.equal(streamed.body.operation.httpStatus, 409);
    assert.ok(streamed.body.operation.finishedAt);
    assert.deepEqual((await command({ operationId: streamed.body.operation.id })).completed, streamed.body.operation);
    const state = await (await fetch(base + "/api/state")).json();
    assert.equal(state.projects[0].sessions.find(session => session.id === sessionId).workspacePath, moved.body.workspacePath);
    await command({ streaming: false });
    const changed = await held("create", `/api/sessions/${sessionId}/branch-context`, { branch: "workspace-changed-async", baseBranch: "main" }, { cwd: repo });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error, "repository_changed");
    assert.equal(changed.body.operation.status, "error");
    assert.equal(changed.body.operation.httpStatus, 409);
    assert.ok(changed.body.operation.finishedAt);
    assert.deepEqual((await command({ operationId: changed.body.operation.id })).completed, changed.body.operation);
    const afterChange = await (await fetch(base + "/api/state")).json();
    assert.equal(afterChange.projects[0].sessions.find(session => session.id === sessionId).workspacePath, repo);
    git(repo, "switch", "checkout-other");
    await command({ unheld: true });
    fs.writeFileSync(path.join(repo, "untracked.txt"), "preserve me\n");
    const beforeDirty = snapshot();
    const dirty = await request(`/api/projects/${projectId}/sessions`, { branch: "dirty-async", baseBranch: "main" });
    assert.equal(dirty.status, 409);
    assert.equal(dirty.body.error, "checkout_dirty");
    assert.deepEqual(snapshot(), beforeDirty);
    fs.writeFileSync(control, "status-fail");
    const unavailable = await request(`/api/projects/${projectId}/sessions`, { branch: "unknown-async", baseBranch: "main" });
    assert.equal(unavailable.status, 409);
    assert.equal(unavailable.body.error, "git_status_unavailable");
    assert.deepEqual(snapshot(), beforeDirty);
    assert.equal(fs.readFileSync(path.join(repo, "untracked.txt"), "utf8"), "preserve me\n");
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
