// Config + app-home paths. App state discipline: config.json (declarative,
// user- and UI-editable) + bindings.json (session -> { projectId, workspacePath } context overrides).
// Everything else is discovered live or owned by pi.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeProjectEnvironment } from "./project-environment.js";

export function appHome() {
  return process.env.PI_WEB_HOME || path.join(os.homedir(), ".pi-web-ui");
}
export const chatsDir = () => path.join(appHome(), "chats");
export const worktreeRootDefault = () => path.join(os.homedir(), ".pi", "worktrees");
const configPath = () => path.join(appHome(), "config.json");
const bindingsPath = () => path.join(appHome(), "bindings.json");

const DEFAULTS = {
  projects: [], // { id, name, repoPath, hooks? }
  projectHooks: {}, // deployment-wide hook defaults, overridden per project
  projectHookSets: {}, // deployment hook defaults keyed by project name
  worktreeRoot: null, // optional root for app-created non-main worktrees
  reposRoot: null, // null -> ~/src; env PI_WEB_REPOS_ROOT still overrides
  port: 3141,
  defaultModel: null,
  defaultThinkingLevel: "medium",
  sync: {
    serverUrl: null,
    allConversations: false,
  },
  pi: {
    profile: null, // local profile dir/settings.json or HTTPS settings URL
    profileSource: "auto", // auto | explicit | disabled
    packages: [], // additional Pi package sources
    extensions: [], // additional package sources or server-local extension paths
  },
  repositorySources: {
    default: "github",
    github: { clientId: null, owner: null },
  },
};

export function normalizeHooks(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const hooks = {};
  for (const [name, command] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(name)) continue;
    if (command === null) hooks[name] = null;
    else if (typeof command === "string" && command.trim()) hooks[name] = command.trim();
  }
  return hooks;
}

export function normalizeHookSets(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sets = {};
  for (const [projectName, hooks] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectName)) continue;
    sets[projectName] = normalizeHooks(hooks);
  }
  return sets;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function normalizeThinkingLevel(value, { strict = false } = {}) {
  const level = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (THINKING_LEVELS.includes(level)) return level;
  if (strict) throw Object.assign(new Error(`Invalid thinking level: ${value}`), { code: "invalid_thinking_level" });
  return "medium";
}

export function normalizePiConfig(value, { strict = false } = {}) {
  const invalid = message => {
    if (strict) throw Object.assign(new Error(message), { code: "invalid_pi_configuration" });
    return { ...DEFAULTS.pi };
  };
  if (value == null) return { ...DEFAULTS.pi };
  if (typeof value !== "object" || Array.isArray(value)) return invalid("Pi configuration must be an object.");
  if (value.profile !== undefined && value.profile !== null && typeof value.profile !== "string") return invalid("Pi profile must be a path or HTTPS URL.");
  if (value.profileSource !== undefined && !["auto", "explicit", "disabled"].includes(value.profileSource)) return invalid("Pi profile source must be auto, explicit, or disabled.");
  for (const key of ["packages", "extensions"]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(entry => typeof entry !== "string"))) {
      return invalid(`Pi ${key} must be an array of strings.`);
    }
  }
  const profile = typeof value.profile === "string" && value.profile.trim() ? value.profile.trim() : null;
  const profileSource = value.profileSource === "disabled"
    ? "disabled"
    : value.profileSource === "auto" || !profile
      ? "auto"
      : "explicit";
  return {
    profile,
    profileSource,
    packages: [...new Set((value.packages || []).map(entry => entry.trim()).filter(Boolean))],
    extensions: [...new Set((value.extensions || []).map(entry => entry.trim()).filter(Boolean))],
  };
}

export function normalizeSyncConfig(value, { strict = false } = {}) {
  const invalid = message => {
    if (strict) throw Object.assign(new Error(message), { code: "invalid_sync_configuration" });
    return { ...DEFAULTS.sync };
  };
  if (value == null) return { ...DEFAULTS.sync };
  if (typeof value !== "object" || Array.isArray(value)) return invalid("Sync configuration must be an object.");
  if (value.serverUrl !== undefined && value.serverUrl !== null && typeof value.serverUrl !== "string") {
    return invalid("Sync server URL must be a string or null.");
  }
  if (value.allConversations !== undefined && typeof value.allConversations !== "boolean") {
    return invalid("Sync allConversations must be a boolean.");
  }
  const serverUrl = typeof value.serverUrl === "string" ? value.serverUrl.trim() : null;
  if (serverUrl) {
    try {
      const parsed = new URL(serverUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported protocol");
      if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("credentials, queries, and fragments are not supported");
    } catch {
      return invalid("Sync server URL must be an HTTP or HTTPS URL.");
    }
  }
  return {
    serverUrl: serverUrl || null,
    allConversations: value.allConversations === true,
  };
}

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  return fallback;
}

