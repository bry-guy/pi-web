// Assembles /api/state: projects with live Git contexts and session trees.
// A context is a concrete checkout/worktree path. Branch and dirty state are
// observations of that path, never authoritative session metadata.
import fs from "node:fs";
import path from "node:path";
import { chatsDir, loadBindings, loadClosed, loadConfig } from "./config.js";
import * as ws from "./workspaces.js";
import { publicHooks } from "./hooks.js";

export async function sessionWorkspace(sessionId, sup) {
  const bindings = loadBindings();
  if (bindings[sessionId]?.workspacePath) return bindings[sessionId].workspacePath;
  const meta = await sup.meta(sessionId);
  return meta?.cwd || null;
}

function pathKey(value) {
  try { return path.resolve(value); } catch { return String(value || ""); }
}

function unavailableContext(project, binding) {
  const workspacePath = binding.workspacePath;
  return {
    id: ws.contextId(project.repoPath, workspacePath),
    branch: null,
    path: workspacePath,
    kind: "unavailable",
    dirty: null,
    status: "unavailable",
    statusError: "The checkout/worktree is no longer discoverable.",
    upstream: null,
    ahead: 0,
    behind: 0,
    externalMain: false,
    protected: false,
    head: null,
    commit: null,
    statusDetails: null,
    detached: false,
    sessions: [],
  };
}

function projectContextsFromLive(project, bindings, live) {
  const paths = new Set(live.map(context => pathKey(context.path)));
  const unavailable = Object.values(bindings)
    .filter(binding => binding?.projectId === project.id && binding.workspacePath && !paths.has(pathKey(binding.workspacePath)))
    .map(binding => unavailableContext(project, binding));
  return [...live, ...unavailable.filter((context, index, list) => list.findIndex(item => item.id === context.id) === index)];
}

function projectContexts(project, bindings, primaryBranch) {
  return projectContextsFromLive(project, bindings, ws.listContexts(project.repoPath, primaryBranch));
}

async function discoverProjectSessions(contexts, bindings, closed, sup, projectId = null) {
  const workspacePaths = contexts.map(context => context.path);
  const discovered = new Map();
  const add = session => {
    if (!session?.id || discovered.has(session.id)) return;
    discovered.set(session.id, {
      ...session,
      cwd: bindings[session.id]?.workspacePath || session.cwd,
      closed: closed.has(session.id),
    });
  };
  for (const context of contexts) {
    if (context.kind === "unavailable") continue;
    try {
      for (const session of await sup.listSessions(context.path)) add(session);
    } catch { /* a context may disappear between Git discovery and session listing */ }
  }
  for (const [id, binding] of Object.entries(bindings)) {
    const liveContext = binding?.workspacePath && workspacePaths.some(workspacePath => pathKey(workspacePath) === pathKey(binding.workspacePath));
    const unavailableContextBinding = binding?.projectId === projectId && binding?.workspacePath && !liveContext;
    if (!liveContext && !unavailableContextBinding) continue;
    if (discovered.has(id)) continue;
    try { add(await sup.meta(id)); } catch { /* bindings can outlive a removed transcript */ }
  }
  return [...discovered.values()];
}

export async function sessionsUsingWorkspace(project, workspacePath, sup) {
  const bindings = loadBindings();
  return sessionsForContexts(project, workspacePath, sup, bindings, projectContexts(project, bindings));
}

export async function sessionsUsingWorkspaceAsync(project, workspacePath, sup) {
  const live = await ws.listContextsAsync(project.repoPath);
  const bindings = loadBindings();
  return sessionsForContexts(project, workspacePath, sup, bindings, projectContextsFromLive(project, bindings, live));
}

async function sessionsForContexts(project, workspacePath, sup, bindings, contexts) {
  const closed = loadClosed();
  const discovered = await discoverProjectSessions(contexts, bindings, closed, sup, project.id);
  return discovered
    .filter(session => !session.closed && pathKey(session.cwd) === pathKey(workspacePath))
    .map(session => ({
      id: session.id,
      title: titleOf(session),
      streaming: sup.isStreaming(session.id),
      updatedAt: isoTime(session.modified),
      when: rel(session.modified),
      workspacePath,
    }));
}

