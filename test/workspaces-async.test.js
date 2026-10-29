import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as ws from "../server/workspaces.js";
import { createWorkspaceFixture } from "./helpers/workspace-fixture.js";

async function withGitShim(rules, callback) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-async-git-"));
  const bin = path.join(tmp, "bin");
  const tracePath = path.join(tmp, "trace");
  const startedPath = path.join(tmp, "started");
  const readyPath = path.join(tmp, "ready");
  const finishedPath = path.join(tmp, "finished");
  const releasePath = path.join(tmp, "release");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const keys = ["PATH", "PI_TEST_GIT_REAL", "PI_TEST_GIT_TRACE", "PI_TEST_GIT_STARTED", "PI_TEST_GIT_READY", "PI_TEST_GIT_FINISHED", "PI_TEST_GIT_RELEASE"];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
printf '%s\\n' "$*" >> "$PI_TEST_GIT_TRACE"
${rules}
exec "$PI_TEST_GIT_REAL" "$@"
`);
  fs.chmodSync(path.join(bin, "git"), 0o700);
  fs.writeFileSync(tracePath, "");
  process.env.PATH = `${bin}${path.delimiter}${saved.get("PATH") || "/usr/bin:/bin"}`;
  process.env.PI_TEST_GIT_REAL = realGit;
  process.env.PI_TEST_GIT_TRACE = tracePath;
  process.env.PI_TEST_GIT_STARTED = startedPath;
  process.env.PI_TEST_GIT_READY = readyPath;
  process.env.PI_TEST_GIT_FINISHED = finishedPath;
  process.env.PI_TEST_GIT_RELEASE = releasePath;
  try {
    await callback({ tracePath, startedPath, readyPath, finishedPath, releasePath });
  } finally {
    fs.writeFileSync(releasePath, "release");
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function gitTrace(tracePath) {
  const contents = fs.readFileSync(tracePath, "utf8").trim();
  return contents ? contents.split(/\r?\n/) : [];
}

test("async workspace readers match sync output and preserve defaults", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const feature = path.join(fixture.tmp, "feature");
    const detached = path.join(fixture.tmp, "detached");
    const externalMain = path.join(fixture.tmp, "external-main");
    fixture.git(fixture.repo, "worktree", "add", "-b", "feature/async", feature);
    fixture.git(fixture.repo, "worktree", "add", "--detach", detached, "HEAD");
    fixture.git(fixture.repo, "switch", "-c", "checkout-away");
    fixture.git(fixture.repo, "worktree", "add", externalMain, "main");
    fixture.git(fixture.repo, "update-ref", "refs/remotes/origin/zeta", "HEAD");
    fixture.git(fixture.repo, "update-ref", "refs/remotes/origin/alpha", "HEAD");
    fixture.git(fixture.repo, "update-ref", "refs/remotes/origin/HEAD", "HEAD");
    fs.writeFileSync(path.join(fixture.repo, "a.txt"), "staged\n");
    fixture.git(fixture.repo, "add", "a.txt");
    fs.writeFileSync(path.join(fixture.repo, "a.txt"), "unstaged\n");
    fs.writeFileSync(path.join(fixture.repo, "new.txt"), "untracked\n");

    assert.equal(await ws.currentBranchAsync(fixture.repo), ws.currentBranch(fixture.repo));
    assert.equal(await ws.currentBranchAsync(detached), ws.currentBranch(detached));
    assert.deepEqual(await ws.listBranchesAsync(fixture.repo), ws.listBranches(fixture.repo));
    assert.deepEqual(await ws.listBranchesAsync(fixture.repo), ["checkout-away", "feature/async", "main"]);
    assert.deepEqual(await ws.listRemoteBranchesAsync(fixture.repo), ws.listRemoteBranches(fixture.repo));
    assert.deepEqual(await ws.listRemoteBranchesAsync(fixture.repo), ["origin/alpha", "origin/zeta"]);
    assert.equal(await ws.defaultBranchAsync(fixture.repo), ws.defaultBranch(fixture.repo));
    assert.equal(await ws.defaultBranchAsync(fixture.repo, [], null), ws.defaultBranch(fixture.repo, [], null));

    const records = await ws.listWorktreeRecordsAsync(fixture.repo);
    assert.deepEqual(records, ws.listWorktreeRecords(fixture.repo));
    assert.equal(records.find(record => record.path === externalMain)?.path, externalMain);
    const contexts = await ws.listContextsAsync(fixture.repo, "main");
    assert.deepEqual(contexts, ws.listContexts(fixture.repo, "main"));
    assert.deepEqual(await ws.listContextsAsync(fixture.repo), ws.listContexts(fixture.repo));
    assert.deepEqual(await ws.listContextsAsync(fixture.repo, null), ws.listContexts(fixture.repo, null));

    const checkout = contexts.find(context => context.path === fixture.repo);
    const featureContext = contexts.find(context => context.path === feature);
    const detachedContext = contexts.find(context => context.path === detached);
    const externalContext = contexts.find(context => context.path === externalMain);
    assert.equal(checkout.status, "dirty");
    assert.deepEqual(checkout.statusDetails, { total: 2, staged: 1, unstaged: 1, untracked: 1, conflicts: 0 });
    assert.equal(featureContext.status, "clean");
    assert.equal(detachedContext.detached, true);
    assert.equal(detachedContext.branch, null);
    assert.equal(externalContext.externalMain, true);
    assert.equal((await ws.contextStatusAsync({ repoPath: fixture.repo, workspacePath: externalMain })).externalMain, true);
    assert.equal((await ws.contextStatusAsync({ repoPath: fixture.repo, workspacePath: externalMain, primaryBranch: null })).externalMain, false);
  } finally {
    fixture.close();
  }
});

test("async primary branch defaults only when omitted", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const externalMain = path.join(fixture.tmp, "external-main");
    fixture.git(fixture.repo, "switch", "-c", "checkout-away");
    fixture.git(fixture.repo, "worktree", "add", externalMain, "main");
    const record = ws.listWorktreeRecords(fixture.repo).find(value => value.path === externalMain);
    await withGitShim("", async ({ tracePath }) => {
      const omitted = await ws.contextStatusAsync({ repoPath: fixture.repo, workspacePath: externalMain, record });
      assert.equal(omitted.primaryBranch, "main");
      assert.equal(omitted.externalMain, true);
      assert.deepEqual(gitTrace(tracePath), [
        "branch --format=%(refname:short)",
        "symbolic-ref --quiet --short HEAD",
        "symbolic-ref --quiet --short refs/remotes/origin/HEAD",
        "status --porcelain=v2 --branch",
        "show -s --format=%H%x00%h%x00%s HEAD",
      ]);

      fs.writeFileSync(tracePath, "");
      const explicitNull = await ws.contextStatusAsync({ repoPath: fixture.repo, workspacePath: externalMain, record, primaryBranch: null });
      assert.equal(explicitNull.primaryBranch, null);
      assert.equal(explicitNull.externalMain, false);
      assert.deepEqual(gitTrace(tracePath), [
        "status --porcelain=v2 --branch",
        "show -s --format=%H%x00%h%x00%s HEAD",
      ]);
    });
  } finally {
    fixture.close();
  }
});

test("defaultBranchAsync distinguishes omitted and explicit null current branches", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const repo = path.join(fixture.tmp, "feature-only");
    fs.mkdirSync(repo);
    fixture.git(repo, "init", "-b", "feature/only");
    fixture.git(repo, "config", "user.email", "t@t");
    fixture.git(repo, "config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    fixture.git(repo, "add", "-A");
    fixture.git(repo, "commit", "-m", "init");

    assert.equal(await ws.defaultBranchAsync(repo, ["feature/only"]), "feature/only");
    assert.equal(await ws.defaultBranchAsync(repo, ["feature/only"], null), "main");
    assert.equal(await ws.defaultBranchAsync(repo, ["feature/only"]), ws.defaultBranch(repo, ["feature/only"]));
    assert.equal(await ws.defaultBranchAsync(repo, ["feature/only"], null), ws.defaultBranch(repo, ["feature/only"], null));
  } finally {
    fixture.close();
  }
});

test("async context status preserves unknown metadata after v2 failure", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const detached = path.join(fixture.tmp, "detached");
    const externalMain = path.join(fixture.tmp, "external-main");
    fixture.git(fixture.repo, "worktree", "add", "--detach", detached, "HEAD");
    fixture.git(fixture.repo, "switch", "-c", "checkout-away");
    fixture.git(fixture.repo, "worktree", "add", externalMain, "main");
    const records = ws.listWorktreeRecords(fixture.repo);
    const externalRecord = records.find(value => value.path === externalMain);
    const detachedRecord = records.find(value => value.path === detached);

    const rules = `if [ "$1" = "status" ] && [ "$2" = "--porcelain=v1" ]; then printf '%s\\n' ' M v1-compatible.txt'; exit 0; fi
