import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeCert } from "./helpers/certs.js";
import YAML from "yaml";
import { createWorkspaced } from "../workspaced/index.js";
import { createLifecycle } from "../workspaced/lifecycle.js";
import { parseGrants } from "../workspaced/grants.js";
import { openshellConfig, openshellProvider, sandboxPolicy, withOpenShell } from "../workspaced/openshell.js";

const TOKEN = "secret-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const json = body => ({ method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
const GRANTS = parseGrants(JSON.stringify({
  default: { anyProject: true },
  sandboxed: { anyProject: true, provider: "openshell", egress: [
    { host: "pi-syncd.pi-sync.svc.cluster.local", port: 8080 },
    { host: "registry.npmjs.org", port: 443, allowEncodedSlash: true, binaries: ["/usr/local/bin/node", "/usr/bin/git"] },
  ] },
}));
const CONFIG = openshellConfig({ OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080/", OPENSHELL_BIN: "/opt/openshell", WORKSPACE_IMAGE: "img@sha256:abc" });

function fakeKube(routes = {}) {
  const calls = [];
  return { calls, request: async (method, p, body) => {
    calls.push([method, p, body]);
    return routes[`${method} ${p}`] || (method === "POST" ? { status: 201, body: {} } : { status: 404, body: {} });
  } };
}

const sandbox = (name, phase = "Ready", extra = {}) => ({
  id: `id-${name}`, name: `ws-${name}`, workspace: "default", phase,
  labels: { "pi-ez-managed-by": "pi-ez-workspaced", "pi-ez-workspace": name },
  annotations: { "pi-ez-grant": "sandboxed", "pi-ez-repository": `project:${name}`, "pi-ez-image": "img@sha256:abc", ...extra },
});

// A fake `openshell` CLI: records argv, serves `sandbox list -o json`, and acts on stop/start/delete.
function fakeCli(sandboxes = []) {
  const calls = [];
  const policies = [];
  const exec = async (bin, args, opts) => {
    calls.push(args);
    assert.equal(bin, "/opt/openshell");
    assert.equal(opts.env.OPENSHELL_GATEWAY_ENDPOINT, "http://127.0.0.1:8080");
    const [, verb, name] = args;
    const found = sandboxes.find(s => s.name === name);
    if (verb === "list") return { stdout: JSON.stringify({ sandboxes, next_page_token: "" }), stderr: "" };
    if (verb === "create") {
      policies.push(YAML.parse(readFileSync(args[args.indexOf("--policy") + 1], "utf8")));
      const labels = Object.fromEntries(args.flatMap((a, i) => a === "--label" ? [args[i + 1].split("=")] : []));
      const annotations = Object.fromEntries(args.flatMap((a, i) => a === "--annotation" ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : []));
      sandboxes.push({ name: args[args.indexOf("--name") + 1], phase: "Ready", labels, annotations });
    }
    if (verb === "stop") found.phase = "Stopped";
    if (verb === "start") found.phase = "Ready";
    if (verb === "delete") sandboxes.splice(sandboxes.indexOf(found), 1);
    if (verb === "fail") throw Object.assign(new Error("Command failed"), { stderr: "\x1b[31mError:\x1b[0m   × connect error: transport error\n" });
    return { stdout: "", stderr: "" };
  };
  return { exec, calls, policies, sandboxes };
}

// A primary (local/kubernetes-like) provider with one worker.
function fakePrimary(names = ["plain"]) {
  const calls = [];
  const ws = names.map(name => ({ name, repository: `o/${name}`, grant: "default", state: "running", ready: true, pinned: false }));
  return {
    calls,
    list: async () => ws.map(w => ({ ...w })),
    create: async args => { calls.push(["create", args.name]); ws.push({ name: args.name, repository: args.repository, grant: args.grant.name, state: "running" }); },
    scale: async (name, n) => { calls.push(["scale", name, n]); },
    remove: async name => { calls.push(["remove", name]); },
    setPinned: async name => { calls.push(["pin", name]); },
    upstream: name => `http://primary/${name}`,
    setGitHubAuth: async () => { calls.push(["github"]); },
    setModelAuth: async () => { calls.push(["model"]); },
  };
}

test("grants: provider openshell takes an egress list; other grants keep the label; bad shapes fail", () => {
  assert.equal(GRANTS.sandboxed.provider, "openshell");
  assert.deepEqual(GRANTS.sandboxed.egress[1], { host: "registry.npmjs.org", port: 443, binaries: ["/usr/local/bin/node", "/usr/bin/git"], allowEncodedSlash: true });
  assert.equal(GRANTS.default.provider, null);
  assert.equal(GRANTS.default.egress, null);
  assert.deepEqual(parseGrants(JSON.stringify({ default: { anyProject: true, provider: "openshell" } })).default.egress, [], "default deny");
  const bad = grant => () => parseGrants(JSON.stringify({ default: { anyProject: true }, g: { anyProject: true, ...grant } }));
  assert.throws(bad({ provider: "docker" }), /provider must be one of openshell/);
  assert.throws(bad({ egress: [{ host: "a.b", port: 1 }] }), /egress is not a valid label value/);
  assert.throws(bad({ provider: "openshell", egress: "open" }), /egress must be a list/);
  assert.throws(bad({ provider: "openshell", egress: [{ host: "a.b", port: 0 }] }), /port must be a port number/);
  assert.throws(bad({ provider: "openshell", egress: [{ host: "a b", port: 1 }] }), /host is not a host name/);
  assert.throws(bad({ provider: "openshell", egress: [{ host: "a.b", port: 1, binaries: ["node"] }] }), /absolute paths/);
  assert.throws(bad({ provider: "openshell", egress: [{ host: "a.b", port: 1, protocol: "tcp" }] }), /unknown fields protocol/);
  assert.throws(bad({ provider: "openshell", env: ["s"] }), /env is not supported/);
  assert.throws(bad({ provider: "openshell", serviceAccount: "sa" }), /serviceAccount is not supported/);
});

test("openshell is configured only by its gateway endpoint", () => {
  assert.equal(openshellConfig({}), null);
  assert.deepEqual({ ...CONFIG, image: undefined }, { endpoint: "http://127.0.0.1:8080", gateway: null, configHome: null, tlsDir: null, workspace: "default", bin: "/opt/openshell", namespace: "openshell", serviceDomain: "openshell.localhost", image: undefined, storage: "20Gi", storageClassName: null });
});

test("the policy is the worker base plus the grant's egress, default deny", () => {
  const base = sandboxPolicy(parseGrants("").default);
  assert.deepEqual(base.filesystem_policy.read_write, ["/tmp", "/dev/null", "/data"]);
  assert.ok(base.filesystem_policy.read_only.includes("/app"));
  assert.equal(base.network_policies, undefined);
  const rules = sandboxPolicy(GRANTS.sandboxed).network_policies;
  assert.deepEqual(rules["egress-1"], { name: "pi-syncd.pi-sync.svc.cluster.local:8080",
    endpoints: [{ host: "pi-syncd.pi-sync.svc.cluster.local", port: 8080, protocol: "rest", enforcement: "enforce", access: "full" }],
    binaries: [{ path: "/usr/local/bin/node" }] });
  assert.equal(rules["egress-2"].endpoints[0].allow_encoded_slash, true);
  assert.deepEqual(rules["egress-2"].binaries, [{ path: "/usr/local/bin/node" }, { path: "/usr/bin/git" }]);
});

test("openshell create makes a labelled PVC, then a sandbox with the worker's env, disk, port and policy", async () => {
  const cli = fakeCli();
  const kube = fakeKube();
  const provider = openshellProvider({ kube, config: CONFIG, exec: cli.exec });
  await provider.create({ name: "agent", repository: "project:agent", grant: GRANTS.sandboxed });
  const [post] = kube.calls.filter(c => c[0] === "POST");
  assert.equal(post[1], "/api/v1/namespaces/openshell/persistentvolumeclaims");
  assert.equal(post[2].metadata.name, "ws-agent");
  assert.equal(post[2].metadata.labels["openshell.ai/sandbox-attachable"], "true");
  assert.equal(post[2].metadata.labels["openshell.ai/sandbox-attachable-workspace"], "default");
  const args = cli.calls.find(a => a[1] === "create");
  const flag = f => args[args.indexOf(f) + 1];
  assert.deepEqual(args.slice(0, 4), ["sandbox", "create", "--name", "ws-agent"]);
  assert.equal(flag("--from"), "img@sha256:abc");
  assert.equal(flag("--expose"), "3141");
  assert.equal(flag("--restart-policy"), "on-failure", "a crashed worker comes back");
  assert.ok(args.includes("--detach") && args.includes("--no-tty"));
  assert.deepEqual(args.slice(args.indexOf("--")), ["--", "node", "/app/server/index.js"]);
  const env = args.flatMap((a, i) => a === "--env" ? [args[i + 1]] : []);
  for (const e of ["PORT=3141", "HOST=127.0.0.1", "HOME=/data/pi-ez-operator-home", "PI_WEB_PROJECT=agent", "PI_PROJECTS_DIR=/data/projects", "PI_SYNC_DEVICE_LABEL=web-agent"]) assert.ok(env.includes(e), e);
  assert.deepEqual(JSON.parse(flag("--driver-config-json")), { kubernetes: {
    volumes: [{ name: "data", persistent_volume_claim: { claim_name: "ws-agent", read_only: false } }],
    containers: { agent: { volume_mounts: [{ name: "data", mount_path: "/data", read_only: false }] } },
  } });
  assert.deepEqual(cli.policies[0], sandboxPolicy(GRANTS.sandboxed), "the policy file is the grant's policy");
  assert.deepEqual((await provider.list()).map(w => [w.name, w.provider, w.grant, w.repository, w.image, w.state]),
    [["agent", "openshell", "sandboxed", "project:agent", "img@sha256:abc", "running"]]);

  // Again: idempotent. A different repository: taken. An existing PVC is used as is.
  await provider.create({ name: "agent", repository: "project:agent", grant: GRANTS.sandboxed });
  assert.equal(cli.calls.filter(a => a[1] === "create").length, 1);
  await assert.rejects(provider.create({ name: "agent", repository: "o/other", grant: GRANTS.sandboxed }), { code: "workspace_name_taken" });
  const kept = fakeKube({ "GET /api/v1/namespaces/openshell/persistentvolumeclaims/ws-spike": { status: 200, body: {} } });
  await openshellProvider({ kube: kept, config: CONFIG, exec: fakeCli().exec }).create({ name: "spike", repository: "project:spike", grant: GRANTS.sandboxed });
  assert.ok(!kept.calls.some(c => c[0] === "POST"));
  await assert.rejects(provider.create({ name: "x", repository: "o/x", grant: GRANTS.sandboxed, score: { record: "{}" } }), { code: "score_unsupported" });
});

test("openshell scale stops and starts, restart is stop + start, remove keeps the disk unless purged", async () => {
  const cli = fakeCli([sandbox("agent")]);
  const kube = fakeKube({ "DELETE /api/v1/namespaces/openshell/persistentvolumeclaims/ws-agent": { status: 200, body: {} } });
  const provider = openshellProvider({ kube, config: CONFIG, exec: cli.exec, pollMs: 1 });
  const acts = () => cli.calls.filter(a => a[1] !== "list").map(a => a.slice(1).join(" "));
  await provider.scale("agent", 0);
  await provider.scale("agent", 0);
  assert.equal((await provider.list())[0].state, "sleeping");
  await provider.scale("agent", 1);
  await provider.restart("agent");
  assert.deepEqual(acts(), ["stop ws-agent", "start ws-agent", "stop ws-agent", "start ws-agent"]);
  await provider.setPinned("agent", true);
  assert.equal((await provider.list())[0].pinned, true);
  await provider.setGitHubAuth({ accessToken: "t" });
  await provider.setModelAuth("{}");
  assert.deepEqual(provider.upstream("agent"), { url: "http://127.0.0.1:8080", headers: { host: "default--ws-agent.openshell.localhost:8080" } });
  await provider.remove("agent", { purge: true });
  assert.equal(acts().at(-1), "delete ws-agent");
  assert.ok(kube.calls.some(([m, p]) => m === "DELETE" && p.endsWith("/persistentvolumeclaims/ws-agent")));
  await assert.rejects(provider.scale("agent", 1), { code: "no_such_workspace" });
  const failing = openshellProvider({ kube, config: CONFIG, exec: async (_b, args) => cli.exec(_b, ["sandbox", "fail", ...args.slice(2)], { env: { OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080" } }) });
  await assert.rejects(failing.list(), { code: "openshell_error", message: "openshell sandbox list failed: Error:   × connect error: transport error" });
});

test("workspaced routes each worker to its provider, merges lists, and keeps names unique", async () => {
  const cli = fakeCli([sandbox("agent")]);
  const primary = fakePrimary(["plain"]);
  const provider = withOpenShell(primary, openshellProvider({ kube: fakeKube(), config: CONFIG, exec: cli.exec }), { log: () => {}, refreshMs: 0 });
  await provider.refreshSandboxes();
  const lifecycle = createLifecycle({ provider, idleMs: 0, sweepMs: 0, log: () => {} });
  const app = createWorkspaced({ provider, grants: GRANTS, token: TOKEN, lifecycle });
  const list = (await (await app.request("/v1/workspaces", { headers: auth })).json()).workspaces;
  assert.deepEqual(list.map(w => [w.name, w.provider ?? "primary"]), [["plain", "primary"], ["agent", "openshell"]]);

  assert.equal((await app.request("/v1/workspaces/agent/sleep?force=1", { method: "POST", headers: auth })).status, 200);
  assert.equal((await app.request("/v1/workspaces/plain/sleep?force=1", { method: "POST", headers: auth })).status, 200);
  assert.ok(cli.calls.some(a => a.join(" ") === "sandbox stop ws-agent"));
  assert.deepEqual(primary.calls, [["scale", "plain", 0]]);
  assert.equal(provider.upstream("plain"), "http://primary/plain");
  assert.equal(provider.upstream("agent").headers.host, "default--ws-agent.openshell.localhost:8080");

  // A name in one provider is taken in the other.
  assert.equal((await app.request("/v1/workspaces", json({ project: "agent" }))).status, 409);
  assert.equal((await app.request("/v1/workspaces", json({ project: "plain", grant: "sandboxed" }))).status, 409);
  assert.equal((await app.request("/v1/workspaces", json({ project: "fresh", grant: "sandboxed" }))).status, 201);
  assert.equal((await app.request("/v1/workspaces", json({ project: "other" }))).status, 201);
  assert.deepEqual(primary.calls.filter(c => c[0] === "create"), [["create", "other"]]);
  assert.equal(cli.calls.filter(a => a[1] === "create").length, 1);

  assert.equal((await app.request("/v1/workspaces/agent", { method: "DELETE", headers: auth })).status, 200);
  assert.ok(cli.calls.some(a => a.join(" ") === "sandbox delete ws-agent"));
  assert.ok(!primary.calls.some(c => c[0] === "remove"));
  await provider.setGitHubAuth({ accessToken: "t" });
  assert.ok(primary.calls.some(c => c[0] === "github"), "the primary still gets the GitHub login");
  lifecycle.stop();
});

test("a gateway outage hides sandboxes but never breaks the primary's workers", async () => {
  const primary = fakePrimary(["plain"]);
  const down = openshellProvider({ kube: fakeKube(), config: CONFIG, exec: async () => { throw Object.assign(new Error("x"), { stderr: "connect error" }); } });
  const provider = withOpenShell(primary, down, { log: () => {} });
  assert.deepEqual((await provider.list()).map(w => w.name), ["plain"]);
  await provider.scale("plain", 0);
  await provider.create({ name: "other", repository: "o/other", grant: GRANTS.default });
  assert.deepEqual(primary.calls, [["scale", "plain", 0], ["create", "other"]]);
});

test("a failed sandbox names the condition that failed; every call answers 503 workspace_failed", async () => {
  // The real shape from `sandbox get` after its worker process was killed: Suspended is the first condition with a message.
  const conditions = [
    { type: "Suspended", status: "False", reason: "NotSuspended", message: "Sandbox is not suspended" },
    { type: "Ready", status: "False", reason: "MainProcessFailed", message: "Canonical main process exited with status 137" },
    { type: "PodScheduled", status: "True", reason: "PodScheduled", message: "" },
  ];
  const cli = fakeCli([{ ...sandbox("agent", "Error"), conditions }]);
  const provider = withOpenShell(fakePrimary([]), openshellProvider({ kube: fakeKube(), config: CONFIG, exec: cli.exec }), { log: () => {}, refreshMs: 0 });
  await provider.refreshSandboxes();
  const lifecycle = createLifecycle({ provider, idleMs: 0, sweepMs: 0, log: () => {} });
  const app = createWorkspaced({ provider, grants: GRANTS, token: TOKEN, lifecycle });
  try {
    const [w] = await provider.list();
    assert.deepEqual([w.state, w.problem.message], ["failed", "Canonical main process exited with status 137"]);
    for (const [method, path] of [["GET", "/api/health"], ["POST", "/api/sessions/s1/message"]]) {
      const res = await app.request(`/v1/workspaces/agent${path}`, { method, headers: auth, body: method === "POST" ? "{}" : undefined });
      assert.equal(res.status, 503, path);
      assert.equal((await res.json()).error, "workspace_failed", path);
    }
  } finally { lifecycle.stop(); }
});

test("a grant asking for an unconfigured provider fails create clearly; other grants are untouched", async () => {
  const primary = fakePrimary([]);
  const app = createWorkspaced({ provider: withOpenShell(primary, null), grants: GRANTS, token: TOKEN });
  const res = await app.request("/v1/workspaces", json({ project: "agent", grant: "sandboxed" }));
  assert.equal(res.status, 501);
  assert.deepEqual(await res.json(), { error: "provider_unconfigured", message: "grant sandboxed needs the openshell provider, which is not configured (set OPENSHELL_GATEWAY_ENDPOINT)" });
  assert.equal((await app.request("/v1/workspaces", json({ chats: true, grant: "sandboxed" }))).status, 501);
  assert.equal((await app.request("/v1/workspaces", json({ project: "agent" }))).status, 201);
  assert.deepEqual(primary.calls, [["create", "agent"]]);
});

test("the proxy, reload and health checks send the provider's headers (OpenShell routes by Host)", async () => {
  const seen = [];
  const gateway = http.createServer((req, res) => {
    seen.push([req.url, req.headers.host]);
    if (req.url === "/api/health") return res.end(JSON.stringify({ ok: true, busy: true }));
    if (req.url === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.end("data: {\"type\":\"connected\"}\n\n"); return undefined; }
    let body = "";
    req.on("data", c => { body += c; }).on("end", () => res.end(JSON.stringify({ path: req.url, body })));
  });
  await new Promise(r => gateway.listen(0, "127.0.0.1", r));
  const host = "default--ws-agent.openshell.localhost:8080";
  const provider = {
    list: async () => [{ name: "agent", repository: "project:agent", state: "running", pinned: false }],
    upstream: () => ({ url: `http://127.0.0.1:${gateway.address().port}`, headers: { host } }),
  };
  const lifecycle = createLifecycle({ provider, idleMs: 0, sweepMs: 0, log: () => {} });
  const app = createWorkspaced({ provider, token: TOKEN, lifecycle });
  try {
    const res = await app.request("/v1/workspaces/agent/api/sessions/s1/message?x=1", { method: "POST", headers: { ...auth, host: "web.internal" }, body: "{\"a\":1}" });
    assert.deepEqual(await res.json(), { path: "/api/sessions/s1/message?x=1", body: "{\"a\":1}" });
    assert.match(await (await app.request("/v1/workspaces/agent/api/events", { headers: auth })).text(), /connected/);
    assert.equal(await lifecycle.busy("agent"), true, "health reached the worker through the gateway");
    await app.request("/v1/workspaces/agent/reload", { method: "POST", headers: auth });
    assert.deepEqual(seen.map(([u, h]) => [u, h]), [
      ["/api/sessions/s1/message?x=1", host], ["/api/events", host], ["/api/health", host], ["/api/pi/reload", host]]);
  } finally { gateway.close(); lifecycle.stop(); }
});

const within = (ms, p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms}ms`)), ms))]);

test("listing and waking ordinary workers never wait on a hung CLI", async () => {
  const primary = fakePrimary(["plain"]);
  const hung = openshellProvider({ kube: fakeKube(), config: CONFIG, exec: () => new Promise(() => {}) });
  const provider = withOpenShell(primary, hung, { log: () => {}, refreshMs: 0 });
  const lifecycle = createLifecycle({ provider, idleMs: 0, sweepMs: 0, log: () => {} });
  const app = createWorkspaced({ provider, grants: GRANTS, token: TOKEN, lifecycle });
  try {
    const list = await within(500, app.request("/v1/workspaces", { headers: auth }));
    assert.deepEqual((await list.json()).workspaces.map(w => w.name), ["plain"]);
    assert.equal((await within(500, app.request("/v1/workspaces/plain/wake", { method: "POST", headers: auth }))).status, 200);
    await within(500, provider.scale("plain", 0));
    assert.deepEqual(primary.calls, [["scale", "plain", 0]]);
  } finally { lifecycle.stop(); }
});

test("the sandbox cache: a created sandbox shows at once, a vanished one goes on the next refresh, outages log per change", async () => {
  const cli = fakeCli([sandbox("old")]);
  let hang = false;
  const exec = async (bin, args, opts) => {
    if (hang && args[1] === "list") return new Promise(() => {});
    const out = await cli.exec(bin, args, opts);
    if (args[1] === "create") hang = true; // the refresh after create never lands
    return out;
  };
  const provider = withOpenShell(fakePrimary([]), openshellProvider({ kube: fakeKube(), config: CONFIG, exec }), { log: () => {}, refreshMs: 0 });
  await provider.refreshSandboxes();
  await provider.create({ name: "agent", repository: "project:agent", grant: GRANTS.sandboxed });
  assert.deepEqual((await provider.list()).map(w => [w.name, w.state]), [["old", "running"], ["agent", "starting"]]);
  assert.equal(provider.upstream("agent").headers.host, "default--ws-agent.openshell.localhost:8080");

  const fresh = fakeCli([sandbox("old"), sandbox("agent")]);
  const lines = [];
  let fail = false;
  const flaky = withOpenShell(fakePrimary([]), openshellProvider({ kube: fakeKube(), config: CONFIG, exec: (b, a, o) => fail ? Promise.reject(Object.assign(new Error("x"), { stderr: "connect error" })) : fresh.exec(b, a, o) }), { log: l => lines.push(l), refreshMs: 0 });
  await flaky.refreshSandboxes();
  fresh.sandboxes.splice(0, 1);
  await flaky.refreshSandboxes();
  assert.deepEqual((await flaky.list()).map(w => w.name), ["agent"]);
  fail = true;
  for (let i = 0; i < 3; i++) await flaky.refreshSandboxes();
  assert.deepEqual((await flaky.list()).map(w => w.name), ["agent"], "an outage keeps the last list");
  fail = false;
  await flaky.refreshSandboxes();
  await flaky.refreshSandboxes();
  assert.deepEqual(lines, ["workspaced: could not list OpenShell sandboxes: openshell sandbox list failed: connect error", "workspaced: OpenShell gateway is reachable again"]);
});

test("passive polling of a sandbox the gateway isn't serving yet (412) answers starting; a bad status is a 502, not a crash", async () => {
  let status = 412;
  const gateway = http.createServer((req, res) => { res.writeHead(status); res.end("precondition"); });
  await new Promise(r => gateway.listen(0, "127.0.0.1", r));
  const provider = {
    list: async () => [{ name: "agent", provider: "openshell", state: "starting", pinned: false }],
    upstream: () => ({ url: `http://127.0.0.1:${gateway.address().port}`, headers: { host: "default--ws-agent.openshell.localhost" } }),
  };
  const lifecycle = createLifecycle({ provider, idleMs: 0, sweepMs: 0, log: () => {} });
  const app = createWorkspaced({ provider, token: TOKEN, lifecycle });
  try {
    const res = await app.request("/v1/workspaces/agent/api/health", { headers: auth });
    assert.deepEqual([res.status, (await res.json()).error, res.headers.get("retry-after")], [503, "workspace_starting", "5"]);
    status = 600;
    const bad = await app.request("/v1/workspaces/agent/api/state", { headers: auth });
    assert.deepEqual([bad.status, (await bad.json()).error], [502, "workspace_unavailable"]);
  } finally { gateway.close(); lifecycle.stop(); }
});

// A gateway that demands a client certificate, as the production one does.
async function mtlsGateway() {
  const ca = makeCert({ cn: "test-ca", ca: true });
  const server = makeCert({ cn: "gateway", issuer: ca, ip: "127.0.0.1" });
  const seen = [];
  const gateway = https.createServer({ ...server, ca: ca.cert, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    seen.push([req.url, req.headers.host, req.socket.getPeerCertificate().subject.CN]);
    if (req.url === "/api/health") return res.end(JSON.stringify({ ok: true, busy: false }));
    if (req.url === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 50);
      return undefined;
    }
    let body = "";
    req.on("data", c => { body += c; }).on("end", () => res.end(JSON.stringify({ path: req.url, body })));
  });
  await new Promise(r => gateway.listen(0, "127.0.0.1", r));
  const home = mkdtempSync(path.join(tmpdir(), "openshell-mtls-"));
  const dir = path.join(home, "openshell", "gateways", "prod", "mtls");
  const writeBundle = cn => {
    const client = makeCert({ cn, issuer: ca });
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "ca.crt"), ca.cert);
    writeFileSync(path.join(dir, "tls.crt"), client.cert);
    writeFileSync(path.join(dir, "tls.key"), client.key);
  };
  const config = openshellConfig({ OPENSHELL_GATEWAY_ENDPOINT: `https://127.0.0.1:${gateway.address().port}`, OPENSHELL_GATEWAY: "prod", XDG_CONFIG_HOME: home, OPENSHELL_BIN: "/opt/openshell" });
  const close = () => { gateway.close(); rmSync(home, { recursive: true, force: true }); };
  return { gateway, seen, dir, writeBundle, config, close };
}

test("over https the proxy, SSE and health use the CLI's client certificate, re-read when it is rotated", async () => {
  const gw = await mtlsGateway();
  gw.writeBundle("workspaced");
  const envs = [];
  const exec = async (_bin, args, opts) => { envs.push(opts.env); return { stdout: JSON.stringify({ sandboxes: args[1] === "list" ? [sandbox("agent")] : [] }), stderr: "" }; };
  const lines = [];
  const openshell = openshellProvider({ kube: fakeKube(), config: gw.config, exec, log: l => lines.push(l), tlsCheckMs: 0 });
  const provider = withOpenShell(fakePrimary([]), openshell, { log: () => {}, refreshMs: 0 });
  await provider.refreshSandboxes();
  const lifecycle = createLifecycle({ provider, idleMs: 0, sweepMs: 0, log: () => {} });
  const app = createWorkspaced({ provider, grants: GRANTS, token: TOKEN, lifecycle });
  try {
    assert.equal(envs[0].OPENSHELL_GATEWAY, "prod");
    assert.equal(envs[0].XDG_CONFIG_HOME, path.dirname(path.dirname(path.dirname(path.dirname(gw.dir)))));
    const res = await app.request("/v1/workspaces/agent/api/sessions/s1/message", { method: "POST", headers: auth, body: "{\"a\":1}" });
    assert.deepEqual(await res.json(), { path: "/api/sessions/s1/message", body: "{\"a\":1}" });
    const events = await app.request("/v1/workspaces/agent/api/events", { headers: auth });
    const reader = events.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /data: one/, "the first event arrives before the stream ends");
    let rest = "";
    for (let r; !(r = await reader.read()).done;) rest += new TextDecoder().decode(r.value);
    assert.match(rest, /data: two/);
    assert.equal((await lifecycle.busy("agent")), false);
    assert.ok(gw.seen.some(([u]) => u === "/api/health"), "health went through the TLS path");
    assert.ok(gw.seen.every(([, host, cn]) => host === `default--ws-agent.openshell.localhost:${gw.gateway.address().port}` && cn === "workspaced"));

    gw.writeBundle("workspaced-rotated");
    await app.request("/v1/workspaces/agent/api/state", { headers: auth });
    assert.equal(gw.seen.at(-1)[2], "workspaced-rotated");
    assert.deepEqual(lines, []);
  } finally { gw.close(); lifecycle.stop(); }
});

