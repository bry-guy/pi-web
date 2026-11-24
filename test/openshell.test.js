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
// Gateway profiles and providers live in `gateway`; `fail` makes the named "<noun> <verb>" calls fail.
function fakeCli(sandboxes = [], { gateway = { profiles: new Set(), providers: new Map() }, fail = new Set() } = {}) {
  const calls = [];
  const envs = [];
  const policies = [];
  const exec = async (bin, args, opts) => {
    calls.push(args);
    envs.push(opts.env);
    assert.equal(bin, "/opt/openshell");
    assert.equal(opts.env.OPENSHELL_GATEWAY_ENDPOINT, "http://127.0.0.1:8080");
    const missing = () => { throw Object.assign(new Error("Command failed"), { stderr: "Error: not found\n" }); };
    if (fail.has(args.slice(0, 2).join(" "))) throw Object.assign(new Error("Command failed"), { stderr: `Error: rejected credential ${opts.env.OPENSHELL_ANTHROPIC_PLACEHOLDER}\n` });
    if (args[0] === "profile") {
      if (args[1] === "describe" && !gateway.profiles.has(args[2])) missing();
      if (args[1] === "import") gateway.profiles.add(YAML.parse(readFileSync(args[3], "utf8")).id);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "provider") {
      if (args[1] === "get" && !gateway.providers.has(args[2])) missing();
      if (args[1] === "create") gateway.providers.set(args[3], opts.env[args[args.indexOf("--credential") + 1]]);
      if (args[1] === "update") gateway.providers.set(args[2], opts.env[args[args.indexOf("--credential") + 1]]);
      return { stdout: "", stderr: "" };
    }
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
  return { exec, calls, envs, policies, sandboxes, gateway };
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

test("grants: a role grant is an OpenShell sandbox locked to its projects", () => {
  const role = g => parseGrants(JSON.stringify({ default: { anyProject: true }, dev: { repos: ["project:p-dev"], provider: "openshell", role: "app/dev", ...g } })).dev;
  assert.equal(role({}).role, "app/dev");
  assert.equal(GRANTS.sandboxed.role, undefined);
  assert.throws(() => role({ provider: undefined }), /role needs provider openshell/, "never a worker that holds web's logins");
  assert.throws(() => role({ anyProject: true }), /role cannot be combined with anyProject/);
  for (const bad of ["dev", "app/dev/x", "App/Dev", 7]) assert.throws(() => role({ role: bad }), /role must be <repo>\/<role>/, String(bad));
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
  const acts = () => cli.calls.filter(a => a[0] === "sandbox" && a[1] !== "list").map(a => a.slice(1).join(" "));
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

const MODEL_GRANTS = parseGrants(JSON.stringify({
  default: { anyProject: true },
  agent: { anyProject: true, provider: "openshell", providers: ["labrat-kube"], environment: { TZ: "UTC" }, packages: ["npm:@gotgenes/pi-anthropic-auth@3.4.4"] },
}));
const TOKEN_A = "sk-ant-oat01-REAL-A";
const TOKEN_B = "sk-ant-oat01-REAL-B";
const modelAuth = (access, expires = Date.now() + 3_600_000) => JSON.stringify({ anthropic: { type: "oauth", access, refresh: "refreshed-by-pi-web", expires } });
const never = () => new Promise(() => {});
// Timers the test fires by hand: openshellProvider's setTimer/clearTimer.
function fakeTimers() {
  const due = [];
  return {
    due,
    setTimer: (fn, ms) => { const t = { fn, ms }; due.push(t); return t; },
    clearTimer: t => { const i = due.indexOf(t); if (i >= 0) due.splice(i, 1); },
    fire() { const t = due.shift(); t.fn(); return t.ms; },
  };
}
const execAt = (cli, verb) => cli.calls.findIndex(a => a.slice(0, 2).join(" ") === verb);

test("grants: OpenShell grants take providers, environment and packages; others and reserved names are refused", () => {
  assert.deepEqual([MODEL_GRANTS.agent.providers, MODEL_GRANTS.agent.environment, MODEL_GRANTS.agent.packages],
    [["labrat-kube"], { TZ: "UTC" }, ["npm:@gotgenes/pi-anthropic-auth@3.4.4"]]);
  assert.equal(MODEL_GRANTS.default.providers, undefined);
  const bad = grant => () => parseGrants(JSON.stringify({ default: { anyProject: true }, g: { anyProject: true, ...grant } }), { log: () => {} });
  assert.throws(bad({ providers: ["x"] }), /g\.providers needs provider openshell/);
  assert.throws(bad({ environment: { A: "1" } }), /g\.environment needs provider openshell/);
  assert.throws(bad({ packages: ["npm:x"] }), /g\.packages needs provider openshell/);
  assert.throws(bad({ provider: "openshell", environment: { OPENSHELL_X: "1" } }), /OPENSHELL_X is reserved/);
  for (const k of ["HOME", "PI_WEB_PACKAGES", "PI_ANTHROPIC_PLACEHOLDER_FILE", "PI_WEB_SANDBOX", "HOST", "PI_WEB_PROJECT"]) assert.throws(bad({ provider: "openshell", environment: { [k]: "1" } }), /is reserved/, k);
  assert.throws(bad({ provider: "openshell", environment: { A: 1 } }), /string value/);
  assert.throws(bad({ provider: "openshell", providers: ["pi-web-anthropic"] }), /attached by workspaced/);
  assert.throws(bad({ provider: "openshell", providers: ["a b"] }), /gateway provider names/);
  assert.throws(bad({ provider: "openshell", packages: ["./local"] }), /pi package sources/);
  const logs = [];
  parseGrants(JSON.stringify({ default: { anyProject: true, secrets: ["x"] } }), { log: m => logs.push(m) });
  assert.deepEqual(logs, ["workspaced: grant default has an unknown field secrets; it is ignored"]);
});

test("model feed: profile and provider are created once, then updated; the token is only in the CLI's env", async () => {
  const logs = [];
  const cli = fakeCli([sandbox("agent"), sandbox("asleep", "Stopped")]);
  const provider = openshellProvider({ kube: fakeKube(), config: CONFIG, exec: cli.exec, log: m => logs.push(m), reconcileMs: 0 });
  await provider.setModelAuth(modelAuth(TOKEN_A));
  await provider.settled();
  const verbs = () => cli.calls.map(a => a.slice(0, 2).join(" "));
  assert.deepEqual(verbs(), ["provider get", "profile describe", "profile import", "provider create", "sandbox list", "sandbox exec"]);
  assert.equal(YAML.parse(readFileSync(cli.calls[2][3], "utf8")).credentials[0].env_vars[0], "OPENSHELL_ANTHROPIC_PLACEHOLDER");
  assert.deepEqual(cli.calls[3], ["provider", "create", "--name", "pi-web-anthropic", "--type", "pi-web-anthropic", "--credential", "OPENSHELL_ANTHROPIC_PLACEHOLDER"]);
  assert.equal(cli.gateway.providers.get("pi-web-anthropic"), TOKEN_A);
  // Only the storing call gets the token; the reconcile exec writes the placeholder for the running sandbox only.
  assert.deepEqual(cli.envs.map(e => e.OPENSHELL_ANTHROPIC_PLACEHOLDER === TOKEN_A), [false, false, false, true, false, false]);
  const execArgs = cli.calls[5];
  assert.deepEqual(execArgs.slice(0, 9), ["sandbox", "exec", "-n", "ws-agent", "--no-login-shell", "--timeout", "60", "--", "sh"]);
  assert.match(execArgs[10], /printenv OPENSHELL_ANTHROPIC_PLACEHOLDER > \/data\/pi-ez-agent\/openshell-placeholder\.tmp && mv /);

  // The same token again: no CLI call. A new one: update in place, then reconcile.
  const before = cli.calls.length;
  await provider.setModelAuth(modelAuth(TOKEN_A, Date.now() + 7_200_000));
  await provider.settled();
  assert.equal(cli.calls.length, before);
  await provider.setModelAuth(modelAuth(TOKEN_B));
  await provider.settled();
  assert.deepEqual(cli.calls.slice(before).map(a => a.slice(0, 2).join(" ")), ["provider update", "sandbox list", "sandbox exec"]);
  assert.deepEqual(cli.calls[before], ["provider", "update", "pi-web-anthropic", "--credential", "OPENSHELL_ANTHROPIC_PLACEHOLDER", "--wait", "--timeout", "60"]);
  assert.equal(cli.gateway.providers.get("pi-web-anthropic"), TOKEN_B);

  // Missing or expired: skipped with one log line, nothing called.
  const n = cli.calls.length;
  await provider.setModelAuth("{}");
  await provider.setModelAuth(modelAuth("sk-ant-oat01-OLD", Date.now() - 1));
  await provider.settled();
  assert.equal(cli.calls.length, n);
  assert.ok(logs.includes("workspaced: OpenShell model feed skipped: no Anthropic OAuth login"));
  assert.ok(logs.includes("workspaced: OpenShell model feed skipped: the Anthropic login has expired"));
  for (const token of [TOKEN_A, TOKEN_B]) assert.ok(!cli.calls.flat().some(a => a.includes(token)) && !logs.some(l => l.includes(token)), "never in argv or logs");
});

test("model feed failures stay out of logs' secrets, retry on the tick, and never fail the primary's setModelAuth", async () => {
  const logs = [];
  const cli = fakeCli([sandbox("agent")], { fail: new Set(["provider create"]) });
  const provider = openshellProvider({ kube: fakeKube(), config: CONFIG, exec: cli.exec, log: m => logs.push(m), reconcileMs: 0 });
  const primary = fakePrimary();
  const routed = withOpenShell(primary, provider, { refreshMs: 0, log: m => logs.push(m) });
  await routed.setModelAuth(modelAuth(TOKEN_A));
  await provider.settled();
  assert.deepEqual(primary.calls, [["model"]]);
  const failed = logs.find(l => l.includes("model feed failed"));
  assert.match(failed, /openshell provider create failed: Error: rejected credential \[redacted\]/);
  assert.ok(!logs.some(l => l.includes(TOKEN_A)));
  assert.ok(!cli.calls.some(a => a[1] === "exec"), "no reconcile without a stored login");

  // A provider that throws is logged; the primary has still stored the login.
  const throwing = { list: async () => [], setModelAuth: async () => { throw new Error("boom"); }, setGitHubAuth: async () => {} };
  const other = fakePrimary();
  await withOpenShell(other, throwing, { refreshMs: 0, log: m => logs.push(m) }).setModelAuth("{}");
  assert.deepEqual(other.calls, [["model"]]);
  assert.ok(logs.includes("workspaced: OpenShell model feed failed: boom"));

  // setModelAuth never waits on the CLI.
  const hung = openshellProvider({ kube: fakeKube(), config: CONFIG, exec: never, log: () => {}, reconcileMs: 0 });
  await Promise.race([hung.setModelAuth(modelAuth(TOKEN_A)), new Promise((_, no) => setTimeout(() => no(new Error("waited on the CLI")), 500))]);
});

test("a sandbox gets the fed model login, the grant's providers, environment and packages, and its placeholder written", async () => {
  const cli = fakeCli();
  const provider = openshellProvider({ kube: fakeKube(), config: CONFIG, exec: cli.exec, log: () => {}, reconcileMs: 0, pollMs: 1 });
  await provider.setModelAuth(modelAuth(TOKEN_A));
  await provider.settled();
  await provider.create({ name: "agent", repository: "project:agent", grant: MODEL_GRANTS.agent });
  const args = cli.calls.find(a => a[0] === "sandbox" && a[1] === "create");
  assert.deepEqual(args.flatMap((a, i) => a === "--provider" ? [args[i + 1]] : []), ["pi-web-anthropic", "labrat-kube"]);
  assert.ok(args.includes("--no-auto-providers"));
  const env = args.flatMap((a, i) => a === "--env" ? [args[i + 1]] : []);
  for (const e of ["PI_ANTHROPIC_PLACEHOLDER_FILE=/data/pi-ez-agent/openshell-placeholder", 'PI_WEB_PACKAGES=["npm:@gotgenes/pi-anthropic-auth@3.4.4"]', "TZ=UTC"]) assert.ok(env.includes(e), e);
  assert.ok(!env.some(e => e.startsWith("OPENSHELL_")));
  const rules = cli.policies[0].network_policies;
  assert.deepEqual(rules.anthropic.endpoints, [{ protocol: "rest", enforcement: "enforce", host: "api.anthropic.com", port: 443, access: "read-write" }]);
  assert.deepEqual(rules.npm.endpoints, [{ protocol: "rest", enforcement: "enforce", host: "registry.npmjs.org", port: 443, access: "read-write", allow_encoded_slash: true }]);
  assert.equal(cli.calls.at(-1)[3], "ws-agent", "the placeholder is written before create returns");
  assert.equal(cli.calls.at(-1)[1], "exec");
  // Waking a sleeping one writes it again.
  cli.sandboxes[0].phase = "Stopped";
  await provider.scale("agent", 1);
  assert.deepEqual(cli.calls.slice(-2).map(a => a[1]), ["start", "exec"]);
});

test("first start: no login yet means no model provider, unless an earlier workspaced left one on the gateway", async () => {
  const logs = [];
  const cli = fakeCli();
  const provider = openshellProvider({ kube: fakeKube(), config: CONFIG, exec: cli.exec, log: m => logs.push(m), reconcileMs: 0 });
  await provider.create({ name: "agent", repository: "project:agent", grant: GRANTS.sandboxed });
  const args = cli.calls.find(a => a[0] === "sandbox" && a[1] === "create");
  assert.ok(!args.includes("--provider") && !args.some(a => a.startsWith("PI_ANTHROPIC_PLACEHOLDER_FILE=")));
  assert.ok(args.includes("PI_WEB_SANDBOX=1"), "marked as a sandbox even without a model login");
  assert.equal(cli.policies[0].network_policies.anthropic, undefined);
  assert.ok(logs.includes("workspaced: ws-agent starts without a model login (pi-web has not shared one with this workspaced yet)"));

  const kept = fakeCli([], { gateway: { profiles: new Set(["pi-web-anthropic"]), providers: new Map([["pi-web-anthropic", "earlier"]]) } });
  const restarted = openshellProvider({ kube: fakeKube(), config: CONFIG, exec: kept.exec, log: () => {}, reconcileMs: 0, pollMs: 1 });
  await restarted.create({ name: "agent", repository: "project:agent", grant: GRANTS.sandboxed });
  const again = kept.calls.find(a => a[0] === "sandbox" && a[1] === "create");
  assert.equal(again[again.indexOf("--provider") + 1], "pi-web-anthropic");
  assert.ok(kept.policies[0].network_policies.anthropic);
  assert.deepEqual(kept.calls.at(-1).slice(0, 4), ["sandbox", "exec", "-n", "ws-agent"], "its placeholder is written before create returns");
});

test("a failed model feed succeeds on the quick retry and rewrites running sandboxes' placeholders", async () => {
  const logs = [];
  const fail = new Set(["provider create"]);
  const cli = fakeCli([sandbox("agent")], { fail });
  const timers = fakeTimers();
  const provider = openshellProvider({ kube: fakeKube(), config: CONFIG, exec: cli.exec, log: m => logs.push(m), reconcileMs: 0, ...timers });
  await provider.setModelAuth(modelAuth(TOKEN_A));
  await provider.settled();
  assert.match(logs.find(l => l.includes("model feed failed")), /retried in 5 s/);
  fail.clear();
  assert.equal(timers.fire(), 5_000);
  await provider.settled();
  assert.equal(cli.gateway.providers.get("pi-web-anthropic"), TOKEN_A);
  assert.ok(logs.includes("workspaced: OpenShell gateway has the current model login"));
  assert.deepEqual(cli.calls.slice(-2).map(a => a.slice(0, 2).join(" ")), ["sandbox list", "sandbox exec"]);
  assert.equal(logs.filter(l => l.includes("model feed failed")).length, 1);
});

test("an update the gateway stored but a stopped sandbox could not confirm counts as fed", async () => {
  const logs = [];
  const cli = fakeCli([sandbox("agent"), sandbox("asleep", "Stopped")], { gateway: { profiles: new Set(["pi-web-anthropic"]), providers: new Map([["pi-web-anthropic", "old"]]) } });
  const exec = async (bin, args, opts) => {
    const out = await cli.exec(bin, args, opts);
    if (args[1] === "update") throw Object.assign(new Error("Command failed"), { stderr: "ws-asleep: pending\nError:   × provider readiness wait did not complete for every selected sandbox; inspect the reported outcomes\n" });
    return out;
  };
  const provider = openshellProvider({ kube: fakeKube(), config: CONFIG, exec, log: m => logs.push(m), reconcileMs: 0 });
  await provider.setModelAuth(modelAuth(TOKEN_A));
  await provider.settled();
  assert.equal(cli.gateway.providers.get("pi-web-anthropic"), TOKEN_A);
  assert.ok(!logs.some(l => l.includes("feed failed")), logs.join("\n"));
  assert.deepEqual(logs.filter(l => l.includes("did not confirm")), ["workspaced: OpenShell stored the model login; some attached sandboxes did not confirm it (stopped ones never do; they get it on wake)"]);
  assert.ok(!logs.some(l => l.includes(TOKEN_A) || l.includes("openshell:resolve")));
  assert.equal(cli.calls.at(-1)[1], "exec", "running sandboxes get the new placeholder");
});

test("waking a worker while the model feed is failing feeds first, then writes its placeholder before it is ready", async () => {
  const logs = [];
  const fail = new Set(["provider create"]);
  const cli = fakeCli([sandbox("agent", "Stopped")], { fail });
  const provider = openshellProvider({ kube: fakeKube(), config: CONFIG, exec: cli.exec, log: m => logs.push(m), reconcileMs: 0, pollMs: 1, feedRetryMs: [] });
  await provider.setModelAuth(modelAuth(TOKEN_A));
  await provider.settled();
  fail.clear();
  cli.calls.length = 0;
  await provider.scale("agent", 1);
  const at = verb => cli.calls.findIndex(a => a.slice(0, 2).join(" ") === verb);
  assert.ok(at("provider create") >= 0 && at("provider create") < at("sandbox start"), "fed before the start");
  assert.ok(cli.calls.slice(at("sandbox start")).some(a => a[1] === "exec" && a[3] === "ws-agent"), "placeholder written before scale returns");
  assert.ok(!logs.some(l => l.includes("no model login yet")));
});

test("waking a worker while the model feed keeps failing or hangs still wakes it, with one log line", async () => {
  const logs = [];
  const cli = fakeCli([sandbox("agent", "Stopped")], { fail: new Set(["provider create"]) });
  const provider = openshellProvider({ kube: fakeKube(), config: CONFIG, exec: cli.exec, log: m => logs.push(m), reconcileMs: 0, pollMs: 1, feedRetryMs: [] });
  await provider.setModelAuth(modelAuth(TOKEN_A));
  await provider.settled();
  await provider.scale("agent", 1);
  assert.equal((await provider.list())[0].state, "running");
  assert.deepEqual(logs.filter(l => l.includes("no model login yet")), ["workspaced: ws-agent has no model login yet (the OpenShell model feed is failing); it gets one when a retry succeeds"]);

  // A hung CLI holds the wake for feedWaitMs only.
  const hung = fakeCli([sandbox("agent", "Stopped")]);
  const exec = (bin, args, opts) => args[0] === "provider" ? never() : hung.exec(bin, args, opts);
  const stuck = openshellProvider({ kube: fakeKube(), config: CONFIG, exec, log: () => {}, reconcileMs: 0, pollMs: 1, feedWaitMs: 20, settleWaitMs: 20 });
  await stuck.setModelAuth(modelAuth(TOKEN_A));
  await Promise.race([stuck.scale("agent", 1), new Promise((_, no) => setTimeout(() => no(new Error("wake waited on the feed")), 1000))]);
  assert.equal(hung.sandboxes[0].phase, "Ready");
});

test("a worker asleep across two login updates gets the current placeholder written before its wake returns", async () => {
  const cli = fakeCli([sandbox("agent", "Stopped")]);
  const provider = openshellProvider({ kube: fakeKube(), config: CONFIG, exec: cli.exec, log: () => {}, reconcileMs: 0, pollMs: 1 });
  for (const token of [TOKEN_A, TOKEN_B]) { await provider.setModelAuth(modelAuth(token)); await provider.settled(); }
  assert.equal(cli.gateway.providers.get("pi-web-anthropic"), TOKEN_B);
  assert.ok(!cli.calls.some(a => a[1] === "exec"), "a stopped sandbox gets nothing on update");
  cli.calls.length = 0;
  await provider.scale("agent", 1);
  assert.ok(execAt(cli, "sandbox start") >= 0 && execAt(cli, "sandbox exec") > execAt(cli, "sandbox start"));
  assert.ok(!cli.calls.some(a => a[0] === "provider"), "a fed login is not fed again");
});

test("after a workspaced restart a wake asks the gateway for the provider and writes the placeholder before it returns", async () => {
  const cli = fakeCli([sandbox("agent", "Stopped")], { gateway: { profiles: new Set(["pi-web-anthropic"]), providers: new Map([["pi-web-anthropic", TOKEN_A]]) } });
  // Fresh process, no push from web yet.
  const provider = openshellProvider({ kube: fakeKube(), config: CONFIG, exec: cli.exec, log: () => {}, reconcileMs: 0, pollMs: 1 });
  await provider.scale("agent", 1);
  assert.ok(execAt(cli, "provider get") > execAt(cli, "sandbox start"));
  assert.ok(execAt(cli, "sandbox exec") > execAt(cli, "provider get"), "placeholder written before scale returns");

  // No provider on the gateway: nothing to write.
  const bare = fakeCli([sandbox("agent", "Stopped")]);
  await openshellProvider({ kube: fakeKube(), config: CONFIG, exec: bare.exec, log: () => {}, reconcileMs: 0, pollMs: 1 }).scale("agent", 1);
  assert.equal(execAt(bare, "sandbox exec"), -1);
});

test("wakes during a failing model feed join the attempt in flight instead of using up the retry schedule", async () => {
  const logs = [];
  const timers = fakeTimers();
  const cli = fakeCli(["a", "b", "c"].map(n => sandbox(n, "Stopped")), { fail: new Set(["provider create"]) });
  let release;
  const gate = new Promise(r => { release = r; });
  let creates = 0;
  const exec = async (bin, args, opts) => {
    if (args[0] === "provider" && args[1] === "create" && ++creates === 2) await gate;
    return cli.exec(bin, args, opts);
  };
  const provider = openshellProvider({ kube: fakeKube(), config: CONFIG, exec, log: m => logs.push(m), reconcileMs: 0, pollMs: 1, ...timers });
  await provider.setModelAuth(modelAuth(TOKEN_A));
  await provider.settled();
  assert.deepEqual(timers.due.map(t => t.ms), [5_000]);
  const wakes = Promise.all(["a", "b", "c"].map(n => provider.scale(n, 1)));
  while (creates < 2) await new Promise(r => setImmediate(r));
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  release();
  await wakes;
  await provider.settled();
  assert.equal(creates, 2, "the first wake ran the pending retry early; the others joined it");
  assert.deepEqual(timers.due.map(t => t.ms), [15_000], "one retry used, the next one scheduled");
  assert.equal(logs.filter(l => l.includes("model feed failed")).length, 2);
  assert.ok(cli.sandboxes.every(s => s.phase === "Ready"));
});

test("a slow placeholder write does not turn a healthy wake into starting", async () => {
  let clock = 1_000_000;
  const cli = fakeCli([sandbox("agent", "Stopped")], { gateway: { profiles: new Set(["pi-web-anthropic"]), providers: new Map([["pi-web-anthropic", TOKEN_A]]) } });
  // The write takes longer than the whole wake budget.
  const exec = async (bin, args, opts) => { if (args[1] === "exec") clock += 60_000; return cli.exec(bin, args, opts); };
  const provider = openshellProvider({ kube: fakeKube(), config: CONFIG, exec, log: () => {}, reconcileMs: 0, pollMs: 1 });
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true }) });
  const lifecycle = createLifecycle({ provider, fetchImpl, now: () => clock, idleMs: 0, sweepMs: 0, cacheMs: 0, pollMs: 1, log: () => {} });
  try {
    assert.equal(await lifecycle.ensureAwake("agent"), true);
    assert.ok(execAt(cli, "sandbox exec") > execAt(cli, "sandbox start"));
  } finally { lifecycle.stop(); }
});

