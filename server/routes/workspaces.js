import { readHistory } from "../workspace-history.js";
export function register(api, deps) {
  const { path, loadBindings, loadConfig, saveBindings, slug, worktreeTarget, sessionWorkspace, sessionsUsingWorkspaceAsync, findProjectByWorkspace, findProjectByWorkspaceAsync, returnSessionToMain, hub, ws, projectHooks, createOperationReporter, operationRequestId, assertRepositoryIdentity, err, withRepositoryAdmission, suggestedWorktreeBranch, bindSessionToContext, bindRehomedSession, primaryBranch, guardedWorkspaceSessions, sup } = deps;


  api.post("/sessions/:id/worktree", async c => {
    const id = c.req.param("id");
    const initialCwd = await sessionWorkspace(id, sup);
    const initialFound = initialCwd && await findProjectByWorkspaceAsync(initialCwd);
    if (!initialFound) return err(c, 404, "no_project_for_session");
    return withRepositoryAdmission(c, initialFound.project.repoPath, async identity => {
    const body = await c.req.json().catch(() => ({}));
    const fork = body.fork === true;
    const cwd = await sessionWorkspace(id, sup);
    const found = cwd && await findProjectByWorkspaceAsync(cwd);
    if (!found) return err(c, 404, "no_project_for_session");
    await assertRepositoryIdentity(identity, found.project.repoPath);
    await assertRepositoryIdentity(identity, cwd);
    if (sup.isStreaming(id)) return err(c, 409, "session_streaming");
    const { project, worktrees } = found;
    const cfg = loadConfig();
    const localBranches = await ws.listBranchesAsync(project.repoPath);
    const remoteBranches = await ws.listRemoteBranchesAsync(project.repoPath);
    const mainBranch = await ws.defaultBranchAsync(project.repoPath, localBranches);
    const validateSource = async () => {
      const sessions = await sessionsUsingWorkspaceAsync(project, cwd, sup);
      const latest = await sessionWorkspace(id, sup);
      if (!latest || path.resolve(latest) !== path.resolve(cwd)) throw Object.assign(new Error("repository_changed"), { code: "repository_changed" });
      if (sup.isStreaming(id)) throw Object.assign(new Error("session_streaming"), { code: "session_streaming" });
      if (sessions.some(session => session.id !== id && sup.isStreaming(session.id))) throw Object.assign(new Error("sessions_active"), { code: "sessions_active" });
    };
    const remoteSource = typeof body.fromRef === "string" && body.fromRef.trim() ? body.fromRef.trim() : null;
    let branch = slug(body.branch || "");
    if (remoteSource && !remoteBranches.includes(remoteSource)) return err(c, 400, "invalid_remote_branch");
    if (!branch && remoteSource) branch = ws.localBranchForRemote(remoteSource);
    if (!branch && !fork) branch = await suggestedWorktreeBranch(project.repoPath, id, sup);
    if (!branch && remoteSource) return err(c, 400, "bad_branch");
    if (branch === mainBranch) return err(c, 409, "main_worktree_forbidden");
    const existingTarget = branch ? (await ws.listWorktreesAsync(project.repoPath))[branch] || null : null;
    if (!fork && existingTarget && path.resolve(existingTarget) === path.resolve(cwd)) return c.json({ ok: true, branch, workspacePath: existingTarget, setup: null, setupNeeded: false });
    if (remoteSource && branch && localBranches.includes(branch)) return err(c, 409, "branch_exists");
    if (remoteSource && fork) return err(c, 400, "invalid_fork_source");

    const parentBranch = Object.entries(worktrees).find(([, workspacePath]) => path.resolve(workspacePath) === path.resolve(cwd))?.[0] || await ws.currentBranchAsync(cwd);
    if (fork) {
      const records = await sup.transcript(id);
      if (!records.length) return err(c, 400, "fork_requires_transcript");
      let branchName = branch;
      let branchWorkspace;
      const cleanupUnusedFork = async (name, workspacePath) => {
        if ((await sessionsUsingWorkspaceAsync(project, workspacePath, sup)).length) return;
        try { await ws.removeWorkspaceAsync({ repoPath: project.repoPath, workspacePath, force: true, primaryBranch: mainBranch }); } catch {}
        try { await ws.deleteLocalBranchAsync(project.repoPath, name, mainBranch); } catch {}
      };
      try {
        ({ branch: branchName, workspacePath: branchWorkspace } = await ws.forkWorkspaceAsync({
          repoPath: project.repoPath, ...worktreeTarget(cfg, project),
          parentWorkspace: cwd, parentBranch, existingBranches: localBranches, branch: branch || undefined,
          primaryBranch: mainBranch, beforeMutation: validateSource,
        }));
      } catch (e) {
        if (e.workspacePath && e.branch && e.code !== "stash_restore_failed") await cleanupUnusedFork(e.branch, e.workspacePath);
        if (e.code === "checkout_dirty") return err(c, 409, "checkout_dirty");
        if (e.code === "git_status_unavailable") return err(c, 409, e.code, e.detail ? { detail: e.detail } : {});
        if (e.code === "branch_exists") return err(c, 409, "branch_exists");
        if (["main_worktree_forbidden", "session_streaming", "sessions_active", "repository_changed", "stash_restore_failed"].includes(e.code)) return err(c, 409, e.code, e.detail ? { detail: e.detail, stashRef: e.stashRef, workspacePath: e.workspacePath } : {});
        throw e;
      }
      const setupNeeded = !!projectHooks(cfg, project).setup;
      let childId = null;
      try {
        await validateSource();
        ({ id: childId } = await sup.fork(id, body.atRecordId || null, { cwd: branchWorkspace }));
        const context = await ws.contextStatusAsync({ repoPath: project.repoPath, workspacePath: branchWorkspace, primaryBranch: mainBranch });
        bindSessionToContext(childId, project, context);
        hub.emit(childId, "session_forked", { session: { id: childId, projectId: project.id, contextId: context.id, branch: branchName }, parentSessionId: id });
        return c.json({ id: childId, projectId: project.id, contextId: context.id, branch: branchName, workspacePath: branchWorkspace, setup: null, setupNeeded });
      } catch (e) {
        if (!childId) await cleanupUnusedFork(branchName, branchWorkspace);
        if (e.code === "bad_fork_record") return err(c, 400, "bad_fork_record");
        if (["session_streaming", "sessions_active", "repository_changed"].includes(e.code)) return err(c, 409, e.code);
        throw e;
      }
    }

    let target;
    try {
      target = await ws.ensureWorkspaceAsync({
        repoPath: project.repoPath, ...worktreeTarget(cfg, project),
        branch, fromRef: remoteSource || "HEAD", primaryBranch: mainBranch, beforeCreate: validateSource,
      });
    } catch (e) {
      if (["checkout_branch", "main_worktree_forbidden", "session_streaming", "sessions_active", "repository_changed"].includes(e.code)) return err(c, 409, e.code);
      throw e;
    }
    if (path.resolve(target) === path.resolve(cwd)) return c.json({ ok: true, branch, workspacePath: target, setup: null, setupNeeded: false });

    try { await validateSource(); await sup.rehome(id, target); }
    catch (e) { if (["session_streaming", "sessions_active", "repository_changed"].includes(e.code)) return err(c, 409, e.code); throw e; }
    bindRehomedSession(id, project, cwd, target);
    const bindings = loadBindings();
    bindings[id] = { branch, workspacePath: target };
    saveBindings(bindings);
    hub.emit(id, "session_meta", { branch });
    const setupNeeded = !existingTarget && !!projectHooks(cfg, project).setup;
    return c.json({ ok: true, branch, workspacePath: target, setup: null, setupNeeded });
    });
  });

  api.post("/sessions/:id/switch", async c => {
    const id = c.req.param("id");
    const initialCwd = await sessionWorkspace(id, sup);
    const initialFound = initialCwd && await findProjectByWorkspaceAsync(initialCwd);
    if (!initialFound) return err(c, 404, "no_project_for_session");
    return withRepositoryAdmission(c, initialFound.project.repoPath, async identity => {
    const body = await c.req.json().catch(() => ({}));
    const cwd = await sessionWorkspace(id, sup);
    const found = cwd && await findProjectByWorkspaceAsync(cwd);
    if (!found) return err(c, 404, "no_project_for_session");
    await assertRepositoryIdentity(identity, found.project.repoPath);
    await assertRepositoryIdentity(identity, cwd);
    const { project } = found;
    const branch = slug(body.branch || "");
    const remoteSource = typeof body.fromRef === "string" && body.fromRef.trim() ? body.fromRef.trim() : null;
    const localBranches = await ws.listBranchesAsync(project.repoPath);
    const remoteBranches = await ws.listRemoteBranchesAsync(project.repoPath);
    if (!branch) return err(c, 400, "bad_branch");
    if (remoteSource && !remoteBranches.includes(remoteSource)) return err(c, 400, "invalid_remote_branch");
    const mainBranch = await ws.defaultBranchAsync(project.repoPath, localBranches);
    const beforeSwitch = async sessions => {
      const latestCwd = await sessionWorkspace(id, sup);
      if (!latestCwd || path.resolve(latestCwd) !== path.resolve(cwd)) throw Object.assign(new Error("repository_changed"), { code: "repository_changed" });
    };
    if (branch === mainBranch) {
      if (remoteSource) return err(c, 409, "main_worktree_forbidden");
      if (await ws.currentBranchAsync(project.repoPath) !== mainBranch) {
        const affected = await sessionsUsingWorkspaceAsync(project, project.repoPath, sup);
      }
      try { return c.json(await returnSessionToMain(sup, hub, id, { beforeSwitch, expectedCwd: cwd })); }
      catch (e) {
        const codes = { session_streaming: 409, no_project_for_session: 404, checkout_dirty: 409, git_status_unavailable: 409, sessions_active: 409, main_worktree_external: 409, return_rehome_failed: 409, git_switch_failed: 409, repository_changed: 409 };
        if (codes[e.code]) return err(c, codes[e.code], e.code, e.detail ? { detail: e.detail, workspacePath: e.workspacePath } : e.workspacePath ? { workspacePath: e.workspacePath } : {});
        throw e;
      }
    }
    if (remoteSource && localBranches.includes(branch)) return err(c, 409, "branch_exists");
    if (!remoteSource && !localBranches.includes(branch)) return err(c, 404, "no_such_branch");
    const current = await ws.currentBranchAsync(cwd);
    if (current === branch) return c.json({ ok: true, branch, workspacePath: cwd, switched: false });
    const worktrees = await ws.listWorktreesAsync(project.repoPath);
    const target = worktrees[branch];
    if (target && path.resolve(target) !== path.resolve(cwd)) return err(c, 409, "branch_in_use", { workspacePath: target });
    let sessions = await sessionsUsingWorkspaceAsync(project, cwd, sup);
    if (sessions.some(session => sup.isStreaming(session.id))) return err(c, 409, "sessions_active");
    try {
      if (await ws.isDirtyAsync(cwd)) return err(c, 409, "workspace_dirty");
      sessions = await sessionsUsingWorkspaceAsync(project, cwd, sup);
      await beforeSwitch(sessions);
      if (sessions.some(session => sup.isStreaming(session.id))) return err(c, 409, "sessions_active");
      await ws.switchWorkspaceAsync({ repoPath: project.repoPath, workspacePath: cwd, branch, fromRef: remoteSource, primaryBranch: mainBranch });
    } catch (e) {
      if (["git_status_unavailable", "git_switch_failed", "main_worktree_forbidden", "repository_changed"].includes(e.code)) return err(c, 409, e.code, e.detail ? { detail: e.detail } : {});
      throw e;
    }
    sessions = await sessionsUsingWorkspaceAsync(project, cwd, sup);
    const bindings = loadBindings();
    sessions = sessions.filter(session => !bindings[session.id]?.workspacePath || path.resolve(bindings[session.id].workspacePath) === path.resolve(cwd));
    for (const session of sessions) bindings[session.id] = { branch, workspacePath: cwd };
    saveBindings(bindings);
    for (const session of sessions) {
      hub.emit(session.id, "session_meta", { branch });
      hub.emit(session.id, "workspace_switched", { branch, workspacePath: cwd });
    }
    return c.json({ ok: true, branch, workspacePath: cwd, switched: true });
    });
  });

  // The workspace's own record of what ran here (hooks, git operations, fork and switch).
  api.get("/sessions/:id/history", async c => {
    const cwd = await sessionWorkspace(c.req.param("id"), sup);
    if (!cwd) return err(c, 404, "no_workspace");
    return c.json({ entries: readHistory(cwd) });
  });

  api.post("/sessions/:id/pull", async c => {
    const id = c.req.param("id");
    const reporter = createOperationReporter({ id: operationRequestId(c), sessionId: id, kind: "pull", title: "Pull branch" });
    reporter.log({ type: "request", phase: "request", message: `POST /api/sessions/${id}/pull` });
    const initialCwd = await sessionWorkspace(id, sup);
    const initialFound = initialCwd && await findProjectByWorkspaceAsync(initialCwd);
    if (!initialFound) return err(c, 404, "no_project_for_session");
    reporter.bind(initialCwd);
    return withRepositoryAdmission(c, initialFound.project.repoPath, async identity => {
    const cwd = await sessionWorkspace(id, sup);
    const found = cwd && await findProjectByWorkspaceAsync(cwd);
    if (!found) return err(c, 404, "no_project_for_session");
    await assertRepositoryIdentity(identity, found.project.repoPath);
    await assertRepositoryIdentity(identity, cwd);
    try {
      const result = await ws.pullWorkspaceAsync(cwd);
      const branch = await ws.currentBranchAsync(cwd);
      hub.emit(id, "session_meta", { branch });
      const operation = reporter.finish({ status: "success", httpStatus: 200, message: "Pull completed." });
      return c.json({ ok: true, branch, workspacePath: cwd, ...result, operation });
    } catch (e) {
      reporter.log({ type: "error", message: String(e.detail || e.message || e.code) });
      const operation = reporter.finish({ status: "error", httpStatus: e.code === "git_pull_failed" ? 409 : 500, message: "Pull failed." });
      if (e.code === "git_pull_failed") return err(c, 409, e.code, { detail: e.detail, operation });
      throw e;
    }
    });
  });

  api.get("/sessions/:id/push-preview", async c => {
    const id = c.req.param("id");
    const cwd = await sessionWorkspace(id, sup);
    const found = cwd && findProjectByWorkspace(cwd);
    if (!found) return err(c, 404, "no_project_for_session");
    try { return c.json({ ok: true, workspacePath: cwd, ...ws.pushPreview(cwd) }); }
    catch (e) {
      const statuses = { detached_head: 409, push_preview_failed: 409 };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, { detail: e.detail });
      throw e;
    }
  });

  api.post("/sessions/:id/push", async c => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const reporter = createOperationReporter({ id: operationRequestId(c, body), sessionId: id, kind: "push", title: "Push branch" });
    reporter.log({ type: "request", phase: "request", message: `POST /api/sessions/${id}/push` });
    const initialCwd = await sessionWorkspace(id, sup);
    reporter.bind(initialCwd);
    const initialFound = initialCwd && await findProjectByWorkspaceAsync(initialCwd);
    if (!initialFound) return err(c, 404, "no_project_for_session");
    return withRepositoryAdmission(c, initialFound.project.repoPath, async identity => {
      const cwd = await sessionWorkspace(id, sup);
      const found = cwd && await findProjectByWorkspaceAsync(cwd);
      if (!found) return err(c, 404, "no_project_for_session");
      await assertRepositoryIdentity(identity, found.project.repoPath);
      await assertRepositoryIdentity(identity, cwd);
      try {
      const preview = await ws.pushPreviewAsync(cwd);
      await assertRepositoryIdentity(identity, found.project.repoPath);
      await assertRepositoryIdentity(identity, cwd);
      if (body.expectedHead && body.expectedHead !== preview.head) {
        const operation = reporter.finish({ status: "error", httpStatus: 409, message: "The branch changed after the push preview." });
        return err(c, 409, "push_preview_stale", { operation });
      }
      if (body.expectedBaseHead !== undefined && body.expectedBaseHead !== preview.baseHead) {
        const operation = reporter.finish({ status: "error", httpStatus: 409, message: "The remote branch changed after the push preview." });
        return err(c, 409, "push_preview_stale", { operation });
      }
      const result = await ws.pushWorkspaceAsync(cwd, { report: reporter.log });
      const branch = await ws.currentBranchAsync(cwd);
      hub.emit(id, "session_meta", { branch });
      const operation = reporter.finish({ httpStatus: 200, message: `Pushed ${result.branch} to ${result.upstream}.` });
      return c.json({ ok: true, branch, workspacePath: cwd, ...result, operation });
    } catch (e) {
      if (e?.repositoryAdmission) throw e;
      const statuses = { detached_head: 409, git_push_failed: 409, push_preview_failed: 409 };
      if (statuses[e.code]) {
        const operation = reporter.finish({ status: "error", httpStatus: statuses[e.code], message: e.detail || e.message || e.code });
        return err(c, statuses[e.code], e.code, { detail: e.detail, operation });
      }
      reporter.finish({ status: "error", httpStatus: 500, message: e.message || String(e) });
      throw e;
      }
    }, reporter);
  });

  api.post("/sessions/:id/merge-local", async c => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const reporter = createOperationReporter({ id: operationRequestId(c, body), sessionId: id, kind: "merge", title: "Merge branch" });
    reporter.log({ type: "request", phase: "request", message: `POST /api/sessions/${id}/merge-local` });
    const initialCwd = await sessionWorkspace(id, sup);
    reporter.bind(initialCwd);
    const initialFound = initialCwd && await findProjectByWorkspaceAsync(initialCwd);
    if (!initialFound) {
      const operation = reporter.finish({ status: "error", httpStatus: 404, message: "The session is not attached to a project." });
      return err(c, 404, "no_project_for_session", { operation });
    }
    return withRepositoryAdmission(c, initialFound.project.repoPath, async identity => {
      const cwd = await sessionWorkspace(id, sup);
      const found = cwd && await findProjectByWorkspaceAsync(cwd);
      if (!found) {
        const operation = reporter.finish({ status: "error", httpStatus: 404, message: "The session is not attached to a project." });
        return err(c, 404, "no_project_for_session", { operation });
      }
      await assertRepositoryIdentity(identity, found.project.repoPath);
      await assertRepositoryIdentity(identity, cwd);
      // The merge lands in the primary checkout, where the session returns.
      reporter.bind(found.project.repoPath);
      const branch = await ws.currentBranchAsync(cwd);
      const mainBranch = await ws.defaultBranchAsync(found.project.repoPath);
      if (!branch || branch === mainBranch) {
        const operation = reporter.finish({ status: "error", httpStatus: 400, message: "There is no branch to merge." });
        return err(c, 400, "nothing_to_merge", { operation });
      }
      let merged = false;
      try {
      const sourceStatus = await ws.contextStatusAsync({ repoPath: found.project.repoPath, workspacePath: cwd, primaryBranch: mainBranch });
      if (sourceStatus.dirty == null) {
        const operation = reporter.finish({ status: "error", httpStatus: 409, message: "Git status is unavailable." });
        return err(c, 409, "git_status_unavailable", { operation });
      }
      if (sourceStatus.dirty) {
        const operation = reporter.finish({ status: "error", httpStatus: 409, message: "The source workspace has uncommitted changes." });
        return err(c, 409, "workspace_dirty", { operation });
      }
      let affected = await sessionsUsingWorkspaceAsync(found.project, cwd, sup);
      if (affected.some(session => sup.isStreaming(session.id))) {
        const operation = reporter.finish({ status: "error", httpStatus: 409, message: "Stop active sessions before merging this branch." });
        return err(c, 409, "sessions_active", { operation });
      }
      let checkoutSessions = await sessionsUsingWorkspaceAsync(found.project, found.project.repoPath, sup);
      if (checkoutSessions.some(session => sup.isStreaming(session.id))) {
        const operation = reporter.finish({ status: "error", httpStatus: 409, message: "Stop active sessions in the primary checkout before merging." });
        return err(c, 409, "sessions_active", { operation });
      }
      const checkoutBranch = await ws.currentBranchAsync(found.project.repoPath);
      const validateMerge = async () => {
        const status = await ws.contextStatusAsync({ repoPath: found.project.repoPath, workspacePath: cwd, primaryBranch: mainBranch });
        if (status.dirty == null) throw Object.assign(new Error("git_status_unavailable"), { code: "git_status_unavailable" });
        if (status.dirty) throw Object.assign(new Error("workspace_dirty"), { code: "workspace_dirty" });
        if (await ws.isDirtyAsync(found.project.repoPath)) throw Object.assign(new Error("checkout_dirty"), { code: "checkout_dirty" });
        affected = await sessionsUsingWorkspaceAsync(found.project, cwd, sup);
        checkoutSessions = await sessionsUsingWorkspaceAsync(found.project, found.project.repoPath, sup);
        const latest = await sessionWorkspace(id, sup);
        if (!latest || path.resolve(latest) !== path.resolve(cwd)) throw Object.assign(new Error("repository_changed"), { code: "repository_changed" });
        if ([...affected, ...checkoutSessions].some(session => sup.isStreaming(session.id))) throw Object.assign(new Error("sessions_active"), { code: "sessions_active" });
      };
      if (await ws.isDirtyAsync(found.project.repoPath)) throw Object.assign(new Error("checkout_dirty"), { code: "checkout_dirty" });
      await validateMerge();
      await ws.prepareMainAsync(found.project.repoPath, { fetch: true, primaryBranch: mainBranch, report: reporter.log, beforeUpdate: validateMerge });
      if (checkoutBranch !== mainBranch) {
        for (const session of await guardedWorkspaceSessions(found.project, found.project.repoPath)) {
          bindRehomedSession(session.id, found.project, found.project.repoPath, found.project.repoPath);
          hub.emit(session.id, "session_meta", { branch: mainBranch, workspacePath: found.project.repoPath });
        }
      }
      reporter.log({ type: "phase", phase: "merge", message: `Merging ${branch} into ${mainBranch}.` });
      const output = await ws.mergeBranchAsync(found.project.repoPath, branch, { report: reporter.log, beforeMerge: validateMerge });
      merged = true;
      reporter.log({ type: "result", phase: "merge", output, message: `Merged ${branch} into ${mainBranch}.` });
      const main = { path: found.project.repoPath };
      reporter.log({ type: "phase", phase: "rehome", message: `Returning ${affected.length} session${affected.length === 1 ? "" : "s"} to ${mainBranch}.` });
      try {
        affected = await guardedWorkspaceSessions(found.project, cwd);
        const returned = [];
        for (const session of affected) {
          const latest = await sessionWorkspace(session.id, sup);
          if (!latest || path.resolve(latest) !== path.resolve(cwd)) continue;
          if (sup.isStreaming(session.id)) throw Object.assign(new Error("sessions_active"), { code: "sessions_active" });
          reporter.log({ type: "phase", phase: "rehome-session", message: `Returning session ${session.id} to ${mainBranch}.` });
          await sup.rehome(session.id, main.path);
          bindRehomedSession(session.id, found.project, cwd, main.path);
          returned.push(session);
          hub.emit(session.id, "session_meta", { branch: mainBranch, workspacePath: main.path });
          hub.emit(session.id, "session_merged", { sessionId: session.id, branch, into: mainBranch });
        }
        affected = returned;
      } catch (e) {
        throw Object.assign(new Error("merge_rehome_failed"), { code: "merge_rehome_failed", detail: String(e.message || e).slice(0, 400) });
      }
      reporter.log({ type: "phase", phase: "cleanup", message: `Removing ${branch} worktree and local branch.` });
      const validateCleanup = async () => {
        if (path.resolve(cwd) !== path.resolve(main.path) && (await guardedWorkspaceSessions(found.project, cwd)).length) {
          throw Object.assign(new Error("sessions_active"), { code: "sessions_active" });
        }
      };
      let cleanupOutput = "";
      if (path.resolve(cwd) !== path.resolve(found.project.repoPath)) {
        await ws.removeWorkspaceAsync({ repoPath: found.project.repoPath, workspacePath: cwd, force: false, primaryBranch: mainBranch, beforeRemove: validateCleanup });
      }
      cleanupOutput = await ws.deleteLocalBranchAsync(found.project.repoPath, branch, mainBranch, validateCleanup);
      reporter.log({ type: "result", phase: "cleanup", output: cleanupOutput, message: `Deleted ${branch}.` });
      hub.emit(null, "git_branch_deleted", { projectId: found.project.id, branch });
      const mergedOutput = [output, cleanupOutput].filter(Boolean).join("\n");
      const operation = reporter.finish({ httpStatus: 200, message: `Merged ${branch} into ${mainBranch} and returned sessions to ${mainBranch}.` });
      return c.json({ ok: true, merged: branch, into: mainBranch, deleted: true, sessionIds: affected.map(session => session.id), command: `git merge --no-ff --no-edit ${branch} && git branch -D ${branch}`, stdout: mergedOutput, stderr: "", workspacePath: found.project.repoPath, operation });
    } catch (e) {
      const statuses = { checkout_dirty: 409, git_status_unavailable: 409, main_worktree_external: 409, main_fetch_failed: 409, main_not_fast_forwardable: 409, git_switch_failed: 409, merge_conflict: 409, sessions_active: 409, merge_rehome_failed: 409, workspace_dirty: 409, branch_delete_failed: 409, repository_changed: 409 };
      const message = `${merged ? `Merge into ${mainBranch} completed; a subsequent step failed: ` : ""}${e.detail || e.message || e.code}`;
      if (statuses[e.code]) {
        const operation = reporter.finish({ status: "error", httpStatus: statuses[e.code], message });
        return err(c, statuses[e.code], e.code, { ...(e.detail ? { detail: e.detail } : {}), ...(merged ? { merged: branch, into: mainBranch } : {}), operation });
      }
      reporter.finish({ status: "error", httpStatus: 500, message });
      throw e;
      }
    }, reporter);
  });
}
