export function register(api, deps) {
  const { execFile, chatsDir, loadConfig, newId, sessionWorkspace, findProjectByWorkspace, hub, hookResult, projectHooks, runHook, resolveProjectEnvironment, gitCredentialEnvironment, createOperationReporter, operationRequestId, err, formatDuration, sup } = deps;


  // Configured project hooks run in the current session workspace. Hook names
  // are deployment-defined; this endpoint does not invent a fixed vocabulary.
  api.post("/sessions/:id/hooks/:name", async c => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const name = c.req.param("name");
    const reporter = createOperationReporter({ id: operationRequestId(c, body), sessionId: id, kind: "hook", title: `${name} hook` });
    reporter.log({ type: "request", phase: "request", message: `POST /api/sessions/${id}/hooks/${name}` });
    const cwd = await sessionWorkspace(id, sup);
    if (!cwd) {
      const operation = reporter.finish({ status: "error", httpStatus: 404, message: "No workspace is bound to this session." });
      return err(c, 404, "no_workspace", { operation });
    }
    reporter.bind(cwd);
    const found = findProjectByWorkspace(cwd);
    if (!found) {
      const operation = reporter.finish({ status: "error", httpStatus: 404, message: "The session is not bound to a project." });
      return err(c, 404, "no_project_for_session", { operation });
    }
    const command = projectHooks(loadConfig(), found.project)[name];
    if (!command) {
      const operation = reporter.finish({ status: "error", httpStatus: 404, message: `No such hook: ${name}.` });
      return err(c, 404, "no_such_hook", { operation });
    }
    let extraEnv;
    try {
      extraEnv = resolveProjectEnvironment(found.project?.environment);
    } catch (error) {
      if (error.code !== "project_environment_source_missing") throw error;
      const operation = reporter.finish({ status: "error", httpStatus: 409, message: "Project environment source is missing." });
      return err(c, 409, error.code, { message: "Project environment source is missing.", operation });
    }
    const result = hookResult(await runHook(command, { cwd, extraEnv, signal: c.req.raw.signal, report: reporter.log }), name);
    const operation = reporter.finish({ status: result.ok ? "success" : "error", httpStatus: result.ok ? 200 : 422, exit: result.exit, message: result.ok ? "Configured hook completed." : "Configured hook failed." });
    return c.json({ ...result, operation });
  });

  // Bang: user-initiated local shell in the session's workspace. Distinct from
  // agent tool calls end-to-end (orange ! rendering keyed on bang_* events).
  api.post("/sessions/:id/bang", async c => {
    const id = c.req.param("id");
    const { cmd } = await c.req.json();
    if (!cmd?.trim()) return err(c, 400, "empty_command");
    const cwd = (await sessionWorkspace(id, sup)) || chatsDir();
    let env;
    try {
      const project = findProjectByWorkspace(cwd)?.project;
      env = gitCredentialEnvironment({
        ...process.env,
        ...resolveProjectEnvironment(project?.environment),
      });
    } catch (error) {
      if (error.code !== "project_environment_source_missing") throw error;
      return err(c, 409, error.code, { message: "Project environment source is missing." });
    }
    const bangId = newId("bg");
    hub.emit(id, "bang_start", { bangId, cmd });
    const t0 = Date.now();
    const { exit, out } = await new Promise(resolve => {
      execFile("/bin/sh", ["-c", cmd], { cwd, env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (e, stdout, stderr) => {
        resolve({ exit: e ? (e.code ?? 1) : 0, out: [stdout, stderr].filter(Boolean).join("") });
      });
    });
    const durationMs = Date.now() - t0;
    const meta = `exit ${exit} · ${formatDuration(durationMs)}`;
    hub.emit(id, "bang_end", { bangId, exit, durationMs, stdout: out });
    await sup.bangRecord(id, { id: bangId, role: "bang", cmd, meta, out });
    return c.json({ exit, durationMs });
  });
}
