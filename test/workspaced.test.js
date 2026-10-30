import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createWorkspaced } from "../workspaced/index.js";
import { deploymentState, kubernetesConfig, kubernetesProvider, podProblem, STUCK_START_MS } from "../workspaced/kubernetes.js";
import { createLifecycle } from "../workspaced/lifecycle.js";
import { parseGrants, repoKey, withGrantCheck } from "../workspaced/grants.js";
import { localProvider } from "../workspaced/local.js";
import { deploymentManifest, quantity, slugFromRepository } from "../workspaced/manifests.js";
import { createRemoteWorkspaces, registerRemoteRoutes } from "../server/remote-workspaces.js";
import { EventHub } from "../server/events.js";

const TOKEN = "secret-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = body => ({ method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

test("slugs are DNS-safe and reject garbage", () => {
  assert.equal(slugFromRepository("https://github.com/bry-guy/srvivor.git"), "srvivor");
  assert.equal(slugFromRepository("bry-guy/Personal_Finances"), "personal-finances");
  assert.equal(slugFromRepository("git@github.com:a/b"), "b");
  assert.equal(slugFromRepository("///"), null);
});

test("workers run one unprivileged container and never ask for a runtime class", () => {
  const spec = deploymentManifest({ name: "x", repository: "a/x", image: "img", grant: { name: "g", env: [], serviceAccount: "ws-x" } }).spec.template.spec;
  assert.equal(spec.containers.length, 1);
  assert.equal(spec.runtimeClassName, undefined);
  assert.ok(!spec.containers.some(c => c.securityContext?.privileged));
  assert.ok(!spec.containers[0].env.some(e => e.name === "DOCKER_HOST"));
  assert.equal(spec.serviceAccountName, "ws-x");
});

test("workers mount the shared GitHub login read-only and optionally", () => {
  const spec = deploymentManifest({ name: "x", repository: "a/x", image: "img" }).spec.template.spec;
  const vol = spec.volumes.find(v => v.name === "github");
  assert.equal(vol.secret.secretName, "pi-ez-github-auth");
  assert.equal(vol.secret.optional, true);
  assert.ok(spec.containers[0].volumeMounts.find(m => m.name === "github").readOnly);
});

function fakeKube(routes = {}) {
  const calls = [];
  return { calls, request: async (method, p, body) => {
    calls.push([method, p, body?.kind]);
    return routes[`${method} ${p}`] || (method === "POST" ? { status: 409, body: {} } : { status: 404, body: {} });
  } };
}

test("workspaced requires its token", async () => {
  const app = createWorkspaced({ provider: { list: async () => [] }, token: TOKEN });
  assert.equal((await app.request("/v1/workspaces")).status, 401);
  assert.equal((await app.request("/v1/workspaces", { headers: { authorization: "Bearer nope-nope-no" } })).status, 401);
  assert.equal((await app.request("/v1/workspaces", { headers: auth })).status, 200);
  assert.equal((await app.request("/healthz")).status, 200);
  assert.throws(() => createWorkspaced({ provider: {} }), /WORKSPACED_TOKEN/);
  const network = createWorkspaced({ provider: { list: async () => [] }, auth: "network" });
  assert.equal((await network.request("/v1/workspaces")).status, 200);
});

test("kubernetes create is idempotent, applies the SA convention, and refuses name collisions", async () => {
  const ns = "/api/v1/namespaces/pi-workspaced";
  const kube = fakeKube({ [`GET ${ns}/serviceaccounts/ws-srvivor`]: { status: 200, body: {} } });
  const app = createWorkspaced({ provider: kubernetesProvider({ kube, config: kubernetesConfig({}) }), token: TOKEN });
  assert.equal((await app.request("/v1/workspaces", json({ repository: "bry-guy/srvivor" }))).status, 201);
  assert.deepEqual(kube.calls.filter(c => c[0] === "POST").map(c => c[2]), ["PersistentVolumeClaim", "Service", "Deployment"]);

  const taken = fakeKube({ "GET /apis/apps/v1/namespaces/pi-workspaced/deployments/ws-srvivor": { status: 200, body: { metadata: { annotations: { "pi-ez.dev/repository": "other/srvivor" } } } } });
  const app2 = createWorkspaced({ provider: kubernetesProvider({ kube: taken, config: kubernetesConfig({}) }), token: TOKEN });
  assert.equal((await app2.request("/v1/workspaces", json({ repository: "bry-guy/srvivor" }))).status, 409);
  assert.equal((await app.request("/v1/workspaces", json({ repository: "a/b", name: "../etc" }))).status, 400);
});

test("kubernetes GitHub auth goes to the shared Secret", async () => {
  const kube = fakeKube({ "PUT /api/v1/namespaces/pi-workspaced/secrets/pi-ez-github-auth": { status: 200, body: {} } });
  const app = createWorkspaced({ provider: kubernetesProvider({ kube, config: kubernetesConfig({}) }), token: TOKEN });
  assert.equal((await app.request("/v1/github-auth", { ...json({ accessToken: "t" }), method: "PUT" })).status, 200);
  assert.ok(kube.calls.some(([m, p]) => m === "PUT" && p.endsWith("/pi-ez-github-auth")));
});

test("local provider persists workspaces, spawns workers, and writes auth 0600", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspaced-"));
  const spawned = [];
  const spawnImpl = (_bin, _args, opts) => { const child = new EventEmitter(); child.exitCode = null; child.kill = () => { child.exitCode = 0; }; spawned.push(opts.env); return child; };
  const provider = localProvider({ root, spawnImpl, env: { PI_WEB_PRESTART_COMMAND: "" } });
  const saved = process.env.PI_WEB_WORKSPACED_URL;
  process.env.PI_WEB_WORKSPACED_URL = "local";
  try { await provider.create({ name: "srvivor", repository: "bry-guy/srvivor" }); }
  finally { if (saved === undefined) delete process.env.PI_WEB_WORKSPACED_URL; else process.env.PI_WEB_WORKSPACED_URL = saved; }
  assert.equal(spawned[0].PI_WEB_REPOS_ROOT, path.join(root, "srvivor", "repos"));
  assert.equal(spawned[0].PI_WEB_WORKSPACED_URL, "", "a worker never runs a gateway of its own");
  assert.equal(spawned[0].PI_WEB_PRESTART_COMMAND, "", "extra worker env applies");
  assert.match(provider.upstream("srvivor"), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(await provider.list(), [{ name: "srvivor", repository: "bry-guy/srvivor", grant: "default", ready: true, state: "running", problem: null, pinned: false }]);
  await provider.setGitHubAuth({ accessToken: "t" });
  assert.equal(statSync(path.join(root, "github-auth.json")).mode & 0o777, 0o600);
  await assert.rejects(provider.create({ name: "srvivor", repository: "x/srvivor" }), { code: "workspace_name_taken" });
  const again = localProvider({ root, spawnImpl });
  await again.init();
  assert.equal(spawned.length, 2, "init restarts registered workers");
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "workspaces.json"), "utf8")), { srvivor: { repository: "bry-guy/srvivor", grant: "default" } });
  await again.scale("srvivor", 0);
  await again.setPinned("srvivor", true);
  assert.deepEqual((await again.list()).map(w => [w.state, w.pinned]), [["sleeping", true]]);
  const third = localProvider({ root, spawnImpl });
  await third.init();
  assert.equal(spawned.length, 2, "sleeping workers stay asleep across restarts");
});

