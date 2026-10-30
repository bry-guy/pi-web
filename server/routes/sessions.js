export function register(api, deps) {
  const { hub, err, sup, extensionUi } = deps;


  api.get("/sessions/:id/commands", async c => {
    try { return c.json({ commands: await sup.commands(c.req.param("id")) }); }
    catch (e) {
      if (String(e?.message || "").startsWith("unknown session")) return err(c, 404, "no_such_session");
      throw e;
    }
  });

  api.post("/sessions/:id/command", async c => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const text = typeof body?.text === "string" ? body.text : "";
    const mode = body?.mode || "prompt";
    if (!text.trim().startsWith("/")) return err(c, 400, "invalid_slash_command");
    try {
      const result = await sup.command(id, text.trim(), mode);
      if (result.action === "settings") return c.json({ ok: true, action: "settings" });
      return c.json({ ok: true, ...result });
    } catch (e) {
      const statuses = {
        session_busy: 409, sync_open_failed: 409,
        model_required: 409, command_busy: 409, model_unavailable: 400, unknown_slash_command: 400, invalid_slash_command: 400,
        command_usage: 400, session_export_too_large: 413, github_auth_required: 401,
        github_rate_limited: 403, github_unavailable: 502,
      };
      if (statuses[e.code]) return err(c, statuses[e.code], e.code, e.message ? { message: e.message } : {});
      if (String(e?.message || "").startsWith("unknown session")) return err(c, 404, "no_such_session");
      throw e;
    }
  });

  api.get("/sessions/:id/export", async c => {
    const format = String(c.req.query("format") || "html").toLowerCase();
    if (format !== "html" && format !== "jsonl") return err(c, 400, "command_usage", { message: "format must be html or jsonl" });
    try {
      const output = await sup.exportSession(c.req.param("id"), format);
      return c.body(output.body, 200, {
        "content-type": output.contentType,
        "content-disposition": `attachment; filename="${output.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "cache-control": "no-store",
      });
    } catch (e) {
      if (String(e?.message || "").startsWith("unknown session")) return err(c, 404, "no_such_session");
      throw e;
    }
  });

  api.post("/sessions/:id/message", async c => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const { text, mode = "prompt", images = [] } = body;
    const clientMessageId = typeof body?.clientMessageId === "string" ? body.clientMessageId.slice(0, 120) : null;
    const messageText = typeof text === "string" ? text.trim() : "";
    if (!messageText && !Array.isArray(images)) return err(c, 400, "empty_message");
    if (!messageText && images.length === 0) return err(c, 400, "empty_message");
    if (!Array.isArray(images) || images.length > 4 || images.some(image =>
      image?.type !== "image" || typeof image.data !== "string" || !/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType || "") ||
      image.data.length > 8_000_000
    )) return err(c, 400, "invalid_images");
    try {
      await sup.message(id, messageText, mode, images, clientMessageId);
      return c.json({ ok: true });
    } catch (e) {
      if (e.code === "session_busy") return err(c, 409, e.code);
      if (e.code === "model_required") {
        return err(c, 409, "model_required", {
          message: "Connect a provider or choose an available model.",
        });
      }
      throw e;
    }
  });

  api.post("/sessions/:id/queue/clear", async c => c.json(await sup.clearQueue(c.req.param("id"))));

  api.post("/sessions/:id/stop", async c => {
    const id = c.req.param("id");
    await sup.stop(id);
    return c.json({ ok: true });
  });

  api.get("/sessions/:id/transcript", async c => {
    const id = c.req.param("id");
    // Capture the sequence before reading the snapshot. Events emitted after
    // this point remain in the client's buffer and are replayed by seq.
    const seq = hub.currentSeq();
    const records = await sup.transcript(id);
    // Emitted after `seq`, so the reloading client applies it once the transcript loads.
    extensionUi?.replayPending(id);
    return c.json({ sessionId: id, seq, streaming: sup.isStreaming(id), compacting: sup.isCompacting(id), queue: sup.queue(id), records });
  });

  api.get("/sessions/:id/meta", async c => {
    const meta = await sup.meta(c.req.param("id"));
    return meta ? c.json(meta) : err(c, 404, "no_such_session");
  });

  api.post("/sessions/:id/model", async c => {
    const id = c.req.param("id");
    const { model } = await c.req.json();
    try {
      await sup.setModel(id, model);
      return c.json({ ok: true, model });
    } catch (e) {
      if (e.code === "model_unavailable") return err(c, 400, "model_unavailable");
      throw e;
    }
  });

  api.get("/sessions/:id/context", async c => c.json(await sup.context(c.req.param("id"))));

  api.get("/sessions/:id/thinking", async c => c.json(await sup.thinking(c.req.param("id"))));
  api.post("/sessions/:id/thinking", async c => {
    const id = c.req.param("id");
    const { level } = await c.req.json();
    return c.json(await sup.setThinking(id, level));
  });

  api.post("/sessions/:id/name", async c => {
    const id = c.req.param("id");
    const { name } = await c.req.json();
    await sup.setName(id, name);
    return c.json({ ok: true, name: String(name || "").trim() || null });
  });
}
