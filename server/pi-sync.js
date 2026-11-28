// Locates the installed pi-sync package. The app only loads its Pi extension
// (which owns sync) and lists shared conversations; it has no sync layer of its own.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, syncConfig } from "./config.js";
import { rel } from "./domain.js";

const DEFAULT_MODULE = "@bry-guy/pi-sync";
const modulePromises = new Map();
const extensionPromises = new Map();

export function syncClientModuleName() {
  return process.env.PI_WEB_SYNC_CLIENT_MODULE || DEFAULT_MODULE;
}

export async function loadPiSyncModule() {
  const specifier = importSpecifier();
  if (!modulePromises.has(specifier)) {
    modulePromises.set(specifier, import(specifier).catch(error => {
      modulePromises.delete(specifier);
      throw Object.assign(new Error("The pi-sync client is not installed."), { code: "sync_client_unavailable", cause: error });
    }));
  }
  return modulePromises.get(specifier);
}

export async function createSyncClient(baseUrl, options = {}) {
  const module = options.module || await loadPiSyncModule();
  if (typeof module.SyncClient !== "function") {
    throw Object.assign(new Error("The installed pi-sync package does not expose SyncClient."), { code: "sync_client_unavailable" });
  }
  return new module.SyncClient({ baseUrl, timeoutMs: options.timeoutMs ?? 8_000, ...(options.fetch ? { fetch: options.fetch } : {}) });
}

async function resolveExtensionPath() {
  const resolved = await import.meta.resolve(importSpecifier());
  const root = path.resolve(path.dirname(fileURLToPath(resolved)), "../..");
  const extension = [
    path.join(root, "dist", "extensions", "sync.js"),
    path.join(root, "extensions", "sync.js"),
    path.join(root, "extensions", "sync.ts"),
  ].find(candidate => fs.existsSync(candidate));
  if (!extension) throw Object.assign(new Error("The installed pi-sync package does not expose its Pi extension."), { code: "sync_client_unavailable" });
  return extension;
}

/** The pi-sync extension file, but only when a sync server is configured; null otherwise or if unavailable. */
export async function activePiSyncExtensionPath(cfg = loadConfig()) {
  if (!syncConfig(cfg).serverUrl) return null;
  const key = syncClientModuleName();
  if (!extensionPromises.has(key)) {
    extensionPromises.set(key, resolveExtensionPath().catch(error => {
      extensionPromises.delete(key);
      console.error("pi-ez-web: pi-sync extension unavailable", error?.message || error);
      return null;
    }));
  }
  return extensionPromises.get(key);
}

export function piSyncState(cfg = loadConfig()) {
  const effective = syncConfig(cfg);
  return { configured: !!effective.serverUrl, serverUrl: effective.serverUrl, allConversations: effective.allConversations };
}

/** Shared conversations for this repository that are not on this host yet, newest first. */
export async function remoteConversationsForRepository(cwd, localIds, { project = null } = {}) {
  const module = await loadPiSyncModule();
  const repository = await module.deriveRepositoryIdentity(cwd);
  if (!repository && !project) return [];
  const client = await createSyncClient(syncConfig(loadConfig()).serverUrl);
  // A pi project's conversations carry its name (pi-sync `project`); they may sit in any of its repositories or its folder.
  const belongs = item => (project && item.project === project) || (repository && module.repositoryIdentity(item.workspace) === repository);
  return listItems((await client.list()).sessions.filter(item => belongs(item) && !localIds.has(item.sessionId)), module);
}

/** Shared conversations of pi project `project` that `isHere(sessionId)` does not already hold, newest first. */
export async function remoteConversationsForProject(project, isHere = () => false) {
  const client = await createSyncClient(syncConfig(loadConfig()).serverUrl);
  return listItems((await client.list()).sessions.filter(item => item.project === project && !isHere(item.sessionId)), await loadPiSyncModule());
}

/** Every conversation on the sync server by id, or null when no sync server is set. Throws when it does not answer. */
export async function syncedConversations({ timeoutMs = 1_500 } = {}) {
  const base = syncConfig(loadConfig()).serverUrl;
  if (!base) return null;
  const client = await createSyncClient(base, { timeoutMs });
  return new Map(listItems((await client.list()).sessions, await loadPiSyncModule()).map(item => [item.sessionId, item]));
}

// The sync server's list as this process last got it. /api/state must not wait for another server, so reading it
// never waits: a reading older than 30 seconds starts a refresh for the next one.
const KNOWN_TTL_MS = 30_000;
let known = { at: -Infinity, items: null, self: null, loading: null };

/** { items, self } (the conversations by id, this device's sync name), or null: no sync server, no answer, or one over a minute old. */
export function knownConversations({ list = syncedConversations, device = ownDevice, now = Date.now() } = {}) {
  if (now - known.at >= KNOWN_TTL_MS && !known.loading) {
    known.loading = Promise.resolve().then(() => list({ timeoutMs: 5_000 }))
      .then(async items => { known = { at: Date.now(), items, self: items ? await device() : null, loading: null }; })
      // No answer: nothing is known until the next one, rather than the old list.
      .catch(() => { known = { at: Date.now(), items: null, self: null, loading: null }; });
  }
  return known.items && now - known.at < 2 * KNOWN_TTL_MS ? { items: known.items, self: known.self } : null;
}

/** The name pi-sync gives this device (its extension's own rule), so a lease or a visit of ours is not "elsewhere". */
async function ownDevice() {
  const module = await loadPiSyncModule();
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return module.loadConfig(module.configPaths(agentDir)).deviceLabel || module.defaultDeviceLabel(agentDir);
}

