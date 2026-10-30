// Pi configuration overlay for the web runtime.
//
// Pi "profiles" are normally just alternate PI_CODING_AGENT_DIR directories.
// pi-ez-web keeps credentials and sessions in its configured agent directory,
// but can layer the declarative settings.json from another directory or HTTPS
// URL over each SDK session. Packages from that profile are installed by Pi's
// normal DefaultResourceLoader into the persistent agent directory.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appHome, effectivePiConfig, loadConfig, resolvePath } from "./config.js";
import { readStoredAuth } from "./github.js";

const MAX_PROFILE_BYTES = 512 * 1024;
const MAX_PROFILE_SKILL_BYTES = 128 * 1024;
const MAX_PROFILE_SKILL_TOTAL = 512 * 1024;
const MAX_PROFILE_SKILLS = 128;
const MAX_PROFILE_RESOURCES = 512;
const MAX_PROFILE_RESOURCE_BYTES = 256 * 1024;
const MAX_PROFILE_RESOURCE_TOTAL = 2 * 1024 * 1024;
const PROFILE_TIMEOUT_MS = 10_000;
const RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"];
const DEFAULT_NPM_COMMAND = ["npm", "--legacy-peer-deps", "--include=dev"];
export const WEB_SUBAGENT_EXTENSION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "extensions",
  "subagent-telemetry.js",
);

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function mergeSettings(base, override) {
  const result = isObject(base) ? clone(base) : {};
  if (!isObject(override)) return result;
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(result[key])) result[key] = mergeSettings(result[key], value);
    else result[key] = clone(value);
  }
  return result;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function sourceOf(pkg) {
  return typeof pkg === "string" ? pkg : isObject(pkg) && typeof pkg.source === "string" ? pkg.source : null;
}

function isLocalSource(source) {
  return /^(?:\.{0,2}\/|~(?:\/|$)|\/)/.test(source) || /^[A-Za-z]:[\\/]/.test(source);
}

function resolveEntry(entry, baseDir, remote, warnings, kind) {
  const rawSource = sourceOf(entry);
  if (!rawSource) return null;
  const source = rawSource.trim();
  if (!source) return null;
  if (!isLocalSource(source)) return typeof entry === "string" ? source : { ...entry, source };
  if (remote) {
    warnings.push(`Ignored remote profile ${kind} path ${source}; remote profiles can reference npm/git sources, not files on the server.`);
    return null;
  }
  const resolved = path.resolve(baseDir, source.replace(/^~(?=$|\/)/, process.env.HOME || "~"));
  return typeof entry === "string" ? resolved : { ...entry, source: resolved };
}

/** Profile packages this deployment leaves out (PI_WEB_SKIP_PACKAGES, comma-separated sources), e.g. laptop-only ones on workers. */
function skippedPackages(env = process.env) {
  return new Set(String(env.PI_WEB_SKIP_PACKAGES || "").split(",").map(item => item.trim()).filter(Boolean));
}

function prepareProfileSettings(value, { baseDir, remote, warnings }) {
  const settings = clone(value);
  // Session and credential storage always remain owned by the deployment's
  // PI_CODING_AGENT_DIR, even when importing another profile's behavior.
  delete settings.sessionDir;

  if (Array.isArray(settings.packages)) {
    const skip = skippedPackages();
    settings.packages = settings.packages
      .map(entry => resolveEntry(entry, baseDir, remote, warnings, "package"))
      .filter(entry => entry && !skip.has(sourceOf(entry)));
  }
  for (const key of RESOURCE_KEYS) {
    if (!Array.isArray(settings[key])) continue;
    settings[key] = settings[key]
      .map(entry => resolveEntry(entry, baseDir, remote, warnings, key.slice(0, -1)))
      .filter(Boolean);
  }
  return settings;
}

function inlineSettings(piConfig, warnings) {
  const baseDir = appHome();
  return {
    packages: piConfig.packages
      .map(entry => resolveEntry(entry, baseDir, false, warnings, "package"))
      .filter(Boolean),
    extensions: piConfig.extensions
      .map(entry => resolveEntry(entry, baseDir, false, warnings, "extension"))
      .filter(Boolean),
  };
}

