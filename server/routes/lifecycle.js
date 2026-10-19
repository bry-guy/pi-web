export function register(api, deps) {
  const { closeSession, hub, createOperationReporter, operationRequestId, err, sup } = deps;


  // Close ends the conversation (stop, withdraw from sync, archive). Git contexts
  // remain user-owned and are never removed as a side effect of session lifecycle.
  api.post("/sessions/:id/close", async c => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const reporter = createOperationReporter({ id: operationRequestId(c, body), sessionId: id, kind: "close", title: body.kind === "chat" ? "Close chat" : "Close session" });
    reporter.log({ type: "request", phase: "request", message: `POST /api/sessions/${id}/close` });
    try {
      const result = await closeSession(sup, hub, id, { report: reporter.log });
      const operation = reporter.finish({ httpStatus: 200, message: `${body.kind === "chat" ? "Chat" : "Session"} ended. No Git branch or worktree was changed.` });
      return c.json({ ok: true, ...result, operation });
    } catch (e) {
      const statuses = { session_streaming: 409, main_worktree_external: 409 };
      const status = statuses[e.code] || 500;
      const operation = reporter.finish({ status: "error", httpStatus: status, message: e.detail || e.message || e.code || "Session close failed." });
      if (e.code === "session_streaming") return err(c, 409, "session_streaming", { operation });
      if (e.code === "main_worktree_external") return err(c, 409, e.code, { workspacePath: e.workspacePath, operation });
      throw e;
    }
  });
}
