// pi-projects integration: a pi project (a folder under PI_PROJECTS_DIR with
// project.json, memory.md, repos/ and worktrees/) groups several of web's
// projects, one per repository it lists. project.json is the source of truth;
// config.json entries for its repositories are derived from it.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const cloning = new Set();

/** PI_PROJECTS_DIR when set, else null: without it web ignores pi projects. */
export function piProjectsDir(env = process.env) {
  const raw = env.PI_PROJECTS_DIR;
  if (!raw) return null;
  return path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
}

function readProject(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** Pi projects web serves: only PI_WEB_PROJECT on a project worker, else every active one. */
export function listPiProjects(env = process.env) {
  const root = piProjectsDir(env);
  if (!root || !fs.existsSync(root)) return [];
  const only = env.PI_WEB_PROJECT || null;
  const names = only ? [only] : fs.readdirSync(root).sort();
  const out = [];
  for (const name of names) {
    if (!NAME.test(name)) continue;
    const dir = path.join(root, name);
    const data = readProject(dir);
    if (!data || data.state === "archived") continue;
    const repos = (Array.isArray(data.repos) ? data.repos : []).filter(r => r && NAME.test(String(r.name || "").toLowerCase()) && typeof r.url === "string");
    out.push({ name, path: dir, id: data.id || null, repos });
  }
  return out;
}

export function piProject(name, env = process.env) {
  return listPiProjects(env).find(p => p.name === name) || null;
}

/** Web's project entry for one repository of a pi project; the id is stable across machines. */
export function repoEntry(group, repo) {
  return {
    id: `pp-${group.name}-${repo.name}`,
    name: repo.name,
    repoPath: path.join(group.path, "repos", repo.name),
    group: group.name,
    worktreeRoot: path.join(group.path, "worktrees", repo.name),
    source: { type: "git-url", url: repo.url },
  };
}

/**
 * Bring config.projects in line with project.json: add entries for cloned
 * repositories, drop entries whose repository the project no longer lists.
 * Repositories not cloned here start cloning in the background. Returns true when cfg changed.
 */
export function reconcile(cfg, { env = process.env, clone = cloneInBackground } = {}) {
  const root = piProjectsDir(env);
  if (!root) return false;
  const groups = listPiProjects(env);
  const wanted = new Map();
  for (const group of groups) {
    for (const repo of group.repos) {
      const entry = repoEntry(group, repo);
      if (fs.existsSync(path.join(entry.repoPath, ".git"))) wanted.set(entry.id, entry);
      else clone(repo, entry.repoPath);
    }
  }
  let changed = false;
  const wantedPaths = new Set([...wanted.values()].map(e => e.repoPath));
  // Entries of archived, deleted or other workers' projects, or of repositories project.json dropped, go.
  const kept = cfg.projects.filter(p => {
    if (!p.group || wantedPaths.has(path.resolve(p.repoPath))) return true;
    changed = true;
    return false;
  });
  for (const entry of wanted.values()) {
    const existing = kept.find(p => p.id === entry.id || path.resolve(p.repoPath) === entry.repoPath);
    if (!existing) { kept.push({ ...entry, hooks: {} }); changed = true; }
    else if (existing.group !== entry.group || existing.worktreeRoot !== entry.worktreeRoot) {
      Object.assign(existing, { group: entry.group, worktreeRoot: entry.worktreeRoot });
      changed = true;
    }
  }
  cfg.projects = kept;
  return changed;
}

function cloneInBackground(repo, dest) {
  if (cloning.has(dest)) return;
  cloning.add(dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const args = ["clone", ...(repo.branch ? ["--branch", repo.branch] : []), repo.url, dest];
  execFile("git", args, { timeout: 15 * 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, () => cloning.delete(dest));
}

function git(cwd, args) {
  return new Promise((resolve, reject) => execFile("git", args, { cwd, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) =>
    error ? reject(new Error(stderr.trim().split("\n").at(-1) || error.message)) : resolve(stdout.trim())));
}

let chain = Promise.resolve();
/** Commit and push project.json/memory.md changes when PI_PROJECTS_DIR is a git repo (pi-projects' state repo). */
export function pushState(message, env = process.env) {
  const root = piProjectsDir(env);
  if (!root || !fs.existsSync(path.join(root, ".git"))) return Promise.resolve(false);
  const run = async () => {
    await git(root, ["add", "-A"]);
    if (await git(root, ["diff", "--cached", "--name-only"])) {
      await git(root, ["-c", "user.name=pi-projects", "-c", "user.email=pi-projects@localhost", "commit", "-q", "-m", message]);
    }
    try { await git(root, ["push", "-q"]); }
    catch { await git(root, ["pull", "-q", "--rebase"]); await git(root, ["push", "-q"]); }
    return true;
  };
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

function writeProject(dir, data) {
  const file = path.join(dir, "project.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`);
  fs.renameSync(tmp, file);
}

/** Record a repository in a pi project's project.json (replacing one with the same name). */
export function recordRepo(groupName, repo, env = process.env) {
  const group = piProject(groupName, env);
  if (!group) throw Object.assign(new Error("no_such_pi_project"), { code: "no_such_pi_project" });
  const data = readProject(group.path);
  data.repos = [...(data.repos || []).filter(r => r.name !== repo.name), repo];
  writeProject(group.path, data);
  return group;
}

/** Forget a repository; its clone stays on disk like any removed project's checkout. */
export function forgetRepo(groupName, repoName, env = process.env) {
  const group = piProject(groupName, env);
  if (!group) return null;
  const data = readProject(group.path);
  data.repos = (data.repos || []).filter(r => r.name !== repoName);
  writeProject(group.path, data);
  return group;
}

/** Root-level sessions (cwd = the project folder) belong to the group's first repository's entry. */
export function primaryOfGroup(cfg, groupName) {
  return cfg.projects.find(p => p.group === groupName) || null;
}
