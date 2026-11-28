import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createIsolatedServerFixture } from "./helpers/isolated-server-fixture.js";

let fixture;
let projectsDir;
const previous = process.env.PI_PROJECTS_DIR;

beforeEach(async () => {
  fixture = await createIsolatedServerFixture({ createProject: false });
  const source = fixture.makeRepo("source-code");
  projectsDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "piweb-pi-projects-"));
  const eco = path.join(projectsDir, "eco");
  fs.mkdirSync(path.join(eco, "repos"), { recursive: true });
  fs.writeFileSync(path.join(eco, "memory.md"), "# eco memory\n");
  fs.writeFileSync(path.join(eco, "project.json"), JSON.stringify({ id: "x", name: "eco", state: "active", repos: [{ name: "code", url: source, branch: "main" }] }));
  execFileSync("git", ["clone", "-q", source, path.join(eco, "repos", "code")]);
  process.env.PI_PROJECTS_DIR = projectsDir;
});

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  if (previous === undefined) delete process.env.PI_PROJECTS_DIR;
  else process.env.PI_PROJECTS_DIR = previous;
});

test("a pi project's repositories become projects grouped under it, its folder sessions under its folder, repository sessions under the repository", async () => {
  const first = await fixture.state();
  const project = first.projects.find(p => p.id === "pp-eco-code");
  assert.ok(project, "repository listed in project.json is a project");
  assert.equal(project.group, "eco");
  assert.equal(project.groupPath, path.join(projectsDir, "eco"));
  assert.deepEqual(first.piProjects.map(p => p.name), ["eco"]);

  const { loadConfig } = await import("../server/config.js");
  const entry = loadConfig().projects.find(p => p.id === "pp-eco-code");
  assert.equal(entry.worktreeRoot, path.join(projectsDir, "eco", "worktrees", "code"));
  const { worktreeTarget } = await import("../server/config.js");
  assert.deepEqual(worktreeTarget(loadConfig(), entry), { worktreeRoot: entry.worktreeRoot, projectId: "" });

  // A session started at the project folder (laptop default) lists under the project's folder entry, not a repository.
  const root = await fixture.supervisor.createSession({ cwd: path.join(projectsDir, "eco") });
  await fixture.post(`/api/sessions/${root.id}/message`, { text: "hello" });
  const second = await fixture.state();
  assert.ok(second.projects.find(p => p.id === "pp-eco").sessions.some(s => s.id === root.id), "root session belongs to the project folder");
  assert.equal(second.projects.find(p => p.id === "pp-eco-code").sessions.some(s => s.id === root.id), false);
  // A session that ran in one of its repositories is a repository session: it lists under that repository.
  const inRepo = await fixture.supervisor.createSession({ cwd: path.join(projectsDir, "eco", "repos", "code") });
  await fixture.post(`/api/sessions/${inRepo.id}/message`, { text: "hello" });
  const third = await fixture.state();
  assert.deepEqual(third.projects.find(p => p.id === "pp-eco").sessions.map(s => s.id), [root.id]);
  assert.deepEqual(third.projects.find(p => p.id === "pp-eco-code").sessions.map(s => s.id), [inRepo.id]);
  assert.deepEqual(third.projects.find(p => p.id === "pp-eco-code").checkoutSync, [], "pi-sync's checkout state is listed per repository");
  assert.equal(third.projects.find(p => p.id === "pp-eco").sessions[0].contextId, "folder");

  // Removing the repository drops it from project.json too.
  const removed = await fixture.remove("/api/projects/pp-eco-code");
  assert.equal(removed.status, 200);
  const data = JSON.parse(fs.readFileSync(path.join(projectsDir, "eco", "project.json"), "utf8"));
  assert.deepEqual(data.repos, []);
  assert.equal((await fixture.state()).projects.some(p => p.id === "pp-eco-code"), false);
});