// GitHub as a role's bot. The token is a made-up value; mintGitHubToken stands in for workspaced/github-app.js.
const GH_TOKEN_A = "ghs_FAKEtokenAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const GH_TOKEN_B = "ghs_FAKEtokenBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const GH = { app: "pi-web-developer", repos: ["bry-guy/pi-web"], permissions: { contents: "write", pull_requests: "write" } };
const ROLE_GRANTS = parseGrants(JSON.stringify({
  default: { anyProject: true },
  dev: { repos: ["project:web-dev"], provider: "openshell", github: GH },
}));
const roleSandbox = (phase = "Ready") => sandbox("web-dev", phase, { "pi-ez-grant": "dev" });
// A minter that hands out the given tokens in turn, each good for an hour of the test's clock.
function fakeMinter(clock, tokens = [GH_TOKEN_A, GH_TOKEN_B]) {
  const asked = [];
  let fail = null;
  const mint = async github => {
    asked.push(github);
    if (fail) throw Object.assign(new Error(fail), { status: 502, code: "github_token_unavailable" });
    return { token: tokens[Math.min(asked.length, tokens.length) - 1], expiresAt: clock.now + 3_600_000 };
  };
  return { mint, asked, failWith: message => { fail = message; } };
}
function roleProvider(cli, { clock = { now: 1_000_000 }, minter = fakeMinter(clock), logs = [], kube = fakeKube(), exec = cli.exec, ...extra } = {}) {
  const provider = openshellProvider({ kube, config: CONFIG, exec, log: m => logs.push(m), reconcileMs: 0, pollMs: 1, grants: ROLE_GRANTS, mintGitHubToken: minter.mint, now: () => clock.now, ...extra });
  return { provider, clock, minter, logs, kube };
}
const verbsOf = cli => cli.calls.map(a => a.slice(0, 2).join(" "));
const noTokenIn = (cli, logs) => {
  for (const token of [GH_TOKEN_A, GH_TOKEN_B]) assert.ok(!cli.calls.flat().some(a => a.includes(token)) && !logs.some(l => l.includes(token)), "never in argv (so never in --env) or logs");
};

