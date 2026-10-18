import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test("merge and deletion stay responsive, hold admission, and preserve late refusal and failure state", { timeout: 120_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-merge-delete-async-"));
  const bin = path.join(tmp, "bin"), control = path.join(tmp, "control"), marker = path.join(tmp, "marker"), release = path.join(tmp, "release");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  let child, output = "";
  const pending = [];
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(control, "");
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
set -eu
mode=
IFS= read -r mode < "$PI_TEST_CONTROL" || :
held=false
case "$mode:$*" in
  read:'status --porcelain'|delete-read:'status --porcelain=v2 --branch') held=true ;;
  merge:'merge --no-ff --no-edit '*|merge-fail:'merge --no-ff --no-edit '*|fetch:'fetch --prune origin') held=true ;;
  remove:'worktree remove '*|remove-fail:'worktree remove '*) held=true ;;
  delete:'branch -D '*|delete-fail:'branch -D '*) held=true ;;
esac
if [ "$held" = true ]; then
  : > "$PI_TEST_MARKER"
  i=0
  while [ ! -e "$PI_TEST_RELEASE" ] && [ "$i" -lt 300 ]; do /bin/sleep 0.05; i=$((i + 1)); done
  [ -e "$PI_TEST_RELEASE" ] || exit 98
  case "$mode" in *-fail) echo 'intentional Git failure' >&2; exit 42 ;; esac