if [ "$1" = "status" ] && [ "$2" = "--porcelain=v2" ]; then printf '%s\\n' 'injected v2 status failure' >&2; exit 42; fi`;
    await withGitShim(rules, async ({ tracePath }) => {
      const v1 = execFileSync("git", ["status", "--porcelain=v1"], { cwd: externalMain, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      assert.equal(v1, " M v1-compatible.txt\n");
      const cases = [
        { workspacePath: externalMain, record: externalRecord, kind: "worktree", branch: "main", head: externalRecord.head, detached: false, externalMain: true },
        { workspacePath: detached, record: detachedRecord, kind: "worktree", branch: null, head: detachedRecord.head, detached: true, externalMain: false },
        { workspacePath: fixture.repo, record: null, kind: "checkout", branch: null, head: null, detached: true, externalMain: false },
      ];
      for (const expected of cases) {
        fs.writeFileSync(tracePath, "");
        const context = await ws.contextStatusAsync({
          repoPath: fixture.repo,
          workspacePath: expected.workspacePath,
          record: expected.record,
          primaryBranch: "main",
        });
        assert.equal(context.kind, expected.kind);
        assert.equal(context.branch, expected.branch);
        assert.equal(context.head, expected.head);
        assert.equal(context.detached, expected.detached);
        assert.equal(context.externalMain, expected.externalMain);
        assert.equal(context.protected, expected.externalMain);
        assert.equal(context.primaryBranch, "main");
        assert.equal(context.status, "unknown");
        assert.equal(context.dirty, null);
        assert.equal(context.statusDetails, null);
        assert.equal(context.commit, null);
        assert.equal(context.upstream, null);
        assert.equal(context.ahead, null);
        assert.equal(context.behind, null);
        assert.equal(context.statusError, "injected v2 status failure");
        assert.deepEqual(gitTrace(tracePath), ["status --porcelain=v2 --branch"]);
      }
    });
  } finally {
    fixture.close();
  }
});

test("async context status preserves commit fallback and subprocess errors", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const head = fixture.git(fixture.repo, "rev-parse", "HEAD").trim();
    const rules = `if [ "$1" = "show" ]; then printf '%s\\n' 'injected show failure' >&2; exit 43; fi