function addInlineResources(settings, inline) {
  const result = clone(settings);
  if (inline.packages.length) result.packages = unique([...(result.packages || []), ...inline.packages]);
  if (inline.extensions.length) result.extensions = unique([...(result.extensions || []), ...inline.extensions]);
  return result;
}

function githubProfileParts(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, rawRepo, marker, ref, ...rest] = parts;
  return { owner, repo: rawRepo.replace(/\.git$/, ""), marker, ref, rest };
}

export function githubProfileRepository(input, refOverride = null) {
  const parts = githubProfileParts(input);
  if (!parts) return null;
  return {
    owner: parts.owner,
    repo: parts.repo,
    ref: refOverride || (parts.marker === "blob" || parts.marker === "tree" ? parts.ref || "HEAD" : "HEAD"),
    explicitRef: parts.marker === "blob" || parts.marker === "tree" ? parts.ref || null : null,
  };
}

export function githubProfileSettingsUrl(input, refOverride = null) {
  const parts = githubProfileParts(input);
  if (!parts) return input;
  const { owner, repo, marker, ref, rest } = parts;
  if (!marker) return `https://raw.githubusercontent.com/${owner}/${repo}/${refOverride || "HEAD"}/.pi/agent/settings.json`;
  if (marker === "blob" && ref && rest.length) {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join("/")}`;
  }
  if (marker === "tree" && ref) {
    const suffix = rest.length ? `${rest.join("/").replace(/\/$/, "")}/settings.json` : ".pi/agent/settings.json";
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${suffix}`;
  }
  return input;
}

function githubAuthHeaders(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname !== "api.github.com" && hostname !== "raw.githubusercontent.com") return {};
    const token = process.env.PI_WEB_GITHUB_TOKEN || readStoredAuth()?.accessToken;
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch { return {}; }
}

function profileLocation(source) {
  if (/^https:\/\//i.test(source)) {
    return { type: "url", requested: source, resolved: githubProfileSettingsUrl(source) };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    throw new Error("Pi profile URLs must use HTTPS.");
  }
  let file = resolvePath(source.startsWith("~") || path.isAbsolute(source) ? source : path.join(appHome(), source));
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, "settings.json"); } catch { /* read reports a useful error */ }
  return { type: "file", requested: source, resolved: file };
}

async function readRemoteJson(url, fetchImpl) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Pi profile URLs must be credential-free HTTPS URLs.");
  if (["localhost", "localhost.localdomain"].includes(parsed.hostname.toLowerCase())) throw new Error("Localhost Pi profile URLs are not allowed.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal, headers: { accept: "application/json", ...githubAuthHeaders(url) } });
    if (!response.ok) throw new Error(`Profile request returned HTTP ${response.status}.`);
    if (response.url && new URL(response.url).protocol !== "https:") throw new Error("Pi profile URL redirected away from HTTPS.");
    const declaredSize = Number(response.headers.get("content-length"));
    if (declaredSize > MAX_PROFILE_BYTES) throw new Error("Pi profile settings are too large.");
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > MAX_PROFILE_BYTES) throw new Error("Pi profile settings are too large.");
    return JSON.parse(new TextDecoder().decode(data));
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Pi profile request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveGithubProfileRef(source, fetchImpl) {
  const repository = githubProfileRepository(source);
  if (!repository) return null;
  if (repository.explicitRef) return repository.ref;
  const apiUrl = `https://api.github.com/repos/${repository.owner}/${repository.repo}`;
  try {
    const metadata = await readRemoteJson(apiUrl, fetchImpl);
    if (typeof metadata?.default_branch === "string" && metadata.default_branch.trim()) return metadata.default_branch.trim();
  } catch { /* public metadata is optional; raw branch fallback below is authoritative */ }
  for (const candidate of ["main", "master"]) {
    try {
      await readRemoteJson(githubProfileSettingsUrl(source, candidate), fetchImpl);
      return candidate;
    } catch { /* try the other conventional branch */ }
  }
  return null;
}