test("grants: github names one App, its repositories and permissions; open, shared or hand-wired shapes are refused", () => {
  assert.deepEqual(ROLE_GRANTS.dev.github, GH);
  assert.equal(ROLE_GRANTS.default.github, undefined);
  const dev = (github, more = {}) => JSON.stringify({ default: { anyProject: true }, dev: { repos: ["project:web-dev"], provider: "openshell", github, ...more } });
  for (const [text, message] of [
    [JSON.stringify({ default: { anyProject: true, github: GH } }), /default\.github needs provider openshell/],
    [JSON.stringify({ default: { anyProject: true }, dev: { anyProject: true, provider: "openshell", github: GH } }), /dev\.github cannot be combined with anyProject/],
    [dev("pi-web-developer"), /dev\.github must be \{app, repos, permissions\}/],
    [dev({ ...GH, key: "x" }), /dev\.github has unknown fields key/],
    [dev({ ...GH, app: "../etc" }), /dev\.github\.app must be/],
    [dev({ ...GH, repos: [] }), /dev\.github\.repos must list owner\/name/],
    [dev({ ...GH, repos: ["pi-web"] }), /dev\.github\.repos must list owner\/name/],
    [dev({ ...GH, repos: ["bry-guy/pi-web", "other/pi-web"] }), /must belong to one owner/],
    [dev({ ...GH, permissions: {} }), /dev\.github\.permissions must map/],
    [dev({ ...GH, permissions: { contents: "admin" } }), /dev\.github\.permissions must map/],
    [dev(GH, { providers: ["pi-web-developer-github"] }), /pi-web-developer-github is attached by workspaced/],
    [dev(GH, { environment: { GH_TOKEN: "x" } }), /dev\.environment\.GH_TOKEN is reserved with github/],
    [dev(GH, { environment: { PI_WEB_GITHUB_AUTH_FILE: "/x" } }), /PI_WEB_GITHUB_AUTH_FILE is reserved/],
    [JSON.stringify({ default: { anyProject: true }, a: { repos: ["project:a"], provider: "openshell", github: GH }, b: { repos: ["project:b"], provider: "openshell", github: { ...GH, repos: ["bry-guy/pi-sync"] } } }), /b\.github\.app pi-web-developer is already used by grant a/],
  ]) assert.throws(() => parseGrants(text), message);
});