test("web's built-in workspaced answers in-process with its own token", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "embedded-"));
  const { embeddedWorkspaced } = await import("../server/remote-workspaces.js");
  const listeners = ["SIGTERM", "SIGINT", "exit"].map(name => [name, process.listeners(name)]);
  const { url, token, fetchImpl } = embeddedWorkspaced({ ...process.env, PI_WEB_HOME: root, WORKSPACED_ROOT: undefined }, { log: () => {} });
  try {
    assert.equal((await fetchImpl(`${url}/v1/workspaces`)).status, 401);
    const res = await fetchImpl(`${url}/v1/workspaces`, { headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual(await res.json(), { workspaces: [] });
    assert.ok(statSync(path.join(root, "workspaces")).isDirectory(), "workers live under PI_WEB_HOME/workspaces");
  } finally {
    // Leave the test process's own signal handling as it was.
    for (const [name, kept] of listeners) for (const fn of process.listeners(name)) if (!kept.includes(fn)) process.removeListener(name, fn);
  }
});

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise(r => server.listen(0, "127.0.0.1", () => r(server)));
}

test("web routes owned ids to workers, merges state, and re-sequences events", async () => {
  // Fake worker: one project with one session, and an event stream.
  const worker = await listen((req, res) => {
    if (req.url === "/api/state") return res.end(JSON.stringify({ projects: [{ id: "p1", name: "srvivor", sessions: [{ id: "s1" }] }] }));
    if (req.url === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ v: 1, seq: 99, sessionId: "s1", type: "token", text: "hi" })}\n\n`); return undefined; }
    return res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  const provider = { list: async () => [{ name: "srvivor", ready: true }], upstream: () => `http://127.0.0.1:${worker.address().port}` };
  const daemon = serve({ fetch: createWorkspaced({ provider, token: TOKEN }).fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise(r => daemon.once("listening", r));
  const hub = new EventHub();
  const frames = [];
  hub.addClient(f => frames.push(f));
  const remote = createRemoteWorkspaces({ url: `http://127.0.0.1:${daemon.address().port}`, token: TOKEN, hub, retryMs: 50, modelAuthSyncMs: 0 });
  try {
    const api = new Hono();
    registerRemoteRoutes(api, remote);
    api.all("*", c => c.json({ local: true }));
    const projects = await remote.projects();
    assert.deepEqual(projects.map(p => [p.id, p.workspace]), [["p1", "srvivor"]]);
    assert.deepEqual(await (await api.request("/sessions/s1/message", { method: "POST", body: "{}" })).json(), { path: "/api/sessions/s1/message", method: "POST" });
    // Web runs no conversations itself: an id no worker owns is unknown, not served locally.
    const unknown = await api.request("/sessions/local-chat/message", { method: "POST" });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: "no_such_session" });
    // Projects exist only in workers and only from GitHub or Git URLs.
    const local = await api.request("/projects", { method: "POST", body: JSON.stringify({ source: "local", repoPath: "/tmp" }) });
    assert.equal(local.status, 400);
    assert.deepEqual(await local.json(), { error: "unsupported_repository_source" });
    for (let i = 0; i < 50 && !frames.some(f => f.includes("token")); i++) await new Promise(r => setTimeout(r, 20));
    const evt = JSON.parse(frames.find(f => f.includes("token")).split("data: ")[1]);
    assert.equal(evt.seq, 2, "web renumbers worker events (1 is the resync on connect)");
    assert.equal(evt.sessionId, "s1");
  } finally {
    remote.stop();
    daemon.close();
    worker.closeAllConnections();
    worker.close();
  }
});

test("model logins go to a read-only Secret that workers link auth.json to", async () => {
  const spec = deploymentManifest({ name: "x", repository: "a/x", image: "img" }).spec.template.spec;
  const vol = spec.volumes.find(v => v.name === "model");
  assert.deepEqual([vol.secret.secretName, vol.secret.optional], ["pi-ez-model-auth", true]);
  assert.ok(spec.containers[0].volumeMounts.find(m => m.name === "model").readOnly);
  const env = Object.fromEntries(spec.containers[0].env.map(e => [e.name, e.value]));
  assert.equal(env.PI_WEB_MODEL_AUTH_FILE, "/run/secrets/pi-ez-model/auth.json");

  const kube = fakeKube({ "PUT /api/v1/namespaces/pi-workspaced/secrets/pi-ez-model-auth": { status: 200, body: {} } });
  const app = createWorkspaced({ provider: kubernetesProvider({ kube, config: kubernetesConfig({}) }), token: TOKEN });
  const put = body => app.request("/v1/model-auth", { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body });
  assert.equal((await put("[]")).status, 400);
  assert.equal((await put("nope")).status, 400);
  assert.equal((await put('{"anthropic":{"type":"oauth"}}')).status, 200);
  assert.ok(kube.calls.some(([m, p]) => m === "PUT" && p.endsWith("/pi-ez-model-auth")));
});

test("workers replace auth.json with a link to the shared model login", async () => {
  const { linkModelAuth } = await import("../server/index.js");
  const dir = mkdtempSync(path.join(tmpdir(), "model-auth-"));
  const target = path.join(dir, "shared.json");
  writeFileSync(target, '{"a":1}');
  writeFileSync(path.join(dir, "auth.json"), "{}");
  const env = { PI_WEB_MODEL_AUTH_FILE: target, PI_CODING_AGENT_DIR: dir };
  linkModelAuth(env);
  linkModelAuth(env);
  assert.equal(readlinkSync(path.join(dir, "auth.json")), target);
  assert.equal(readFileSync(path.join(dir, "auth.json"), "utf8"), '{"a":1}');
});

test("web refreshes OAuth at 30 minutes and republishes model logins only on change", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "model-push-"));
  const authPath = path.join(dir, "auth.json");
  writeFileSync(authPath, '{"v":1}');
  const refreshed = [];
  const runtime = {
    listCredentials: async () => [{ providerId: "anthropic", type: "oauth" }, { providerId: "k", type: "api_key" }],
    getAuth: async (id, opts) => { refreshed.push([id, opts.minOAuthValidityMs]); },
  };
  const puts = [];
  const fetchImpl = async (url, init) => { puts.push([url, init.body]); return new Response("{}", { status: 200 }); };
  const remote = createRemoteWorkspaces({ url: "http://w", token: TOKEN, sup: { _modelRuntime: async () => runtime }, modelAuthPath: authPath, fetchImpl, modelAuthSyncMs: 0 });
  await remote.pushModelAuth();
  await remote.pushModelAuth();
  writeFileSync(authPath, '{"v":2}');
  await remote.pushModelAuth();
  assert.deepEqual(refreshed[0], ["anthropic", 30 * 60_000]);
  assert.ok(refreshed.every(([id]) => id === "anthropic"));
  assert.deepEqual(puts.map(([u, b]) => [u, b]), [["http://w/v1/model-auth", '{"v":1}'], ["http://w/v1/model-auth", '{"v":2}']]);
  remote.stop();
});