export async function projectState(project, sup) {
  const cfg = loadConfig();
  const bindings = loadBindings();
  // Read repository-level Git facts once per snapshot and share them.
  const branches = await ws.listBranchesAsync(project.repoPath);
  const currentBranch = await ws.currentBranchAsync(project.repoPath);
  const defaultBranch = await ws.defaultBranchAsync(project.repoPath, branches, currentBranch);
  const liveContexts = await ws.listContextsAsync(project.repoPath, defaultBranch);
  const contexts = projectContextsFromLive(project, bindings, liveContexts);
  const pathToContext = Object.fromEntries(contexts.map(context => [pathKey(context.path), context]));
  const worktrees = Object.fromEntries(contexts.filter(context => context.branch).map(context => [context.branch, context.path]));

  const closed = loadClosed();
  const discovered = (await discoverProjectSessions(contexts, bindings, closed, sup, project.id))
    // Like chats: an unprompted, unnamed session nothing has open is hidden, not deleted.
    .map(s => s.closed || hasPrompt(s) || promptText(s.name) || sup.isStreaming(s.id) || sup.isOpen?.(s.id) ? s : { ...s, closed: true });
  const all = discovered.filter(s => !s.closed);

  // Session tree from fork lineage. Walk through closed ancestors so visible
  // descendants occupy the closed node's former position.
  const byId = new Map(discovered.map(s => [s.id, { ...s, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.closed) continue;
    let parent = node.parentSessionId && byId.get(node.parentSessionId);
    while (parent?.closed) parent = parent.parentSessionId && byId.get(parent.parentSessionId);
    (parent ? parent.children : roots).push(node);
  }
  const toNode = n => {
    const children = n.children.sort(byRecency).map(toNode);
    const updatedAt = isoTime(n.modified);
    const activityAt = children.reduce((latest, child) => newerTimestamp(latest, child.activityAt), updatedAt);
    return {
      id: n.id,
      title: titleOf(n),
      name: n.name || null,
      contextId: pathToContext[pathKey(n.cwd)]?.id || null,
      branch: pathToContext[pathKey(n.cwd)]?.branch || null,
      workspacePath: n.cwd || null,
      streaming: sup.isStreaming(n.id),
      model: n.model || null,
      requestedModel: n.requestedModel || null,
      modelFallback: !!n.modelFallback,
      modelUnavailable: !!n.modelUnavailable,
      when: rel(n.modified),
      updatedAt,
      activityAt,
      children,
    };
  };

  const sessions = roots.sort((a, b) => compareTimestamp(treeActivity(b), treeActivity(a))).map(toNode);
  const updatedAt = all.reduce((latest, session) => newerTimestamp(latest, isoTime(session.modified)), null);

  const contextSessions = context => all
    .filter(session => pathKey(session.cwd) === pathKey(context.path))
    .map(session => ({
      id: session.id,
      title: titleOf(session),
      streaming: sup.isStreaming(session.id),
      updatedAt: isoTime(session.modified),
      when: rel(session.modified),
    }));
  const publicContexts = contexts.map(context => ({ ...context, sessions: contextSessions(context) }));
  const workspaceStatus = Object.fromEntries(publicContexts.map(context => [
    context.branch || context.id,
    { ...context, sessions: context.sessions },
  ]));

  return {
    id: project.id,
    name: project.name,
    repoPath: project.repoPath,
    source: project.source || { type: "local" },
    defaultBranch,
    branch: currentBranch,
    branches,
    remoteBranches: await ws.listRemoteBranchesAsync(project.repoPath),
    contexts: publicContexts,
    worktrees,
    workspaceStatus,
    sessions,
    updated: updatedAt ? rel(updatedAt) : "—",
    updatedAt,
    hooks: publicHooks(cfg, project),
  };
}

export async function chatsState(sup) {
  const root = chatsDir();
  const cwds = [root];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) cwds.push(path.join(root, entry.name));
    }
  } catch { /* ensureHome normally creates this; discovery stays best-effort */ }

  const discovered = [];
  for (const cwd of cwds) {
    try { discovered.push(...await sup.listSessions(cwd)); }
    catch { /* ignore an empty or malformed scratch directory */ }
  }
  const closed = loadClosed();
  // An unprompted, unnamed chat that nothing has open is an empty scratch file.
  // Hide it from the sidebar without touching the file.
  const list = discovered.filter(s => !closed.has(s.id) && (hasPrompt(s) || promptText(s.name) || sup.isStreaming(s.id) || sup.isOpen?.(s.id)));
  return list
    .sort((a, b) => compareTimestamp(b.modified, a.modified))
    .map(s => ({
      id: s.id,
      title: titleOf(s),
      when: rel(s.modified),
      updatedAt: isoTime(s.modified),
      activityAt: isoTime(s.modified),
      streaming: sup.isStreaming(s.id),
      model: s.model || null,
      requestedModel: s.requestedModel || null,
      modelFallback: !!s.modelFallback,
      modelUnavailable: !!s.modelUnavailable,
    }));
}

// Pi reports "(no messages)" in place of a prompt for sessions that have none.
const NO_MESSAGES = "(no messages)";
function promptText(value) {
  const text = String(value || "").trim();
  return text === NO_MESSAGES ? "" : text;
}
function hasPrompt(s) { return !!promptText(s.firstMessage); }

export function titleOf(s) {
  return promptText(s.name) || truncateSessionStart(promptText(s.firstMessage));
}

export function truncateSessionStart(value, max = 48) {
  // Titles are plain text; drop inline markdown markers from the first prompt.
  const text = String(value || "").replace(/[*_`#>~]+/g, "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : "New session";
}

export function timestampValue(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isoTime(value) {
  const timestamp = timestampValue(value);
  return timestamp ? new Date(timestamp).toISOString() : null;
}

export function compareTimestamp(a, b) {
  const delta = timestampValue(a) - timestampValue(b);
  return delta || String(a || "").localeCompare(String(b || ""));
}

export function newerTimestamp(a, b) {
  return timestampValue(a) >= timestampValue(b) ? (a || null) : (b || null);
}

function treeActivity(node) {
  return (node.children || []).reduce((latest, child) => newerTimestamp(latest, treeActivity(child)), node.modified);
}

function byRecency(a, b) { return compareTimestamp(b.modified, a.modified); }

export function rel(ts) {
  if (!ts) return "";
  const d = Date.now() - new Date(ts).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return "now";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  const days = Math.floor(h / 24);
  if (days < 7) return days + "d";
  return Math.floor(days / 7) + "w";
}
