import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { saveBindings } from "../server/config.js";
import { projectState, sessionsUsingWorkspace } from "../server/domain.js";
import * as ws from "../server/workspaces.js";
import { createWorkspaceFixture } from "./helpers/workspace-fixture.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForFile(file, child, output, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`server exited before Git shim blocked\n${output()}`);
    await delay(10);
  }
  assert.ok(fs.existsSync(file), `timed out waiting for Git shim\n${output()}`);
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { status: response.status, body: await response.json() };
  } finally {
    clearTimeout(timer);
  }
}

async function within(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(value => ({ completed: true, value })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ completed: false }), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  if ((await within(exited, 1500)).completed) return true;
  child.kill("SIGKILL");
  return (await within(exited, 1500)).completed;
}

function gitTrace(tracePath) {
  const contents = fs.readFileSync(tracePath, "utf8").trim();
  return contents ? contents.split(/\r?\n/).map(line => {
    const separator = line.indexOf("\t");
    return { cwd: line.slice(0, separator), args: line.slice(separator + 1) };
  }) : [];
}

async function withGitTrace(callback, rules = "") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-state-git-"));
  const bin = path.join(tmp, "bin");
  const tracePath = path.join(tmp, "trace");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const keys = ["PATH", "PI_TEST_GIT_REAL", "PI_TEST_GIT_TRACE"];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
