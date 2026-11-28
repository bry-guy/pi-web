export function register(api, deps) {
  const { closeSession, restoreSession, cleanupCandidate, sessionWorkspace, hub, createOperationReporter, operationRequestId, err, sup } = deps;


  // Close takes the conversation off the sidebar (stop, unload, list as closed); the conversation itself is
  // not changed. Git contexts remain user-owned and are never removed as a side effect.
  api.post("/sessions/:id/close", async c => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const reporter = createOperationReporter({ id: operationRequestId(c, body), sessionId: id, kind: "close", title: body.kind === "chat" ? "Close chat" : "Close session" });
    reporter.log({ type: "request", phase: "request", message: `POST /api/sessions/${id}/close` });
    try {
      const workspacePath = await sessionWorkspace(id, sup).catch(() => null);
      const result = await closeSession(sup, hub, id, { report: reporter.log });
      const cleanup = await cleanupCandidate(sup, workspacePath).catch(() => null);
      const operation = reporter.finish({ httpStatus: 200, message: `${body.kind === "chat" ? "Chat" : "Session"} closed. No Git branch or worktree was changed.` });
      return c.json({ ok: true, ...result, cleanup, operation });
    } catch (e) {
      const statuses = { session_streaming: 409, main_worktree_external: 409 };
      const status = statuses[e.code] || 500;
      const operation = reporter.finish({ status: "error", httpStatus: status, message: e.detail || e.message || e.code || "Session close failed." });
      if (e.code === "session_streaming") return err(c, 409, "session_streaming", { operation });
      if (e.code === "main_worktree_external") return err(c, 409, e.code, { workspacePath: e.workspacePath, operation });
      throw e;
    }
  });

  // Deletes a session's file: web's retention sweep for a prime's old runs (run-door.js). Never a running one.
  api.post("/sessions/:id/delete", async c => {
    const id = c.req.param("id");
    try { await sup.deleteSession(id); }
    catch (e) {
      if (e.code === "session_streaming") return err(c, 409, e.code);
      if (String(e?.message || "").startsWith("unknown session")) return err(c, 404, "no_such_session");
      throw e;
    }
    hub.emit(id, "session_closed", { sessionId: id });
    return c.json({ ok: true });
  });

  // Opens a closed conversation (the route's name is from when closing ended one).
  api.post("/sessions/:id/restore", async c => c.json({ ok: true, ...await restoreSession(sup, hub, c.req.param("id")) }));
}