async function readRemoteText(url, fetchImpl, { maxBytes = MAX_PROFILE_SKILL_BYTES, label = "skill" } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Pi profile URLs must be credential-free HTTPS URLs.");
  if (["localhost", "localhost.localdomain"].includes(parsed.hostname.toLowerCase())) throw new Error("Localhost Pi profile URLs are not allowed.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROFILE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal, headers: { accept: "text/plain", ...githubAuthHeaders(url) } });
    if (!response.ok) throw new Error(`Profile ${label} request returned HTTP ${response.status}.`);
    if (response.url && new URL(response.url).protocol !== "https:") throw new Error("Pi profile skill URL redirected away from HTTPS.");
    const declaredSize = Number(response.headers.get("content-length"));
    if (declaredSize > maxBytes) throw new Error(`Pi profile ${label} is too large.`);
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maxBytes) throw new Error(`Pi profile ${label} is too large.`);
    return new TextDecoder().decode(data);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Pi profile skill request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function githubResourceUrl(repository, file) {
  return `https://raw.githubusercontent.com/${repository.owner}/${repository.repo}/${repository.ref}/${file}`;
}

const PROFILE_SKILL_PREFIXES = [".agents/skills/", ".pi/agent/skills/"];
const PROFILE_EXTENSION_PREFIXES = [".pi/agent/extensions/", ".pi/extensions/"];
function profileResourceKind(file, declaredExtensionPaths = []) {
  if (PROFILE_SKILL_PREFIXES.some(prefix => file.startsWith(prefix))) return "skill";
  if (PROFILE_EXTENSION_PREFIXES.some(prefix => file.startsWith(prefix))) return "extension";
  if (declaredExtensionPaths.some(prefix => file === prefix || file.startsWith(`${prefix}/`))) return "extension";
  return null;
}

async function fetchGithubProfileResources(source, fetchImpl, refOverride = null, declaredExtensionPaths = []) {
  const repository = githubProfileRepository(source, refOverride);
  if (!repository) return { ref: null, resources: [] };
  const treeUrl = `https://api.github.com/repos/${repository.owner}/${repository.repo}/git/trees/${repository.ref}?recursive=1`;
  const tree = await readRemoteJson(treeUrl, fetchImpl);
  const entries = (tree?.tree || [])
    .filter(entry => entry?.type === "blob" && typeof entry.path === "string"
      && profileResourceKind(entry.path, declaredExtensionPaths) && !entry.path.split("/").includes(".."))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (entries.filter(entry => profileResourceKind(entry.path, declaredExtensionPaths) === "skill" && entry.path.endsWith("/SKILL.md")).length > MAX_PROFILE_SKILLS) {
    throw new Error("Pi profile contains too many skills.");
  }
  if (entries.length > MAX_PROFILE_RESOURCES) throw new Error("Pi profile contains too many resources.");

  const resources = [];
  let total = 0;
  for (const entry of entries) {
    const kind = profileResourceKind(entry.path, declaredExtensionPaths);
    if (Number(entry.size) > MAX_PROFILE_RESOURCE_BYTES) throw new Error(`Pi profile ${kind} is too large: ${entry.path}`);
    const content = await readRemoteText(githubResourceUrl(repository, entry.path), fetchImpl, { maxBytes: MAX_PROFILE_RESOURCE_BYTES, label: kind });
    total += Buffer.byteLength(content, "utf8");
    if (total > MAX_PROFILE_RESOURCE_TOTAL) throw new Error("Pi profile resources are too large.");
    resources.push({ path: entry.path, content, kind });
  }
  return { ref: repository.ref, commit: typeof tree?.sha === "string" ? tree.sha : null, resources };
}

function profileResourcesRoot(location) {
  const key = createHash("sha256").update(`${location.resolved}@${location.ref || "HEAD"}`).digest("hex").slice(0, 24);
  return path.join(appHome(), "pi-profile-resources", key);
}

function remoteExtensionPaths(settings) {
  return (Array.isArray(settings?.extensions) ? settings.extensions : [])
    .map(sourceOf)
    .filter(source => source && /^\.\/?[^/]/.test(source) && !source.split("/").includes(".."))
    .map(source => source.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean);
}

function resourceRelativePath(value) {
  const relative = String(value || "").replaceAll("/", path.sep);
  return relative && !relative.split(path.sep).includes("..") ? relative : null;
}

function materializeProfileResources(location, resources) {
  const root = path.resolve(profileResourcesRoot(location));
  const stage = `${root}.stage-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const skillPaths = [];
  const extensionPaths = [];
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    for (const resource of resources || []) {
      const relative = resourceRelativePath(resource.path);
      if (!relative || typeof resource.content !== "string") continue;
      const target = path.resolve(stage, relative);
      if (!target.startsWith(`${stage}${path.sep}`)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, resource.content, { encoding: "utf8", mode: 0o600 });
      if (resource.kind === "skill" && target.endsWith(`${path.sep}SKILL.md`)) skillPaths.push(path.resolve(root, relative));
      if (resource.kind === "extension") extensionPaths.push(path.resolve(root, relative));
    }
    fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
    fs.rmSync(root, { recursive: true, force: true });
    fs.renameSync(stage, root);
    return { root, skillPaths, extensionPaths };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function readLocalJson(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("Pi profile must point to a settings.json file or profile directory.");
  if (stat.size > MAX_PROFILE_BYTES) throw new Error("Pi profile settings are too large.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function profileCachePath() { return path.join(appHome(), "pi-profile-cache.json"); }

function gitPackageSource(entry) {
  const source = sourceOf(entry)?.trim();
  if (!source?.startsWith("git:")) return null;
  let value = source.slice(4).trim();
  let host;
  let repoPath;
  if (value.startsWith("git@")) {
    const separator = value.indexOf(":", 4);
    if (separator < 0) return null;
    host = value.slice(4, separator);
    repoPath = value.slice(separator + 1);
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      host = url.hostname;
      repoPath = url.pathname.replace(/^\/+/, "");
    } catch { return null; }
  } else {
    const separator = value.indexOf("/");
    if (separator < 1) return null;
    host = value.slice(0, separator);
    repoPath = value.slice(separator + 1);
  }
  repoPath = repoPath.replace(/\.git$/, "").replace(/@[^/]+$/, "");
  const parts = [host, ...repoPath.split("/")];
  if (parts.some(part => !part || part === "." || part === ".." || /[\\\\\0]/.test(part))) return null;
  return parts;
}

// Pi's package manager cleans failed clones, but a process interruption can
// leave a non-repository directory behind. Remove only such directories for
// Git packages explicitly present in the selected profile/configuration.
export function recoverIncompleteGitPackages(agentDir, settings) {
  const recovered = [];
  for (const entry of Array.isArray(settings?.packages) ? settings.packages : []) {
    const parts = gitPackageSource(entry);
    if (!parts) continue;
    const target = path.resolve(agentDir, "git", ...parts);
    const root = path.resolve(agentDir, "git");
    if (target === root || !target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target)) continue;
    if (fs.existsSync(path.join(target, ".git"))) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      recovered.push(target);
    } catch (error) {
      throw new Error(`Could not recover incomplete Pi package ${target}: ${publicError(error)}`, { cause: error });
    }
  }
  if (recovered.length) console.warn("pi-ez-web: recovered incomplete Pi package checkout(s)", recovered);
  return recovered;
}
function readProfileCacheForSource(source) {
  try {
    const cached = JSON.parse(fs.readFileSync(profileCachePath(), "utf8"));
    if (cached?.source !== source || !isObject(cached.settings)) return null;
    const resources = Array.isArray(cached.resources)
      ? cached.resources
      : (cached.skills || []).map(resource => ({ ...resource, kind: "skill" }));
    return { ...cached, resources };
  } catch { return null; }
}

function readProfileCache(location) {
  try {
    const cached = readProfileCacheForSource(location.requested);
    if (cached?.resolvedSource !== location.resolved) return null;
    return cached;
  } catch { return null; }
}
function writeProfileCache(location, settings, resources = [], { ref = null, commit = null } = {}) {
  const file = profileCachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({
      source: location.requested,
      resolvedSource: location.resolved,
      fetchedAt: new Date().toISOString(),
      ref,
      commit,
      settings,
      resources,
    }, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function publicError(error) {
  return String(error?.message || error || "Could not load Pi profile.")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/gh[oprsu]_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/(OP_SERVICE_ACCOUNT_TOKEN\s*=\s*)[^\s]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|key|code|state|access_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]");
}

class OverlaySettingsStorage {
  constructor(cwd, agentDir, overlay, suppressPackages = false) {
    this.paths = {
      global: path.join(agentDir, "settings.json"),
      project: path.join(cwd, ".pi", "settings.json"),
    };
    this.overlay = overlay;
    this.suppressPackages = suppressPackages;
  }

  withLock(scope, fn) {
    const file = this.paths[scope];
    let original;
    try { original = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }

    let presented = original;
    let baseValue = {};
    let presentedValue;
    if (scope === "global" || this.suppressPackages) {
      // Preserve malformed JSON so SettingsManager can report the parse error
      // instead of silently replacing it with the imported profile.
      try {
        baseValue = original ? JSON.parse(original) : {};
        presentedValue = scope === "global" ? this.overlay(baseValue) : clone(baseValue);
        if (this.suppressPackages) presentedValue.packages = [];
        presented = JSON.stringify(presentedValue, null, 2);
      } catch { /* SettingsManager owns parse diagnostics */ }
    }

    const next = fn(presented);
    if (next === undefined) return;

    let output = next;
    if (scope === "global" && presentedValue) {
      // Setters write the full settings object. Strip unchanged profile-owned
      // top-level values before persisting so a routine SDK setting change does
      // not copy the external profile permanently into local settings.json.
      try {
        const nextValue = JSON.parse(next);
        for (const key of new Set([...Object.keys(presentedValue), ...Object.keys(baseValue)])) {
          if (!same(nextValue[key], presentedValue[key])) continue;
          if (Object.hasOwn(baseValue, key)) nextValue[key] = baseValue[key];
          else delete nextValue[key];
        }
        output = JSON.stringify(nextValue, null, 2);
      } catch { /* persist the SDK-provided value and let future reads diagnose it */ }
    } else if (this.suppressPackages && presentedValue) {
      try {
        const nextValue = JSON.parse(next);
        if (same(nextValue.packages, presentedValue.packages)) {
          if (Object.hasOwn(baseValue, "packages")) nextValue.packages = baseValue.packages;
          else delete nextValue.packages;
        }
        output = JSON.stringify(nextValue, null, 2);
      } catch { /* persist the SDK-provided value and let future reads diagnose it */ }
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temporary, output, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

export class PiConfiguration {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl;
    this.cache = null;
    this.runtime = null;
  }

  invalidate() {
    this.cache = null;
    this.runtime = null;
  }

  async resolve(piConfig = effectivePiConfig(), { force = false, report = null } = {}) {
    const key = JSON.stringify(piConfig);
    if (!force && this.cache?.key === key) return this.cache.promise;
    const promise = this.#resolve(piConfig, report);
    this.cache = { key, promise };
    return promise;
  }

  async #resolve(piConfig, report = null) {
    let warnings = [];
    const inline = inlineSettings(piConfig, warnings);
    let settings = {};
    let profile = { status: "none", source: null, resolvedSource: null, error: null };
    let location = null;
    let resources = [];
    let materialized = null;
    let profileCommit = null;

    if (piConfig.profile) {
      try {
        location = profileLocation(piConfig.profile);
        if (location.type === "url") {
          report?.({ type: "phase", phase: "profile-branch", message: "Resolving the GitHub dotfiles default branch." });
          const cachedHint = readProfileCacheForSource(location.requested);
          location.ref = await resolveGithubProfileRef(location.requested, this.fetchImpl) || cachedHint?.ref || "HEAD";
          location.resolved = githubProfileSettingsUrl(location.requested, location.ref);
        }
        report?.({ type: "phase", phase: "profile-settings", message: location.type === "url" ? `Fetching ${location.resolved}.` : `Reading ${location.resolved}.` });
        const value = location.type === "url"
          ? await readRemoteJson(location.resolved, this.fetchImpl)
          : readLocalJson(location.resolved);
        if (!isObject(value)) throw new Error("Pi profile settings must contain a JSON object.");
        const declaredExtensionPaths = location.type === "url" ? remoteExtensionPaths(value) : [];
        if (location.type === "url") {
          try {
            report?.({ type: "phase", phase: "profile-resources", message: "Fetching dotfiles skills and extensions." });
            const fetched = await fetchGithubProfileResources(location.requested, this.fetchImpl, location.ref, declaredExtensionPaths);
            resources = fetched.resources;
            profileCommit = fetched.commit || null;
            report?.({ type: "phase", phase: "profile-materialize", message: `Materializing ${resources.length} dotfiles resources.` });
            materialized = materializeProfileResources(location, resources);
            try { writeProfileCache(location, value, resources, { ref: location.ref, commit: profileCommit }); }
            catch (error) { warnings.push(`Could not cache Pi profile: ${publicError(error)}`); }
          } catch (error) {
            report?.({ type: "warning", phase: "profile-resources", message: `Dotfiles resource refresh failed: ${publicError(error)}` });
            const cached = readProfileCache(location);
            resources = cached?.resources || [];
            profileCommit = cached?.commit || null;
            if (resources.length) {
              report?.({ type: "phase", phase: "profile-cache", message: `Using ${resources.length} cached dotfiles resources.` });
              materialized = materializeProfileResources(location, resources);
              warnings.push(`Could not refresh Pi profile resources: ${publicError(error)}`);
            } else {
              warnings.push(`Could not refresh Pi profile resources: ${publicError(error)}`);
            }
          }
        }
        settings = prepareProfileSettings(value, {
          baseDir: location.type === "file" ? path.dirname(location.resolved) : appHome(),
          remote: location.type === "url",
          warnings,
        });
        if (declaredExtensionPaths.length) {
          warnings = warnings.filter(warning => !declaredExtensionPaths.some(source => warning.includes(source)));
        }
        if (materialized) {
          settings.skills = unique([...(settings.skills || []), ...materialized.skillPaths]);
          settings.extensions = unique([...(settings.extensions || []), ...materialized.extensionPaths]);
        }
        profile = {
          status: "loaded",
          source: location.requested,
          resolvedSource: location.resolved,
          ref: location.ref || null,
          commit: profileCommit,
          resourceCount: resources.length,
          error: null,
          loadedAt: new Date().toISOString(),
        };
      } catch (error) {
        const cached = location?.type === "url" ? readProfileCache(location) : null;
        if (cached) {
          resources = cached.resources || [];
          profileCommit = cached.commit || null;
          report?.({ type: "phase", phase: "profile-cache", message: `Using ${resources.length} cached dotfiles resources.` });
          materialized = materializeProfileResources(location, resources);
          settings = prepareProfileSettings(cached.settings, { baseDir: appHome(), remote: true, warnings });
          settings.skills = unique([...(settings.skills || []), ...materialized.skillPaths]);
          settings.extensions = unique([...(settings.extensions || []), ...materialized.extensionPaths]);
          report?.({ type: "warning", phase: "profile-cache", message: `Using the cached Pi profile because refresh failed: ${publicError(error)}` });
          warnings.push(`Using cached Pi profile because refresh failed: ${publicError(error)}`);
          profile = {
            status: "cached",
            source: location.requested,
            resolvedSource: location.resolved,
            ref: cached.ref || location.ref || null,
            commit: profileCommit,
            resourceCount: resources.length,
            error: publicError(error),
            loadedAt: cached.fetchedAt,
          };
        } else {
          report?.({ type: "error", phase: "profile-load", message: `Pi profile load failed: ${publicError(error)}` });
          profile = { status: "error", source: piConfig.profile, resolvedSource: location?.resolved || null, ref: location?.ref || null, error: publicError(error) };
        }
      }
    }

    const overlay = addInlineResources(settings, inline);
    // Include dev tools because Git packages may build runtime files in prepare;
    // legacy peer resolution avoids auto-installing Pi's host dependencies.
    // An explicitly supplied profile npmCommand remains authoritative.
    if (!Object.hasOwn(overlay, "npmCommand")) overlay.npmCommand = [...DEFAULT_NPM_COMMAND];
    profile.packageCount = Array.isArray(overlay.packages) ? overlay.packages.length : 0;
    return { piConfig: clone(piConfig), profile, settings: overlay, inline, warnings };
  }

  async createSettingsManager(cwd, agentDir, SettingsManager, { loadPackages = true, packageSources } = {}) {
    const resolved = await this.resolve();
    const settings = packageSources === undefined
      ? resolved.settings
      : { ...resolved.settings, packages: clone(packageSources) };
    if (loadPackages) recoverIncompleteGitPackages(agentDir, settings);
    const storage = new OverlaySettingsStorage(cwd, agentDir, base => ["loaded", "cached"].includes(resolved.profile.status)
      ? mergeSettings(base, settings)
      : addInlineResources(base, resolved.inline), !loadPackages);
    return { settingsManager: SettingsManager.fromStorage(storage), resolved };
  }

  recordRuntime(resourceLoader, extensionsResult, sessionId = null, cwd = null, errors = [], packageStatus = null) {
    const skillState = resourceLoader.getSkills();
    const extensionState = extensionsResult || resourceLoader.getExtensions();
    const extensionErrors = [
      ...errors.map(error => ({ path: error.path, error: publicError(error.error) })),
      ...(extensionState.errors || []).map(error => ({ path: error.path, error: publicError(error.error) })),
    ];
    const skillDiagnostics = (skillState.diagnostics || []).map(diagnostic => ({
      path: diagnostic.path || null,
      message: publicError(diagnostic.message || diagnostic.error || diagnostic),
      severity: diagnostic.severity || "warning",
    }));
    this.runtime = {
      loadedAt: new Date().toISOString(),
      ...(sessionId ? { sessionId } : {}),
      ...(cwd ? { cwd } : {}),
      extensions: (extensionState.extensions || []).map(extension => ({
        name: extension.name || path.basename(extension.path || extension.resolvedPath || "<extension>"),
        path: extension.path || extension.resolvedPath || "<extension>",
        ...(extension.sourceInfo?.source ? { source: extension.sourceInfo.source } : {}),
        ...(extension.sourceInfo?.scope ? { scope: extension.sourceInfo.scope } : {}),
        ...(extension.sourceInfo?.origin ? { origin: extension.sourceInfo.origin } : {}),
      })),
      errors: extensionErrors,
      extensionDiagnostics: extensionErrors,
      skills: (skillState.skills || []).map(skill => ({
        name: skill.name,
        description: skill.description,
        path: skill.filePath,
        ...(skill.sourceInfo?.source ? { source: skill.sourceInfo.source } : {}),
        ...(skill.sourceInfo?.scope ? { scope: skill.sourceInfo.scope } : {}),
        ...(skill.sourceInfo?.origin ? { origin: skill.sourceInfo.origin } : {}),
        disableModelInvocation: !!skill.disableModelInvocation,
      })),
      skillDiagnostics,
      prompts: resourceLoader.getPrompts().prompts.length,
      ...(packageStatus ? { packageStatus: clone(packageStatus) } : {}),
    };
  }

  recordRuntimeError(error) {
    this.runtime = { loadedAt: new Date().toISOString(), extensions: [], errors: [{ path: "<pi-configuration>", error: publicError(error) }], extensionDiagnostics: [{ path: "<pi-configuration>", error: publicError(error) }], skills: [], skillDiagnostics: [], prompts: 0 };
  }

  async state(options) {
    const resolved = await this.resolve(effectivePiConfig(), options);
    return {
      config: resolved.piConfig,
      profile: resolved.profile,
      warnings: resolved.warnings,
      runtime: this.runtime,
      note: "Profiles import declarative settings and resources; credentials and sessions remain in PI_CODING_AGENT_DIR.",
    };
  }
}
