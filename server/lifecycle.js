// A conversation has no lifecycle: closing one only takes it off the sidebar, and
// opening it puts it back. Worktrees and branches are never touched by either.
import path from "node:path";
import { loadBindings, loadClosed, loadConfig, saveBindings, saveClosed, syncConfig } from "./config.js";
import { sessionWorkspace, sessionsUsingWorkspaceAsync } from "./domain.js";
import { syncedConversations } from "./pi-sync.js";
import * as ws from "./workspaces.js";


export function findProjectByWorkspace(wsPath) {
  const bindings = loadBindings();
  for (const p of loadConfig().projects) {
    const contexts = ws.listContexts(p.repoPath);
    const discovered = contexts.some(context => path.resolve(context.path) === path.resolve(wsPath));
    const retained = Object.values(bindings).some(binding => binding?.projectId === p.id && binding.workspacePath && path.resolve(binding.workspacePath) === path.resolve(wsPath));
    if (discovered || retained) {
      return { project: p, contexts, worktrees: Object.fromEntries(contexts.filter(context => context.branch).map(context => [context.branch, context.path])) };
    }
  }
  return null;
}

export async function findProjectByWorkspaceAsync(wsPath) {
  const bindings = loadBindings();
  for (const p of loadConfig().projects) {
    const contexts = await ws.listContextsAsync(p.repoPath);
    const discovered = contexts.some(context => path.resolve(context.path) === path.resolve(wsPath));
    const retained = Object.values(bindings).some(binding => binding?.projectId === p.id && binding.workspacePath && path.resolve(binding.workspacePath) === path.resolve(wsPath));
    if (discovered || retained) {
      return { project: p, contexts, worktrees: Object.fromEntries(contexts.filter(context => context.branch).map(context => [context.branch, context.path])) };
    }
  }
  return null;
}

function descendantsOf(sup, sessionId) {
  if (typeof sup?.allSessions !== "function") return [];
  return Promise.resolve(sup.allSessions()).then(sessions => {
    const children = new Map();
    for (const session of sessions || []) {
      if (!session?.id || !session.parentSessionId) continue;
      const siblings = children.get(session.parentSessionId) || [];
      siblings.push(session.id);
      children.set(session.parentSessionId, siblings);
    }
    const seen = new Set([sessionId]);
    const queue = [sessionId];
    const descendants = [];
    while (queue.length) {
      for (const child of children.get(queue.shift()) || []) {
        if (seen.has(child)) continue;
        seen.add(child);
        descendants.push(child);
        queue.push(child);
      }
    }
    return descendants;
  });
}

// Close a conversation and its forks: stop a running turn, let go of it here, and take it off the sidebar.
// Unloading shuts its extensions down, so pi-sync uploads what is left, releases its lease and stops polling.
// Nothing is written into the conversation: it stays shared, and opens again like any other.
export async function closeSession(sup, hub, sessionId, { report = null } = {}) {
  const sessionIds = [sessionId, ...(await descendantsOf(sup, sessionId))];
  report?.({ type: "phase", phase: "closed-read", message: "Reading the list of closed conversations." });
  // Read first: a corrupt list fails before anything is stopped.
  const closed = loadClosed();
  for (const id of sessionIds) {
    if (sup.isStreaming?.(id)) {
      report?.({ type: "phase", phase: "stop", message: `Stopping the running turn in ${id}.` });
      await sup.stop(id).catch(() => undefined);
    }
    // A failed unload must not keep it on the sidebar; the warning is in the operation log.
    await sup.unload?.(id).catch(error => report?.({ type: "warning", phase: "unload", message: `Could not unload ${id}: ${error.message || error}` }));
  }
  for (const id of sessionIds) closed.add(id);
  report?.({ type: "phase", phase: "closed-write", message: "Writing the list of closed conversations." });
  saveClosed(closed);
  report?.({ type: "phase", phase: "session-event", message: "Emitting the session-closed event." });
  for (const id of sessionIds) hub.emit(id, "session_closed", { sessionId: id });
  return { closed: true };
}

// After a close: a worktree that no open session uses any more, is clean and is merged into
// main can be deleted. Returns what the client needs to offer that, or null.
export async function cleanupCandidate(sup, workspacePath) {
  if (!workspacePath) return null;
  const found = await findProjectByWorkspaceAsync(workspacePath);
  if (!found || path.resolve(workspacePath) === path.resolve(found.project.repoPath)) return null;
  const context = found.contexts.find(item => path.resolve(item.path) === path.resolve(workspacePath));
  const primaryBranch = await ws.defaultBranchAsync(found.project.repoPath);
  if (!context?.branch || context.branch === primaryBranch) return null;
  if ((await sessionsUsingWorkspaceAsync(found.project, workspacePath, sup)).length) return null;
  const status = await ws.contextStatusAsync({ repoPath: found.project.repoPath, workspacePath, primaryBranch });
  if (status.dirty !== false) return null;
  if (!await ws.branchMergedAsync(found.project.repoPath, context.branch, primaryBranch)) return null;
  return { projectId: found.project.id, branch: context.branch, primaryBranch };
}

// Shares `ids` again with pi-sync's attach, which works in the session's own file: it uploads what this copy
// added, or takes the server's copy when that is newer (turns only this copy has are kept as a separate
// conversation). Returns { attached: ids, syncError }.
export async function attachSynced(sup, ids) {
  const attached = [];
  for (const id of ids) {
    try { await sup.command(id, "/sync attach"); attached.push(id); }
    catch (error) { return { attached, syncError: `This conversation is not syncing: ${error.message || error}. Run /sync attach in it.` }; }
  }
  return { attached };
}