test("kubernetes remove waits until the pod and purged PVC are gone", async () => {
  let polls = 0;
  const kube = { request: async (method, p) => {
    if (method === "DELETE") return { status: 200, body: {} };
    if (p.includes("/pods?")) return { status: 200, body: { items: ++polls < 3 ? [{}] : [] } };
    return { status: polls < 3 ? 200 : 404, body: {} };
  } };
  await kubernetesProvider({ kube, config: kubernetesConfig({}), removePollMs: 1 }).remove("x", { purge: true });
  assert.equal(polls, 3);
  const stuck = { request: async (m, p) => m === "DELETE" ? { status: 200 } : { status: 200, body: { items: p.includes("/pods?") ? [{}] : [] } } };
  await assert.rejects(kubernetesProvider({ kube: stuck, config: kubernetesConfig({}), removeTimeoutMs: 5, removePollMs: 1 }).remove("x"), { code: "workspace_remove_timeout" });
});

function fakeLifecycleProvider(workerPort) {
  const ws = { name: "app", repository: "o/app", state: "sleeping", pinned: false };
  const calls = [];
  return {
    ws, calls,
    list: async () => [{ ...ws }],
    upstream: () => `http://127.0.0.1:${workerPort}`,
    scale: async (_name, n) => { calls.push(["scale", n]); ws.state = n ? "running" : "sleeping"; },
    setPinned: async (_name, pinned) => { calls.push(["pin", pinned]); ws.pinned = pinned; },
  };
}

test("passive calls never wake a sleeping worker; user calls wake it", async () => {
  const worker = await listen((req, res) => res.end(JSON.stringify({ ok: true, path: req.url, busy: false })));
  const provider = fakeLifecycleProvider(worker.address().port);
  const lifecycle = createLifecycle({ provider, idleMs: 0, pollMs: 5, cacheMs: 0, log: () => {} });
  const app = createWorkspaced({ provider, token: TOKEN, lifecycle });
  try {
    for (const p of ["/api/events", "/api/state", "/api/health"]) {
      const res = await app.request(`/v1/workspaces/app${p}`, { headers: auth });
      assert.equal(res.status, 503, p);
      assert.equal((await res.json()).error, "workspace_sleeping");
    }
    assert.deepEqual(provider.calls, [], "no scale from passive calls");
    const res = await app.request("/v1/workspaces/app/api/sessions/s1/message", { method: "POST", headers: auth, body: "{}" });
    assert.equal(res.status, 200);
    assert.deepEqual(provider.calls, [["scale", 1]]);
  } finally { worker.close(); }
});

test("a worker that does not come up in time answers 503 workspace_starting", async () => {
  const provider = fakeLifecycleProvider(1);
  provider.upstream = () => "http://127.0.0.1:1";
  const lifecycle = createLifecycle({ provider, idleMs: 0, pollMs: 5, wakeTimeoutMs: 30, cacheMs: 0, log: () => {} });
  const res = await createWorkspaced({ provider, token: TOKEN, lifecycle }).request("/v1/workspaces/app/api/files", { headers: auth });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "5");
  assert.equal((await res.json()).error, "workspace_starting");
});

test("sweeper sleeps idle workers, but not pinned, busy, or recently used ones", async () => {
  let busy = false;
  const worker = await listen((_req, res) => res.end(JSON.stringify({ ok: true, busy })));
  const provider = fakeLifecycleProvider(worker.address().port);
  provider.ws.state = "running";
  let clock = 0;
  const lifecycle = createLifecycle({ provider, idleMs: 1000, sweepMs: 0, cacheMs: 0, now: () => clock, log: () => {} });
  try {
    await lifecycle.sweep();
    clock = 500; await lifecycle.sweep();
    assert.deepEqual(provider.calls, [], "recently seen");
    clock = 2000; provider.ws.pinned = true; await lifecycle.sweep();
    assert.deepEqual(provider.calls, [], "pinned");
    provider.ws.pinned = false; busy = true; await lifecycle.sweep();
    assert.deepEqual(provider.calls, [], "agent turn running");
    clock = 4000; lifecycle.begin("app"); await lifecycle.sweep();
    assert.deepEqual(provider.calls, [], "request in flight");
    lifecycle.end("app"); busy = false; clock = 6000; await lifecycle.sweep();
    assert.deepEqual(provider.calls, [["scale", 0]]);
  } finally { worker.close(); }
});

test("sweeper upgrades outdated workers: sleeping now, awake only when idle", async () => {
  let busy = true;
  const worker = await listen((_req, res) => res.end(JSON.stringify({ ok: true, busy })));
  const provider = fakeLifecycleProvider(worker.address().port);
  provider.ws.outdated = true;
  provider.upgrade = async name => { provider.calls.push(["upgrade", name]); provider.ws.outdated = false; };
  const lifecycle = createLifecycle({ provider, sweepMs: 0, cacheMs: 0, log: () => {} });
  try {
    await lifecycle.sweep();
    assert.deepEqual(provider.calls, [["upgrade", "app"]], "sleeping");
    provider.calls.length = 0; provider.ws.outdated = true; provider.ws.state = "running";
    await lifecycle.sweep();
    assert.deepEqual(provider.calls, [], "busy");
    busy = false; await lifecycle.sweep();
    assert.deepEqual(provider.calls, [["upgrade", "app"]]);
  } finally { worker.close(); }
});

test("kubernetes scale and pin are merge patches on the Deployment", async () => {
  const seen = [];
  const kube = { request: async (method, p, body, type) => { seen.push([method, p, body, type]); return { status: 200, body: {} }; } };
  const provider = kubernetesProvider({ kube, config: kubernetesConfig({}) });
  await provider.scale("app", 0);
  await provider.setPinned("app", true);
  const patches = seen.filter(s => s[0] === "PATCH");
  assert.deepEqual(patches.map(s => [s[1].split("/").pop(), s[3]]), [["ws-app", "application/merge-patch+json"], ["ws-app", "application/merge-patch+json"]]);
  assert.deepEqual(patches[0][2], { spec: { replicas: 0 } });
  assert.deepEqual(patches[1][2], { metadata: { annotations: { "pi-ez.dev/keep-awake": "true" } } });
  assert.equal(deploymentState({ spec: { replicas: 0 } }), "sleeping");
  assert.equal(deploymentState({ spec: { replicas: 1 }, status: {} }), "starting");
  assert.equal(deploymentState({ spec: { replicas: 1 }, status: { readyReplicas: 1 } }), "running");
  const d = deploymentManifest({ name: "app", repository: "o/app", image: "img" });
  assert.equal(d.spec.template.spec.enableServiceLinks, false);
  assert.equal(d.spec.template.spec.containers[0].readinessProbe.periodSeconds, 1);
  await provider.upgrade("app");
  const up = seen.at(-1);
  assert.equal(up[3], "application/strategic-merge-patch+json", "merge by container name, keep env and probes");
  assert.deepEqual(up[2].spec.template.spec.containers, [{ name: d.spec.template.spec.containers[0].name, image: "ghcr.io/bry-guy/pi-ez-web:latest", resources: kubernetesConfig({}).resources }]);
});

