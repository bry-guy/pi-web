export function register(api, deps) {
  const { path, loadConfig, sessionWorkspace, findProjectByWorkspace, findProjectByWorkspaceAsync, hub, ws, projectHooks, createOperationReporter, operationRequestId, assertRepositoryIdentity, err, withRepositoryAdmission, projectContext, bindSessionToContext, boundProject, branchContext, branchContextAsync, ensureBranchContext, sup } = deps;


  api.post("/sessions/:id/fork", async c => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const name = typeof body.name === "string" ? body.name.trim() || null : null;
    const cwd = await sessionWorkspace(id, sup);
    if (!cwd) return err(c, 404, "no_such_session");
    if (sup.isStreaming(id)) return err(c, 409, "session_streaming");
    const found = findProjectByWorkspace(cwd);
    const atRecordId = typeof body.atRecordId === "string" && body.atRecordId ? body.atRecordId : null;
    try {
      if (found) {
        const { project } = found;
        const context = branchContext(project, ws.currentBranch(cwd)) || projectContext(project, null);
        if (!context) return err(c, 404, "no_such_context");
        const { id: childId } = await sup.fork(id, atRecordId, { cwd: context.path, name });
        bindSessionToContext(childId, project, context);
        hub.emit(childId, "session_forked", { session: { id: childId, projectId: project.id, contextId: context.id, branch: context.branch }, parentSessionId: id });
        return c.json({ id: childId, projectId: project.id, contextId: context.id, branch: context.branch, workspacePath: context.path, forkedFrom: id });
      }
      const source = await sup.meta(id);
      const { id: childId } = await sup.fork(id, atRecordId, { cwd: source?.cwd || cwd, name });
      hub.emit(childId, "session_forked", { session: { id: childId }, parentSessionId: id });
      return c.json({ id: childId, forkedFrom: id, workspacePath: source?.cwd || cwd });
    } catch (e) {
      const statuses = { bad_fork_record: 400, session_streaming: 409 };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.message ? { message: e.message } : {});
      if (String(e?.message || "").startsWith("unknown")) return err(c, 404, "no_such_session");
      throw e;
    }
  });

  api.post("/sessions/:id/branch-context", async c => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) || {};
    const hasName = Object.prototype.hasOwnProperty.call(body, "name");
    const name = typeof body.name === "string" ? body.name.trim() || null : null;
    const reporter = createOperationReporter({ id: operationRequestId(c, body), sessionId: id, kind: body.mode === "fork" ? "fork" : "switch", title: body.mode === "fork" ? "Fork session" : "Switch session" });
    reporter.log({ type: "request", phase: "request", message: `POST /api/sessions/${id}/branch-context` });
    const initialCwd = await sessionWorkspace(id, sup);
    reporter.bind(initialCwd);
    const initialProject = (initialCwd && await findProjectByWorkspaceAsync(initialCwd))?.project || boundProject(id);
    if (!initialProject) return err(c, 404, "no_project_for_session");
    return withRepositoryAdmission(c, initialProject.repoPath, async identity => {
      const cwd = await sessionWorkspace(id, sup);
      const project = (cwd && await findProjectByWorkspaceAsync(cwd))?.project || boundProject(id);
      if (!cwd || !project) return err(c, 404, "no_project_for_session");
      if (project.id !== initialProject.id) {
        const operation = reporter.finish({ status: "error", httpStatus: 409, message: "The repository changed before the operation began." });
        return err(c, 409, "repository_changed", { operation });
      }
      await assertRepositoryIdentity(identity, project.repoPath);
      await assertRepositoryIdentity(identity, cwd);
      const source = await sup.meta(id);
      if (body.mode === "fork" && !source) {
        const operation = reporter.finish({ status: "error", httpStatus: 404, message: "The source session was not found." });
        return err(c, 404, "no_such_session", { operation });
      }
      const currentBranch = await ws.currentBranchAsync(cwd) || null;
      let branch = typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : null;
      if (!branch) return err(c, 400, "bad_branch");
      try {
        branch = await ws.validateBranchNameAsync(branch);
      if (branch === currentBranch) return err(c, 409, "same_branch");
      if (body.mode !== "fork" && sup.isStreaming(id)) return err(c, 409, "session_streaming");
      const existed = !!(await branchContextAsync(project, branch));
      const context = await ensureBranchContext(project, branch, body.baseBranch || currentBranch || await ws.defaultBranchAsync(project.repoPath), { syncMain: true, report: reporter.log, sup, except: id });
      const latestCwd = await sessionWorkspace(id, sup);
      if (!latestCwd || path.resolve(latestCwd) !== path.resolve(cwd)) {
        const operation = reporter.finish({ status: "error", httpStatus: 409, message: "The session workspace changed while preparing the branch." });
        return err(c, 409, "repository_changed", { operation });
      }
      if (body.mode !== "fork" && sup.isStreaming(id)) {
        const operation = reporter.finish({ status: "error", httpStatus: 409, message: "The session started streaming while preparing the branch." });
        return err(c, 409, "session_streaming", { operation });
      }
      reporter.bind(context.path);
      if (body.mode === "fork") {
        const setupNeeded = !existed && context.kind !== "checkout" && !!projectHooks(loadConfig(), project).setup;
        reporter.log({ type: "phase", phase: "fork-session", message: `Forking session ${id} into ${context.path}.` });
        const { id: childId } = await sup.fork(id, null, { cwd: context.path, name });
        bindSessionToContext(childId, project, context);
        hub.emit(childId, "session_forked", { session: { id: childId, contextId: context.id, branch: context.branch }, parentSessionId: id });
        const operation = reporter.finish({ httpStatus: 200, message: `Forked session ${childId} on ${context.branch}.` });
        return c.json({ id: childId, forkedFrom: id, branch: context.branch, contextId: context.id, workspacePath: context.path, setup: null, setupNeeded, operation });
      }
      const setupNeeded = !existed && context.kind !== "checkout" && !!projectHooks(loadConfig(), project).setup;
      reporter.log({ type: "phase", phase: "rehome-session", message: `Moving session ${id} to ${context.path}.` });
      await sup.rehome(id, context.path);
      bindSessionToContext(id, project, context);
      if (hasName) await sup.setName(id, name);
      hub.emit(id, "session_meta", { branch: context.branch, workspacePath: context.path });
      const operation = reporter.finish({ httpStatus: 200, message: `Switched session ${id} to ${context.branch}.` });
      return c.json({ ok: true, id, branch: context.branch, contextId: context.id, workspacePath: context.path, name: hasName ? name : source?.name || null, setup: null, setupNeeded, operation });
    } catch (e) {
      const statuses = { checkout_in_use: 409, bad_branch: 400, no_such_base_branch: 404, checkout_dirty: 409, git_status_unavailable: 409, main_worktree_external: 409, main_fetch_failed: 409, main_not_fast_forwardable: 409, git_switch_failed: 409, session_streaming: 409, same_branch: 409 };
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
