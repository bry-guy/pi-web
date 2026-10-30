// Client for workspaced. Projects live in per-project workers; web routes
// project/session calls to the owning worker, merges their state into
// /api/state, and re-emits their events on its own SSE hub. Plain chats live
// in one more worker, "chats", which has no repository. Without
// PI_WEB_WORKSPACED_URL (only mock mode and tests) web serves everything in-process.
// PI_WEB_WORKSPACED_URL=local runs workspaced inside web, its workers as child processes.

import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { chatTransfer } from "./chat-transfer.js";
import { remoteConversationPreview, remoteConversationsForProject, syncedProjects as syncedProjectsFromServer } from "./pi-sync.js";

// workspaced's CHATS_WORKSPACE: the worker without a repository.
const CHATS = "chats";
const isChats = w => w.name === CHATS && !w.repository;

// Workers read web's model logins from a read-only copy. Pi refreshes OAuth
// itself only inside 5 minutes of expiry (and would fail on the read-only
// file), so web refreshes at 30 minutes and republishes well before that.
const MODEL_AUTH_MIN_VALIDITY_MS = 30 * 60_000;
const MODEL_AUTH_SYNC_MS = 5 * 60_000;

const DROP_HEADERS = ["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding"];

export function remoteWorkspacesFromEnv(env, deps) {
  let url = env.PI_WEB_WORKSPACED_URL;
  if (!url) return null;
  let token = env.WORKSPACED_TOKEN || null;
  let fetchImpl;
  if (url === "local") {
    const embedded = embeddedWorkspaced(env);
    ({ url, token, fetchImpl } = embedded);
  }
  const modelAuthPath = path.join(env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"), "auth.json");
  const cachePath = env.PI_WEB_HOME ? path.join(env.PI_WEB_HOME, "remote-projects.json") : null;
  return createRemoteWorkspaces({ url: url.replace(/\/+$/, ""), token, modelAuthPath, cachePath, transfer: chatTransfer(), syncedProjects: syncedProjectsFromServer, ...(fetchImpl ? { fetchImpl } : {}), ...deps });
}

// workspaced with the local provider, answering web's calls in-process (no port, no network).
// Workers share this machine and HOME, so they skip the prestart web already ran.
export function embeddedWorkspaced(env, { log = console.log } = {}) {
  const token = randomBytes(32).toString("hex");
  const home = env.PI_WEB_HOME || path.join(homedir(), ".pi-web-ui");
  const workspacedEnv = { ...env, WORKSPACED_PROVIDER: "local", WORKSPACED_ROOT: env.WORKSPACED_ROOT || path.join(home, "workspaces") };
  const ready = import("../workspaced/index.js")
    .then(m => m.workspacedFromEnv(workspacedEnv, { token, auth: "token", local: { env: { PI_WEB_PRESTART_COMMAND: "" } } }));
  ready.then(({ provider }) => {
    log(`pi-ez-web: workers run as local processes under ${workspacedEnv.WORKSPACED_ROOT}`);
    const stop = signal => { provider.stop(); process.exit(signal === "SIGINT" ? 130 : 143); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    process.once("exit", () => provider.stop());
  }, e => log(`pi-ez-web: could not start the built-in workspaced: ${e.message}`));
  const fetchImpl = async (input, init) => (await ready).app.fetch(new Request(input, init));
  return { url: "http://workspaced.internal", token, fetchImpl };
}

// transfer: web's own earlier chats to copy into the chats worker (chat-transfer.js), or null.
export function createRemoteWorkspaces({ url, token, hub, github, sup = null, modelAuthPath = null, cachePath = null, transfer = null, fetchImpl = globalThis.fetch, readyTimeoutMs = 180_000, stateTimeoutMs = 400, retryMs = 5_000, modelAuthSyncMs = MODEL_AUTH_SYNC_MS, syncedProjects = async () => [], syncedTtlMs = 30_000, log = console.log }) {
  const owners = { project: new Map(), session: new Map() };

  // pi projects with synced conversations (pi-sync), so a project not on web yet is still listed.
  let synced = { at: -Infinity, projects: [] };
  async function syncedList() {
    if (Date.now() - synced.at < syncedTtlMs) return synced.projects;
    try { synced = { at: Date.now(), projects: await syncedProjects() }; } catch { synced.at = Date.now(); }
    return synced.projects;
  }
  const streams = new Map();
  const auth = token ? { authorization: `Bearer ${token}` } : {};
  let stopped = false;

  // Last known projects per workspace, so sleeping workers stay in the sidebar.
  let snapshots = {};
  try { snapshots = cachePath ? JSON.parse(readFileSync(cachePath, "utf8")) : {}; } catch { snapshots = {}; }
  function saveSnapshots() {
    if (!cachePath) return;
    try {
      writeFileSync(`${cachePath}.tmp`, JSON.stringify(snapshots), { mode: 0o600 });
      renameSync(`${cachePath}.tmp`, cachePath);
    } catch { /* the cache is a convenience */ }
  }
  for (const [name, projects] of Object.entries(snapshots)) remember(name, projects);

  // Last known chats, so they stay listed while the chats worker sleeps.
  const chatCachePath = cachePath ? path.join(path.dirname(cachePath), "remote-chats.json") : null;
  let chatSnapshot = [];
  try { chatSnapshot = chatCachePath ? JSON.parse(readFileSync(chatCachePath, "utf8")) : []; } catch { chatSnapshot = []; }
  function saveChats() {
    if (!chatCachePath) return;
    try {
      writeFileSync(`${chatCachePath}.tmp`, JSON.stringify(chatSnapshot), { mode: 0o600 });
      renameSync(`${chatCachePath}.tmp`, chatCachePath);
    } catch { /* the cache is a convenience */ }
  }
  for (const chat of chatSnapshot) owners.session.set(chat.id, CHATS);

  const call = (path, init = {}) => fetchImpl(`${url}/v1${path}`, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  const workerPath = (name, rest) => `/workspaces/${encodeURIComponent(name)}/api${rest}`;

  async function list() {
    const res = await call("/workspaces");
    if (!res.ok) throw Object.assign(new Error("workspaced unavailable"), { code: "workspaced_unavailable" });
    return (await res.json()).workspaces || [];
  }

  async function workerState(name) {
    // A slow worker must not hold up the sidebar; its cached snapshot shows instead.
    const res = await call(workerPath(name, "/state"), { signal: AbortSignal.timeout(stateTimeoutMs) });
    return res.ok ? res.json() : null;
  }

  function remember(name, projects) {
    // Forks are nested; an unknown child id would fall through to web's own routes.
    const walk = nodes => { for (const s of nodes || []) { owners.session.set(s.id, name); walk(s.children); } };
    for (const p of projects) {
      owners.project.set(p.id, name);
      walk(p.sessions);
      walk(p.ended);
    }
  }

  // An ended session must not come back from the cached snapshot of a slow or sleeping worker.
  function forgetSession(name, id) {
    if (name === CHATS) {
      chatSnapshot = chatSnapshot.filter(s => s.id !== id);
      saveChats();
      return;
    }
    const prune = nodes => (nodes || []).filter(s => s.id !== id).map(s => ({ ...s, children: prune(s.children) }));
    if (!snapshots[name]) return;
    snapshots[name] = snapshots[name].map(p => ({ ...p, sessions: prune(p.sessions) }));
    saveSnapshots();
  }

  function unsubscribe(name) {
    streams.get(name)?.abort();
    streams.delete(name);
  }

  // Remote projects and chats for /api/state; also refreshes ownership and event streams.
  // Only running workers are polled or streamed: web must never wake a worker.
  async function refresh() {
    maybeMoveChats();
    let all;
    try { all = await list(); } catch { return { projects: [], chats: [] }; }
    const known = new Set(all.map(w => w.name));
    let changed = false;
    for (const name of Object.keys(snapshots)) if (!known.has(name)) { delete snapshots[name]; changed = true; }
    for (const name of streams.keys()) if (!known.has(name)) unsubscribe(name);
    const chatsWorker = all.find(isChats);
    const workspaces = all.filter(w => !isChats(w));
    const tag = (w, p) => ({ ...p, workspace: w.name, workspaceState: w.state || (w.ready ? "running" : "starting"), workspacePinned: !!w.pinned, workspaceGrant: w.grant || "default", workspaceProblem: w.problem || null });
    const chats = chatsWorker ? chatList(chatsWorker) : Promise.resolve([]);
    const lists = await Promise.all(workspaces.map(async w => {
      const running = w.state ? w.state === "running" : w.ready;
      let fresh = null;
      if (running) {
        subscribe(w.name);
        const state = await workerState(w.name).catch(() => null);
        fresh = state?.projects || null;
        if (state?.piProjects) piProjectsByWorker[w.name] = state.piProjects;
      } else unsubscribe(w.name);
      if (fresh) {
        remember(w.name, fresh);
        if (JSON.stringify(snapshots[w.name]) !== JSON.stringify(fresh)) { snapshots[w.name] = fresh; changed = true; }
      }
      const shown = fresh || snapshots[w.name];
      if (shown) return shown.map(p => tag(w, p));
      return [tag(w, { id: `workspace:${w.name}`, name: w.name, pending: true, branches: [], sessions: [], contexts: [], worktrees: {}, workspaceStatus: {} })];
    }));
    if (changed) saveSnapshots();
    // A project worker names its pi project even before it has repositories (sleeping workers: from the worker name).
    const piProjects = workspaces.filter(w => w.repository?.startsWith("project:")).map(w => {
      const known = (piProjectsByWorker[w.name] || []).find(p => `project:${p.name}` === w.repository);
      return { name: w.repository.slice(8), repos: known?.repos || [], ...tag(w, {}) };
    });
    // Projects other devices synced but web has no worker for yet: opening one creates it.
    const served = new Set(piProjects.map(p => p.name));
    for (const p of await syncedList()) {
      if (!served.has(p.name)) piProjects.push({ name: p.name, repos: [], workspace: null, workspaceState: null, synced: { sessions: p.sessions || 0, lastActive: p.lastActive || null } });
    }
    return { projects: lists.flat(), piProjects, chats: await chats, ended: chatsEnded, piConfiguration: chatsPi };
  }
  const projects = async () => (await refresh()).projects;

  // Whether the chats worker answered at the last look; when not, the next chat request wakes it first.
  let chatsAwake = false;
  // The chats worker's Pi setup, which Settings → Pi shows and edits; null until it has answered once.
  let chatsPi = null;
  let chatsEnded = [];
  async function chatList(w) {
    chatsAwake = (w.state || (w.ready ? "running" : "starting")) === "running";
    if (!chatsAwake) {
      unsubscribe(w.name);
      return chatSnapshot;
    }
    subscribe(w.name);
    const state = await workerState(w.name).catch(() => null);
    if (state?.piConfiguration) chatsPi = state.piConfiguration;
    if (state?.endedChats) {
      chatsEnded = state.endedChats;
      for (const chat of chatsEnded) owners.session.set(chat.id, w.name);
    }
    const fresh = state?.chats;
    if (!fresh) return chatSnapshot;
    for (const chat of fresh) owners.session.set(chat.id, w.name);
    if (JSON.stringify(fresh) !== JSON.stringify(chatSnapshot)) { chatSnapshot = fresh; saveChats(); }
    return fresh;
  }

  // Creates the chats worker the first time it is needed, and waits until it answers.
  let chatsStarting = null;
  function ensureChats() {
    chatsStarting ??= (async () => {
      if (!(await list()).some(isChats)) {
        await pushGitHubAuth();
        await pushModelAuth();
        const res = await call("/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chats: true }) });
        if (!res.ok) throw Object.assign(new Error("could not create the chats worker"), { code: "workspaced_unavailable", status: 502 });
      }
      await call(`/workspaces/${CHATS}/wake`, { method: "POST" }).catch(() => {});
      await waitReady(CHATS);
      chatsAwake = true;
      subscribe(CHATS);
    })().finally(() => { chatsStarting = null; });
    return chatsStarting;
  }

  async function createChat(c) {
    await ensureChats();
    const res = await call(workerPath(CHATS, "/chats"), { method: "POST", headers: { "content-type": "application/json" }, body: await c.req.text() || "{}" });
    const body = await res.json().catch(() => ({ error: "workspace_unavailable" }));
    if (res.ok && body.id) owners.session.set(body.id, CHATS);
    return c.json(body, res.status);
  }

  // Web's earlier in-process chats move to the chats worker once; until then web still serves them.
  let moving = null;
  let lastMoveAttempt = -Infinity;
  function maybeMoveChats() {
    if (!transfer?.pending() || moving || Date.now() - lastMoveAttempt < 60_000) return;
    lastMoveAttempt = Date.now();
    moving = (async () => {
      await ensureChats();
      const count = await transfer.run(async item => {
        const res = await call(workerPath(CHATS, "/chats/import"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(item) });
        if (!res.ok) throw new Error(`import answered ${res.status}`);
      });
      log(`pi-ez-web: moved ${count} chat files to the chats worker`);
    })().catch(e => log(`pi-ez-web: could not move chats to the chats worker yet: ${e.message}`)).finally(() => { moving = null; });
  }

  // Settings → Pi applies to the chats worker (project workers keep their own setup).
  async function chatsPost(rest, body) {
    await ensureChats();
    const res = await call(workerPath(CHATS, rest), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const out = await res.json().catch(() => ({ error: "workspace_unavailable" }));
    if (res.ok && out.piConfiguration) chatsPi = out.piConfiguration;
    return { status: res.status, body: out };
  }
  const isChatSession = id => owners.session.get(id) === CHATS;

  async function setPinned(name, pinned) {
    const res = await call(`/workspaces/${encodeURIComponent(name)}/pin`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: !!pinned }) });
    if (!res.ok) throw Object.assign(new Error("could not change keep-awake"), { code: "workspaced_unavailable", status: 502 });
  }

  // Restart, reset and reload: workspaced's answer (status and body) passes through.
  async function workspaceAction(name, action, { force = false, body } = {}) {
    const res = await call(`/workspaces/${encodeURIComponent(name)}/${action}${force ? "?force=1" : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  // Settings view: activity and usage from workspaced; grant details without env values (Secret names only).
  async function inventory() {
    const [res, allGrants] = await Promise.all([call("/workspaces?detail=1"), grants("")]);
    if (!res.ok) throw Object.assign(new Error("workspaced unavailable"), { code: "workspaced_unavailable", status: 502 });
    const body = await res.json();
    const byName = new Map(allGrants.map(g => [g.name, g]));
    const grantView = g => g && { name: g.name, description: g.description || "", namespace: g.namespace, serviceAccount: g.serviceAccount, egress: g.egress, env: g.env || [] };
    return {
      usageAvailable: !!body.usageAvailable,
      workspaces: (body.workspaces || []).map(w => ({
        name: w.name, repository: w.repository, state: w.state || (w.ready ? "running" : "starting"), ready: !!w.ready,
        keepAwake: !!w.pinned, busy: !!w.busy, lastUsed: w.lastUsed ?? null, resources: w.resources ?? null, usage: w.usage ?? null,
        grant: grantView(byName.get(w.grant || "default")) || null,
      })),
    };
  }

  // Reloads every awake worker; one that fails doesn't stop the others.
  async function reloadAwake() {
    const awake = (await list()).filter(w => (w.state || (w.ready ? "running" : "starting")) === "running");
    return Promise.all(awake.map(async w => {
      const { status, body } = await workspaceAction(w.name, "reload").catch(() => ({ status: 502, body: { error: "workspace_unavailable" } }));
      return { name: w.name, ok: status < 300, status, error: status < 300 ? null : body.error || "workspace_unavailable" };
    }));
  }

  // Deletes a worker. Its volume (clone, sessions, unpushed work) is kept unless purged,
  // so adding the repository again picks it back up.
  async function remove(name, { purge = false } = {}) {
    const res = await call(`/workspaces/${encodeURIComponent(name)}${purge ? "?purge=1" : ""}`, { method: "DELETE" });
    if (!res.ok) return { status: res.status, body: await res.json().catch(() => ({ error: "workspaced_unavailable" })) };
    unsubscribe(name);
    delete snapshots[name];
    saveSnapshots();
    if (name === CHATS) { chatSnapshot = []; saveChats(); }
    for (const map of Object.values(owners)) for (const [id, owner] of map) if (owner === name) map.delete(id);
    return { status: 200, body: { ok: true, name, purged: purge } };
  }

  // Fire and forget: workspaced holds the request until the worker is ready.
  function wake(name) {
    call(`/workspaces/${encodeURIComponent(name)}/wake`, { method: "POST" }).catch(() => {});
  }

  async function grants(repository) {
    const res = await call(`/grants${repository ? `?repository=${encodeURIComponent(repository)}` : ""}`);
    if (!res.ok) throw Object.assign(new Error("workspaced unavailable"), { code: "workspaced_unavailable", status: 502 });
    return (await res.json()).grants || [];
  }

  async function setGrant(name, grant) {
    const res = await call(`/workspaces/${encodeURIComponent(name)}/grant`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant }) });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  async function owner(kind, id) {
    if (!owners[kind].has(id)) await projects();
    return owners[kind].get(id) || null;
  }

  // Worker seq → web seq for recent re-emitted events, per workspace. The
  // browser compares a transcript snapshot's seq with live event seqs, so a
  // snapshot from a worker must carry web's numbering or live events are
  // dropped until reload.
  const seqMaps = new Map();
  function webSeq(name, workerSeq) {
    const pairs = seqMaps.get(name) || [];
    if (!pairs.length || !Number.isFinite(workerSeq)) return hub.currentSeq();
    // shortcut: a snapshot newer than every event seen yet maps to now, so an event still in flight may apply twice; rare (ms window).
    let out = pairs[0][1] - 1;
    for (const [w, web] of pairs) { if (w > workerSeq) break; out = web; }
    return pairs.at(-1)[0] < workerSeq ? hub.currentSeq() : out;
  }

  async function forward(c, name) {
    // Unlike a project, the UI has no worker state for a chat to wake, so web wakes the chats worker itself.
    if (name === CHATS && !chatsAwake) await ensureChats();
    const raw = c.req.url;
    const search = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
    const rest = c.req.path.replace(/^.*?\/api(?=\/)/, "");
    const headers = new Headers(c.req.raw.headers);
    for (const h of DROP_HEADERS) headers.delete(h);
    headers.delete("authorization");
    if (auth.authorization) headers.set("authorization", auth.authorization);
    const hasBody = !["GET", "HEAD"].includes(c.req.method);
    let res;
    try {
      res = await fetchImpl(`${url}/v1${workerPath(name, rest)}${search}`, { method: c.req.method, headers, body: hasBody ? c.req.raw.body : undefined, duplex: "half", signal: c.req.raw.signal });
    } catch {
      if (name === CHATS) chatsAwake = false;
      return c.json({ error: "workspace_unavailable", workspace: name }, 502);
    }
    if (name === CHATS && res.status >= 502) chatsAwake = false;
    const out = new Headers(res.headers);
    for (const h of DROP_HEADERS) out.delete(h);
    const closed = c.req.method === "POST" && rest.match(/^\/sessions\/([^/]+)\/close$/);
    if (res.ok && closed) forgetSession(name, decodeURIComponent(closed[1]));
    if (res.ok && c.req.method === "GET" && /^\/sessions\/[^/]+\/transcript$/.test(rest)) {
      const snap = await res.json();
      snap.seq = webSeq(name, Number(snap.seq));
      out.delete("content-length");
      return new Response(JSON.stringify(snap), { status: res.status, headers: out });
    }
    return new Response(res.body, { status: res.status, headers: out });
  }

  // Fan-in: each worker numbers its own events, so re-emit through web's hub
  // to keep one ordered sequence for the browser.
  function subscribe(name) {
    if (streams.has(name) || stopped) return;
    const controller = new AbortController();
    streams.set(name, controller);
    (async () => {
      while (!stopped && !controller.signal.aborted) {
        try {
          const res = await call(workerPath(name, "/events"), { signal: controller.signal });
          // Sleeping: stop until projects() sees it running again.
          if (res.status === 503) { if (streams.get(name) === controller) streams.delete(name); return; }
          if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
          // A new connection may be a restarted worker numbering from zero.
          const pairs = [];
          seqMaps.set(name, pairs);
          // Workers keep no event backlog; anything sent while web was not listening is gone,
          // so open transcripts reload from a snapshot instead.
          hub.emit(null, "events_resync", { workspace: name });
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const chunk of res.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let end;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = frame.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("\n");
              if (!data) continue;
              try {
                const { v: _v, seq, sessionId, type, ...rest } = JSON.parse(data);
                if (type === "ping") continue; // the worker's keepalive; web sends its own
                if (sessionId) owners.session.set(sessionId, name);
                hub.emit(sessionId, type, rest);
                pairs.push([Number(seq), hub.currentSeq()]);
                if (pairs.length > 5000) pairs.splice(0, 1000);
              } catch { /* malformed frame */ }
            }
          }
        } catch { /* reconnect below */ }
        if (!stopped && !controller.signal.aborted) await new Promise(r => setTimeout(r, retryMs));
      }
    })();
  }

  async function waitReady(name) {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      const res = await call(workerPath(name, "/health")).catch(() => null);
      if (res?.ok) return;
      await new Promise(r => setTimeout(r, 2_000));
    }
    throw Object.assign(new Error("workspace did not become ready"), { code: "workspace_start_timeout" });
  }

  async function pushGitHubAuth() {
    const value = github?.effectiveAuth?.();
    const body = value ? { version: 1, accessToken: value.accessToken, tokenType: value.tokenType || "bearer", scope: value.scope || "", account: value.account || null } : {};
    const res = await call("/github-auth", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw Object.assign(new Error("could not share GitHub login"), { code: "workspaced_unavailable" });
  }

  let publishedModelAuth = null;
  async function pushModelAuth() {
    const runtime = await sup?._modelRuntime?.().catch(() => null);
    if (runtime) {
      for (const { providerId, type } of await runtime.listCredentials()) {
        if (type === "oauth") await runtime.getAuth(providerId, { minOAuthValidityMs: MODEL_AUTH_MIN_VALIDITY_MS }).catch(() => {});
      }
    }
    let content;
    try { content = modelAuthPath ? readFileSync(modelAuthPath, "utf8") : "{}"; } catch { content = "{}"; }
    if (content === publishedModelAuth) return;
    const res = await call("/model-auth", { method: "PUT", headers: { "content-type": "application/json" }, body: content });
    if (!res.ok) throw Object.assign(new Error("could not share model logins"), { code: "workspaced_unavailable" });
    publishedModelAuth = content;
  }
  // workspaced keeps the GitHub login in memory only (to read score.yaml), so re-share it after a gateway restart.
  const syncAuth = () => { pushModelAuth().catch(() => {}); pushGitHubAuth().catch(() => {}); };
  const modelAuthTimer = modelAuthSyncMs ? setInterval(syncAuth, modelAuthSyncMs) : null;
  modelAuthTimer?.unref?.();
  if (modelAuthTimer) syncAuth();

  // Adding a repository creates its workspace, then the worker connects it.
  const piProjectsByWorker = {};

  /** The worker serving pi project `name`, from the workers list. */
  async function projectWorker(name) {
    return (await list()).find(w => w.repository === `project:${name}`)?.name || null;
  }

  async function createProject(c, body) {
    // A new pi project: its own worker, named after it; it starts with no repositories.
    if (typeof body.project === "string" && body.project) {
      // Opening a project creates its worker; a second open (another tab, a double click) finds it.
      const existing = await projectWorker(body.project);
      if (existing) return c.json({ project: body.project, workspace: existing }, 200);
      await pushGitHubAuth();
      await pushModelAuth();
      const res = await call("/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: body.project, ...(body.grant ? { grant: String(body.grant) } : {}) }) });
      const created = await res.json().catch(() => ({}));
      if (!res.ok) return c.json({ error: created.error || "workspaced_unavailable" }, res.status);
      await waitReady(created.name);
      subscribe(created.name);
      return c.json({ project: body.project, workspace: created.name }, 201);
    }
    // Adding a repository to a pi project goes to that project's worker.
    if (typeof body.group === "string" && body.group) {
      const name = await projectWorker(body.group);
      if (!name) return c.json({ error: "no_such_pi_project" }, 404);
      await waitReady(name);
      const forwarded = await call(workerPath(name, "/projects"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await forwarded.json().catch(() => ({}));
      if (forwarded.ok) { owners.project.set(result.id, name); if (result.sessionId) owners.session.set(result.sessionId, name); }
      return c.json({ ...result, workspace: name }, forwarded.status);
    }
    const repository = body.source === "github" ? body.fullName : body.url;
    if (typeof repository !== "string" || !repository.trim()) return c.json({ error: "invalid_repository" }, 400);
    await pushGitHubAuth();
    await pushModelAuth();
    const res = await call("/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: repository.trim(), ...(body.grant ? { grant: String(body.grant) } : {}) }) });
    const created = await res.json().catch(() => ({}));
    if (!res.ok) return c.json({ error: created.error || "workspaced_unavailable" }, res.status);
    await waitReady(created.name);
    subscribe(created.name);
    const forwarded = await call(workerPath(created.name, "/projects"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let result = await forwarded.json().catch(() => ({}));
    // A kept volume already holds this project (closed earlier without deleting data): reuse it.
    if (forwarded.status === 409 && ["repository_exists", "project_exists"].includes(result.error)) {
      const existing = (await workerState(created.name).catch(() => null))?.projects?.[0];
      if (existing) {
        remember(created.name, [existing]);
        return c.json({ id: existing.id, sessionId: null, workspace: created.name, reused: true }, 200);
      }
    }
    if (forwarded.ok) { owners.project.set(result.id, created.name); if (result.sessionId) owners.session.set(result.sessionId, created.name); }
    return c.json({ ...result, workspace: created.name }, forwarded.status);
  }

  // Other devices' conversations of a pi project, straight from pi-sync, so the menu needs no worker.
  // Only this project's own worker counts as "here": a copy another worker once opened still belongs in this list.
  const projectSynced = async name => {
    const worker = await projectWorker(name).catch(() => null);
    return remoteConversationsForProject(name, id => !!worker && owners.session.get(id) === worker);
  };
  const syncedPreview = id => remoteConversationPreview(id);

  return {
    wake, projectSynced, syncedPreview,
    projects, refresh, createChat, chatsPost, isChatSession, owner, forward, createProject, pushGitHubAuth, pushModelAuth, setPinned, grants, setGrant, inventory, workspaceAction, reloadAwake, remove,
    stop() { stopped = true; clearInterval(modelAuthTimer); for (const c of streams.values()) c.abort(); },
  };
}

// Mount before the in-process routes so remote ids never reach them.
export function registerRemoteRoutes(api, remote) {
  // Closing a worker project deletes its worker.
  api.delete("/remote-workspaces/:name", async c => {
    const { status, body } = await remote.remove(c.req.param("name"), { purge: c.req.query("purge") === "1" });
    return c.json(body, status);
  });
  for (const [kind, pattern] of [["project", "/projects/:id/*"], ["session", "/sessions/:id/*"]]) {
    api.use(pattern, async c => {
      const name = await remote.owner(kind, c.req.param("id"));
      // Web runs no conversations of its own: an id no worker owns does not exist.
      return name ? remote.forward(c, name) : c.json({ error: kind === "session" ? "no_such_session" : "no_such_project" }, 404);
    });
  }
  api.get("/pi-projects/:name/synced", async c => {
    try { return c.json({ sessions: await remote.projectSynced(c.req.param("name")) }); }
    catch (error) { return c.json({ error: "sync_unavailable", message: error.message }, 502); }
  });
  api.get("/pi-projects/synced/:syncId", async c => {
    try { return c.json({ records: await remote.syncedPreview(c.req.param("syncId")) }); }
    catch (error) { return c.json({ error: "sync_unavailable", message: error.message }, 502); }
  });
  api.post("/pi/reload", async c => {
    const { status, body } = await remote.chatsPost("/pi/reload", {});
    return c.json(body, status);
  });
  // Pi setup goes to the chats worker; every other setting is web's own.
  api.post("/settings", async (c, next) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.pi === undefined) return next();
    const sessionId = body.activeSessionId && remote.isChatSession(body.activeSessionId) ? body.activeSessionId : null;
    const { status, body: out } = await remote.chatsPost("/settings", { pi: body.pi, operationId: body.operationId, activeSessionId: sessionId });
    return c.json(out, status);
  });
  api.put("/remote-workspaces/:name/pin", async c => {
    const body = await c.req.json().catch(() => ({}));
    await remote.setPinned(c.req.param("name"), !!body.pinned);
    return c.json({ ok: true, pinned: !!body.pinned });
  });
  api.post("/remote-workspaces/:name/wake", c => { remote.wake(c.req.param("name")); return c.json({ ok: true }, 202); });
  api.get("/remote-workspaces", async c => c.json(await remote.inventory()));
  api.post("/remote-workspaces/reload", async c => c.json({ results: await remote.reloadAwake() }));
  for (const action of ["restart", "reset", "reload", "sleep"]) {
    api.post(`/remote-workspaces/:name/${action}`, async c => {
      const body = await c.req.json().catch(() => ({}));
      const { status, body: out } = await remote.workspaceAction(c.req.param("name"), action, { force: c.req.query("force") === "1", body });
      return c.json(out, status);
    });
  }
  api.get("/remote-workspaces/grants", async c => c.json({ grants: await remote.grants(c.req.query("repository") || "") }));
  api.put("/remote-workspaces/:name/grant", async c => {
    const body = await c.req.json().catch(() => ({}));
    const { status, body: out } = await remote.setGrant(c.req.param("name"), body.grant);
    return c.json(out, status);
  });
  api.post("/chats", c => remote.createChat(c));
  api.post("/projects", async c => {
    const body = await c.req.json().catch(() => ({}));
    if (body.project && !body.source) return remote.createProject(c, body);
    if (body.source !== "github" && body.source !== "git-url") return c.json({ error: "unsupported_repository_source" }, 400);
    return remote.createProject(c, body);
  });
}