test("workers get CPU/memory requests and a memory limit by default; empty env unsets", async () => {
  const defaults = kubernetesConfig({});
  assert.deepEqual(defaults.resources, { requests: { cpu: "250m", memory: "512Mi" }, limits: { memory: "4Gi" } });
  const unset = kubernetesConfig({ WORKSPACE_MEMORY_LIMIT: "", WORKSPACE_CPU_REQUEST: "1", WORKSPACE_CPU_LIMIT: "2" });
  assert.deepEqual(unset.resources, { requests: { cpu: "1", memory: "512Mi" }, limits: { cpu: "2" } });
  const posts = [];
  const kube = { request: async (method, p, body) => { if (method === "POST") posts.push(body); return { status: method === "POST" ? 201 : 404, body: {} }; } };
  await kubernetesProvider({ kube, config: defaults }).create({ name: "app", repository: "o/app" });
  const deployment = posts.find(b => b.kind === "Deployment");
  assert.deepEqual(deployment.spec.template.spec.containers[0].resources, defaults.resources);
  const kubeWithItems = { request: async () => ({ status: 200, body: { items: [{ metadata: { labels: { "pi-ez.dev/workspace": "app" }, annotations: {} }, spec: { replicas: 1, template: { spec: { containers: [{ image: "x", resources: defaults.resources }] } } }, status: {} }] } }) };
  assert.deepEqual((await kubernetesProvider({ kube: kubeWithItems, config: defaults }).list())[0].resources, defaults.resources);
});

test("web keeps sleeping projects in the sidebar from a persisted snapshot", async () => {
  let state = "running";
  const worker = await listen((req, res) => {
    if (req.url === "/api/state") return res.end(JSON.stringify({ projects: [{ id: "p1", name: "app", sessions: [{ id: "s1" }] }] }));
    res.writeHead(200, { "content-type": "text/event-stream" });
    return undefined;
  });
  const provider = { list: async () => [{ name: "app", ready: state === "running", state, pinned: false }], upstream: () => `http://127.0.0.1:${worker.address().port}` };
  const daemon = serve({ fetch: createWorkspaced({ provider, token: TOKEN }).fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise(r => daemon.once("listening", r));
  const cachePath = path.join(mkdtempSync(path.join(tmpdir(), "pz-cache-")), "remote-projects.json");
  const url = `http://127.0.0.1:${daemon.address().port}`;
  const make = () => createRemoteWorkspaces({ url, token: TOKEN, hub: new EventHub(), cachePath, retryMs: 50, modelAuthSyncMs: 0 });
  const first = make();
  try {
    assert.deepEqual((await first.projects()).map(p => [p.id, p.workspaceState]), [["p1", "running"]]);
    first.stop();
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
    state = "sleeping";
    const restarted = make();
    try {
      assert.deepEqual((await restarted.projects()).map(p => [p.id, p.workspaceState, p.sessions.length]), [["p1", "sleeping", 1]]);
      assert.equal(await restarted.owner("session", "s1"), "app", "ownership survives a web restart");
    } finally { restarted.stop(); }
  } finally {
    first.stop();
    daemon.close();
    worker.closeAllConnections();
    worker.close();
  }
});

test("web renumbers worker transcript snapshots so live events still apply", async () => {
  const worker = await listen((req, res) => {
    if (req.url === "/api/state") return res.end(JSON.stringify({ projects: [{ id: "p1", name: "app", sessions: [{ id: "s1" }] }] }));
    if (req.url === "/api/sessions/s1/transcript") return res.end(JSON.stringify({ sessionId: "s1", seq: 901, records: [] }));
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const seq of [900, 901]) res.write(`data: ${JSON.stringify({ v: 1, seq, sessionId: "s1", type: "turn_start" })}\n\n`);
    return undefined;
  });
  const provider = { list: async () => [{ name: "app", ready: true, state: "running", pinned: false }], upstream: () => `http://127.0.0.1:${worker.address().port}` };
  const daemon = serve({ fetch: createWorkspaced({ provider, token: TOKEN }).fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise(r => daemon.once("listening", r));
  const hub = new EventHub();
  for (let i = 0; i < 3; i++) hub.emit("other", "noop");
  const remote = createRemoteWorkspaces({ url: `http://127.0.0.1:${daemon.address().port}`, token: TOKEN, hub, retryMs: 50, modelAuthSyncMs: 0 });
  try {
    await remote.projects();
    for (let i = 0; i < 200 && hub.currentSeq() < 6; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(hub.currentSeq(), 6, "3 others, the resync on connect, 2 worker events");
    const api = new Hono();
    registerRemoteRoutes(api, remote);
    const snap = await (await api.request("/sessions/s1/transcript")).json();
    assert.equal(snap.seq, 6, "worker seq 901 maps to web seq of that event, not 901");
  } finally {
    remote.stop();
    daemon.close();
    worker.closeAllConnections();
    worker.close();
  }
});

test("grants: repo-locked grants refuse other repositories, also on wake", async () => {
  const grants = parseGrants(JSON.stringify({
    default: { anyProject: true },
    operator: { repos: ["bry-guy/infra"], namespace: "pi-ez-operator", serviceAccount: "infra-operator", env: ["operator-env"], egress: "open" },
  }));
  assert.throws(() => parseGrants(JSON.stringify({ x: { anyProject: true } })), /default/);
  assert.throws(() => parseGrants(JSON.stringify({ default: { anyProject: true }, y: {} })), /anyProject or repos/);
  assert.equal(repoKey("https://github.com/Bry-Guy/infra.git"), "bry-guy/infra");
  assert.equal(repoKey("git@github.com:bry-guy/infra"), "bry-guy/infra");
  const created = [];
  let listed = [];
  const provider = { list: async () => listed, create: async w => created.push(w), scale: async () => "scaled", setGrant: async (_n, g) => created.push({ regrant: g.name }) };
  const app = createWorkspaced({ provider, grants, auth: "network" });
  const json = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await app.request("/v1/workspaces", json({ repository: "redis/redis", grant: "operator" }))).status, 403);
  assert.equal((await app.request("/v1/workspaces", json({ repository: "redis/redis", grant: "nope" }))).status, 400);
  assert.equal((await app.request("/v1/workspaces", json({ repository: "redis/redis" }))).status, 201);
  assert.equal(created[0].grant.name, "default");
  assert.equal((await app.request("/v1/workspaces", json({ repository: "https://github.com/bry-guy/infra", grant: "operator" }))).status, 201);
  assert.equal(created[1].grant.serviceAccount, "infra-operator");
  const offered = await (await app.request("/v1/grants?repository=redis/redis")).json();
  assert.deepEqual(offered.grants.map(g => g.name), ["default"]);
  listed = [{ name: "redis", repository: "redis/redis", grant: "default" }];
  const put = grant => app.request("/v1/workspaces/redis/grant", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant }) });
  assert.equal((await put("operator")).status, 403);
  assert.equal((await put("default")).status, 200);
  // A worker whose grant no longer allows its repo cannot be woken.
  const guarded = withGrantCheck(provider, grants);
  listed = [{ name: "redis", repository: "redis/redis", grant: "operator" }];
  await assert.rejects(guarded.scale("redis", 1), { code: "grant_not_allowed" });
  assert.equal(await guarded.scale("redis", 0), "scaled");
});