test("an https gateway without a usable bundle logs it once and answers 502 for sandbox workers only", async () => {
  const gw = await mtlsGateway();
  const lines = [];
  const exec = async () => ({ stdout: JSON.stringify({ sandboxes: [sandbox("agent")] }), stderr: "" });
  const openshell = openshellProvider({ kube: fakeKube(), config: gw.config, exec, log: l => lines.push(l), tlsCheckMs: 0 });
  const primary = fakePrimary(["plain"]);
  const provider = withOpenShell(primary, openshell, { log: () => {}, refreshMs: 0 });
  await provider.refreshSandboxes();
  const lifecycle = createLifecycle({ provider, idleMs: 0, sweepMs: 0, log: () => {} });
  const app = createWorkspaced({ provider, grants: GRANTS, token: TOKEN, lifecycle });
  try {
    assert.equal(lines.length, 1);
    assert.match(lines[0], /OpenShell mTLS bundle at .*\/openshell\/gateways\/prod\/mtls is unusable \(ENOENT.*ca\.crt'\); sandbox workers answer 502 openshell_tls_unavailable/);
    for (const p of ["/api/sessions/s1/message", "/api/health"]) {
      const res = await app.request(`/v1/workspaces/agent${p}`, { method: "POST", headers: auth, body: "{}" });
      assert.deepEqual([res.status, (await res.json()).error], [502, "openshell_tls_unavailable"], p);
    }
    assert.equal((await app.request("/v1/workspaces/agent/reload", { method: "POST", headers: auth })).status, 502);
    assert.equal(provider.upstream("plain"), "http://primary/plain");
    assert.equal(lines.length, 1, "logged once, not per request");

    gw.writeBundle("workspaced");
    const res = await app.request("/v1/workspaces/agent/api/sessions/s1/message", { method: "POST", headers: auth, body: "{}" });
    assert.equal(res.status, 200);
    assert.match(lines[1], /is usable again/);
    assert.equal(openshellConfig({ OPENSHELL_GATEWAY_ENDPOINT: "https://gw:8080" }).tlsDir, null, "no gateway name, no bundle");
  } finally { gw.close(); lifecycle.stop(); }
});