test("an archived pi project's repositories are not served", async () => {
  const file = path.join(projectsDir, "eco", "project.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), state: "archived" }));
  const state = await fixture.state();
  assert.equal(state.projects.length, 0);
  assert.deepEqual(state.piProjects, []);
});

test("a project worker sparse-clones only its project from the state repo, and creates new projects there", async () => {
  const { ensureProjectFolder } = await import("../server/pi-projects.js");
  const base = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "piweb-state-"));
  const remote = path.join(base, "state.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const seed = path.join(base, "seed");
  execFileSync("git", ["clone", "-q", remote, seed]);
  for (const name of ["eco", "other"]) {
    fs.mkdirSync(path.join(seed, name), { recursive: true });
    fs.writeFileSync(path.join(seed, name, "project.json"), JSON.stringify({ id: name, name, state: "active", repos: [] }));
    fs.writeFileSync(path.join(seed, name, "memory.md"), `# ${name}\n`);
  }
  const g = (...args) => execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  g("add", "-A"); g("commit", "-q", "-m", "seed"); g("push", "-q", "origin", "main");

  const dir = path.join(base, "worker", "projects");
  const env = { ...process.env, PI_PROJECTS_DIR: dir, PI_WEB_PROJECT: "eco", PI_PROJECTS_STATE_REMOTE: remote };
  assert.equal(await ensureProjectFolder(env), path.join(dir, "eco"));
  assert.ok(fs.existsSync(path.join(dir, "eco", "project.json")));
  assert.equal(fs.existsSync(path.join(dir, "other")), false, "other projects stay out of this worker");

  const fresh = { ...env, PI_WEB_PROJECT: "brand-new", PI_PROJECTS_DIR: path.join(base, "worker2", "projects") };
  await ensureProjectFolder(fresh);
  execFileSync("git", ["-C", seed, "pull", "-q"]);
  assert.ok(fs.existsSync(path.join(seed, "brand-new", "project.json")), "a new project is pushed to the state repo");
});

test("web creates a named pi project when PI_PROJECTS_DIR is set", async () => {
  const res = await fixture.post("/api/projects", { project: "fresh" });
  assert.equal(res.status, 201);
  assert.ok(fs.existsSync(path.join(projectsDir, "fresh", "project.json")));
  const state = await fixture.state();
  assert.equal(state.piProjectsEnabled, true);
  assert.ok(state.piProjects.some(p => p.name === "fresh"));
  assert.equal((await fixture.post("/api/projects", { project: "fresh" })).status, 409);
});

test("a repository being cloned is not served until its clone is complete", async () => {
  const { reconcile } = await import("../server/pi-projects.js");
  const source = fixture.makeRepo("clone-me");
  const dir = path.join(projectsDir, "cl");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ id: "x", name: "cl", state: "active", repos: [{ name: "clone-me", url: source }] }));
  const cfg = { projects: [] };
  reconcile(cfg, { env: { PI_PROJECTS_DIR: projectsDir } });
  const dest = path.join(dir, "repos", "clone-me");
  assert.equal(fs.existsSync(dest), false, "nothing at the destination while cloning");
  for (let i = 0; i < 100 && !fs.existsSync(dest); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(fs.existsSync(path.join(dest, ".git")));
  assert.equal(fs.existsSync(`${dest}.cloning`), false);
  reconcile(cfg, { env: { PI_PROJECTS_DIR: projectsDir } });
  assert.ok(cfg.projects.some(p => p.name === "clone-me" && p.group === "cl"));
});

test("a repository whose URL is a local path missing on this machine is not cloned, on any state call", async () => {
  const { reconcile } = await import("../server/pi-projects.js");
  const here = fixture.makeRepo("here");
  const dir = path.join(projectsDir, "lp");
  fs.mkdirSync(dir, { recursive: true });
  const repos = [
    { name: "laptop-only", url: "/Users/someone/dev/laptop-only" },
    { name: "laptop-file", url: "file:///Users/someone/dev/laptop-file" },
    { name: "here", url: here },
    { name: "hosted", url: "https://github.com/bry-guy/pi-web.git" },
    { name: "hosted-ssh", url: "git@github.com:bry-guy/pi-sync.git" },
  ];
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ id: "x", name: "lp", state: "active", repos }));
  const asked = [];
  for (let call = 0; call < 2; call++) reconcile({ projects: [] }, { env: { PI_PROJECTS_DIR: projectsDir }, clone: repo => asked.push(repo.name) });
  assert.deepEqual(asked.filter(name => name !== "code"), ["here", "hosted", "hosted-ssh", "here", "hosted", "hosted-ssh"], "the two that can never clone here are left alone");
});