test("a role worker is created with its App's token on the gateway and only a placeholder inside", async () => {
  const cli = fakeCli();
  const { provider, minter, logs } = roleProvider(cli);
  await provider.create({ name: "web-dev", repository: "project:web-dev", grant: ROLE_GRANTS.dev });
  assert.deepEqual(minter.asked, [GH]);
  // Stored before the sandbox exists; the model login is not involved (none was shared).
  assert.deepEqual(verbsOf(cli).filter(v => v !== "sandbox list"), ["provider get", "profile describe", "profile import", "provider create", "provider get", "sandbox create", "sandbox exec"]);
  const profile = YAML.parse(readFileSync(cli.calls.find(a => a[1] === "import")[3], "utf8"));
  assert.equal(profile.id, "pi-web-github");
  assert.deepEqual(profile.credentials[0].env_vars, ["OPENSHELL_GITHUB_PLACEHOLDER"]);
  assert.deepEqual(profile.endpoints.map(e => [e.host, e.access]), [["api.github.com", "read-write"], ["github.com", "read-write"]]);
  assert.deepEqual(cli.calls.find(a => a[1] === "create" && a[0] === "provider"), ["provider", "create", "--name", "pi-web-developer-github", "--type", "pi-web-github", "--credential", "OPENSHELL_GITHUB_PLACEHOLDER"]);
  assert.equal(cli.gateway.providers.get("pi-web-developer-github"), GH_TOKEN_A);
  assert.deepEqual(cli.envs.map(e => e.OPENSHELL_GITHUB_PLACEHOLDER === GH_TOKEN_A), cli.calls.map(a => a[0] === "provider" && a[1] === "create"), "only the storing call's env holds the token");

  const args = cli.calls.find(a => a[0] === "sandbox" && a[1] === "create");
  assert.deepEqual(args.flatMap((a, i) => a === "--provider" ? [args[i + 1]] : []), ["pi-web-developer-github"]);
  const env = args.flatMap((a, i) => a === "--env" ? [args[i + 1]] : []);
  assert.deepEqual(env.filter(e => /GITHUB|GH_/.test(e)), ["PI_WEB_GITHUB_AUTH_FILE=/data/pi-ez-agent/openshell-github-auth.json", "PI_WEB_GITHUB_BOT=pi-web-developer"]);
  assert.deepEqual(cli.policies[0].network_policies.github.endpoints.map(e => `${e.host}:${e.port} ${e.access} ${e.enforcement}`), ["api.github.com:443 read-write enforce", "github.com:443 read-write enforce"]);
  const write = cli.calls.at(-1);
  assert.deepEqual(write.slice(0, 4), ["sandbox", "exec", "-n", "ws-web-dev"], "the placeholder file is written before create returns");
  assert.match(write.at(-1), /printf '\{"accessToken":"%s"\}\\n' "\$OPENSHELL_GITHUB_PLACEHOLDER" > \/data\/pi-ez-agent\/openshell-github-auth\.json\.tmp && mv /);
  assert.ok(logs.some(l => /gateway has a GitHub token for pi-web-developer, valid until/.test(l)));
  noTokenIn(cli, logs);
});

