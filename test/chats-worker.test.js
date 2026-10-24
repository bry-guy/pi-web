import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createWorkspaced } from "../workspaced/index.js";
import { kubernetesConfig, kubernetesProvider } from "../workspaced/kubernetes.js";
import { parseGrants } from "../workspaced/grants.js";
import { localProvider } from "../workspaced/local.js";
import { createRemoteWorkspaces, registerRemoteRoutes } from "../server/remote-workspaces.js";
import { chatTransfer, importChatItem } from "../server/chat-transfer.js";
import { EventHub } from "../server/events.js";

const TOKEN = "secret-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = body => ({ method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

test("workspaced creates the chats worker without a repository, on a grant any project may use", async () => {
  const kube = { calls: [], request: async (method, p, body) => { kube.calls.push([method, p, body]); return method === "POST" ? { status: 201, body: {} } : { status: 404, body: {} }; } };
  const grants = parseGrants(JSON.stringify({ default: { anyProject: true }, ops: { repos: ["a/infra"] } }));
  const app = createWorkspaced({ provider: kubernetesProvider({ kube, config: kubernetesConfig({}) }), grants, token: TOKEN });
  assert.equal((await app.request("/v1/workspaces", json({ chats: true, grant: "ops" }))).status, 403);
  const res = await app.request("/v1/workspaces", json({ chats: true }));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { name: "chats" });
  const created = kube.calls.filter(([m]) => m === "POST").map(([, , body]) => body);
  assert.deepEqual(created.map(b => [b.kind, b.metadata.name]), [["PersistentVolumeClaim", "ws-chats"], ["Service", "ws-chats"], ["Deployment", "ws-chats"]]);
  assert.ok(created.every(b => !("pi-ez.dev/repository" in b.metadata.annotations)));
  assert.equal(created[2].metadata.annotations["pi-ez.dev/grant"], "default");

  const local = localProvider({ root: mkdtempSync(path.join(tmpdir(), "workspaced-")), spawnImpl: () => Object.assign(new EventEmitter(), { exitCode: null, kill() {} }) });
  await local.create({ name: "chats", repository: null });
  await local.create({ name: "chats", repository: null });
  await assert.rejects(local.create({ name: "chats", repository: "someone/chats" }), { code: "workspace_name_taken" });
});

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

