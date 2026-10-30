import { syncConfig } from "../config.js";
import { remoteConversationPreview, remoteConversationsForProject, remoteConversationsForRepository } from "../pi-sync.js";
import { withRepositoryAdmission as runRepositoryAdmission } from "../repository-admission.js";
import { createPiProject, forgetRepo, listPiProjects, piProject, pushState, recordRepo, repoEntry } from "../pi-projects.js";
import { folderId } from "../domain.js";

const IDLE_MS = 24 * 60 * 60 * 1000;

export function register(api, deps) {
  const { path, loadConfig, newId, sessionWorkspace, normalizeHooks, repositorySource, reposRoot, resolvePath, saveConfig, hub, ws, cloneRepository, projectHooks, createOperationReporter, operationRequestId, assertRepositoryIdentity, err, withRepositoryAdmission, projectContext, projectContextAsync, bindSessionToContext, branchContextAsync, ensureBranchContext, sessionBelongsToProject, github, sup, projectState, closeSession, sessionsUsingWorkspaceAsync } = deps;
  // A pi project's own folder (web id pp-<name>): sessions there need no repository.
  const folderOf = id => listPiProjects().find(group => folderId(group.name) === id) || null;

  // A new session on main opens at once; main is fetched and fast-forwarded afterwards.
  // Skipped (and logged to History) when main is dirty, diverged, busy or a turn is running.
  const pullMainLater = (project, mainBranch, context, sessionId) => setTimeout(() => {
    const reporter = createOperationReporter({ sessionId, kind: "pull", title: `Update ${mainBranch}` });
    reporter.bind(context.path);
    runRepositoryAdmission(project.repoPath, async () => {
      // Never switch branches in the background: only update main while the checkout is still on it.
      if (await ws.currentBranchAsync(project.repoPath) !== mainBranch) return reporter.finish({ status: "error", message: `Skipped: the checkout is no longer on ${mainBranch}.` });
      const sessions = await sessionsUsingWorkspaceAsync(project, context.path, sup);
      if (sessions.some(session => sup.isStreaming(session.id))) return reporter.finish({ status: "error", message: `Skipped: a session on ${mainBranch} is running.` });
      const result = await ws.prepareMainAsync(project.repoPath, { fetch: true, primaryBranch: mainBranch, report: reporter.log });
      reporter.finish({ message: result.fastForwarded ? `${mainBranch} is up to date with ${result.upstream}.` : `${mainBranch} was already up to date.` });
      if (result.fastForwarded) hub.emit(sessionId, "session_meta", {});
    }).catch(error => reporter.finish({ status: "error", message: `Skipped: ${error.detail || error.message || error.code}` }));
  }, 0);


  api.post("/projects", async c => {
    const body = await c.req.json();
    // A new pi project: a named folder; repositories are added to it afterwards.
    if (typeof body.project === "string" && !body.source) {
      try { await createPiProject(body.project); }
      catch (e) {
        const statuses = { pi_projects_disabled: 409, invalid_project_name: 400, project_exists: 409 };
        if (statuses[e.code]) return err(c, statuses[e.code], e.code);
        throw e;
      }
      return c.json({ project: body.project }, 201);
    }
    const cfg = loadConfig();
    const source = body.source || repositorySource(cfg);
    // Adding a repository to a pi project clones it into that project's repos/.
    const group = body.group ? piProject(String(body.group)) : null;
    if (body.group && !group) return err(c, 404, "no_such_pi_project");
    let repoPath, sourceInfo, cloned;
    {
      try {
        const result = await cloneRepository({
          source,
          url: body.url,
          fullName: body.fullName,
          github,
          root: group ? path.join(group.path, "repos") : reposRoot(cfg),
          signal: c.req.raw?.signal,
        });
        repoPath = result.repoPath;
        sourceInfo = result.source;
        cloned = result.cloned;
      } catch (e) {
        const statuses = {
          github_auth_required: 401,
          github_not_configured: 409,
          github_not_found: 404,
          github_rate_limited: 403,
          github_unavailable: 502,
          invalid_github_repository: 400,
          invalid_git_url: 400,
          invalid_repository_name: 400,
          unsupported_repository_source: 400,
          repository_exists: 409,
          clone_in_progress: 409,
          clone_failed: 502,
        };
        // A removed project's clone is kept on disk; adding it again reuses it.
        if (e.code === "repository_exists" && e.repoPath && !cfg.projects.some(p => p.repoPath === e.repoPath)) {
          ({ repoPath, source: sourceInfo } = e);
          cloned = false;
        } else if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.code === "clone_failed" ? { message: e.message } : {});
        else throw e;
      }
    }
    if (cfg.projects.some(p => p.repoPath === repoPath)) return err(c, 409, "project_exists");
    let project = {
      id: newId("p"), name: body.name || path.basename(repoPath), repoPath, source: sourceInfo,
      hooks: normalizeHooks(body.hooks),
    };
    if (group) {
      const url = sourceInfo?.type === "github" ? `https://github.com/${sourceInfo.fullName}.git` : sourceInfo?.url || body.url;
      const branch = await ws.currentBranchAsync(repoPath).catch(() => null);
      const repo = { name: path.basename(repoPath), url, ...(branch ? { branch } : {}) };
      recordRepo(group.name, repo);
      project = { ...repoEntry(group, repo), source: sourceInfo, hooks: project.hooks };
      pushState(`${group.name}: add ${repo.name}`).catch(error => console.warn(`pi-projects: could not sync ${group.name}: ${error.message}`));
    }
    cfg.projects.push(project);
    saveConfig(cfg);
    // First session runs in the repository checkout; Git state remains user-owned.
    const { id: sessionId } = await sup.createSession({ cwd: repoPath });
    const context = projectContext(project, null);
    if (context) bindSessionToContext(sessionId, project, context);
    hub.emit(sessionId, "session_created", { session: { id: sessionId, projectId: project.id, contextId: context?.id || null } });
    const setupNeeded = !!projectHooks(cfg, project).setup;
    return c.json({ id: project.id, sessionId, repoPath, cloned, contextId: context?.id || null, branch: context?.branch || null, workspacePath: context?.path || repoPath, setup: null, setupNeeded });
  });

  api.post("/projects/:id/fetch", async c => {
    const id = c.req.param("id");
    const project = loadConfig().projects.find(item => item.id === id);
    if (!project) return err(c, 404, "no_such_project");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const reporter = createOperationReporter({ id: operationRequestId(c, body), kind: "fetch", title: "Fetch Git branches" });
    reporter.log({ type: "request", phase: "request", message: `POST /api/projects/${id}/fetch` });
    // Fetched from a session panel: keep it in that session's workspace history.
    if (typeof body.sessionId === "string" && body.sessionId) reporter.bind(await sessionWorkspace(body.sessionId, sup).catch(() => null));
    return withRepositoryAdmission(c, project.repoPath, async identity => {
      const currentProject = loadConfig().projects.find(item => item.id === id);
      if (!currentProject) return err(c, 404, "no_such_project");
      await assertRepositoryIdentity(identity, currentProject.repoPath);
      try {
        const result = await ws.fetchRepositoryAsync(currentProject.repoPath, { report: reporter.log });
        const operation = reporter.finish({ httpStatus: 200, message: "Fetched Git branches." });
        return c.json({ ok: true, projectId: id, ...result, operation });
      } catch (e) {
        if (e.code === "git_fetch_failed") {
          const operation = reporter.finish({ status: "error", httpStatus: 409, message: e.detail || e.message || e.code });
          return err(c, 409, e.code, { detail: e.detail, operation });
        }
        reporter.finish({ status: "error", httpStatus: 500, message: e.message || String(e) });
        throw e;
      }
    }, reporter);
  });

  // End every session tree with no activity for a day and nothing running in it.
  // Remove a project: end its sessions and drop it from the list. The checkout on disk is kept.
  api.delete("/projects/:id", async c => {
    const cfg = loadConfig();
    const project = cfg.projects.find(p => p.id === c.req.param("id"));
    if (!project) return err(c, 404, "no_such_project");
    const { sessions } = await projectState(project, sup);
    for (const session of sessions) await closeSession(sup, hub, session.id);
    const latest = loadConfig();
    latest.projects = latest.projects.filter(p => p.id !== project.id);
    saveConfig(latest);
    // A pi project's repository is also dropped from project.json, so other machines and workers drop it too.
    if (project.group && forgetRepo(project.group, path.basename(project.repoPath))) {
      pushState(`${project.group}: remove ${path.basename(project.repoPath)}`).catch(error => console.warn(`pi-projects: could not sync ${project.group}: ${error.message}`));
    }
    return c.json({ ok: true, id: project.id, endedSessions: sessions.length });
  });

  api.post("/projects/:id/end-idle", async c => {
    const project = loadConfig().projects.find(p => p.id === c.req.param("id"));
    if (!project) return err(c, 404, "no_such_project");
    const cutoff = Date.now() - IDLE_MS;
    const busy = node => node.streaming || (node.children || []).some(busy);
    const idle = (await projectState(project, sup)).sessions.filter(node => !busy(node) && Date.parse(node.activityAt || 0) < cutoff);
    for (const node of idle) await closeSession(sup, hub, node.id);
    return c.json({ ok: true, ended: idle.map(node => node.id) });
  });

  api.get("/projects/:id/synced-sessions", async c => {
    const project = loadConfig().projects.find(p => p.id === c.req.param("id"));
    const folder = project ? null : folderOf(c.req.param("id"));
    if (!project && !folder) return err(c, 404, "no_such_project");
    if (!syncConfig(loadConfig()).serverUrl) return c.json({ sessions: [] });
    try {
      const localIds = new Set((await sup.allSessions()).map(session => session.id));
      if (folder) return c.json({ sessions: await remoteConversationsForProject(folder.name, id => localIds.has(id)) });
      return c.json({ sessions: await remoteConversationsForRepository(project.repoPath, localIds, { project: project.group || null }) });
    } catch { return c.json({ sessions: [], unavailable: true }); }
  });

  api.get("/projects/:id/synced-sessions/:syncId", async c => {
    if (!loadConfig().projects.some(p => p.id === c.req.param("id")) && !folderOf(c.req.param("id"))) return err(c, 404, "no_such_project");
    if (!syncConfig(loadConfig()).serverUrl) return err(c, 409, "sync_not_configured");
    try { return c.json({ records: await remoteConversationPreview(c.req.param("syncId")) }); }
    catch (error) { return err(c, 502, "sync_preview_failed", { message: error.message }); }
  });

  // Open another device's conversation by replacing a fresh session at `cwd` in place (pi-sync's /sync open).
  async function openSynced(c, syncSessionId, cwd, reporter) {
    if (!syncConfig(loadConfig()).serverUrl) return { error: err(c, 409, "sync_not_configured") };
    if (typeof syncSessionId !== "string" || !syncSessionId) return { error: err(c, 400, "bad_sync_session") };
    reporter.log({ type: "phase", phase: "open-synced", message: `Opening synchronized conversation ${syncSessionId}.` });
    const { id: createdId } = await sup.createSession({ cwd });
    try { await sup.command(createdId, `/sync open ${syncSessionId}`, "prompt"); }
    catch (error) {
      const operation = reporter.finish({ status: "error", httpStatus: 409, message: error.message || "The conversation could not be opened." });
      return { error: err(c, 409, "sync_open_failed", { message: error.message, operation }) };
    }
    if (!sup.isLive(syncSessionId)) {
      const operation = reporter.finish({ status: "error", httpStatus: 409, message: "The conversation could not be opened." });
      return { error: err(c, 409, "sync_open_failed", { operation }) };
    }
    return { sessionId: syncSessionId };
  }

  api.post("/projects/:id/sessions", async c => {
    const folder = folderOf(c.req.param("id"));
    if (folder && !loadConfig().projects.some(p => p.id === c.req.param("id"))) {
      const body = (await c.req.json().catch(() => ({}))) || {};
      const name = typeof body.name === "string" ? body.name.trim() || null : null;
      const reporter = createOperationReporter({ id: operationRequestId(c, body), kind: "create-session", title: "Create session" });
      reporter.log({ type: "request", phase: "request", message: `POST /api/projects/${folder.name}/sessions` });
      const base = { projectId: folderId(folder.name), contextId: "folder", branch: null, workspacePath: folder.path, setup: null, setupNeeded: false };
      if (body.mode === "synced") {
        const opened = await openSynced(c, body.syncSessionId, folder.path, reporter);
        if (opened.error) return opened.error;
        hub.emit(opened.sessionId, "session_created", { session: { id: opened.sessionId, projectId: base.projectId, contextId: "folder", branch: null } });
        return c.json({ id: opened.sessionId, ...base, operation: reporter.finish({ httpStatus: 200, message: "Opened synchronized conversation in the project folder." }) });
      }
      const { id: sessionId } = await sup.createSession({ cwd: folder.path, name });
      hub.emit(sessionId, "session_created", { session: { id: sessionId, projectId: base.projectId, contextId: "folder", branch: null } });
      return c.json({ id: sessionId, ...base, operation: reporter.finish({ httpStatus: 200, message: `Created session ${sessionId} in the project folder.` }) });
    }
    const initialProject = loadConfig().projects.find(p => p.id === c.req.param("id"));
    if (!initialProject) return err(c, 404, "no_such_project");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const name = typeof body.name === "string" ? body.name.trim() || null : null;
    const mode = body.mode === "fork" ? "fork" : body.mode === "synced" ? "synced" : "new";
    const reporter = createOperationReporter({ id: operationRequestId(c, body), sessionId: body.sourceSessionId || null, kind: mode === "fork" ? "fork" : "create-session", title: mode === "fork" ? "Fork session" : "Create session" });
    reporter.log({ type: "request", phase: "request", message: `POST /api/projects/${c.req.param("id")}/sessions` });
    return withRepositoryAdmission(c, initialProject.repoPath, async identity => {
      const project = loadConfig().projects.find(item => item.id === initialProject.id);
      if (!project) return err(c, 404, "no_such_project");
      await assertRepositoryIdentity(identity, project.repoPath);
      const mainBranch = await ws.defaultBranchAsync(project.repoPath);
      let branch = typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : null;
      const legacyContext = body.contextId ? await projectContextAsync(project, body.contextId) : null;
      if (!branch && legacyContext) branch = legacyContext.branch;
      branch ||= mainBranch;
      try {
        let sourceSessionId = null;
      let atRecordId = null;
      if (mode === "fork") {
        sourceSessionId = String(body.sourceSessionId || "");
        if (!sourceSessionId || !(await sessionBelongsToProject(sourceSessionId, project, sup))) {
          const operation = reporter.finish({ status: "error", httpStatus: 404, message: "The source session was not found in this project." });
          return err(c, 404, "no_such_source_session", { operation });
        }
        atRecordId = typeof body.atRecordId === "string" && body.atRecordId ? body.atRecordId : null;
        if (atRecordId && !(await sup.transcript(sourceSessionId)).some(record => record.id === atRecordId && record.role === "user")) {
          const operation = reporter.finish({ status: "error", httpStatus: 400, message: "The fork record must be a user message." });
          return err(c, 400, "bad_fork_record", { operation });
        }
      }
      const existed = !!(await branchContextAsync(project, branch));
      let notice = null;
      let context;
      try {
        context = await ensureBranchContext(project, branch, body.baseBranch || mainBranch, { syncMain: true, report: reporter.log, sup, except: sourceSessionId });
      } catch (error) {
        // A new session never moves a checkout others are working in: it starts where the checkout is.
        if (error.code !== "checkout_in_use" || mode !== "new") throw error;
        notice = `${error.detail} The new session starts on ${error.branch}.`;
        reporter.log({ type: "phase", phase: "prepare-main", message: notice });
        context = await branchContextAsync(project, error.branch) || await ws.contextStatusAsync({ repoPath: project.repoPath, workspacePath: project.repoPath, primaryBranch: mainBranch });
      }
      const setupNeeded = !existed && context.kind !== "checkout" && !!projectHooks(loadConfig(), project).setup;
      if (mode === "fork") {
        reporter.log({ type: "phase", phase: "fork-session", message: `Forking from session ${sourceSessionId}.` });
        const { id: sessionId } = await sup.fork(sourceSessionId, atRecordId, { cwd: context.path, name });
        bindSessionToContext(sessionId, project, context);
        hub.emit(sessionId, "session_forked", { session: { id: sessionId, contextId: context.id, branch: context.branch }, parentSessionId: sourceSessionId });
        const operation = reporter.finish({ httpStatus: 200, message: `Forked session ${sessionId} on ${context.branch}.` });
        return c.json({ id: sessionId, projectId: project.id, contextId: context.id, branch: context.branch, workspacePath: context.path, forkedFrom: sourceSessionId, setup: null, setupNeeded, operation });
      }
      if (mode === "synced") {
        const opened = await openSynced(c, body.syncSessionId, context.path, reporter);
        if (opened.error) return opened.error;
        const sessionId = opened.sessionId;
        // No binding write: without a binding the session's workspace is its cwd (server/domain.js).
        hub.emit(sessionId, "session_created", { session: { id: sessionId, projectId: project.id, contextId: context.id, branch: context.branch } });
        const operation = reporter.finish({ httpStatus: 200, message: `Opened synchronized conversation on ${context.branch}.` });
        return c.json({ id: sessionId, projectId: project.id, contextId: context.id, branch: context.branch, workspacePath: context.path, setup: null, setupNeeded, operation });
      }
      reporter.log({ type: "phase", phase: "create-session", message: `Creating the Pi session in ${context.path}.` });
      const { id: sessionId } = await sup.createSession({ cwd: context.path, name });
      bindSessionToContext(sessionId, project, context);
      if (body.pull === "background" && context.branch === mainBranch && context.kind === "checkout") pullMainLater(project, mainBranch, context, sessionId);
      hub.emit(sessionId, "session_created", { session: { id: sessionId, projectId: project.id, contextId: context.id, branch: context.branch } });
      const operation = reporter.finish({ httpStatus: 200, message: `Created session ${sessionId} on ${context.branch}.` });
      return c.json({ id: sessionId, projectId: project.id, contextId: context.id, branch: context.branch, workspacePath: context.path, setup: null, setupNeeded, operation, ...(notice ? { notice } : {}) });
    } catch (e) {
      const statuses = { checkout_in_use: 409, bad_branch: 400, no_such_base_branch: 404, checkout_dirty: 409, git_status_unavailable: 409, main_worktree_external: 409, main_fetch_failed: 409, main_not_fast_forwardable: 409, git_switch_failed: 409 };
      if (statuses[e.code]) {
        const operation = reporter.finish({ status: "error", httpStatus: statuses[e.code], message: e.detail || e.message || e.code });
        return err(c, statuses[e.code], e.code, { ...(e.detail ? { detail: e.detail } : {}), operation });
      }
      if (e.code === "bad_fork_record") {
        const operation = reporter.finish({ status: "error", httpStatus: 400, message: e.message || e.code });
        return err(c, 400, e.code, { operation });
      }
      if (String(e?.message || "").startsWith("unknown")) {
        const operation = reporter.finish({ status: "error", httpStatus: 404, message: "The source session was not found." });
        return err(c, 404, "no_such_source_session", { operation });
      }
        reporter.finish({ status: "error", httpStatus: 500, message: e.message || String(e) });
        throw e;
      }
    }, reporter);
  });
}