test("no token, no role worker: a failed mint or store fails create and wake before anything is made or started", async () => {
  const cli = fakeCli([roleSandbox("Stopped")]);
  const { provider, minter, logs, kube } = roleProvider(cli);
  minter.failWith("GitHub App pi-web-developer: POST /app/installations/1/access_tokens answered 422 (not granted)");
  const refused = e => e.status === 502 && e.code === "github_token_unavailable";
  await assert.rejects(provider.create({ name: "other-dev", repository: "project:web-dev", grant: ROLE_GRANTS.dev }), refused);
  await assert.rejects(provider.scale("web-dev", 1), refused);
  await assert.rejects(provider.restart("web-dev"), refused);
  await assert.rejects(provider.reset("web-dev"), refused);
  assert.deepEqual(verbsOf(cli).filter(v => v !== "sandbox list"), []);
  assert.deepEqual(kube.calls, [], "no disk either");

  // The gateway refusing the token is the same failure, with the token cut from the message.
  const refusing = async (bin, args, opts) => {
    if (args[0] === "provider" && args[1] === "create") throw Object.assign(new Error("Command failed"), { stderr: `Error: rejected credential ${opts.env.OPENSHELL_GITHUB_PLACEHOLDER}\n` });
    return cli.exec(bin, args, opts);
  };
  const second = roleProvider(cli, { exec: refusing });
  await assert.rejects(second.provider.scale("web-dev", 1), e => refused(e) && /the gateway did not store its token \(openshell provider create failed: Error: rejected credential \[redacted\]\)/.test(e.message));
  assert.ok(!verbsOf(cli).includes("sandbox start"));

  // No keys mounted at all.
  const keyless = openshellProvider({ kube: fakeKube(), config: CONFIG, exec: cli.exec, log: () => {}, reconcileMs: 0, grants: ROLE_GRANTS });
  await assert.rejects(keyless.scale("web-dev", 1), e => refused(e) && /WORKSPACED_GITHUB_APPS_DIR is not set/.test(e.message));
  // Web's own GitHub login is never an alternative: sharing it changes nothing for sandboxes.
  const before = cli.calls.length;
  await keyless.setGitHubAuth({ accessToken: "gho_FAKEwebLogin" });
  assert.equal(cli.calls.length, before);
  noTokenIn(cli, [...logs, ...second.logs]);
});