fi
exec "$PI_TEST_REAL_GIT" "$@"
`);
    fs.chmodSync(path.join(bin, "git"), 0o700);
    child = spawn(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs';
      import path from 'node:path';
      import { createIsolatedServerFixture } from ${JSON.stringify(new URL("./helpers/isolated-server-fixture.js", import.meta.url).href)};
      const fixture = await createIsolatedServerFixture();
      const { loadBindings } = await import(${JSON.stringify(new URL("../server/config.js", import.meta.url).href)});
      const streaming = fixture.supervisor.isStreaming.bind(fixture.supervisor), rehome = fixture.supervisor.rehome.bind(fixture.supervisor), stop = fixture.supervisor.stop.bind(fixture.supervisor);
      let flags = {};
      const stopped = [];
      fixture.supervisor.isStreaming = id => flags.streaming === id || streaming(id);
      fixture.supervisor.stop = async id => { await stop(id); stopped.push(id); if (flags.streaming === id) flags.streaming = null; };
      fixture.supervisor.rehome = (id, cwd) => { if (flags.failRehome === id) throw new Error('intentional rehome failure'); return rehome(id, cwd); };
      process.on('message', async message => {
        if (message.source) {
          flags = {};
          const source = await fixture.createWorktreeSession(message.source);
          fs.writeFileSync(path.join(source.workspacePath, message.source + '.txt'), message.source);
          fixture.git(source.workspacePath, 'add', '-A');
          fixture.git(source.workspacePath, 'commit', '-m', message.source);
          return process.send(source);
        }
        if (message.checkout) {
          flags = {};
          fixture.git(fixture.repo, 'switch', '-c', message.checkout);
          const sessionId = await fixture.createBoundSession();
          return process.send({ sessionId, workspacePath: fixture.repo, branch: message.checkout });
        }
        if (message.remote) {
          const remote = path.join(fixture.repo, '..', 'origin.git');
          fixture.git(fixture.repo, 'init', '--bare', remote);
          fixture.git(fixture.repo, 'remote', 'add', 'origin', remote);
          fixture.git(fixture.repo, 'push', '-u', 'origin', 'main');
          return process.send({ acknowledged: true });
        }
        if (message.observe) return process.send({ bindings: loadBindings(), closed: [...fixture.closedSessions()], stopped });
        flags = message;
        process.send({ acknowledged: true });
      });
      process.once('SIGTERM', () => fixture.close().then(() => process.exit(0)));
      const health = await fixture.get('/api/health');
      process.send({ base: new URL(health.url).origin, repo: fixture.repo, projectId: fixture.projectId });
    `], { env: { PATH: `${bin}${path.delimiter}${path.dirname(realGit)}:/usr/bin:/bin`, HOME: tmp, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PI_WEB_UI_ONLY: "0", PI_WEB_PRESTART_COMMAND: "", PI_TEST_CONTROL: control, PI_TEST_MARKER: marker, PI_TEST_RELEASE: release, PI_TEST_REAL_GIT: realGit }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const [{ base, repo, projectId }] = await Promise.race([once(child, "message"), delay(10_000).then(() => { throw new Error(`startup timeout: ${output}`); })]);
    const git = (...args) => execFileSync(realGit, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const command = async message => { const reply = once(child, "message"); child.send(message); return (await reply)[0]; };
    const request = async (route, method = "POST", body = {}) => {
      const response = await fetch(base + route, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      return { status: response.status, body: await response.json() };
    };
    const held = async (mode, source, method, change = null, body = {}) => {
      for (const file of [marker, release]) fs.rmSync(file, { force: true });
      fs.writeFileSync(control, mode);
      const route = method === "DELETE" ? `/api/projects/${projectId}/branches/${source.branch}` : `/api/sessions/${source.sessionId}/merge-local`;
      const operation = request(route, method, body).then(value => ({ value }), error => ({ error }));
      pending.push(operation);
      const deadline = Date.now() + 30_000; // matches the request timeout; git spawns are slow under parallel suite load
      while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await delay(10);
      assert.ok(fs.existsSync(marker), `hold ${mode}: ${output}`);
      const health = await fetch(base + "/api/health", { signal: AbortSignal.timeout(2_000) });
      assert.equal(health.status, 200);
      assert.equal(fs.existsSync(release), false);
      const refs = git("show-ref"), worktrees = git("worktree", "list", "--porcelain");
      const busy = await request(`/api/projects/${projectId}/fetch`);
      assert.equal(busy.status, 409);
      assert.equal(busy.body.error, "repository_busy");
      assert.equal(git("show-ref"), refs);
      assert.equal(git("worktree", "list", "--porcelain"), worktrees);
      if (change) await command(change);
      fs.writeFileSync(control, "");
      fs.writeFileSync(release, "go");
      const outcome = await operation;
      assert.equal(outcome.error, undefined, outcome.error?.stack || output);
      assert.equal((await request(`/api/projects/${projectId}/fetch`)).status, 200);
      return outcome.value;
    };
    let number = 0;
    const source = async () => { const branch = `feature-${++number}`; return { ...await command({ source: branch }), branch }; };
    for (const [mode, method] of [["read", "POST"], ["merge", "POST"], ["remove", "POST"], ["delete", "POST"], ["delete-read", "DELETE"], ["remove", "DELETE"], ["delete", "DELETE"]]) {
      const item = await source();
      const result = await held(mode, item, method);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(fs.existsSync(item.workspacePath), false);
      assert.equal((await command({ observe: true })).bindings[item.sessionId].workspacePath, repo);
    }
    const closed = await source();
    const closing = await held("delete-read", closed, "DELETE", { streaming: closed.sessionId }, { closeSessions: true });
    assert.equal(closing.status, 200, JSON.stringify(closing.body));
    assert.deepEqual(closing.body.closedSessionIds, [closed.sessionId]);
    assert.ok((await command({ observe: true })).closed.includes(closed.sessionId));
    const forced = await source();
    fs.writeFileSync(path.join(forced.workspacePath, "README.md"), "local edit\n");
    fs.writeFileSync(path.join(forced.workspacePath, "untracked.txt"), "local untracked\n");
    const force = await held("delete-read", forced, "DELETE", null, { force: true });
    assert.equal(force.status, 200, JSON.stringify(force.body));
    assert.equal(fs.existsSync(forced.workspacePath), false);
    const streamed = await source(), beforeStreamed = git("show-ref");
    const streamedResult = await held("read", streamed, "POST", { streaming: streamed.sessionId });
    assert.equal(streamedResult.status, 409);
    assert.equal(streamedResult.body.error, "sessions_active");
    assert.equal(git("show-ref"), beforeStreamed);
    assert.equal(fs.existsSync(streamed.workspacePath), true);
    const failed = await source(), before = git("show-ref");
    assert.equal((await held("merge-fail", failed, "POST")).body.error, "merge_conflict");
    assert.equal(git("show-ref"), before);
    assert.equal(fs.existsSync(failed.workspacePath), true);
    for (const mode of ["remove-fail", "delete-fail"]) {
      const item = await source();
      const result = await held(mode, item, "DELETE");
      assert.ok(result.status >= 400, JSON.stringify(result.body));
      assert.equal(git("rev-parse", `refs/heads/${item.branch}`).length, 40);
      if (mode === "remove-fail") assert.equal(fs.existsSync(item.workspacePath), true);
    }
    const checkout = await command({ checkout: 'checkout-streaming' });
    const checkoutDelete = await held('delete-read', checkout, 'DELETE', { streaming: checkout.sessionId });
    assert.equal(checkoutDelete.status, 200, JSON.stringify(checkoutDelete.body));
    assert.ok((await command({ observe: true })).stopped.includes(checkout.sessionId));
    assert.equal(git('branch', '--show-current'), 'main');
    await command({ remote: true });
    const lateFetch = await source(), beforeFetch = git('rev-parse', 'main');
    const fetchRefusal = await held('fetch', lateFetch, 'POST', { streaming: lateFetch.sessionId });
    assert.equal(fetchRefusal.status, 409);
    assert.equal(fetchRefusal.body.error, 'sessions_active');
    assert.equal(git('rev-parse', 'main'), beforeFetch);
    assert.equal(fs.existsSync(lateFetch.workspacePath), true);
    const rehome = await source();
    const result = await held("read", rehome, "POST", { failRehome: rehome.sessionId });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, "merge_rehome_failed");
    assert.equal(result.body.merged, rehome.branch);
    assert.equal(fs.existsSync(rehome.workspacePath), true);
    assert.equal(git("merge-base", "--is-ancestor", rehome.branch, "main"), "");
  } finally {
    fs.writeFileSync(control, ""); fs.writeFileSync(release, "go");
    if (child && child.exitCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM");
      if (!await Promise.race([exited.then(() => true), delay(2_000).then(() => false)])) { child.kill("SIGKILL"); await exited; }
    }
    await Promise.allSettled(pending);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