test("grants: manifests and the kubernetes provider honour namespace, SA, env and egress", async () => {
  const grant = parseGrants(JSON.stringify({ default: { anyProject: true }, operator: { repos: ["o/infra"], namespace: "ops", serviceAccount: "op", env: ["op-env"], egress: "open" } })).operator;
  const d = deploymentManifest({ name: "infra", repository: "o/infra", image: "img", grant });
  const pod = d.spec.template;
  assert.equal(d.metadata.annotations["pi-ez.dev/grant"], "operator");
  assert.equal(pod.metadata.labels["pi-ez.dev/egress"], "open");
  assert.equal(pod.spec.serviceAccountName, "op");
  assert.deepEqual(pod.spec.containers[0].envFrom, [{ secretRef: { name: "op-env", optional: true } }]);
  const plain = deploymentManifest({ name: "r", repository: "r/r", image: "img" }).spec.template;
  assert.equal(plain.spec.automountServiceAccountToken, false);
  assert.equal(plain.metadata.labels["pi-ez.dev/egress"], undefined);
  const posts = [];
  const kube = { request: async (method, p, body) => {
    if (method === "POST") { posts.push(p); return { status: 201, body: {} }; }
    if (method === "GET" && p.includes("?")) return { status: 200, body: { items: p.includes("/namespaces/ops/") ? [{ metadata: { labels: { "pi-ez.dev/workspace": "infra" }, annotations: { "pi-ez.dev/repository": "o/infra", "pi-ez.dev/grant": "operator" } }, spec: { replicas: 1 }, status: {} }] : [] } };
    return { status: 404, body: {} };
  } };
  const provider = kubernetesProvider({ kube, config: kubernetesConfig({}), grants: { operator: grant } });
  await provider.create({ name: "infra", repository: "o/infra", grant });
  assert.ok(posts.every(p => p.includes("/namespaces/ops/")), posts.join());
  const [w] = await provider.list();
  assert.equal(w.grant, "operator");
  assert.equal(provider.upstream("infra"), "http://ws-infra.ops.svc.cluster.local:3141");
});

test("waking past the limit sleeps the least recently used idle worker first", async () => {
  const worker = await listen((_req, res) => res.end(JSON.stringify({ ok: true, busy: false })));
  const states = { a: "running", b: "running", c: "sleeping" };
  const pinned = {};
  const calls = [];
  const provider = {
    list: async () => Object.entries(states).map(([name, state]) => ({ name, state, pinned: !!pinned[name] })),
    upstream: () => `http://127.0.0.1:${worker.address().port}`,
    scale: async (name, n) => { calls.push([name, n]); states[name] = n ? "running" : "sleeping"; },
  };
  let clock = 0;
  const lifecycle = createLifecycle({ provider, maxAwake: 2, sweepMs: 0, pollMs: 1, cacheMs: 0, now: () => clock, log: () => {} });
  try {
    await lifecycle.refresh();
    clock = 10; lifecycle.touch("a"); clock = 20; lifecycle.touch("b");
    assert.equal(await lifecycle.ensureAwake("c"), true);
    assert.deepEqual(calls, [["a", 0], ["c", 1]], "a was used least recently");
    pinned.b = true; states.a = "running"; clock = 30; lifecycle.touch("c"); clock = 40; lifecycle.touch("a");
    await lifecycle.sweep();
    assert.deepEqual(calls.at(-1), ["c", 0], "pinned b is never chosen");
  } finally { worker.close(); }
});

test("a slow worker does not hold up the project list; its snapshot shows instead", async () => {
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith("/v1/workspaces")) return new Response(JSON.stringify({ workspaces: [{ name: "slow", state: "running" }] }));
    if (url.includes("/events")) return new Promise(() => {});
    return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason)));
  };
  const remote = createRemoteWorkspaces({ url: "http://w", token: TOKEN, hub: { emit() {} }, fetchImpl, stateTimeoutMs: 50, retryMs: 60_000 });
  const t0 = Date.now();
  const projects = await remote.projects();
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(projects[0].pending, true);
  remote.close?.();
});

test("usage: quantities parse, metrics-server pods sum per worker, and missing metrics read as unavailable", async () => {
  assert.deepEqual([quantity("250m"), quantity("512Mi"), quantity("1"), quantity("bogus")], [0.25, 512 * 2 ** 20, 1, null]);
  assert.ok(Math.abs(quantity("123456789n") - 0.123456789) < 1e-12);
  let calls = 0;
  const metrics = { status: 200, body: { items: [
    { metadata: { labels: { "pi-ez.dev/workspace": "app" } }, containers: [{ usage: { cpu: "120m", memory: "100Mi" } }, { usage: { cpu: "30m", memory: "1Mi" } }] },
    { metadata: { labels: {} }, containers: [{ usage: { cpu: "9m", memory: "9Mi" } }] },
  ] } };
  const kube = { request: async (method, p) => { calls++; assert.match(p, /^\/apis\/metrics\.k8s\.io\/v1beta1\/namespaces\/pi-workspaced\/pods\?labelSelector=/); return metrics; } };
  const provider = kubernetesProvider({ kube, config: kubernetesConfig({}) });
  assert.deepEqual(await provider.usage(), { app: { cpuMillicores: 150, memoryBytes: 101 * 2 ** 20 } });
  assert.deepEqual(await provider.usage(), { app: { cpuMillicores: 150, memoryBytes: 101 * 2 ** 20 } });
  assert.equal(calls, 1, "cached briefly");
  const forbidden = kubernetesProvider({ kube: { request: async () => ({ status: 403, body: {} }) }, config: kubernetesConfig({}) });
  assert.equal(await forbidden.usage(), null);
  const hung = kubernetesProvider({ kube: { request: () => new Promise(() => {}) }, config: kubernetesConfig({}) });
  assert.equal(await hung.usage(), null, "a stalled metrics API gives up quickly");
});

// The local provider reads usage from ps; minimal containers ship without it.
const hasPs = (await import("node:child_process")).spawnSync("ps", ["-p", String(process.pid)]).status === 0;
test("usage: local workers report their child's memory and CPU from ps", { skip: !hasPs && "ps is not installed" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspaced-usage-"));
  const { spawn } = await import("node:child_process");
  const provider = localProvider({ root, spawnImpl: () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]) });
  try {
    await provider.create({ name: "app", repository: "o/app" });
    // A child is near-empty for a moment after fork; wait for node to load.
    let usage;
    for (let i = 0; i < 100 && !(usage?.app?.memoryBytes > 1024 * 1024); i++) { await new Promise(r => setTimeout(r, 50)); usage = await provider.usage(); }
    assert.ok(usage.app.memoryBytes > 1024 * 1024, JSON.stringify(usage));
    assert.equal(typeof usage.app.cpuMillicores, "number");
  } finally { provider.stop(); }
});