test("waking a role worker reuses a token with more than 30 minutes left, replaces an older one without waiting, and rewrites its file", async () => {
  const cli = fakeCli([roleSandbox("Stopped")]);
  const { provider, minter, clock, logs } = roleProvider(cli);
  await provider.scale("web-dev", 1);
  assert.deepEqual(verbsOf(cli), ["sandbox list", "provider get", "profile describe", "profile import", "provider create", "sandbox start", "provider get", "sandbox exec"]);
  assert.match(cli.calls.at(-1).at(-1), /openshell-github-auth\.json/);

  // 29 minutes later the stored token has 31 left: no mint, but the file is written again (the sandbox's placeholder may have moved).
  cli.sandboxes[0].phase = "Stopped";
  clock.now += 29 * 60_000;
  cli.calls.length = 0;
  await provider.scale("web-dev", 1);
  assert.equal(minter.asked.length, 1);
  assert.deepEqual(verbsOf(cli), ["sandbox list", "sandbox start", "provider get", "sandbox exec"]);

  // Two minutes more: under 30 left. A stopped sandbox never confirms an update, so this one does not wait for it.
  cli.sandboxes[0].phase = "Stopped";
  clock.now += 2 * 60_000;
  cli.calls.length = 0;
  await provider.scale("web-dev", 1);
  assert.equal(minter.asked.length, 2);
  assert.deepEqual(cli.calls[2], ["provider", "update", "pi-web-developer-github", "--credential", "OPENSHELL_GITHUB_PLACEHOLDER"]);
  assert.ok(execAt(cli, "provider update") < execAt(cli, "sandbox start"));
  assert.equal(cli.gateway.providers.get("pi-web-developer-github"), GH_TOKEN_B);
  noTokenIn(cli, logs);
});

