import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_KEYS = [
  "PI_WEB_HOME",
  "PI_WEB_MODE",
  "PI_WEB_MOCK_THINK_MS",
  "PI_WEB_MOCK_DELTA_MS",
  "PI_WEB_REPOS_ROOT",
];

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

function saveEnvironment() {
  return new Map(ENV_KEYS.map(key => [key, process.env[key]]));
}

function restoreEnvironment(previous) {
  for (const key of ENV_KEYS) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export async function createIsolatedServerFixture({ createProject: createInitialProject = true } = {}) {
  const previous = saveEnvironment();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-srv-isolated-"));
  const home = path.join(tmp, "home");
  const reposRoot = path.join(tmp, "local-repositories");
  const repo = path.join(reposRoot, "repo");
  let server;
  let supervisor;
  const initialProjectId = "p-isolated";
  let projectId = createInitialProject ? initialProjectId : null;
  let mainSessionId = null;
  let closed = false;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    supervisor?.stopAll?.();
    server?.closeAllConnections?.();
    await new Promise(resolve => {
      if (!server?.listening) return resolve();
      server.close(() => resolve());
    });
    restoreEnvironment(previous);
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  try {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "init");

    fs.mkdirSync(home, { recursive: true });
    const config = {
      reposRoot,
      worktreeRoot: path.join(home, "worktrees"),
      projects: createInitialProject ? [{ id: initialProjectId, name: "repo", repoPath: repo, source: { type: "local" }, hooks: {} }] : [],
    };
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
    delete process.env.PI_WEB_REPOS_ROOT;
    process.env.PI_WEB_HOME = home;
    process.env.PI_WEB_MODE = "mock";
    process.env.PI_WEB_MOCK_THINK_MS = "0";
    process.env.PI_WEB_MOCK_DELTA_MS = "0";

    const { startServer } = await import("../../server/index.js");
    const { loadBindings, loadClosed, loadConfig, newId, normalizeHooks, saveBindings, saveConfig } = await import("../../server/config.js");
    const { projectHooks } = await import("../../server/hooks.js");
    const ws = await import("../../server/workspaces.js");
    ({ server, sup: supervisor } = startServer(0));
    if (createInitialProject) {
      mainSessionId = (await supervisor.createSession({ cwd: repo })).id;
      saveBindings({ [mainSessionId]: { projectId, workspacePath: repo } });
    }
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { "content-type": "application/json" };
    const post = (route, body) => fetch(base + route, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
    });
    const get = route => fetch(base + route);
    const remove = route => fetch(base + route, { method: "DELETE", headers, body: "{}" });
    const state = async () => (await get("/api/state")).json();
    const project = async (id = projectId) => {
      const snapshot = await state();
      return snapshot.projects.find(item => item.id === id);
    };
    // Projects normally come from a GitHub or Git URL clone; tests register an existing checkout directly.
    const createProject = async ({ repoPath: dir, name, hooks } = {}) => {
      const cfg = loadConfig();
      if (cfg.projects.some(item => item.repoPath === dir)) return { error: "project_exists" };
      const created = { id: newId("p") };
      cfg.projects.push({ id: created.id, name: name || path.basename(dir), repoPath: dir, source: { type: "git-url" }, hooks: normalizeHooks(hooks) });
      saveConfig(cfg);
      created.sessionId = (await supervisor.createSession({ cwd: dir })).id;
      saveBindings({ ...loadBindings(), [created.sessionId]: { projectId: created.id, workspacePath: dir } });
      Object.assign(created, { repoPath: dir, setup: null, setupNeeded: !!projectHooks(loadConfig(), loadConfig().projects.find(item => item.id === created.id)).setup });
      if (projectId === null) {
        projectId = created.id;
        mainSessionId = created.sessionId;
      }
      return created;
    };
    const makeRepo = name => {
      const dir = path.join(tmp, name);
      fs.mkdirSync(dir, { recursive: true });
      git(dir, "init", "-b", "main");
      git(dir, "config", "user.email", "t@t");
      git(dir, "config", "user.name", "t");
      fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-m", "init");
      return dir;
    };
    const createBoundSession = async (cwd = repo) => {
      const created = await supervisor.createSession({ cwd });
      const bindings = loadBindings();
      bindings[created.id] = { projectId, workspacePath: cwd };
      saveBindings(bindings);
      return created.id;
    };
    const checkoutSession = async () => {
      const createdChat = await (await post("/api/chats")).json();
      const sessionFile = path.join(home, "mock-sessions", `${createdChat.id}.json`);
      const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      session.cwd = repo;
      fs.writeFileSync(sessionFile, JSON.stringify(session));
      return createdChat.id;
    };
    const createWorktreeSession = async branch => {
      const sessionId = await createBoundSession();
      const workspacePath = ws.ensureWorkspace({
        repoPath: repo,
        worktreeRoot: path.join(home, "worktrees"),
        projectId,
        branch,
      });
      await supervisor.rehome(sessionId, workspacePath);
      const bindings = loadBindings();
      bindings[sessionId] = { projectId, workspacePath };
      saveBindings(bindings);
      return { sessionId, workspacePath };
    };

    return {
      get,
      remove,
      git,
      makeRepo,
      post,
      project,
      state,
      createProject,
      repo,
      checkoutSession,
      createBoundSession,
      createWorktreeSession,
      closedSessions: loadClosed,
      mainSessionId,
      projectId,
      close: cleanup,
      supervisor,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