printf '%s\\t%s\\n' "$(pwd -P)" "$*" >> "$PI_TEST_GIT_TRACE"
${rules}
exec "$PI_TEST_GIT_REAL" "$@"
`);
  fs.chmodSync(path.join(bin, "git"), 0o700);
  fs.writeFileSync(tracePath, "");
  process.env.PATH = `${bin}${path.delimiter}${saved.get("PATH") || "/usr/bin:/bin"}`;
  process.env.PI_TEST_GIT_REAL = realGit;
  process.env.PI_TEST_GIT_TRACE = tracePath;
  try {
    await callback(tracePath);
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function withProjectEnvironment(repoPath, callback) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-state-home-"));
  const project = { id: "p-state", name: "repo", repoPath };
  const previousHome = process.env.PI_WEB_HOME;
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ projects: [project] }));
  process.env.PI_WEB_HOME = home;
  try {
    await callback({ home, project });
  } finally {
    if (previousHome === undefined) delete process.env.PI_WEB_HOME;
    else process.env.PI_WEB_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("projectState snapshots Git facts once and matches synchronous helpers", async () => {
  const fixture = createWorkspaceFixture();
  try {
    fixture.git(fixture.repo, "branch", "default");
    const head = fixture.git(fixture.repo, "rev-parse", "HEAD").trim();
    for (const branch of ["zeta", "alpha", "default"]) fixture.git(fixture.repo, "update-ref", `refs/remotes/origin/${branch}`, head);
    fixture.git(fixture.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/default");
    fs.mkdirSync(fixture.wtRoot);
    const worktree = path.join(fixture.wtRoot, "feature-state");
    fixture.git(fixture.repo, "worktree", "add", "-b", "feature/state", worktree);

    const expectedBranches = ws.listBranches(fixture.repo);
    const expectedCurrent = ws.currentBranch(fixture.repo);
    const expectedDefault = ws.defaultBranch(fixture.repo, expectedBranches, expectedCurrent);
    const expectedContexts = ws.listContexts(fixture.repo, expectedDefault);
    const expectedRemoteBranches = ws.listRemoteBranches(fixture.repo);
    const sup = { listSessions: async () => [], meta: async () => null, isStreaming: () => false };

    await withProjectEnvironment(fixture.repo, async ({ project }) => {
      await withGitTrace(async tracePath => {
        const state = await projectState(project, sup);
        const expectedContextSnapshot = expectedContexts.map(context => ({ ...context, sessions: [] }));
        assert.deepEqual(Object.keys(state).sort(), ["branch", "branches", "contexts", "defaultBranch", "ended", "hooks", "id", "name", "remoteBranches", "repoPath", "sessions", "source", "updated", "updatedAt", "worktrees", "workspaceStatus"].sort());
        assert.equal(state.branch, expectedCurrent);
        assert.equal(state.defaultBranch, "default");
        assert.deepEqual(state.branches, expectedBranches);
        assert.deepEqual(state.contexts, expectedContextSnapshot);
        assert.deepEqual(state.remoteBranches, ["origin", "origin/alpha", "origin/default", "origin/zeta"]);
        assert.deepEqual(state.remoteBranches, expectedRemoteBranches);
        assert.deepEqual(state.worktrees, Object.fromEntries(expectedContexts.filter(context => context.branch).map(context => [context.branch, context.path])));
        assert.deepEqual(state.workspaceStatus, Object.fromEntries(expectedContextSnapshot.map(context => [context.branch || context.id, context])));
        assert.deepEqual(state.sessions, []);
        const trace = gitTrace(tracePath);
        for (const command of [
          "branch --format=%(refname:short)",
          "symbolic-ref --quiet --short HEAD",
          "symbolic-ref --quiet --short refs/remotes/origin/HEAD",
          "branch --remotes --format=%(refname:short)",
        ]) assert.equal(trace.filter(item => item.args === command).length, 1, command);
        assert.deepEqual(
          trace.filter(item => item.args === "status --porcelain=v2 --branch").map(item => item.cwd).sort(),
          expectedContexts.map(context => fs.realpathSync(context.path)).sort(),
        );
      });
    });
  } finally {
    fixture.close();
  }
});

test("projectState deduplicates unavailable bindings and preserves unknown v2 status", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const project = { id: "p-state", name: "repo", repoPath: fixture.repo };
    const missingPath = path.join(fixture.tmp, "removed-worktree");
    const sup = { listSessions: async () => [], meta: async () => null, isStreaming: () => false };
    await withProjectEnvironment(fixture.repo, async () => {
      saveBindings({
        "gone-a": { projectId: project.id, workspacePath: missingPath },
        "gone-b": { projectId: project.id, workspacePath: missingPath },
      });
      await withGitTrace(async tracePath => {
        const legacy = ws.workspaceStatus({ repoPath: fixture.repo, branch: "main", workspacePath: fixture.repo, primaryBranch: "main" });
        const state = await projectState(project, sup);
        const live = state.contexts.find(context => context.path === fixture.repo);
        const unavailable = state.contexts.filter(context => context.path === missingPath);
        assert.equal(legacy.dirty, false);
        assert.equal(live.status, "unknown");
        assert.equal(live.dirty, null);
        assert.equal(live.statusDetails, null);
        assert.equal(live.commit, null);
        assert.match(live.statusError, /intentional v2 failure/);
        assert.equal(state.workspaceStatus.main.status, "unknown");
        assert.equal(state.workspaceStatus.main.dirty, null);
        assert.equal(unavailable.length, 1);
        assert.equal(unavailable[0].kind, "unavailable");
        assert.equal(unavailable[0].status, "unavailable");
        assert.equal(unavailable[0].id, ws.contextId(fixture.repo, missingPath));
        const trace = gitTrace(tracePath);
        assert.ok(trace.some(item => item.args === "status --porcelain"));
        assert.ok(trace.some(item => item.args === "status --porcelain=v2 --branch"));
      }, `if [ "$*" = "status --porcelain=v2 --branch" ]; then printf '%s\\n' 'intentional v2 failure' >&2; exit 42; fi`);
    });
  } finally {
    fixture.close();
  }
});

test("projectState returns a full context for an unborn checkout", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-unborn-"));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    const expectedContexts = ws.listContexts(repo, "main");
    const sup = { listSessions: async () => [], meta: async () => null, isStreaming: () => false };
    await withProjectEnvironment(repo, async ({ project }) => {
      const state = await projectState(project, sup);
      assert.deepEqual(state.branches, []);
      assert.equal(state.branch, "main");
      assert.equal(state.defaultBranch, "main");
      assert.deepEqual(state.contexts, expectedContexts.map(context => ({ ...context, sessions: [] })));
      assert.equal(state.contexts[0].kind, "checkout");
      assert.equal(state.contexts[0].branch, "main");
      assert.equal(state.contexts[0].status, "clean");
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sessionsUsingWorkspace completes synchronous Git reads before session discovery", async () => {
  const fixture = createWorkspaceFixture();
  try {
    const project = { id: "p-state", name: "repo", repoPath: fixture.repo };
    let resolveSessions;
    let releaseDiscovery = false;
    let discoveryEntered = false;
    let traceAtDiscovery;
    await withProjectEnvironment(fixture.repo, async () => {
      await withGitTrace(async tracePath => {
        const sup = {
          listSessions: () => {
            discoveryEntered = true;
            traceAtDiscovery = gitTrace(tracePath);
            return new Promise(resolve => {
              resolveSessions = resolve;
              if (releaseDiscovery) resolve([]);
            });
          },
          meta: async () => null,
          isStreaming: () => false,
        };
        const pending = sessionsUsingWorkspace(project, fixture.repo, sup);
        try {
          assert.equal(discoveryEntered, true);
          for (const command of [
            "branch --format=%(refname:short)",
            "symbolic-ref --quiet --short HEAD",
            "symbolic-ref --quiet --short refs/remotes/origin/HEAD",
            "worktree list --porcelain",
            "status --porcelain=v2 --branch",
          ]) assert.ok(traceAtDiscovery.some(item => item.args === command), command);
        } finally {
          releaseDiscovery = true;
          resolveSessions?.([]);
          await pending;
        }
      });
    });
  } finally {
    fixture.close();
  }
});

test("/api/state leaves the server event loop available during Git reads", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-state-async-"));
  const home = path.join(tmp, "home");
  const repo = path.join(tmp, "repo");
  const bin = path.join(tmp, "bin");
  const marker = path.join(tmp, "git-blocked");
  const release = path.join(tmp, "git-release");
  const finished = path.join(tmp, "git-finished");
  fs.mkdirSync(repo, { recursive: true });
  const repoPath = fs.realpathSync(repo);
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "test");
  fs.writeFileSync(path.join(repo, "README.md"), "state regression\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  const configPath = path.join(home, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    reposRoot: tmp,
    worktreeRoot: path.join(home, "worktrees"),
    projects: [{ id: "p-state", name: "repo", repoPath }],
  }));

  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
if [ "$PWD" = "$PI_TEST_GIT_REPO" ] && [ "$*" = "branch --format=%(refname:short)" ] && [ ! -e "$PI_TEST_GIT_MARKER" ]; then
  : > "$PI_TEST_GIT_MARKER"
  i=0
  while [ ! -e "$PI_TEST_GIT_RELEASE" ] && [ "$i" -lt 100 ]; do
    /bin/sleep 0.1
    i=$((i + 1))
  done
  if [ ! -e "$PI_TEST_GIT_RELEASE" ]; then
    printf '%s\\n' 'Git shim release deadline expired' >&2
    : > "$PI_TEST_GIT_FINISHED"
    exit 98
  fi
  : > "$PI_TEST_GIT_FINISHED"
  "$PI_TEST_GIT_REAL" "$@"
  status=$?
  exit "$status"
fi
exec "$PI_TEST_GIT_REAL" "$@"
`);
  fs.chmodSync(path.join(bin, "git"), 0o700);

  let stdout = "";
  let stderr = "";
  let port;
  let child;
  let childError = null;
  let stateRequest;
  let healthRequest;
  const output = () => `stdout:\n${stdout}\nstderr:\n${stderr}\nchild error: ${childError?.stack || "none"}`;
  try {
    child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { startServer } from ${JSON.stringify(new URL("../server/index.js", import.meta.url).href)};
      const { server } = startServer(0);
      const ready = () => console.log(JSON.stringify({ port: server.address().port }));
      if (server.listening) ready(); else server.once("listening", ready);
    `], {
      env: {
        PATH: `${bin}${path.delimiter}${path.dirname(realGit)}:/usr/bin:/bin`,
        HOME: tmp,
        PI_WEB_HOME: home,
        PI_WEB_MODE: "mock",
        PI_WEB_UI_ONLY: "0",
        PI_WEB_PRESTART_COMMAND: "",
        PI_WEB_MOCK_THINK_MS: "0",
        PI_WEB_MOCK_DELTA_MS: "0",
        PI_TEST_GIT_REAL: realGit,
        PI_TEST_GIT_REPO: repoPath,
        PI_TEST_GIT_MARKER: marker,
        PI_TEST_GIT_RELEASE: release,
        PI_TEST_GIT_FINISHED: finished,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", error => { childError = error; });
    let startupBuffer = "";
    child.stdout.on("data", chunk => {
      const text = String(chunk);
      stdout += text;
      startupBuffer += text;
      for (const line of startupBuffer.split(/\r?\n/).slice(0, -1)) {
        try { port = JSON.parse(line).port; } catch {}
      }
      startupBuffer = startupBuffer.split(/\r?\n/).at(-1) || "";
    });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const startupDeadline = Date.now() + 8000;
    while (!port && !childError && Date.now() < startupDeadline && child.exitCode === null && child.signalCode === null) await delay(10);
    assert.ok(port, `server failed to announce its port\n${output()}`);

    stateRequest = fetchJson(`http://127.0.0.1:${port}/api/state`, 30000).then(
      value => ({ status: "fulfilled", value }),
      error => ({ status: "rejected", error }),
    );
    await waitForFile(marker, child, output, 12000);
    healthRequest = fetchJson(`http://127.0.0.1:${port}/api/health`, 8000).then(
      value => ({ status: "fulfilled", value }),
      error => ({ status: "rejected", error }),
    );
    let timeout;
    const healthBeforeRelease = await Promise.race([
      healthRequest.then(value => ({ type: "response", value })),
      new Promise(resolve => { timeout = setTimeout(() => resolve({ type: "timeout" }), 3000); }),
    ]);
    clearTimeout(timeout);
    assert.equal(healthBeforeRelease.type, "response", `health request did not finish before Git was released\n${output()}`);
    assert.equal(healthBeforeRelease.value.status, "fulfilled", `health request failed before Git was released\n${output()}`);
    assert.equal(healthBeforeRelease.value.value.status, 200, `unexpected health response\n${output()}`);
    assert.equal(fs.existsSync(release), false, `Git was released before health completed\n${output()}`);
    assert.equal(fs.existsSync(finished), false, `held Git command finished before health completed\n${output()}`);
    fs.writeFileSync(release, "release\n");
    const stateOutcome = await stateRequest;
    assert.equal(stateOutcome.status, "fulfilled", `state request failed\n${output()}`);
    assert.equal(stateOutcome.value.status, 200, `state request failed\n${output()}`);
    assert.equal(stateOutcome.value.body.projects[0]?.error, undefined, `state discovery failed\n${output()}`);
    assert.equal(fs.existsSync(finished), true, `held Git command did not finish after release\n${output()}`);

    const badRepo = path.join(tmp, "not-a-repository");
    fs.mkdirSync(badRepo);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.projects.push({ id: "p-broken", name: "broken", repoPath: badRepo });
    fs.writeFileSync(configPath, JSON.stringify(config));
    const errorSnapshot = await fetchJson(`http://127.0.0.1:${port}/api/state`, 10000);
    assert.equal(errorSnapshot.status, 200, `state error response failed\n${output()}`);
    const failedProject = errorSnapshot.body.projects.find(project => project.id === "p-broken");
    assert.deepEqual(Object.keys(failedProject), ["id", "name", "repoPath", "defaultBranch", "error", "branches", "sessions", "contexts", "worktrees", "workspaceStatus"]);
    assert.equal(failedProject.defaultBranch, "main");
    assert.match(failedProject.error, /git/i);
    assert.deepEqual(failedProject.branches, []);
    assert.deepEqual(failedProject.sessions, []);
    assert.deepEqual(failedProject.contexts, []);
    assert.deepEqual(failedProject.worktrees, {});
    assert.deepEqual(failedProject.workspaceStatus, {});
  } finally {
    try {
      fs.writeFileSync(release, "release\n");
      if (child) {
        const requests = [stateRequest, healthRequest].filter(Boolean);
        let completed = await within(Promise.all(requests), 2500);
        if (!completed.completed) {
          const stopped = await stopChild(child);
          assert.ok(stopped, `child server failed to terminate\n${output()}`);
          completed = await within(Promise.all(requests), 1000);
        } else {
          assert.ok(await stopChild(child), `child server failed to terminate\n${output()}`);
        }
        assert.ok(completed.completed, `HTTP requests did not settle after release\n${output()}`);
        stateRequest = completed.value?.[0] || stateRequest;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  assert.equal(stateRequest?.status, "fulfilled", `state request failed\n${output()}`);
  assert.equal(stateRequest.value.status, 200, `state request failed\n${output()}`);
  assert.equal(stateRequest.value.body.projects[0]?.error, undefined, `state discovery failed\n${output()}`);
});

test("projectState hides unprompted sessions nothing has open", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-empty-"));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    const session = (id, extra = {}) => ({ id, cwd: repo, modified: new Date(), firstMessage: "", ...extra });
    const sessions = [session("empty"), session("open"), session("prompted", { firstMessage: "hi" }), session("named", { name: "Plan" })];
    const sup = { listSessions: async () => sessions, meta: async () => null, isStreaming: () => false, isOpen: id => id === "open" };
    await withProjectEnvironment(repo, async ({ project }) => {
      const listed = (await projectState(project, sup)).sessions;
      assert.deepEqual(listed.map(item => item.id).sort(), ["named", "open", "prompted"]);
      // The open one is kept for its page but marked draft, so the sidebar leaves it out until a prompt.
      assert.deepEqual(listed.filter(item => item.draft).map(item => item.id), ["open"]);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