test("the detailed list adds activity, last use and usage; usage is null without metrics", async () => {
  const provider = { list: async () => [{ name: "app", state: "running", pinned: false }], usage: async () => null, upstream: () => "http://127.0.0.1:1" };
  const lifecycle = createLifecycle({ provider, sweepMs: 0, cacheMs: 0, log: () => {} });
  lifecycle.touch("app");
  const app = createWorkspaced({ provider, token: TOKEN, lifecycle });
  const plain = await (await app.request("/v1/workspaces", { headers: auth })).json();
  assert.equal(plain.workspaces[0].busy, undefined);
  const detail = await (await app.request("/v1/workspaces?detail=1", { headers: auth })).json();
  assert.deepEqual(detail, { workspaces: [{ name: "app", state: "running", pinned: false, lastUsed: detail.workspaces[0].lastUsed, busy: false, usage: null }], usageAvailable: false });
  assert.equal(typeof detail.workspaces[0].lastUsed, "number");
});

test("sleep refuses a busy worker unless forced", async () => {
  let busy = true;
  const worker = await listen((_req, res) => res.end(JSON.stringify({ ok: true, busy })));
  const provider = fakeLifecycleProvider(worker.address().port);
  provider.ws.state = "running";
  const lifecycle = createLifecycle({ provider, sweepMs: 0, cacheMs: 0, log: () => {} });
  const app = createWorkspaced({ provider, token: TOKEN, lifecycle });
  const sleep = q => app.request(`/v1/workspaces/app/sleep${q}`, { method: "POST", headers: auth });
  try {
    const refused = await sleep("");
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error, "workspace_busy");
    assert.deepEqual(provider.calls, [], "nothing slept");
    assert.equal((await sleep("?force=1")).status, 200);
    assert.deepEqual(provider.calls, [["scale", 0]]);
    provider.ws.state = "running"; busy = false;
    assert.equal((await sleep("")).status, 200, "idle workers sleep without force");
  } finally { worker.close(); }
});

test("restart and reset refuse busy or sleeping workers; reset needs its name as confirm", async () => {
  let busy = false;
  const worker = await listen((_req, res) => res.end(JSON.stringify({ ok: true, busy })));
  const provider = fakeLifecycleProvider(worker.address().port);
  provider.restart = async name => provider.calls.push(["restart", name]);
  provider.reset = async name => provider.calls.push(["reset", name]);
  const lifecycle = createLifecycle({ provider, sweepMs: 0, cacheMs: -1, log: () => {} });
  const app = createWorkspaced({ provider, token: TOKEN, lifecycle });
  const post = (p, body, q = "") => app.request(`/v1/workspaces/app/${p}${q}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await post("restart")).status, 409, "asleep");
    assert.equal((await post("reset", { confirm: "app" })).status, 409, "asleep");
    assert.deepEqual(provider.calls, []);
    provider.ws.state = "running";
    busy = true;
    const refused = await post("restart");
    assert.equal((await refused.json()).error, "workspace_busy");
    assert.equal((await post("reset", { confirm: "app" }, "?force=1")).status, 200, "force");
    busy = false;
    assert.equal((await post("reset", { confirm: "nope" })).status, 400);
    assert.equal((await post("reset")).status, 400);
    assert.equal((await post("restart")).status, 200);
    assert.deepEqual(provider.calls, [["reset", "app"], ["restart", "app"]]);
  } finally { worker.close(); }
});

test("reload proxies to the worker, passes its 409 through, and never wakes a sleeping worker", async () => {
  const seen = [];
  const worker = await listen((req, res) => {
    seen.push([req.method, req.url]);
    res.statusCode = seen.length === 1 ? 200 : 409;
    res.end(JSON.stringify(seen.length === 1 ? { ok: true } : { error: "pi_configuration_busy" }));
  });
  const provider = fakeLifecycleProvider(worker.address().port);
  const lifecycle = createLifecycle({ provider, sweepMs: 0, cacheMs: -1, log: () => {} });
  const app = createWorkspaced({ provider, token: TOKEN, lifecycle });
  try {
    const asleep = await app.request("/v1/workspaces/app/reload", { method: "POST", headers: auth });
    assert.equal(asleep.status, 409);
    assert.equal((await asleep.json()).error, "asleep");
    assert.deepEqual(provider.calls, [], "no wake");
    provider.ws.state = "running";
    const ok = await app.request("/v1/workspaces/app/reload", { method: "POST", headers: auth });
    assert.equal(ok.status, 200);
    const busy = await app.request("/v1/workspaces/app/reload", { method: "POST", headers: auth });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).error, "pi_configuration_busy");
    assert.deepEqual(seen, [["POST", "/api/pi/reload"], ["POST", "/api/pi/reload"]]);
  } finally { worker.close(); }
});

test("kubernetes restart patches the pod template; reset scales down, drops the PVC, recreates it, scales up", async () => {
  const seen = [];
  let pvcExists = true;
  const deployment = { metadata: { annotations: { "pi-ez.dev/repository": "o/app" } }, spec: { replicas: 1, template: { spec: { containers: [{ image: "img" }] } } } };
  const kube = { request: async (method, p, body, type) => {
    seen.push([method, p, body, type]);
    if (method === "GET" && p.endsWith("/deployments/ws-app")) return { status: 200, body: deployment };
    if (method === "GET" && p.includes("/pods?")) return { status: 200, body: { items: [] } };
    if (method === "GET" && p.endsWith("/persistentvolumeclaims/ws-app")) return { status: pvcExists ? 200 : 404, body: {} };
    if (method === "DELETE" && p.endsWith("/persistentvolumeclaims/ws-app")) { pvcExists = false; return { status: 200, body: {} }; }
    if (method === "POST") { pvcExists = true; return { status: 201, body: {} }; }
    return { status: 200, body: {} };
  } };
  const provider = kubernetesProvider({ kube, config: kubernetesConfig({}), removePollMs: 1 });
  await provider.restart("app");
  const restart = seen.filter(s => s[0] === "PATCH").at(-1);
  assert.ok(restart[2].spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]);
  assert.equal(restart[2].spec.replicas, undefined, "stays awake");
  seen.length = 0;
  await provider.reset("app");
  const ops = seen.filter(s => s[0] !== "GET").map(s => s[0] === "PATCH" ? `PATCH ${s[2].spec.replicas}` : `${s[0]} ${s[1].split("/").at(-1)}`);
  assert.deepEqual(ops, ["PATCH 0", "DELETE ws-app", "POST persistentvolumeclaims", "PATCH 1"]);
  assert.deepEqual(seen.find(s => s[0] === "POST")[2].spec, { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "20Gi" } } });
});

test("local restart respawns the worker; reset also wipes its data", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "workspaced-reset-"));
  const spawned = [];
  const spawnImpl = (_bin, _args, opts) => { const child = new EventEmitter(); child.exitCode = null; child.kill = () => { child.exitCode = 0; }; spawned.push(child); return child; };
  const provider = localProvider({ root, spawnImpl });
  await provider.create({ name: "app", repository: "o/app" });
  const dataFile = path.join(root, "app", "marker");
  mkdirSync(path.join(root, "app"));
  writeFileSync(dataFile, "x");
  await provider.restart("app");
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].exitCode, 0, "old worker stopped");
  assert.equal(await provider.list().then(l => l[0].state), "running");
  await provider.reset("app");
  assert.equal(spawned.length, 3);
  assert.equal(existsSync(dataFile), false, "data wiped");
  assert.equal(await provider.list().then(l => l[0].state), "running");
});

test("web lists workspaces with activity, usage and grant names, and forwards restart, reset and reload", async () => {
  const seen = [];
  const worker = await listen((req, res) => { seen.push(req.url); res.end(JSON.stringify({ ok: true })); });
  const ws = { name: "app", repository: "o/app", grant: "operator", state: "running", ready: true, pinned: true, resources: { requests: { cpu: "250m" } } };
  const calls = [];
  const provider = {
    list: async () => [{ ...ws }],
    usage: async () => ({ app: { cpuMillicores: 5, memoryBytes: 1024 } }),
    upstream: () => `http://127.0.0.1:${worker.address().port}`,
    restart: async n => calls.push(["restart", n]),
    reset: async n => calls.push(["reset", n]),
  };
  const grants = parseGrants(JSON.stringify({ default: { anyProject: true }, operator: { repos: ["o/app"], namespace: "ops", serviceAccount: "op", env: ["op-env"], egress: "open" } }));
  const lifecycle = createLifecycle({ provider, sweepMs: 0, cacheMs: 0, log: () => {} });
  const daemon = createWorkspaced({ provider, grants, token: TOKEN, lifecycle });
  const remote = createRemoteWorkspaces({ url: "http://workspaced", token: TOKEN, hub: { emit() {} }, fetchImpl: (u, i) => daemon.fetch(new Request(u, i)), modelAuthSyncMs: 0 });
  const api = new Hono();
  registerRemoteRoutes(api, remote);
  try {
    const listed = await (await api.request("/remote-workspaces")).json();
    assert.equal(listed.usageAvailable, true);
    assert.deepEqual(listed.workspaces, [{
      name: "app", repository: "o/app", state: "running", ready: true, keepAwake: true, busy: false, lastUsed: listed.workspaces[0].lastUsed,
      resources: { requests: { cpu: "250m" } }, usage: { cpuMillicores: 5, memoryBytes: 1024 },
      grant: { name: "operator", description: "", namespace: "ops", serviceAccount: "op", egress: "open", env: ["op-env"] },
    }]);
    assert.equal((await api.request("/remote-workspaces/app/reset", json({ confirm: "nope" }))).status, 400);
    assert.deepEqual(await (await api.request("/remote-workspaces/app/reset", json({ confirm: "app" }))).json(), { ok: true });
    assert.equal((await api.request("/remote-workspaces/app/restart", json({}))).status, 200);
    assert.equal((await api.request("/remote-workspaces/app/reload", json({}))).status, 200);
    assert.deepEqual(await (await api.request("/remote-workspaces/reload", json({}))).json(), { results: [{ name: "app", ok: true, status: 200, error: null }] });
    assert.deepEqual(calls, [["reset", "app"], ["restart", "app"]]);
    assert.deepEqual(seen.filter(u => u === "/api/pi/reload"), ["/api/pi/reload", "/api/pi/reload"]);
  } finally {
    remote.stop();
    lifecycle.stop();
    worker.close();
  }
});