// Opens a closed conversation: it and its forks go back on the sidebar, and pi-sync catches them up when they
// load, as it does any conversation. Only a copy that still carries a detach (what closing wrote before) and that
// the sync server lists is attached first; when that fails nothing opens, since typing into the stale copy would
// fork the conversation. Returns { restored, attached?, syncError? }.
export async function restoreSession(sup, hub, sessionId, { listed = syncedConversations } = {}) {
  const closed = loadClosed();
  if (!closed.has(sessionId)) return { restored: false };
  const ids = [sessionId, ...(await descendantsOf(sup, sessionId))];
  const detached = syncConfig().serverUrl ? ids.filter(id => sup.syncCopy?.(id)?.detached) : [];
  let attached;
  if (detached.length) {
    let items;
    try { items = await listed(); }
    catch (error) { return { restored: false, syncError: `This conversation was detached from sync, and the sync server did not answer (${error.message || error}). Try again.` }; }
    const sync = await attachSynced(sup, detached.filter(id => items?.has(id)));
    if (sync.syncError) {
      // The attach loaded them; let go again, so nothing holds or polls a conversation that stays closed.
      for (const id of detached) await sup.unload?.(id).catch(() => undefined);
      return { restored: false, ...sync };
    }
    attached = sync.attached;
  }
  for (const id of ids) closed.delete(id);
  saveClosed(closed);
  hub.emit(sessionId, "session_meta", {});
  return { restored: true, ...(attached ? { attached } : {}) };
}

function failure(code, extra = {}) {
  return Object.assign(new Error(code), { code, ...extra });
}

// Compatibility helpers retained for older API clients; branch workflows now
// use the explicit branch-context and merge-local routes.
export async function switchCheckoutToMain(sup, hub, project, { beforeSwitch = null } = {}) {
  const primaryBranch = await ws.defaultBranchAsync(project.repoPath);
  const worktrees = await ws.listWorktreesAsync(project.repoPath);
  const mainPath = worktrees[primaryBranch];
  if (mainPath && path.resolve(mainPath) !== path.resolve(project.repoPath)) {
    throw failure("main_worktree_external", { workspacePath: mainPath });
  }
  let sessions = await sessionsUsingWorkspaceAsync(project, project.repoPath, sup);
  if (await ws.currentBranchAsync(project.repoPath) === primaryBranch) return { switched: false, sessions };
  if (await ws.isDirtyAsync(project.repoPath)) throw failure("checkout_dirty");
  sessions = await sessionsUsingWorkspaceAsync(project, project.repoPath, sup);
  await beforeSwitch?.(sessions);
  if (sessions.some(session => sup.isStreaming(session.id))) throw failure("sessions_active");
  await ws.switchWorkspaceAsync({ repoPath: project.repoPath, workspacePath: project.repoPath, branch: primaryBranch, primaryBranch });
  sessions = await sessionsUsingWorkspaceAsync(project, project.repoPath, sup);
  const bindings = loadBindings();
  sessions = sessions.filter(session => !bindings[session.id]?.workspacePath || path.resolve(bindings[session.id].workspacePath) === path.resolve(project.repoPath));
  for (const session of sessions) bindings[session.id] = { branch: primaryBranch, workspacePath: project.repoPath };
  saveBindings(bindings);
  for (const session of sessions) {
    hub.emit(session.id, "session_meta", { branch: primaryBranch });
    hub.emit(session.id, "workspace_switched", { branch: primaryBranch, workspacePath: project.repoPath });
  }
  return { switched: true, sessions };
}

export async function returnSessionToMain(sup, hub, sessionId, { beforeSwitch = null, expectedCwd = null } = {}) {
  if (sup.isStreaming(sessionId)) throw failure("session_streaming");
  const cwd = await sessionWorkspace(sessionId, sup);
  if (expectedCwd && (!cwd || path.resolve(cwd) !== path.resolve(expectedCwd))) throw failure("repository_changed");
  const validateSession = async () => {
    const latestCwd = await sessionWorkspace(sessionId, sup);
    if (!latestCwd || path.resolve(latestCwd) !== path.resolve(cwd)) throw failure("repository_changed");
    if (sup.isStreaming(sessionId)) throw failure("session_streaming");
  };
  const found = cwd && await findProjectByWorkspaceAsync(cwd);
  if (!found) throw failure("no_project_for_session");
  const { project } = found;
  const primaryBranch = await ws.defaultBranchAsync(project.repoPath);
  const checkout = path.resolve(cwd) === path.resolve(project.repoPath);
  const result = await switchCheckoutToMain(sup, hub, project, {
    beforeSwitch: async sessions => {
      await beforeSwitch?.(sessions);
      await validateSession();
    },
  });
  await validateSession();
  if (checkout) return { ok: true, branch: primaryBranch, workspacePath: project.repoPath, switched: result.switched, returned: false };
  try { await sup.rehome(sessionId, project.repoPath); }
  catch (e) { throw failure("return_rehome_failed", { detail: String(e.message || e).slice(0, 400) }); }
  const bindings = loadBindings();
  bindings[sessionId] = { branch: primaryBranch, workspacePath: project.repoPath };
  saveBindings(bindings);
  hub.emit(sessionId, "session_meta", { branch: primaryBranch });
  hub.emit(sessionId, "session_returned", { branch: primaryBranch, workspacePath: project.repoPath });
  return { ok: true, branch: primaryBranch, workspacePath: project.repoPath, switched: result.switched, returned: true };
}
