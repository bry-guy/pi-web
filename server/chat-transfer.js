// Moves the chats web used to run in its own process into the chats worker,
// once. Web exports (exportChats); the chats worker imports (importChatItem).
// Copies only: web keeps its files, and the marker stops it listing them again.

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { appHome, chatsDir, loadClosed, saveClosed } from "./config.js";

const agentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
// Pi's default session directory for a cwd (getDefaultSessionDirPath in the SDK).
const sessionDirFor = cwd => path.join(agentDir(), "sessions", `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
const syncBindingsPath = () => path.join(agentDir(), "sync-bindings.json");
const CHAT_KEY = /^[A-Za-z0-9_-]+$/;

const dirents = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

function filesUnder(dir, rel = "") {
  const out = [];
  for (const entry of dirents(path.join(dir, rel))) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(dir, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

// Chat key "" is chatsDir() itself, where older chats shared one cwd.
function localChatItems() {
  const root = chatsDir();
  const keys = ["", ...dirents(root).filter(e => e.isDirectory() && CHAT_KEY.test(e.name)).map(e => e.name)];
  const items = [];
  for (const chat of keys) {
    const cwd = chat ? path.join(root, chat) : root;
    const sessions = sessionDirFor(cwd);
    for (const entry of dirents(sessions)) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) items.push({ kind: "session", chat, path: entry.name, file: path.join(sessions, entry.name) });
    }
    if (chat) for (const rel of filesUnder(cwd)) items.push({ kind: "file", chat, path: rel, file: path.join(cwd, rel) });
  }
  return items;
}

function readSyncBindings() {
  try { return JSON.parse(fs.readFileSync(syncBindingsPath(), "utf8")).bindings || []; } catch { return []; }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, data, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

// Web side. pending() is decided once at start; run(send) posts every item, then marks the move done.
export function chatTransfer({ marker = path.join(appHome(), "chats-moved.json") } = {}) {
  let pending = !fs.existsSync(marker) && localChatItems().some(item => item.kind === "session");
  return {
    pending: () => pending,
    async run(send) {
      const items = localChatItems();
      for (const item of items) {
        await send({ kind: item.kind, chat: item.chat, path: item.path, source: chatsDir(), content: fs.readFileSync(item.file).toString("base64") });
      }
      // pi-sync's record of each shared chat, so the worker keeps syncing it instead of sharing it anew.
      const sessions = new Map(items.filter(item => item.kind === "session").map(item => [item.file, item]));
      const syncBindings = readSyncBindings().filter(b => sessions.has(b.materializedFile)).map(b => {
        const { chat, path: file } = sessions.get(b.materializedFile);
        return { ...b, materializedFile: null, chat, path: file };
      });
      await send({ kind: "meta", closed: [...loadClosed()], syncBindings });
      writeAtomic(marker, JSON.stringify({ movedAt: new Date().toISOString(), items: items.length }));
      pending = false;
      return items.length;
    },
  };
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "invalid_chat_import", status: 400 });
}

// Worker side. Never overwrites: a file already here wins, so a repeated import is harmless.
// Returns whether anything was written.
export function importChatItem(body) {
  const root = chatsDir();
  if (body?.kind === "meta") {
    const closed = loadClosed();
    for (const id of Array.isArray(body.closed) ? body.closed : []) if (typeof id === "string" && id) closed.add(id);
    saveClosed(closed);
    const file = syncBindingsPath();
    let current = { version: 1, bindings: [] };
    try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none yet */ }
    const known = new Set(current.bindings.map(b => b.nativeSessionId));
    let added = 0;
    for (const { chat, path: name, ...binding } of Array.isArray(body.syncBindings) ? body.syncBindings : []) {
      if (!binding.nativeSessionId || known.has(binding.nativeSessionId) || !CHAT_KEY.test(chat || "x") || !name || /[/\\]/.test(name)) continue;
      current.bindings.push({ ...binding, materializedFile: path.join(sessionDirFor(chat ? path.join(root, chat) : root), name) });
      added++;
    }
    if (added) writeAtomic(file, JSON.stringify(current));
    return added > 0;
  }
  const chat = typeof body?.chat === "string" ? body.chat : null;
  const rel = typeof body?.path === "string" ? body.path : "";
  if (chat === null || (chat && !CHAT_KEY.test(chat))) throw invalid("invalid chat");
  if (!rel || path.isAbsolute(rel) || rel.split(/[/\\]/).some(part => part === ".." || part === "")) throw invalid("invalid path");
  const cwd = chat ? path.join(root, chat) : root;
  let data = Buffer.from(String(body.content || ""), "base64");
  let target;
  if (body.kind === "file" && chat) target = path.join(cwd, rel);
  else if (body.kind === "session" && !/[/\\]/.test(rel) && rel.endsWith(".jsonl")) {
    target = path.join(sessionDirFor(cwd), rel);
    // The session header records its cwd; web's chats directory can differ from this worker's.
    const text = data.toString("utf8");
    const end = text.indexOf("\n");
    try {
      const header = JSON.parse(end < 0 ? text : text.slice(0, end));
      if (typeof header.cwd === "string" && body.source && header.cwd.startsWith(body.source)) {
        header.cwd = root + header.cwd.slice(body.source.length);
        data = Buffer.from(JSON.stringify(header) + (end < 0 ? "" : text.slice(end)));
      }
    } catch { /* not a header line; copy as is */ }
  } else throw invalid("invalid item");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(target, data, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}
