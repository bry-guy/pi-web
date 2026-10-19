import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { reposRoot, resolvePath } from "./config.js";
import { gitCredentialEnvironment } from "./git-credentials.js";
import { validateFullName, githubError } from "./github.js";

const execFileAsync = promisify(execFile);
const cloneLocks = new Set();

function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function redacted(value) {
  return String(value || "")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/gh[oprsu]_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/([?&](?:code|state|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]");
}

function publicGitUrl(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch { throw coded("invalid_git_url"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw coded("invalid_git_url");
  url.hash = "";
  // Query parameters are not needed for a public clone and can accidentally
  // carry a credential or tracking value into Git's process arguments.
  url.search = "";
  return url.toString();
}

function repositoryNameFromUrl(url) {
  const value = path.basename(new URL(url).pathname).replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw coded("invalid_git_url");
  return value;
}

function safeDestination(root, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw coded("invalid_repository_name");
  const base = resolvePath(root);
  const destination = path.resolve(base, name);
  const relative = path.relative(base, destination);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw coded("invalid_repository_name");
  }
  return { base, destination };
}

function gitOptions({ token, signal }) {
  const args = token ? ["clone", "--"] : ["-c", "credential.helper=", "clone", "--"];
  // A user's global `url.*.insteadOf` can silently turn a validated public
  // HTTPS URL into SSH (or another protocol). Cloning starts in an empty temp
  // directory, so ignoring global/system Git config is safe and preserves the
  // public-HTTPS-only source boundary.
  const source = { ...process.env };
  delete source.PI_WEB_GITHUB_TOKEN;
  delete source.PI_WEB_GIT_TOKEN;
  let env;
  if (token) {
    env = gitCredentialEnvironment({ ...source, PI_WEB_GITHUB_TOKEN: token });
  } else {
    env = { ...source, GIT_TERMINAL_PROMPT: "0" };
    delete env.GIT_ASKPASS;
    delete env.GIT_ASKPASS_REQUIRE;
  }
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_NOSYSTEM = "1";
  return { args, env, signal };
}

export function parsePublicGitUrl(raw) { return publicGitUrl(raw); }

export async function cloneRepository({ source, url, fullName, github, root = reposRoot(), signal, runGit = execFileAsync }) {
  let cloneUrl;
  let name;
  let sourceInfo;
  let token = null;
  if (source === "github") {
    const repo = await github.repository(validateFullName(fullName));
    cloneUrl = repo.cloneUrl;
    name = repo.name;
    sourceInfo = { type: "github", fullName: repo.fullName };
    token = github.effectiveAuth()?.accessToken || null;
    // Public metadata and public HTTPS cloning intentionally work before a
    // device login. Private GitHub repositories still require the stored or
    // environment-managed OAuth token.
    if (repo.private && !token) throw githubError("github_auth_required");
  } else if (source === "git-url") {
    cloneUrl = publicGitUrl(url);
    name = repositoryNameFromUrl(cloneUrl);
    sourceInfo = { type: "git-url", url: cloneUrl };
  } else {
    throw coded("unsupported_repository_source");
  }

  const { base, destination } = safeDestination(root, name);
  const lockKey = destination;
  if (cloneLocks.has(lockKey)) throw coded("clone_in_progress");
  if (fs.existsSync(destination)) throw coded("repository_exists");
  cloneLocks.add(lockKey);
  let temporary = null;
  try {
    fs.mkdirSync(base, { recursive: true });
    temporary = fs.mkdtempSync(path.join(base, `.pi-ez-clone-${randomUUID()}-`));
    const options = gitOptions({ token, signal });
    await runGit("git", [...options.args, cloneUrl, temporary], {
      cwd: base,
      env: options.env,
      signal,
      timeout: 10 * 60 * 1000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (fs.existsSync(destination)) throw coded("repository_exists");
    fs.renameSync(temporary, destination);
    return { repoPath: destination, name, source: sourceInfo, cloned: true };
  } catch (error) {
    if (error?.code === "repository_exists") throw error;
    const failure = coded("clone_failed", "Git could not clone this repository.");
    failure.detail = redacted(error?.stderr || error?.message || error);
    throw failure;
  } finally {
    try {
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
    } finally {
      cloneLocks.delete(lockKey);
    }
  }
}