// The URL this process last wrote into PI_SYNC_SERVER_URL; an env value equal to it is ours, not a deployment setting.
let exportedSyncServerUrl = null;

export function syncEnvironmentOverrides() {
  const url = process.env.PI_SYNC_SERVER_URL;
  return {
    serverUrl: url !== undefined && url !== exportedSyncServerUrl,
    allConversations: process.env.PI_WEB_SYNC_ALL_CONVERSATIONS !== undefined,
  };
}

export function syncConfig(cfg = loadConfig()) {
  const configured = normalizeSyncConfig(cfg?.sync);
  const rawServerUrl = syncEnvironmentOverrides().serverUrl
    ? String(process.env.PI_SYNC_SERVER_URL).trim()
    : configured.serverUrl;
  const serverUrl = rawServerUrl
    ? normalizeSyncConfig({ serverUrl: rawServerUrl }).serverUrl
    : null;
  return {
    serverUrl,
    allConversations: envBoolean("PI_WEB_SYNC_ALL_CONVERSATIONS", configured.allConversations),
  };
}

// Writes the effective sync settings where the pi-sync extension reads them. Called before sessions load it.
export function exportSyncEnvironment(cfg = loadConfig()) {
  const effective = syncConfig(cfg);
  process.env.PI_SYNC_ALL_SESSIONS = effective.allConversations ? "on" : "off";
  if (syncEnvironmentOverrides().serverUrl) return;
  exportedSyncServerUrl = effective.serverUrl;
  if (effective.serverUrl) process.env.PI_SYNC_SERVER_URL = effective.serverUrl;
  else delete process.env.PI_SYNC_SERVER_URL;
}

export function syncSettingsState(cfg = loadConfig()) {
  const effective = syncConfig(cfg);
  return {
    serverUrl: {
      value: effective.serverUrl,
      source: syncEnvironmentOverrides().serverUrl ? "PI_SYNC_SERVER_URL" : cfg.sync?.serverUrl ? "config" : "default",
      editable: !syncEnvironmentOverrides().serverUrl,
    },
    allConversations: {
      value: effective.allConversations,
      source: syncEnvironmentOverrides().allConversations ? "PI_WEB_SYNC_ALL_CONVERSATIONS" : cfg.sync?.allConversations ? "config" : "default",
      editable: !syncEnvironmentOverrides().allConversations,
    },
  };
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (error) {
    if (fs.existsSync(p)) console.warn(`pi-ez-web: could not read JSON state ${p}: ${error.message}`);
    return fallback;
  }
}
function readConfig() {
  let raw;
  try {
    raw = fs.readFileSync(configPath(), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw Object.assign(new Error("Configuration file could not be read."), { code: "config_unreadable" });
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Configuration file contains invalid JSON."), { code: "invalid_config" });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Configuration file must contain a JSON object."), { code: "invalid_config" });
  }
  return value;
}
function writeJson(p, obj, mode = 0o600) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const temporary = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", mode, flag: "wx" });
    fs.renameSync(temporary, p);
    try { fs.chmodSync(p, mode); } catch { /* best effort on non-POSIX filesystems */ }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function ensureHome() {
  fs.mkdirSync(chatsDir(), { recursive: true });
}

export function loadConfig() {
  const raw = readConfig();
  const sources = raw.repositorySources && typeof raw.repositorySources === "object" ? raw.repositorySources : {};
  const github = sources.github && typeof sources.github === "object" ? sources.github : {};
  const projects = (Array.isArray(raw.projects) ? raw.projects : DEFAULTS.projects).map(project => {
    if (!project || typeof project !== "object" || Array.isArray(project)) return project;
    const { mode: _legacyMode, ...current } = project;
    if (Object.hasOwn(current, "environment")) current.environment = normalizeProjectEnvironment(current.environment);
    return current;
  });
  return {
    ...DEFAULTS,
    ...raw,
    projects,
    projectHooks: normalizeHooks(raw.projectHooks),
    projectHookSets: normalizeHookSets(raw.projectHookSets),
    defaultThinkingLevel: normalizeThinkingLevel(raw.defaultThinkingLevel),
    sync: normalizeSyncConfig(raw.sync),
    pi: normalizePiConfig(raw.pi),
    repositorySources: {
      ...DEFAULTS.repositorySources,
      ...sources,
      default: ["github", "git-url"].includes(sources.default) ? sources.default : DEFAULTS.repositorySources.default,
      github: {
        ...DEFAULTS.repositorySources.github,
        ...github,
        clientId: github.clientId ? String(github.clientId).trim() : null,
        owner: github.owner ? String(github.owner).trim() : null,
      },
    },
  };
}
export function saveConfig(cfg) {
  writeJson(configPath(), cfg);
  return cfg;
}
export function resolvePath(raw) {
  let value = String(raw).trim().replace(/^~(?=$|\/)/, os.homedir());
  // Be forgiving of the common macOS shell typo `Users/name/...` when the
  // intended path is `/Users/name/...`; ordinary relative paths still resolve
  // from the process working directory.
  if (process.platform === "darwin" && value.startsWith("Users/")) value = `/${value}`;
  return path.resolve(value);
}

