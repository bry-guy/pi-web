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

test("a pi project's repositories become projects grouped under it, with its root sessions", async () => {
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

  // A session started at the project folder (laptop default) lists under the project's first repository.
  const root = await fixture.supervisor.createSession({ cwd: path.join(projectsDir, "eco") });
  await fixture.post(`/api/sessions/${root.id}/message`, { text: "hello" });
  const second = await fixture.state();
  const ids = second.projects.find(p => p.id === "pp-eco-code").sessions.map(s => s.id);
  assert.ok(ids.includes(root.id), "root session belongs to the pi project");

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
