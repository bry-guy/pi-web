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