/**
 * What a session file holds, for comparing with the sync server: its head entry, whether it was detached here
 * (pi-sync's last `pi-sync-link` entry; a detached copy does not sync until it is attached again), and has(entryId).
 */
export function copyFacts(entries, head) {
  const link = entries.findLast(entry => entry.type === "custom" && entry.customType === "pi-sync-link");
  const ids = `\n${entries.map(entry => entry.id).join("\n")}\n`;
  // pi-sync's own rule (localChanged): a model or thinking switch after the last upload waits for the next turn.
  const onlySettingsAfter = id => {
    const at = entries.findIndex(entry => entry.id === id);
    return at >= 0 && entries.slice(at + 1).every(entry => entry.type === "model_change" || entry.type === "thinking_level_change");
  };
  return { head: head || entries.at(-1)?.id || null, detached: link?.data?.detached === true, has: id => !!id && ids.includes(`\n${id}\n`), onlySettingsAfter };
}

/**
 * Whether the sync server's `item` is past the copy here: another device holds it, or its head is an entry this
 * copy (`copy`: copyFacts) does not have. { where: "on <device>", when } or null; null too for a copy not read.
 */
export function elsewhere(item, copy, self = null) {
  const held = item.leaseHolder && item.leaseHolder !== self ? item.leaseHolder : null;
  if (!held && (!copy?.head || item.headEntryId === copy.head || copy.has(item.headEntryId))) return null;
  // The device named is the holder, else the newest other device the server has seen; never this one.
  return { where: `on ${held || (item.devices || []).find(label => label !== self) || "another device"}`, when: rel(item.updatedAt) };
}

/**
 * A row's words for the copy here against the server's list (`items`), or null for a copy not read. "synced" only
 * when both end in the same entry, or this copy has only model and thinking switches since; a copy with more is
 * "not uploaded yet". Where the conversation went on comes first: a detached copy reads "not synced" only when
 * the server is not past it and no other device holds it.
 */
export function syncStanding(items, id, copy, self = null) {
  if (!copy?.head) return null;
  const item = items.get(id);
  if (!item) return "not synced";
  const away = elsewhere(item, copy, self);
  if (away) return `${away.where} · ${away.when}`;
  if (copy.detached) return "not synced";
  return item.headEntryId === copy.head || copy.onlySettingsAfter(item.headEntryId) ? "synced" : "not uploaded yet";
}

/** Gives each session of `projects` (as /api/state lists them), open or closed, its sync words. */
export function labelProjects(projects, { items, self }, copyOf) {
  const label = nodes => {
    for (const node of nodes || []) {
      const words = syncStanding(items, node.id, copyOf(node.id), self);
      if (words) node.sync = words;
      label(node.children);
    }
  };
  for (const project of projects) {
    label(project.sessions);
    label(project.closed);
  }
}

function listItems(sessions, module) {
  return sessions
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
    .map(item => ({
      sessionId: item.sessionId,
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : null,
      branch: item.workspace?.branch || null,
      // A repository-level conversation: its repository's name (project.json's repo name) and commit; none for project-level.
      repo: module.repositoryIdentity?.(item.workspace)?.split("/").at(-1) || null,
      commit: item.workspace?.commit || null,
      updatedAt: item.updatedAt || item.createdAt,
      when: rel(item.updatedAt || item.createdAt),
      device: item.devices?.[0]?.label || null,
      // Every device the server has seen it on, newest first, and the entry its copy ends in.
      devices: (item.devices || []).map(device => device.label),
      headEntryId: item.headEntryId || null,
      leaseHolder: item.leaseHolder || null,
    }));
}

/** pi projects that have synced conversations (pi-sync GET /v1/projects): [{name, sessions, lastActive}]. */
export async function syncedProjects({ fetchImpl = globalThis.fetch, timeoutMs = 1_500 } = {}) {
  const base = syncConfig(loadConfig()).serverUrl;
  if (!base) return [];
  const res = await fetchImpl(`${base.replace(/\/+$/, "")}/v1/projects`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`pi-sync projects answered ${res.status}`);
  const body = await res.json();
  return (body.projects || []).filter(p => typeof p?.name === "string" && p.name);
}

/**
 * A read-only look at a shared conversation (no lease taken): its active branch's user and
 * assistant messages as transcript-style records, oldest first.
 */
export async function remoteConversationPreview(sessionId) {
  const client = await createSyncClient(syncConfig(loadConfig()).serverUrl);
  return previewRecords((await client.get(sessionId)).session);
}

export function previewRecords(envelope) {
  const byId = new Map((envelope?.entries || []).map(entry => [entry.id, entry]));
  const branch = [];
  for (let entry = byId.get(envelope?.headEntryId); entry && branch.length < byId.size; entry = byId.get(entry.parentId)) branch.push(entry);
  const text = content => typeof content === "string" ? content
    : Array.isArray(content) ? content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
  return branch.reverse()
    .filter(entry => entry.type === "message" && ["user", "assistant"].includes(entry.message?.role))
    .map(entry => ({ id: entry.id, role: entry.message.role, text: text(entry.message.content).trim(), at: Date.parse(entry.timestamp) || null }))
    .filter(record => record.text);
}

function importSpecifier() {
  const raw = syncClientModuleName();
  let filePath = raw;
  try {
    if (raw.startsWith("file:")) filePath = fileURLToPath(raw);
    if (path.isAbsolute(filePath) && fs.existsSync(path.join(filePath, "package.json"))) {
      return pathToFileURL(path.join(filePath, "dist/src/index.js")).href;
    }
  } catch {
    // Let the normal dynamic import produce the stable unavailable error.
  }
  return raw;
}
