import { importChatItem } from "../chat-transfer.js";

export function register(api, deps) {
  const { fs, path, chatsDir, newId, hub, sup } = deps;


  // ---------- chats & projects ----------
  api.post("/chats", async c => {
    // Give every plain chat its own workspace. Keep chatsDir() itself as the
    // legacy parent so old shared-cwd sessions remain discoverable.
    const scratch = path.join(chatsDir(), newId("c"));
    fs.mkdirSync(scratch, { recursive: true });
    const { id } = await sup.createSession({ cwd: scratch });
    hub.emit(id, "session_created", { session: { id, title: "New session" } });
    return c.json({ id });
  });

  // The chats worker receives web's earlier chats here, one file at a time (see chat-transfer.js).
  api.post("/chats/import", async c => {
    const body = await c.req.json().catch(() => null);
    return c.json({ ok: true, written: importChatItem(body) });
  });
}