const pod = (status, created = "2026-01-01T00:00:00Z") => ({ metadata: { creationTimestamp: created }, status });
const T0 = Date.parse("2026-01-01T00:00:00Z");

test("podProblem names OOM, crash loops, scheduling and stuck starts", () => {
  const running = { name: "workspace", restartCount: 0, state: { running: {} } };
  assert.equal(podProblem(pod({ phase: "Running", containerStatuses: [running] }), T0), null);

  const oomOnce = podProblem(pod({ phase: "Running", containerStatuses: [{ ...running, restartCount: 1, lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } } }] }), T0);
  assert.equal(oomOnce.reason, "OOMKilled"); assert.equal(oomOnce.fatal, false); assert.equal(oomOnce.restarts, 1);

  // Some runtimes report an OOM as exit 137 with reason Error.
  const vmKilled = podProblem(pod({ phase: "Running", containerStatuses: [{ ...running, restartCount: 2, lastState: { terminated: { reason: "Error", exitCode: 137 } } }] }), T0);
  assert.equal(vmKilled.reason, "OOMKilled");

  const loop = podProblem(pod({ phase: "Running", containerStatuses: [{ name: "workspace", restartCount: 5, state: { waiting: { reason: "CrashLoopBackOff" } }, lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } } }] }), T0);
  assert.deepEqual([loop.reason, loop.fatal], ["OOMKilled", true]);
  assert.match(loop.message, /out of memory/);

  // Pod overhead can make a pod unschedulable on a full node.
  const unsched = podProblem(pod({ phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/3 nodes: Insufficient memory" }] }), T0);
  assert.deepEqual([unsched.reason, unsched.fatal], ["Unschedulable", true]);

  // A pod that never starts leaves its container waiting in ContainerCreating.
  const creating = { phase: "Pending", containerStatuses: [{ name: "workspace", restartCount: 0, state: { waiting: { reason: "ContainerCreating" } } }] };
  assert.equal(podProblem(pod(creating), T0 + 30_000), null, "still within normal boot time");
  assert.equal(podProblem(pod(creating), T0 + STUCK_START_MS + 1).reason, "StuckStarting");

  assert.equal(podProblem(pod({ phase: "Failed", reason: "Evicted", message: "low memory" }), T0).reason, "Evicted");
  assert.equal(podProblem(pod({ phase: "Running", containerStatuses: [{ name: "workspace", state: { waiting: { reason: "ImagePullBackOff" } } }] }), T0).fatal, true);
});

test("kubernetes list reports the newest pod's problem, not for sleeping workers; restart rolls a new pod", async () => {
  const calls = [];
  const deploy = (name, replicas) => ({ metadata: { name: `ws-${name}`, labels: { "pi-ez.dev/workspace": name }, annotations: {} }, spec: { replicas }, status: {} });
  const kube = { request: async (method, p, body) => {
    calls.push([method, p, body]);
    if (method === "GET" && p.includes("/deployments?")) return { status: 200, body: { items: [deploy("a", 1), deploy("b", 0)] } };
    if (method === "GET" && p.includes("/pods?")) return { status: 200, body: { items: [
      { metadata: { labels: { "pi-ez.dev/workspace": "a" }, creationTimestamp: "2026-01-01T00:00:00Z" }, status: { containerStatuses: [{ restartCount: 3, state: { waiting: { reason: "CrashLoopBackOff" } }, lastState: { terminated: { reason: "Error", exitCode: 1 } } }] } },
      { metadata: { labels: { "pi-ez.dev/workspace": "b" }, creationTimestamp: "2026-01-01T00:00:00Z" }, status: { phase: "Failed", reason: "Evicted" } },
    ] } };
    if (method === "GET") return { status: 200, body: deploy("a", 1) };
    return { status: 200, body: {} };
  } };
  const provider = kubernetesProvider({ kube });
  const [a, b] = await provider.list();
  assert.equal(a.problem.reason, "CrashLoopBackOff"); assert.equal(a.problem.fatal, true);
  assert.equal(b.problem, null);
  await provider.restart("a");
  const patchBody = calls.find(c => c[0] === "PATCH")[2];
  assert.equal(patchBody.spec.replicas, undefined, "stays awake");
  assert.ok(patchBody.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]);
});