test("a closed conversation past the closed list's cut-off is still listed, with the synced conversations", async () => {
  const { syncListServer } = await import("./helpers/sync-list-server.js");
  const folder = path.join(projectsDir, "eco");
  const ids = [];
  // 22 closed conversations in the project folder, the first the oldest; the first has a fork closed with it.
  for (let i = 0; i < 22; i++) {
    const { id } = await fixture.supervisor.createSession({ cwd: folder, name: `talk ${i}` });
    const file = path.join(process.env.PI_WEB_HOME, "mock-sessions", `${id}.json`);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...stored, modified: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() }));
    ids.push(id);
  }
  const open = (await fixture.supervisor.createSession({ cwd: folder, name: "open talk" })).id;
  const closed = fixture.closedSessions();
  for (const id of ids) closed.add(id);
  const { saveClosed } = await import("../server/config.js");
  saveClosed(closed);

  const listed = (await fixture.state()).projects.find(p => p.id === "pp-eco").closed.map(item => item.id);
  assert.deepEqual(listed, ids.slice(2).reverse(), "the closed list is the newest 20");

  // The sync server has the two past the cut-off, one inside it, the open one, and one this machine never had.
  const sync = await syncListServer([ids[0], ids[1], ids[21], open, "elsewhere-only"].map(sessionId => ({ sessionId, project: "eco" })));
  const previousUrl = process.env.PI_SYNC_SERVER_URL;
  process.env.PI_SYNC_SERVER_URL = sync.url;
  try {
    const synced = (await (await fixture.get("/api/projects/pp-eco/synced-sessions")).json()).sessions.map(item => item.sessionId).sort();
    // The one inside the cut-off is in both lists; the menu shows it once, from the closed list.
    assert.deepEqual(synced, [ids[0], ids[1], ids[21], "elsewhere-only"].sort(), "closed ones are listed, so none past the cut-off is unreachable");
    // Opening one from that list opens the copy here.
    const before = (await fixture.supervisor.allSessions()).length;
    const opened = await fixture.post("/api/projects/pp-eco/sessions", { mode: "synced", syncSessionId: ids[0] });
    assert.equal(opened.status, 200);
    assert.equal((await opened.json()).id, ids[0]);
    assert.equal((await fixture.supervisor.allSessions()).length, before);
    assert.ok((await fixture.state()).projects.find(p => p.id === "pp-eco").sessions.some(s => s.id === ids[0]), "and it is on the sidebar");
  } finally {
    if (previousUrl === undefined) delete process.env.PI_SYNC_SERVER_URL;
    else process.env.PI_SYNC_SERVER_URL = previousUrl;
    await sync.close();
  }
});

test("GitHub SSH remotes clone over HTTPS on web", async () => {
  const { cloneUrl } = await import("../server/pi-projects.js");
  assert.equal(cloneUrl("ssh://git@github.com/bry-guy/pi-web.git"), "https://github.com/bry-guy/pi-web.git");
  assert.equal(cloneUrl("ssh://git@github.com/bry-guy/pi-worktree-include"), "https://github.com/bry-guy/pi-worktree-include.git");
  assert.equal(cloneUrl("git@github.com:bry-guy/pi-sync.git"), "https://github.com/bry-guy/pi-sync.git");
  assert.equal(cloneUrl("https://gitlab.com/a/b.git"), "https://gitlab.com/a/b.git");
});

test("a pi project with no repositories lists, creates and opens sessions in its folder, without Git", async () => {
  const bare = path.join(projectsDir, "bare");
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, "project.json"), JSON.stringify({ id: "y", name: "bare", state: "active", repos: [] }));
  const folder = (await fixture.state()).projects.find(p => p.id === "pp-bare");
  assert.ok(folder, "the project folder is listed");
  assert.equal(folder.kind, "folder");
  assert.equal(folder.group, "bare");
  assert.deepEqual(folder.sessions, []);

  const res = await fixture.post("/api/projects/pp-bare/sessions", { branch: "main" });
  assert.equal(res.status, 200);
  const created = await res.json();
  assert.equal(created.workspacePath, bare);
  assert.equal(created.branch, null);
  await fixture.post(`/api/sessions/${created.id}/message`, { text: "hello" });
  const listed = (await fixture.state()).projects.find(p => p.id === "pp-bare");
  assert.deepEqual(listed.sessions.map(s => [s.id, s.contextId, s.branch]), [[created.id, "folder", null]]);
  // Git routes do not apply to the folder (it sits in the projects state repo).
  assert.equal((await fixture.post("/api/projects/pp-bare/fetch", {})).status, 404);
});
