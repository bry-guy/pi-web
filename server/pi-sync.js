// Locates the installed pi-sync package. The app only loads its Pi extension
// (which owns sync) and lists shared conversations; it has no sync layer of its own.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, syncConfig } from "./config.js";

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
  return listItems((await client.list()).sessions.filter(item => belongs(item) && !localIds.has(item.sessionId)));
}

/** Shared conversations of pi project `project` that `isHere(sessionId)` does not already hold, newest first. */
export async function remoteConversationsForProject(project, isHere = () => false) {
  const client = await createSyncClient(syncConfig(loadConfig()).serverUrl);
  return listItems((await client.list()).sessions.filter(item => item.project === project && !isHere(item.sessionId)));
}

function listItems(sessions) {
  return sessions
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
    .map(item => ({
      sessionId: item.sessionId,
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : null,
      branch: item.workspace?.branch || null,
      updatedAt: item.updatedAt || item.createdAt,
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
