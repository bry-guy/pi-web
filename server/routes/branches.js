export function register(api, deps) {
  const { path, loadConfig, sessionWorkspace, sessionsUsingWorkspaceAsync, closeSession, hub, ws, createOperationReporter, operationRequestId, assertRepositoryIdentity, err, withRepositoryAdmission, bindRehomedSession, branchContextAsync, primaryBranch, guardedWorkspaceSessions, sup } = deps;


  // ---------- workspace cleanup ----------
  api.delete("/projects/:id/branches/:branch", async c => {
    const id = c.req.param("id");
    const initialProject = loadConfig().projects.find(x => x.id === id);
    const body = await c.req.json().catch(() => ({}));
    const reporter = createOperationReporter({ id: operationRequestId(c, body), kind: "delete", title: "Delete branch" });
    reporter.log({ type: "request", phase: "request", message: `DELETE /api/projects/${c.req.param("id")}/branches/${c.req.param("branch")}` });
    if (!initialProject) {
      const operation = reporter.finish({ status: "error", httpStatus: 404, message: "The project does not exist." });
      return err(c, 404, "no_such_project", { operation });
    }
    return withRepositoryAdmission(c, initialProject.repoPath, async identity => {
    const p = loadConfig().projects.find(x => x.id === id);
    if (!p) {
      const operation = reporter.finish({ status: "error", httpStatus: 404, message: "The project does not exist." });
      return err(c, 404, "no_such_project", { operation });
    }
    await assertRepositoryIdentity(identity, p.repoPath);
    const branch = decodeURIComponent(c.req.param("branch"));
    const mainBranch = await ws.defaultBranchAsync(p.repoPath);
    if (branch === mainBranch) {
      const operation = reporter.finish({ status: "error", httpStatus: 400, message: `The primary branch ${mainBranch} cannot be deleted.` });
      return err(c, 400, "cannot_delete_main", { operation });
    }
    const force = body.force === true || c.req.query("force") === "1";
    const closeSessions = body.closeSessions === true;
    const context = await branchContextAsync(p, branch);
    const wsPath = context?.path || null;
    try {
      let affected = wsPath ? await guardedWorkspaceSessions(p, wsPath, true) : [];
      const validateDeletion = async () => {
        if (wsPath) {
          const status = await ws.contextStatusAsync({ repoPath: p.repoPath, workspacePath: wsPath, primaryBranch: mainBranch });
          if (status.dirty == null) throw Object.assign(new Error("git_status_unavailable"), { code: "git_status_unavailable" });
          if (status.dirty && (!force || path.resolve(wsPath) === path.resolve(p.repoPath))) throw Object.assign(new Error(path.resolve(wsPath) === path.resolve(p.repoPath) ? "checkout_dirty" : "workspace_dirty"), { code: path.resolve(wsPath) === path.resolve(p.repoPath) ? "checkout_dirty" : "workspace_dirty" });
          affected = await guardedWorkspaceSessions(p, wsPath, true);
        }
        if (await ws.currentBranchAsync(p.repoPath) !== mainBranch) {
          const checkout = await sessionsUsingWorkspaceAsync(p, p.repoPath, sup);
          for (const session of checkout) {
            if (!sup.isStreaming(session.id)) continue;
            if (!wsPath || path.resolve(wsPath) !== path.resolve(p.repoPath) || !affected.some(item => item.id === session.id)) throw Object.assign(new Error("sessions_active"), { code: "sessions_active" });
            await sup.stop(session.id);
          }
          if (await ws.isDirtyAsync(p.repoPath)) throw Object.assign(new Error("checkout_dirty"), { code: "checkout_dirty" });
        }
      };
      if (wsPath) {
        const branchStatus = await ws.contextStatusAsync({ repoPath: p.repoPath, workspacePath: wsPath, primaryBranch: mainBranch });
        if (branchStatus.dirty == null) {
          const operation = reporter.finish({ status: "error", httpStatus: 409, message: "Git status is unavailable." });
          return err(c, 409, "git_status_unavailable", { operation });
        }
        if (branchStatus.dirty && !force) {
          const operation = reporter.finish({ status: "error", httpStatus: 409, message: "The branch has uncommitted changes." });
          return err(c, 409, "workspace_dirty", { operation });
        }
        if (path.resolve(wsPath) === path.resolve(p.repoPath) && branchStatus.dirty) {
          const operation = reporter.finish({ status: "error", httpStatus: 409, message: "The primary checkout has uncommitted changes." });
          return err(c, 409, "checkout_dirty", { operation });
        }
      }
      reporter.log({ type: "phase", phase: "prepare-main", message: `Preparing ${mainBranch} before deleting ${branch}.` });
      await validateDeletion();
      await ws.prepareMainAsync(p.repoPath, { fetch: false, primaryBranch: mainBranch, report: reporter.log, beforeUpdate: validateDeletion });
      await validateDeletion();
      const main = { path: p.repoPath };
      const moved = [];
      for (const session of affected) {
        const latest = await sessionWorkspace(session.id, sup);
        if (!latest || path.resolve(latest) !== path.resolve(wsPath)) continue;
        reporter.log({ type: "phase", phase: "rehome-session", message: `${closeSessions ? "Closing" : "Moving"} session ${session.id} to ${mainBranch}.` });
        if (sup.isStreaming(session.id)) await sup.stop(session.id);
        const current = await sessionWorkspace(session.id, sup);
        if (!current || path.resolve(current) !== path.resolve(wsPath)) continue;
        await sup.rehome(session.id, main.path);
        bindRehomedSession(session.id, p, wsPath, main.path);
        moved.push(session);
        if (closeSessions) await closeSession(sup, hub, session.id);
        else hub.emit(session.id, "session_meta", { branch: mainBranch, workspacePath: main.path });
      }
      affected = moved;
      const validateCleanup = async () => {
        if (wsPath && path.resolve(wsPath) !== path.resolve(main.path) && (await guardedWorkspaceSessions(p, wsPath, true)).length) {
          throw Object.assign(new Error("sessions_active"), { code: "sessions_active" });
        }
      };
      if (wsPath && path.resolve(wsPath) !== path.resolve(p.repoPath)) await ws.removeWorkspaceAsync({ repoPath: p.repoPath, workspacePath: wsPath, force, primaryBranch: mainBranch, beforeRemove: validateCleanup });
      const stdout = await ws.deleteLocalBranchAsync(p.repoPath, branch, mainBranch, validateCleanup);
      reporter.log({ type: "result", phase: "delete", output: stdout, message: `Deleted ${branch}.` });
      hub.emit(null, "git_branch_deleted", { projectId: p.id, branch });
      const operation = reporter.finish({ httpStatus: 200, message: `Deleted ${branch}.` });
      return c.json({ ok: true, branch, command: `git branch -D ${branch}`, stdout, stderr: "", movedSessionIds: closeSessions ? [] : affected.map(session => session.id), closedSessionIds: closeSessions ? affected.map(session => session.id) : [], operation });
    } catch (e) {
      const statuses = { cannot_delete_main: 400, no_such_context: 404, no_such_branch: 404, git_status_unavailable: 409, workspace_dirty: 409, checkout_dirty: 409, main_worktree_external: 409, git_switch_failed: 409, branch_delete_failed: 409, sessions_active: 409, repository_changed: 409 };
      if (statuses[e.code]) {
        const operation = reporter.finish({ status: "error", httpStatus: statuses[e.code], message: e.detail || e.message || e.code });
        return err(c, statuses[e.code], e.code, { ...(e.detail ? { detail: e.detail } : {}), operation });
      }
      reporter.finish({ status: "error", httpStatus: 500, message: e.message || String(e) });
      throw e;
    }
    }, reporter);
  });
}