test("the refresh tick keeps running role workers' tokens and files current, and mints nothing for sleeping ones", async () => {
  const asleep = fakeCli([roleSandbox("Stopped")]);
  const idle = roleProvider(asleep);
  await idle.provider.refreshGitHub();
  assert.deepEqual(idle.minter.asked, []);
  assert.deepEqual(verbsOf(asleep), ["sandbox list"]);

  const cli = fakeCli([roleSandbox(), sandbox("agent")]);
  const { provider, minter, clock, logs } = roleProvider(cli);
  // After a workspaced restart nothing is known to be stored: the first tick mints.
  await provider.refreshGitHub();
  assert.deepEqual(minter.asked, [GH]);
  assert.deepEqual(verbsOf(cli), ["sandbox list", "provider get", "profile describe", "profile import", "provider create", "sandbox exec"]);
  assert.equal(cli.calls.at(-1)[3], "ws-web-dev", "only the role's sandbox gets the file");

  // Later ticks: the file every time, a new token once the stored one is under 30 minutes, confirmed by running sandboxes.
  cli.calls.length = 0;
  clock.now += 25 * 60_000;
  await provider.refreshGitHub();
  assert.deepEqual(verbsOf(cli), ["sandbox list", "sandbox exec"]);
  cli.calls.length = 0;
  clock.now += 10 * 60_000;
  await provider.refreshGitHub();
  assert.deepEqual(cli.calls[2], ["provider", "update", "pi-web-developer-github", "--credential", "OPENSHELL_GITHUB_PLACEHOLDER", "--wait", "--timeout", "60"]);
  assert.deepEqual(verbsOf(cli), ["sandbox list", "provider get", "provider update", "sandbox exec"]);
  assert.equal(cli.gateway.providers.get("pi-web-developer-github"), GH_TOKEN_B);

  // A failing mint is logged and tried again on the next tick; the worker keeps its old token until GitHub expires it.
  clock.now += 31 * 60_000;
  minter.failWith("GitHub App pi-web-developer: GET /repos/bry-guy/pi-web/installation did not answer (ETIMEDOUT)");
  cli.calls.length = 0;
  await provider.refreshGitHub();
  await provider.refreshGitHub();
  assert.equal(minter.asked.length, 4);
  assert.equal(logs.filter(l => l.includes("GitHub token refresh failed") && l.includes("ETIMEDOUT")).length, 2);
  assert.ok(!verbsOf(cli).includes("provider update"));
  noTokenIn(cli, logs);
});