if [ "$1" = "worktree" ]; then printf '%s\\n' 'injected worktree failure' >&2; exit 44; fi`;
    await withGitShim(rules, async ({ tracePath }) => {
      const context = await ws.contextStatusAsync({ repoPath: fixture.repo, workspacePath: fixture.repo, primaryBranch: "main" });
      assert.deepEqual(context.commit, { hash: head, shortHash: head.slice(0, 8), subject: "" });
      assert.deepEqual(gitTrace(tracePath), [
        "status --porcelain=v2 --branch",
        "show -s --format=%H%x00%h%x00%s HEAD",
      ]);
      fs.writeFileSync(tracePath, "");
      await assert.rejects(ws.listWorktreeRecordsAsync(fixture.repo), error => {
        assert.equal(String(error.stderr).trim(), "injected worktree failure");
        assert.equal(String(error.stdout || ""), "");
        return true;
      });
      assert.deepEqual(gitTrace(tracePath), ["worktree list --porcelain"]);
    });

    const missing = path.join(fixture.tmp, "missing");
    assert.equal(await ws.currentBranchAsync(missing), null);
    assert.deepEqual(await ws.listBranchesAsync(missing), []);
    assert.deepEqual(await ws.listRemoteBranchesAsync(missing), []);
    await assert.rejects(ws.listWorktreeRecordsAsync(missing));
    const unavailable = await ws.contextStatusAsync({ repoPath: missing, workspacePath: missing, primaryBranch: null });
    assert.equal(unavailable.status, "unknown");
    assert.equal(unavailable.primaryBranch, null);
    assert.equal(typeof unavailable.statusError, "string");
  } finally {
    fixture.close();
  }
});

test("async Git read closes stdin and leaves the event loop responsive", { timeout: 5000 }, async () => {
  const fixture = createWorkspaceFixture();
  try {
    const rules = `printf '%s\\n' started > "$PI_TEST_GIT_STARTED"
exec 3<&0
cat <&3 >/dev/null &
reader=$!
(sleep 1; kill -TERM "$reader" 2>/dev/null) &
watchdog=$!
wait "$reader"
read_status=$?
kill "$watchdog" 2>/dev/null || true
wait "$watchdog" 2>/dev/null || true
if [ "$read_status" -ne 0 ]; then exit 44; fi
printf '%s\\n' ready > "$PI_TEST_GIT_READY"
n=0
while [ ! -e "$PI_TEST_GIT_RELEASE" ] && [ "$n" -lt 300 ]; do
  n=$((n + 1))
  sleep 0.01
done
if [ ! -e "$PI_TEST_GIT_RELEASE" ]; then exit 44; fi
printf '%s\\n' finished > "$PI_TEST_GIT_FINISHED"`;
    await withGitShim(rules, async ({ startedPath, readyPath, finishedPath, releasePath }) => {
      let pending;
      try {
        let pendingSettled = false;
        pending = ws.listBranchesAsync(fixture.repo);
        pending.then(() => { pendingSettled = true; }, () => { pendingSettled = true; });
        const deadline = Date.now() + 2000;
        while (!fs.existsSync(startedPath) || !fs.existsSync(readyPath)) {
          if (Date.now() >= deadline) throw new Error("Git shim did not reach stdin EOF");
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(fs.existsSync(finishedPath), false);
        assert.equal(pendingSettled, false);
        let eventLoopRan = false;
        await new Promise((resolve, reject) => setImmediate(() => {
          eventLoopRan = true;
          try {
            assert.equal(pendingSettled, false);
            fs.writeFileSync(releasePath, "release");
            resolve();
          } catch (error) {
            fs.writeFileSync(releasePath, "release");
            reject(error);
          }
        }));
        assert.equal(eventLoopRan, true);
        assert.deepEqual(await pending, ws.listBranches(fixture.repo));
        assert.equal(fs.existsSync(finishedPath), true);
      } finally {
        fs.writeFileSync(releasePath, "release");
        if (pending) await pending.catch(() => {});
      }
    });
  } finally {
    fixture.close();
  }
});
