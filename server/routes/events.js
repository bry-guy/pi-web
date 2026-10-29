import { CONTRACT_VERSION } from "../events.js";

export function register(api, deps) {
  const { streamSSE, hub } = deps;


  // ---------- SSE ----------
  api.get("/events", c =>
    streamSSE(c, async stream => {
      let open = true;
      const remove = hub.addClient(frame => { if (open) stream.write(frame); });
      stream.onAbort(() => { open = false; remove(); });
      // Keepalive as a data frame, so the browser can tell a silently dead stream (no pings)
      // and a restarted server (seq lower than what it has seen) apart from a quiet one.
      while (open) {
        await stream.sleep(15000);
        try { await stream.write(`data: ${JSON.stringify({ v: CONTRACT_VERSION, type: "ping", seq: hub.currentSeq() })}\n\n`); } catch { break; }
      }
      remove();
    })
  );
}
