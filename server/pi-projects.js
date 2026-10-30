// pi-projects integration: a pi project (a folder under PI_PROJECTS_DIR with
// project.json, memory.md, repos/ and worktrees/) groups several of web's
// projects, one per repository it lists. project.json is the source of truth;
// config.json entries for its repositories are derived from it.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gitCredentialEnvironment } from "./git-credentials.js";

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
  // Clone beside the destination and move it in when done, so a half-cloned repository never looks cloned.
  const tmp = `${dest}.cloning`;
  fs.rmSync(tmp, { recursive: true, force: true });
  const args = ["clone", ...(repo.branch ? ["--branch", repo.branch] : []), cloneUrl(repo.url), tmp];
  execFile("git", args, { timeout: 15 * 60_000, env: { ...gitCredentialEnvironment(), GIT_TERMINAL_PROMPT: "0" } }, (error, _stdout, stderr) => {
    if (error) console.warn(`pi-projects: could not clone ${repo.url}: ${String(stderr || error.message).trim().split("\n").at(-1)}`);
    try { if (!error && !fs.existsSync(dest)) fs.renameSync(tmp, dest); else fs.rmSync(tmp, { recursive: true, force: true }); }
    finally { cloning.delete(dest); }
  });
}

/** GitHub SSH remotes (as cloned on a laptop) as HTTPS: web authenticates to GitHub over HTTPS only. */
export function cloneUrl(url) {
  const m = /^(?:ssh:\/\/)?git@github\.com[:/](.+?)(?:\.git)?\/?$/.exec(url);
  return m ? `https://github.com/${m[1]}.git` : url;
}

// GitHub HTTPS remotes authenticate through web's credential helper (the login web shares with workers).
function git(cwd, args, timeout = 60_000) {
  return new Promise((resolve, reject) => execFile("git", args, { cwd, timeout, env: gitCredentialEnvironment() }, (error, stdout, stderr) =>
    error ? reject(new Error(stderr.trim().split("\n").at(-1) || error.message)) : resolve(stdout.trim())));
}

/**
 * On a project worker (PI_WEB_PROJECT): make sure its folder exists under PI_PROJECTS_DIR.
 * With PI_PROJECTS_STATE_REMOTE, PI_PROJECTS_DIR is a sparse clone of pi-projects' state repo holding only
 * this project (pulled on every start); otherwise a new project folder is created locally.
 */
export async function ensureProjectFolder(env = process.env, log = console.log) {
  const name = env.PI_WEB_PROJECT;
  const root = piProjectsDir(env);
  if (!name || !root || !NAME.test(name)) return null;
  const dir = path.join(root, name);
  const remote = env.PI_PROJECTS_STATE_REMOTE || "";
  if (remote) {
    if (!fs.existsSync(path.join(root, ".git"))) {
      fs.mkdirSync(path.dirname(root), { recursive: true });
      await git(path.dirname(root), ["clone", "-q", "--filter=blob:none", "--no-checkout", remote, root], 10 * 60_000);
      await git(root, ["sparse-checkout", "set", "--no-cone", `/${name}/`, "/.gitignore", "/.gitattributes"]);
      await git(root, ["checkout", "-q"]);
    } else {
      await git(root, ["pull", "-q", "--rebase"]).catch(error => log(`pi-projects: could not pull ${name}: ${error.message}`));
    }
  }
  if (!fs.existsSync(path.join(dir, "project.json"))) {
    // A project new to the state repo (or without one): create it the way pi-projects does.
    for (const sub of ["repos", "worktrees", "artifacts"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.writeFileSync(path.join(dir, "memory.md"), `# ${name} memory\n`);
    writeProject(dir, { id: randomUUID(), name, state: "active", created: new Date().toISOString(), memory: { enabled: true }, repos: [] });
    if (remote) await pushState(`${name}: new`, env).catch(error => log(`pi-projects: could not push ${name}: ${error.message}`));
  }
  for (const sub of ["repos", "worktrees", "artifacts"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
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

/** Create a pi project folder (as pi-projects does) and sync it when PI_PROJECTS_DIR is a state repo. */
export async function createPiProject(name, env = process.env) {
  const root = piProjectsDir(env);
  if (!root) throw Object.assign(new Error("pi_projects_disabled"), { code: "pi_projects_disabled" });
  if (!NAME.test(name)) throw Object.assign(new Error("invalid_project_name"), { code: "invalid_project_name" });
  const dir = path.join(root, name);
  if (fs.existsSync(dir)) throw Object.assign(new Error("project_exists"), { code: "project_exists" });
  await ensureProjectFolder({ ...env, PI_WEB_PROJECT: name, PI_PROJECTS_STATE_REMOTE: "" });
  await pushState(`${name}: new`, env).catch(error => console.warn(`pi-projects: could not sync ${name}: ${error.message}`));
  return dir;
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