test("worker manifests give a slow first boot time, then restart a hung worker", () => {
  const d = deploymentManifest({ name: "x", repository: "r", image: "i", grant: { name: "default" } });
  const c = d.spec.template.spec.containers[0];
  assert.ok(c.startupProbe.periodSeconds * c.startupProbe.failureThreshold >= 300);
  assert.equal(c.livenessProbe.httpGet.path, "/api/health");
});

test("local provider restarts a crashed worker, stops after repeated crashes, and restart clears it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ws-crash-"));
  const children = [];
  const spawnImpl = () => { const child = new EventEmitter(); child.exitCode = null; child.kill = () => { child.exitCode = 0; child.emit("exit", 0, "SIGTERM"); }; children.push(child); return child; };
  const provider = localProvider({ root, spawnImpl, maxRestarts: 2, restartDelayMs: 1, log: () => {} });
  await provider.create({ name: "app", repository: "https://x/app.git", grant: { name: "default" } });
  const crash = () => { const c = children.at(-1); c.exitCode = 137; c.emit("exit", null, "SIGKILL"); };
  const settle = () => new Promise(r => setTimeout(r, 30));

  crash(); await settle();
  let [w] = await provider.list();
  assert.equal(w.state, "running", "restarted");
  assert.equal(w.problem.reason, "OOMKilled"); assert.equal(w.problem.fatal, false);
  assert.equal(children.length, 2);

  crash(); await settle(); crash(); await settle();
  [w] = await provider.list();
  assert.deepEqual([w.state, w.problem.fatal], ["failed", true]);
  assert.equal(children.length, 3, "gave up after maxRestarts");

  await provider.restart("app");
  [w] = await provider.list();
  assert.deepEqual([w.state, w.problem], ["running", null]);

  // Sleeping on purpose is not a crash.
  await provider.scale("app", 0); await settle();
  [w] = await provider.list();
  assert.deepEqual([w.state, w.problem], ["sleeping", null]);
  provider.stop();
});

test("wakes run one at a time; a worker that cannot start answers 503 workspace_failed fast", async () => {
  let active = 0, peak = 0;
  const worker = await listen((_req, res) => res.end(JSON.stringify({ ok: true })));
  const states = { a: "sleeping", b: "sleeping", bad: "sleeping" };
  const problems = {};
  const provider = {
    list: async () => Object.entries(states).map(([name, state]) => ({ name, state, pinned: false, problem: problems[name] || null })),
    upstream: name => name === "bad" ? "http://127.0.0.1:1" : `http://127.0.0.1:${worker.address().port}`,
    scale: async (name, n) => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 20));
      states[name] = n ? "running" : "sleeping"; active--;
      if (name === "bad" && n) { states.bad = "failed"; problems.bad = { reason: "Unschedulable", message: "No node can run it.", fatal: true }; }
    },
  };
  const lifecycle = createLifecycle({ provider, maxAwake: 0, pollMs: 5, wakeTimeoutMs: 5_000, cacheMs: 0, log: () => {} });
  try {
    assert.deepEqual(await Promise.all([lifecycle.ensureAwake("a"), lifecycle.ensureAwake("b")]), [true, true]);
    assert.equal(peak, 1);
    const t0 = Date.now();
    const res = await createWorkspaced({ provider, token: TOKEN, lifecycle }).request("/v1/workspaces/bad/api/files", { headers: auth });
    assert.ok(Date.now() - t0 < 2_000, "did not wait out the wake timeout");
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, "workspace_failed"); assert.equal(body.problem.reason, "Unschedulable");
  } finally { worker.close(); }
});

test("ending a forked session routes to its worker and drops it from the cached snapshot; delete forgets the worker", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remote-close-"));
  const cachePath = path.join(dir, "remote-projects.json");
  const fork = { id: "child", title: "Fork", children: [] };
  writeFileSync(cachePath, JSON.stringify({ app: [{ id: "p1", name: "app", sessions: [{ id: "root", title: "Root", children: [fork] }] }] }));
  const calls = [];
  // The worker is asleep: state comes only from the snapshot, actions are forwarded.
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url}`);
    if (url === "http://w/v1/workspaces") return Response.json({ workspaces: [{ name: "app", state: "sleeping" }] });
    if (url.endsWith("/sessions/child/close")) return Response.json({ ok: true });
    if (init.method === "DELETE") return Response.json({ ok: true });
    return new Response("{}", { status: 404 });
  };
  const remote = createRemoteWorkspaces({ url: "http://w", token: TOKEN, hub: new EventHub(), fetchImpl, cachePath, modelAuthSyncMs: 0 });
  const api = new Hono();
  registerRemoteRoutes(api, remote);
  api.post("/sessions/:id/close", c => c.json({ error: "reached web's own route" }, 500));
  try {
    assert.equal(await remote.owner("session", "child"), "app", "nested forks are owned by their worker");
    const closed = await api.request("/sessions/child/close", { method: "POST", body: "{}" });
    assert.equal(closed.status, 200);
    const sessions = (await remote.projects())[0].sessions;
    assert.deepEqual(sessions[0].children, [], "the ended fork is gone from the snapshot");

    const removed = await api.request("/remote-workspaces/app?purge=1", { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.ok(calls.includes("DELETE http://w/v1/workspaces/app?purge=1"));
    assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).app, undefined, "its snapshot is dropped");
  } finally { remote.stop(); }
});

test("a pi project's worker is named after it and serves PI_PROJECTS_DIR from its volume", async () => {
  const created = [];
  const app = createWorkspaced({ provider: { list: async () => [], create: async w => { created.push(w); } }, token: TOKEN });
  const res = await app.request("/v1/workspaces", json({ project: "eco" }));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { name: "eco" });
  assert.equal(created[0].repository, "project:eco");
  assert.equal((await app.request("/v1/workspaces", json({ project: "Bad Name" }))).status, 400);
  const env = Object.fromEntries(deploymentManifest({ name: "eco", repository: "project:eco", image: "img" }).spec.template.spec.containers[0].env.map(e => [e.name, e.value]));
  assert.equal(env.PI_PROJECTS_DIR, "/data/projects");
  assert.equal(env.PI_WEB_PROJECT, "eco");
  assert.equal(env.PI_WEB_REPOS_ROOT, "/data/projects/eco/repos");
  const plain = Object.fromEntries(deploymentManifest({ name: "x", repository: "a/x", image: "img" }).spec.template.spec.containers[0].env.map(e => [e.name, e.value]));
  assert.equal(plain.PI_PROJECTS_DIR, undefined);
});
