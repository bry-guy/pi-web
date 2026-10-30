import path from "node:path";
import {
  chatsDir, githubConfig, loadBindings, loadConfig, newId, normalizeHookSets, normalizeHooks, normalizePiConfig, normalizeSyncConfig, normalizeThinkingLevel, repositorySource, reposRoot, resolvePath, saveBindings, saveConfig, sessionSlug, slug, syncConfig, syncSettingsState, worktreeTarget,
} from "../config.js";
import { chatsState, projectState, sessionWorkspace, sessionsUsingWorkspace, sessionsUsingWorkspaceAsync } from "../domain.js";
import { closeSession, findProjectByWorkspace, findProjectByWorkspaceAsync, returnSessionToMain } from "../lifecycle.js";
import * as ws from "../workspaces.js";
import { AuthFlowManager } from "../auth-flows.js";
import { assertRepositoryIdentity, withRepositoryAdmission as runRepositoryAdmission } from "../repository-admission.js";


export const err = (c, status, code, extra = {}) => c.json({ error: code, ...extra }, status);
export const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };
export const withRepositoryAdmission = async (c, repoPath, task, reporter = null) => {
  try { return await runRepositoryAdmission(repoPath, task); }
  catch (error) {
    if (!error?.repositoryAdmission) throw error;
    const operation = reporter?.finish({ status: "error", httpStatus: 409, message: error.message || error.code });
    return err(c, 409, error.code, { ...(error.detail ? { detail: error.detail } : {}), ...(operation ? { operation } : {}) });
  }
};
export const formatDuration = durationMs => durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;

// Collisions count like humans do: foo, foo-2, foo-3.
// The `.N` namespace is reserved for fork children (see forkWorkspace).
// With workspaced, projects live only in workers, so web offers no local source.
export function repositorySourceState(cfg, github) {
  const status = github.status();
  return {
    default: repositorySource(cfg),
    sources: [
      {
        id: "github",
        enabled: true,
        configured: status.configured,
        authenticated: status.authenticated,
        credentialSource: status.credentialSource,
        account: status.account,
        owner: status.owner,
      },
      { id: "git-url", enabled: true },
    ],
  };
}

export function settingsState(cfg, github) {
  const githubCfg = githubConfig(cfg);
  return {
    sync: syncSettingsState(cfg),
    reposRoot: {
      value: reposRoot(cfg),
      source: process.env.PI_WEB_REPOS_ROOT ? "PI_WEB_REPOS_ROOT" : cfg.reposRoot ? "config" : "default",
      editable: !process.env.PI_WEB_REPOS_ROOT,
    },
    defaultRepositorySource: {
      value: repositorySource(cfg),
      source: process.env.PI_WEB_REPOSITORY_SOURCE ? "PI_WEB_REPOSITORY_SOURCE" : "config",
      editable: !process.env.PI_WEB_REPOSITORY_SOURCE,
    },
    githubOwner: {
      value: githubCfg.owner,
      source: process.env.PI_WEB_GITHUB_OWNER ? "PI_WEB_GITHUB_OWNER" : "config",
      editable: !process.env.PI_WEB_GITHUB_OWNER,
    },
  };
}

export async function suggestedWorktreeBranch(repoPath, sessionId, sup) {
  const records = await sup.transcript(sessionId);
  const firstMessage = records.find(record => record.role === "user")?.text || "";
  const base = sessionSlug(firstMessage);
  const branches = await ws.listBranchesAsync(repoPath);
  if (!branches.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!branches.includes(candidate)) return candidate;
  }
}

export function projectContext(project, requestedId) {
  const contexts = ws.listContexts(project.repoPath);
  if (requestedId) return contexts.find(context => context.id === String(requestedId)) || null;
  return contexts.find(context => path.resolve(context.path) === path.resolve(project.repoPath)) || contexts[0] || null;
}

export async function projectContextAsync(project, requestedId) {
  const contexts = await ws.listContextsAsync(project.repoPath);
  if (requestedId) return contexts.find(context => context.id === String(requestedId)) || null;
  return contexts.find(context => path.resolve(context.path) === path.resolve(project.repoPath)) || contexts[0] || null;
}

export function requestedContext(project, c) {
  if (c.req.query("contextId")) return projectContext(project, c.req.query("contextId"));
  const branch = c.req.query("branch");
  if (branch) return ws.listContexts(project.repoPath).find(context => context.branch === branch) || null;
  return projectContext(project, null);
}

export function bindSessionToContext(sessionId, project, context) {
  const bindings = loadBindings();
  bindings[sessionId] = { projectId: project.id, workspacePath: context.path };
  saveBindings(bindings);
}