export function reposRoot(cfg = loadConfig()) {
  const raw = process.env.PI_WEB_REPOS_ROOT || cfg.reposRoot || path.join(os.homedir(), "src");
  return resolvePath(raw);
}

export function repositorySource(cfg = loadConfig()) {
  const value = process.env.PI_WEB_REPOSITORY_SOURCE || cfg.repositorySources?.default;
  return ["github", "git-url"].includes(value) ? value : "github";
}

export function githubConfig(cfg = loadConfig()) {
  const configured = cfg.repositorySources?.github || {};
  return {
    clientId: process.env.PI_WEB_GITHUB_CLIENT_ID || configured.clientId || null,
    owner: process.env.PI_WEB_GITHUB_OWNER || configured.owner || null,
  };
}

export function effectivePiConfig(cfg = loadConfig()) {
  const pi = normalizePiConfig(cfg?.pi);
  return pi.profileSource === "disabled" ? { ...pi, profile: null } : pi;
}

export function worktreeRoot(cfg) {
  return cfg.worktreeRoot || worktreeRootDefault();
}

const closedPath = () => path.join(appHome(), "closed.json");
export function loadClosed() {
  let raw;
  try { raw = fs.readFileSync(closedPath(), "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw error;
  }
  const ids = JSON.parse(raw);
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || id.length === 0)) {
    throw new TypeError("Closed-session archive must contain an array of session IDs.");
  }
  return new Set(ids);
}
export function saveClosed(set) {
  writeJson(closedPath(), [...set]);
}

export function loadBindings() {
  const bindings = readJson(bindingsPath(), {});
  let migrated = false;
  for (const [sessionId, value] of Object.entries(bindings)) {
    if (typeof value === "string") {
      bindings[sessionId] = { projectId: null, workspacePath: value };
      migrated = true;
    }
  }
  if (migrated) saveBindings(bindings);
  return bindings;
}
export function saveBindings(b) {
  writeJson(bindingsPath(), b);
}

function bindingObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function assertSessionBindingCompatible(source, target) {
  const sourceProject = bindingObject(source)?.projectId;
  const targetProject = bindingObject(target)?.projectId;
  if (sourceProject && targetProject && sourceProject !== targetProject) {
    throw Object.assign(new Error("The replacement session belongs to a different project."), { code: "session_binding_conflict" });
  }
}

export function prepareSessionVisibilityReplacement(sourceId, targetId, fallbackWorkspace) {
  const initialBindings = loadBindings();
  const source = bindingObject(initialBindings[sourceId]);
  const target = bindingObject(initialBindings[targetId]);
  assertSessionBindingCompatible(source, target);
  const inherited = source
    ? { ...source, ...(!source.workspacePath && fallbackWorkspace ? { workspacePath: fallbackWorkspace } : {}) }
    : null;
  const workspacePath = inherited?.workspacePath || target?.workspacePath || fallbackWorkspace || null;
  let committed = null;
  const restore = (bindings, closed) => {
    const errors = [];
    try { saveBindings(bindings); } catch (error) { errors.push(error); }
    try { saveClosed(closed); } catch (error) { errors.push(error); }
    return errors;
  };

  return {
    workspacePath,
    commit() {
      const beforeBindings = loadBindings();
      const beforeClosed = loadClosed();
      assertSessionBindingCompatible(source, beforeBindings[targetId]);
      const nextBindings = { ...beforeBindings };
      if (inherited) nextBindings[targetId] = { ...inherited };
      const nextClosed = new Set(beforeClosed);
      nextClosed.delete(targetId);
      try {
        if (JSON.stringify(nextBindings) !== JSON.stringify(beforeBindings)) saveBindings(nextBindings);
        if (nextClosed.size !== beforeClosed.size) saveClosed(nextClosed);
      } catch (error) {
        const rollbackErrors = restore(beforeBindings, beforeClosed);
        if (rollbackErrors.length && error && (typeof error === "object" || typeof error === "function")) {
          Object.defineProperty(error, "rollbackErrors", { value: rollbackErrors, configurable: true });
        }
        throw error;
      }
      committed = { bindings: beforeBindings, closed: beforeClosed };
      return {
        rollback() {
          if (!committed) return;
          const previous = committed;
          committed = null;
          const errors = restore(previous.bindings, previous.closed);
          if (errors.length) throw new AggregateError(errors, "Session visibility rollback failed.");
        },
      };
    },
  };
}

export function sessionSlug(firstMessage) {
  const slug = String(firstMessage || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return `session/${slug || "chat"}`;
}

export function slug(s) {
  return String(s).trim().replace(/\s+/g, "-").replace(/[^\w./-]/g, "-");
}
export function newId(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}