test("a hung model feed does not hold up a role worker's GitHub token, and the token does not need a model login", async () => {
  const cli = fakeCli([roleSandbox("Stopped")]);
  // Calls about the model provider never return; everything else answers.
  const exec = (bin, args, opts) => (args.includes("pi-web-anthropic") ? never() : cli.exec(bin, args, opts));
  const { provider, minter } = roleProvider(cli, { exec, feedWaitMs: 5, settleWaitMs: 5 });
  await provider.setModelAuth(modelAuth(TOKEN_A));
  await provider.scale("web-dev", 1);
  assert.equal(minter.asked.length, 1);
  assert.equal(cli.gateway.providers.get("pi-web-developer-github"), GH_TOKEN_A);
  assert.ok(cli.calls.some(a => a[1] === "exec" && /openshell-github-auth\.json/.test(a.at(-1))));
});

test("workspaced answers 502 github_token_unavailable when a role worker cannot get its token", async () => {
  const cli = fakeCli();
  const { provider, minter } = roleProvider(cli);
  minter.failWith("GitHub App pi-web-developer: cannot read private-key of Secret pi-web-developer-github-app (ENOENT)");
  const routed = withOpenShell(fakePrimary([]), provider, { refreshMs: 0, log: () => {} });
  const lifecycle = createLifecycle({ provider: routed, idleMs: 0, sweepMs: 0, cacheMs: -1, log: () => {} });
  try {
    const app = createWorkspaced({ provider: routed, grants: ROLE_GRANTS, token: TOKEN, lifecycle });
    const res = await app.request("/v1/workspaces", json({ project: "web-dev", grant: "dev" }));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "github_token_unavailable", message: "GitHub App pi-web-developer: cannot read private-key of Secret pi-web-developer-github-app (ENOENT)" });
    assert.ok(!verbsOf(cli).includes("sandbox create"));
    // The same for a wake, whether asked for or caused by a request to the sleeping worker.
    cli.sandboxes.push(roleSandbox("Stopped"));
    await routed.refreshSandboxes();
    for (const route of ["/v1/workspaces/web-dev/wake", "/v1/workspaces/web-dev/api/sessions"]) {
      const woke = await app.request(route, json({}));
      assert.equal(woke.status, 502, route);
      assert.equal((await woke.json()).error, "github_token_unavailable", route);
    }
    assert.ok(!verbsOf(cli).includes("sandbox start"));
  } finally { lifecycle.stop(); }
});