export function bindRehomedSession(sessionId, project, source, target) {
  const bindings = loadBindings();
  const boundPath = bindings[sessionId]?.workspacePath;
  if (boundPath && ![source, target].some(dir => path.resolve(dir) === path.resolve(boundPath))) {
    throw Object.assign(new Error("repository_changed"), { code: "repository_changed" });
  }
  bindings[sessionId] = { projectId: project.id, workspacePath: target };
  saveBindings(bindings);
}

export function boundProject(sessionId) {
  const projectId = loadBindings()[sessionId]?.projectId;
  return projectId ? loadConfig().projects.find(project => project.id === projectId) || null : null;
}

export function branchContext(project, branch) {
  const contexts = ws.listContexts(project.repoPath).filter(context => context.branch === branch);
  return contexts.find(context => context.kind === "checkout") || contexts[0] || null;
}

export async function branchContextAsync(project, branch) {
  const contexts = (await ws.listContextsAsync(project.repoPath)).filter(context => context.branch === branch);
  return contexts.find(context => context.kind === "checkout") || contexts[0] || null;
}

export function primaryBranch(project) {
  return ws.defaultBranch(project.repoPath);
}

/**
 * Sessions other than `except` working in the project's checkout. When the checkout has been moved off
 * main (by hand, or by an agent running there), switching it back would pull the branch out from
 * under them, so main is then left alone.
 */
export async function checkoutHolders(project, sup, except = null) {
  if (!sup) return [];
  const sessions = await sessionsUsingWorkspaceAsync(project, project.repoPath, sup);
  return sessions.filter(session => session.id !== except
    && (session.streaming || sup.isOpen?.(session.id) || session.title !== "New session"));
}

async function assertCheckoutFree(project, mainBranch, sup, except) {
  const current = await ws.currentBranchAsync(project.repoPath);
  if (!current || current === mainBranch) return;
  const holders = await checkoutHolders(project, sup, except);
  if (holders.length) {
    throw Object.assign(new Error("checkout_in_use"), {
      code: "checkout_in_use", branch: current,
      detail: `The checkout is on ${current}, where ${holders.length === 1 ? "another session is" : `${holders.length} other sessions are`} working; it was not switched to ${mainBranch}.`,
    });
  }
}

export async function ensureBranchContext(project, branch, baseBranch, { syncMain = true, report = null, sup = null, except = null } = {}) {
  const mainBranch = await ws.defaultBranchAsync(project.repoPath);
  branch = await ws.validateBranchNameAsync(branch || mainBranch);
  baseBranch = await ws.validateBranchNameAsync(baseBranch || mainBranch);
  if (branch === mainBranch) {
    report?.({ type: "phase", phase: "prepare-main", message: `Preparing ${mainBranch} checkout.` });
    await assertCheckoutFree(project, mainBranch, sup, except);
    await ws.prepareMainAsync(project.repoPath, { fetch: false, primaryBranch: mainBranch, report });
    return (await branchContextAsync(project, branch)) || ws.contextStatusAsync({ repoPath: project.repoPath, workspacePath: project.repoPath, primaryBranch: mainBranch });
  }
  const existing = await branchContextAsync(project, branch);
  if (existing) return existing;
  const branches = await ws.listBranchesAsync(project.repoPath);
  if (!branches.includes(branch) && baseBranch === mainBranch && syncMain) {
    report?.({ type: "phase", phase: "fetch-main", message: `Updating ${mainBranch} before creating ${branch}.` });
    // A checkout in use on another branch is not switched; the branch starts from local main instead.
    try {
      await assertCheckoutFree(project, mainBranch, sup, except);
      await ws.prepareMainAsync(project.repoPath, { fetch: true, primaryBranch: mainBranch, report });
    } catch (error) {
      if (error.code !== "checkout_in_use") throw error;
      report?.({ type: "phase", phase: "fetch-main", message: `${error.detail} ${branch} starts from local ${mainBranch}.` });
    }
  }
  if (!(await ws.listBranchesAsync(project.repoPath)).includes(baseBranch)) throw Object.assign(new Error("no_such_base_branch"), { code: "no_such_base_branch" });
  const cfg = loadConfig();
  const workspacePath = await ws.ensureWorkspaceAsync({
    repoPath: project.repoPath,
    ...worktreeTarget(cfg, project),
    branch,
    fromRef: baseBranch,
    primaryBranch: mainBranch,
    report,
  });
  const context = await branchContextAsync(project, branch);
  return context || ws.contextStatusAsync({ repoPath: project.repoPath, workspacePath, primaryBranch: mainBranch });
}

export async function sessionBelongsToProject(id, project, sup) {
  const cwd = await sessionWorkspace(id, sup);
  if (!cwd) return false;
  const found = await findProjectByWorkspaceAsync(cwd);
  return found?.project?.id === project.id;
}