test("web lists chats from the chats worker, creates them there, and routes their sessions to it", async () => {
  const seen = [];
  const worker = await listen((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === "/api/state") return res.end(JSON.stringify({ projects: [], chats: [{ id: "c1", title: "hi" }] }));
    if (req.url === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream" }); return undefined; }
    if (req.url === "/api/health") return res.end("{}");
    if (req.url === "/api/chats") return res.end(JSON.stringify({ id: "c2" }));
    return res.end(JSON.stringify({ path: req.url }));
  });
  let workers = [];
  const provider = {
    list: async () => workers,
    create: async ({ name, repository }) => { workers.push({ name, repository, ready: true, state: "running" }); },
    upstream: () => `http://127.0.0.1:${worker.address().port}`,
    setGitHubAuth: async () => {}, setModelAuth: async () => {},
  };
  const daemon = serve({ fetch: createWorkspaced({ provider, token: TOKEN }).fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise(r => daemon.once("listening", r));
  const remote = createRemoteWorkspaces({ url: `http://127.0.0.1:${daemon.address().port}`, token: TOKEN, hub: new EventHub(), retryMs: 50, modelAuthSyncMs: 0 });
  try {
    const api = new Hono();
    registerRemoteRoutes(api, remote);
    api.all("*", c => c.json({ local: true }));
    assert.deepEqual(await remote.refresh(), { projects: [], chats: [] }, "no chats worker until the first chat");
    const created = await api.request("/chats", { method: "POST", body: "{}" });
    assert.deepEqual(await created.json(), { id: "c2" });
    assert.deepEqual(workers.map(w => [w.name, w.repository]), [["chats", null]]);
    assert.deepEqual(await (await api.request("/sessions/c2/message", { method: "POST", body: "{}" })).json(), { path: "/api/sessions/c2/message" });
    const state = await remote.refresh();
    assert.deepEqual(state.projects, [], "the chats worker is not a project");
    assert.deepEqual(state.chats.map(c => c.id), ["c1"]);
    assert.deepEqual(await (await api.request("/sessions/c1/meta")).json(), { path: "/api/sessions/c1/meta" });
  } finally {
    remote.stop();
    daemon.close();
    worker.closeAllConnections();
    worker.close();
  }
});

test("web's earlier chats copy into the chats worker once, with sync bindings and ended chats", async () => {
  const saved = { home: process.env.PI_WEB_HOME, agent: process.env.PI_CODING_AGENT_DIR };
  const web = mkdtempSync(path.join(tmpdir(), "chats-web-"));
  const target = mkdtempSync(path.join(tmpdir(), "chats-worker-"));
  const encode = cwd => `--${cwd.replace(/^\//, "").replace(/[/:]/g, "-")}--`;
  try {
    process.env.PI_WEB_HOME = path.join(web, "home");
    process.env.PI_CODING_AGENT_DIR = path.join(web, "agent");
    const chat = path.join(web, "home", "chats", "c_1");
    mkdirSync(path.join(chat, "notes"), { recursive: true });
    writeFileSync(path.join(chat, "notes", "a.txt"), "draft");
    const sessions = path.join(web, "agent", "sessions", encode(chat));
    mkdirSync(sessions, { recursive: true });
    const sessionFile = path.join(sessions, "1_s1.jsonl");
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: "s1", cwd: chat })}\n{"type":"message"}\n`);
    writeFileSync(path.join(web, "agent", "sync-bindings.json"), JSON.stringify({ version: 1, bindings: [
      { nativeSessionId: "s1", materializedFile: sessionFile, state: "ready" },
      { nativeSessionId: "p1", materializedFile: "/elsewhere/p1.jsonl", state: "ready" },
    ] }));
    writeFileSync(path.join(web, "home", "closed.json"), JSON.stringify(["old"]));

    const transfer = chatTransfer();
    assert.equal(transfer.pending(), true);
    const items = [];
    assert.equal(await transfer.run(async item => { items.push(item); }), 2);
    assert.equal(transfer.pending(), false);
    assert.equal(chatTransfer().pending(), false, "the marker keeps it moved after a restart");

    process.env.PI_WEB_HOME = path.join(target, "home");
    process.env.PI_CODING_AGENT_DIR = path.join(target, "agent");
    assert.deepEqual(items.map(item => importChatItem(item)), [true, true, true]);
    assert.deepEqual(items.map(item => importChatItem(item)), [false, false, false], "a repeated import writes nothing");
    const movedChat = path.join(target, "home", "chats", "c_1");
    assert.equal(readFileSync(path.join(movedChat, "notes", "a.txt"), "utf8"), "draft");
    const movedFile = path.join(target, "agent", "sessions", encode(movedChat), "1_s1.jsonl");
    const [header, rest] = readFileSync(movedFile, "utf8").split("\n");
    assert.equal(JSON.parse(header).cwd, movedChat);
    assert.equal(rest, '{"type":"message"}');
    assert.deepEqual(JSON.parse(readFileSync(path.join(target, "agent", "sync-bindings.json"), "utf8")).bindings, [{ nativeSessionId: "s1", materializedFile: movedFile, state: "ready" }]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(target, "home", "closed.json"), "utf8")), ["old"]);
    assert.throws(() => importChatItem({ kind: "file", chat: "c_1", path: "../../escape", content: "" }), { code: "invalid_chat_import" });
    assert.throws(() => importChatItem({ kind: "session", chat: "../x", path: "a.jsonl", content: "" }), { code: "invalid_chat_import" });
    assert.ok(!existsSync(path.join(target, "escape")));
  } finally {
    for (const [key, value] of [["PI_WEB_HOME", saved.home], ["PI_CODING_AGENT_DIR", saved.agent]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
