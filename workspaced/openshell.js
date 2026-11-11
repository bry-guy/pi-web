import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { createSecureContext } from "node:tls";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { DEFAULT_GRANT, grantError } from "./grants.js";
import { DATA, MANAGED_BY, pvcManifest, WORKSPACE_PORT, workerEnv } from "./manifests.js";

// Workers as NVIDIA OpenShell sandboxes (CLI 0.1.7), driven through the `openshell` CLI. A sandbox
// named ws-<name> runs the worker image with the PVC ws-<name> at /data, exposes the worker port
// through the gateway, and gets a policy built from its grant. The gateway's sandbox list (labels and
// annotations) is the record; workspaced keeps no database. See docs/workspaced.md#openshell.

// The worker image's node. A rule's binaries also match their child processes, so node covers
// everything the worker runs (pi, git, the bash tool).
const NODE = "/usr/local/bin/node";
const MANAGED_LABEL = "pi-ez-managed-by";
const NAME_LABEL = "pi-ez-workspace";
const REPO_ANNOTATION = "pi-ez-repository";
const GRANT_ANNOTATION = "pi-ez-grant";
const IMAGE_ANNOTATION = "pi-ez-image";
const PHASE_STATE = { Ready: "running", Stopped: "sleeping", Stopping: "sleeping", Suspended: "sleeping", Suspending: "sleeping", Error: "failed" };

export function openshellConfig(env = process.env) {
  if (!env.OPENSHELL_GATEWAY_ENDPOINT) return null;
  const endpoint = env.OPENSHELL_GATEWAY_ENDPOINT.replace(/\/+$/, "");
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || "", ".config");
  return {
    endpoint,
    gateway: env.OPENSHELL_GATEWAY || null,
    configHome: env.XDG_CONFIG_HOME || null,
    // The CLI's own client bundle for that gateway: an https endpoint is mutual TLS.
    tlsDir: endpoint.startsWith("https:") && env.OPENSHELL_GATEWAY ? path.join(configHome, "openshell", "gateways", env.OPENSHELL_GATEWAY, "mtls") : null,
    workspace: env.OPENSHELL_WORKSPACE || "default",
    bin: env.OPENSHELL_BIN || "openshell",
    namespace: env.OPENSHELL_NAMESPACE || "openshell",
    serviceDomain: env.OPENSHELL_SERVICE_DOMAIN || "openshell.localhost",
    image: env.WORKSPACE_IMAGE || "ghcr.io/bry-guy/pi-ez-web:latest",
    storage: env.WORKSPACE_STORAGE || "20Gi",
    storageClassName: env.WORKSPACE_STORAGE_CLASS || null,
  };
}

// Base (as the spike's worker-policy.yaml: the app read-only, /data the only writable data) plus the
// grant's egress rules. No rule, no network: OpenShell denies by default.
export function sandboxPolicy(grant) {
  const policy = {
    version: 1,
    filesystem_policy: {
      include_workdir: true,
      read_only: ["/bin", "/usr", "/lib", "/proc", "/dev/urandom", "/etc", "/var/log", "/app"],
      read_write: ["/tmp", "/dev/null", DATA],
    },
    landlock: { compatibility: "best_effort" },
  };
  const rules = Array.isArray(grant?.egress) ? grant.egress : [];
  if (rules.length) {
    policy.network_policies = Object.fromEntries(rules.map((r, i) => [`egress-${i + 1}`, {
      name: `${r.host}:${r.port}`,
      endpoints: [{ host: r.host, port: r.port, protocol: "rest", enforcement: "enforce", access: "full", ...(r.allowEncodedSlash ? { allow_encoded_slash: true } : {}) }],
      binaries: (r.binaries || [NODE]).map(p => ({ path: p })),
    }]));
  }
  return policy;
}

// The argv after `openshell` that creates a worker's sandbox (flags as in the spike's run.sh t3).
export function createArgs({ name, repository, grant, config, policyFile }) {
  const env = [...workerEnv({ name, repository }), { name: "HOST", value: "127.0.0.1" }];
  const driver = { kubernetes: {
    volumes: [{ name: "data", persistent_volume_claim: { claim_name: `ws-${name}`, read_only: false } }],
    containers: { agent: { volume_mounts: [{ name: "data", mount_path: DATA, read_only: false }] } },
  } };
  return [
    "sandbox", "create", "--name", `ws-${name}`, "--from", config.image, "--policy", policyFile,
    "--expose", String(WORKSPACE_PORT), "--detach", "--no-tty", "--restart-policy", "on-failure",
    "--label", `${MANAGED_LABEL}=${MANAGED_BY}`, "--label", `${NAME_LABEL}=${name}`,
    "--annotation", `${GRANT_ANNOTATION}=${grant?.name || DEFAULT_GRANT}`, "--annotation", `${IMAGE_ANNOTATION}=${config.image}`,
    ...(repository ? ["--annotation", `${REPO_ANNOTATION}=${repository}`] : []),
    ...env.flatMap(e => ["--env", `${e.name}=${e.value}`]),
    "--driver-config-json", JSON.stringify(driver),
    "--", "node", "/app/server/index.js",
  ];
}

const httpError = (message, status, code) => Object.assign(new Error(message), { status, code });

// The client bundle as the CLI lays it out (a kubernetes.io/tls Secret's keys). Returns a getter for
// { agent, error }: files are re-read only when a stat (at most every checkMs) shows they changed,
// as when a rotated Secret is remounted. One log line per change between usable and not.
export function mtlsAgent(dir, { log = console.log, checkMs = 30_000, now = Date.now } = {}) {
  const files = ["ca.crt", "tls.crt", "tls.key"].map(f => path.join(dir || "", f));
  let checked = -Infinity;
  let state = { sig: null, agent: null, error: null };
  function load() {
    try {
      if (!dir) throw new Error("OPENSHELL_GATEWAY is not set");
      const sig = files.map(f => { const s = statSync(f); return `${s.ino}:${s.mtimeMs}:${s.size}`; }).join();
      if (sig === state.sig) return;
      const [ca, cert, key] = files.map(f => readFileSync(f));
      createSecureContext({ ca, cert, key }); // throws on unparsable PEM or a key that isn't the cert's
      if (state.error) log(`workspaced: OpenShell mTLS bundle at ${dir} is usable again`);
      // Old agents are left to finish their streams; without keepAlive they hold no idle sockets.
      state = { sig, agent: new https.Agent({ ca, cert, key }), error: null };
    } catch (e) {
      if (!state.error) log(`workspaced: OpenShell mTLS bundle at ${dir} is unusable (${e.message}); sandbox workers answer 502 openshell_tls_unavailable until it is fixed`);
      state = { sig: null, agent: null, error: e.message };
    }
  }
  return () => {
    if (now() - checked >= checkMs) { checked = now(); load(); }
    return state;
  };
}

// One `sandbox list -o json` entry as a workspace.
function toWorkspace(s) {
  const state = PHASE_STATE[s.phase] || "starting";
  // The first condition with a message is usually "Sandbox is not suspended"; the failing one is False.
  const failure = (s.conditions || []).find(c => c.status === "False" && c.type !== "Suspended" && c.message)?.message;
  return {
    name: s.labels?.[NAME_LABEL] || null,
    provider: "openshell",
    repository: s.annotations?.[REPO_ANNOTATION] || null,
    grant: s.annotations?.[GRANT_ANNOTATION] || DEFAULT_GRANT,
    image: s.annotations?.[IMAGE_ANNOTATION] || null,
    phase: s.phase,
    ready: s.phase === "Ready",
    state,
    problem: state === "failed" ? { reason: "SandboxError", message: failure || "The sandbox reported an error.", fatal: true, restarts: 0, last: null } : null,
    pinned: false,
    resources: null,
    // shortcut: no upgrade (a new image means delete + create); add it when OpenShell workers outlive an image.
    outdated: false,
  };
}

// exec(bin, args, {env, timeout}) resolves { stdout, stderr }: execFile's promise form, injectable for tests.
export function openshellProvider({ kube, config, exec = promisify(execFile), waitMs = 90_000, pollMs = 2_000, log = console.log, tlsCheckMs = 30_000 }) {
  // The CLI gets only what it reads: never workspaced's own token or the workers' secrets.
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|HOME|XDG_CONFIG_HOME|OPENSHELL_.*)$/.test(k)));
  const env = {
    ...own, OPENSHELL_GATEWAY_ENDPOINT: config.endpoint, OPENSHELL_WORKSPACE: config.workspace, OPENSHELL_COLOR: "never",
    ...(config.gateway ? { OPENSHELL_GATEWAY: config.gateway } : {}), ...(config.configHome ? { XDG_CONFIG_HOME: config.configHome } : {}),
  };
  const pvcs = `/api/v1/namespaces/${config.namespace}/persistentvolumeclaims`;
  const endpoint = new URL(config.endpoint);
  const tls = endpoint.protocol === "https:" ? mtlsAgent(config.tlsDir, { log, checkMs: tlsCheckMs }) : null;
  tls?.(); // logs a bad bundle at startup
  // shortcut: pins live in memory (the CLI cannot change a sandbox's annotations); persist them if pinning sandboxes matters.
  const pinned = new Set();

  async function run(args, timeout = 120_000) {
    try {
      return (await exec(config.bin, args, { env, timeout, maxBuffer: 16 * 1024 * 1024 })).stdout;
    } catch (e) {
      const detail = String(e.stderr || (e.killed ? "timed out" : `exit ${e.code ?? "unknown"}`)).replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").filter(Boolean).pop();
      throw httpError(`openshell ${args.slice(0, 2).join(" ")} failed: ${detail}`, 502, "openshell_error");
    }
  }

  async function list() {
    const out = JSON.parse(await run(["sandbox", "list", "-o", "json", "--selector", `${MANAGED_LABEL}=${MANAGED_BY}`], 10_000) || "{}");
    // shortcut: one page (100 sandboxes); follow next_page_token if a gateway ever holds more workers.
    return (out.sandboxes || []).map(toWorkspace).filter(w => w.name).map(w => ({ ...w, pinned: pinned.has(w.name) }));
  }
  async function mustFind(name) {
    const w = (await list()).find(x => x.name === name);
    if (!w) throw httpError("no such workspace", 404, "no_such_workspace");
    return w;
  }
  async function waitFor(check, what) {
    const deadline = Date.now() + waitMs;
    while (!await check()) {
      if (Date.now() > deadline) throw httpError(`timed out waiting for ${what}`, 504, "openshell_timeout");
      await new Promise(r => setTimeout(r, pollMs));
    }
  }
  const stopped = name => waitFor(async () => (await mustFind(name)).phase === "Stopped", `ws-${name} to stop`);

  // The PVC OpenShell attaches: the labels mark it attachable to this workspace. An existing one is used as is.
  async function ensurePvc(name, repository) {
    const got = await kube.request("GET", `${pvcs}/ws-${name}`);
    if (got.status === 200) return;
    if (got.status !== 404) throw httpError(`kubernetes ${got.status}`, 502, "kubernetes_error");
    const pvc = pvcManifest({ name, repository, storage: config.storage, storageClassName: config.storageClassName });
    Object.assign(pvc.metadata.labels, { "openshell.ai/sandbox-attachable": "true", "openshell.ai/sandbox-attachable-workspace": config.workspace });
    const res = await kube.request("POST", pvcs, pvc);
    if (res.status >= 300 && res.status !== 409) throw httpError(res.body?.message || `kubernetes ${res.status}`, 502, "kubernetes_error");
  }
  async function deletePvc(name) {
    const res = await kube.request("DELETE", `${pvcs}/ws-${name}`);
    if (res.status >= 300 && res.status !== 404) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
    await waitFor(async () => (await kube.request("GET", `${pvcs}/ws-${name}`)).status === 404, `PVC ws-${name} to go`);
  }

  return {
    list,
    async create({ name, repository, grant, score = null }) {
      if (score) throw httpError("score.yaml resources need a Kubernetes worker, not an OpenShell one", 501, "score_unsupported");
      const existing = (await list()).find(w => w.name === name);
      if (existing) {
        if ((existing.repository ?? null) !== (repository ?? null)) throw httpError("workspace name taken", 409, "workspace_name_taken");
        return existing;
      }
      await ensurePvc(name, repository);
      const dir = mkdtempSync(path.join(tmpdir(), "openshell-policy-"));
      try {
        const policyFile = path.join(dir, "policy.yaml");
        writeFileSync(policyFile, YAML.stringify(sandboxPolicy(grant)));
        // --detach returns once OpenShell has the sandbox (~7 s), not when the worker answers; wake waits for it.
        await run(createArgs({ name, repository, grant, config, policyFile }), 600_000);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      // What the gateway will list, until it does.
      return toWorkspace({ phase: "Provisioning", labels: { [NAME_LABEL]: name }, annotations: { [GRANT_ANNOTATION]: grant?.name || DEFAULT_GRANT, [IMAGE_ANNOTATION]: config.image, ...(repository ? { [REPO_ANNOTATION]: repository } : {}) } });
    },
    async scale(name, replicas) {
      const w = await mustFind(name);
      if (replicas === 0 && w.state !== "sleeping") await run(["sandbox", "stop", `ws-${name}`]);
      if (replicas > 0 && w.state === "sleeping") await run(["sandbox", "start", `ws-${name}`]);
    },
    // New pod, same disk: stop, then start once it has stopped.
    async restart(name) {
      await run(["sandbox", "stop", `ws-${name}`]);
      await stopped(name);
      await run(["sandbox", "start", `ws-${name}`]);
    },
    // Wipe the disk: stop, drop and recreate the PVC, start. Stays awake, as the kubernetes provider's reset.
    async reset(name) {
      const w = await mustFind(name);
      await run(["sandbox", "stop", `ws-${name}`]);
      await stopped(name);
      await deletePvc(name);
      await ensurePvc(name, w.repository);
      await run(["sandbox", "start", `ws-${name}`]);
    },
    // The PVC holds unpushed work; it goes only when purged.
    async remove(name, { purge = false } = {}) {
      await run(["sandbox", "delete", `ws-${name}`]);
      pinned.delete(name);
      if (purge) await deletePvc(name);
    },
    async setPinned(name, on) {
      if (on) pinned.add(name); else pinned.delete(name);
    },
    // The gateway routes an exposed service by Host: <workspace>--<sandbox>.<domain>[:gateway port].
    upstream: name => {
      const { agent, error } = tls?.() || {};
      return {
        url: config.endpoint,
        headers: { host: `${config.workspace}--ws-${name}.${config.serviceDomain}${endpoint.port ? `:${endpoint.port}` : ""}` },
        ...(tls ? { agent } : {}),
        ...(error ? { error: { code: "openshell_tls_unavailable", message: `OpenShell client certificate unusable: ${error}` } } : {}),
      };
    },
    // Role credentials for sandbox workers are a later step: they get no GitHub or model login yet.
    async setGitHubAuth() {},
    async setModelAuth() {},
  };
}

// Routes each workspace to the provider that owns it: OpenShell for sandboxes it lists, the primary
// (local or kubernetes) for the rest. A grant with provider "openshell" creates a sandbox; without
// an OpenShell provider such a grant fails create. Names are unique across both.
// Sandboxes come from a cached list refreshed every refreshMs and after each change made here, so
// listing and routing never wait on the CLI.
export function withOpenShell(primary, openshell, { log = console.log, refreshMs = 10_000 } = {}) {
  const unconfigured = grant => grantError(`grant ${grant.name} needs the ${grant.provider} provider, which is not configured (set OPENSHELL_GATEWAY_ENDPOINT)`, 501, "provider_unconfigured");
  const mismatch = () => grantError("that grant uses another provider; remove the project and add it again with it", 409, "grant_provider_mismatch");
  if (!openshell) {
    const overrides = { async create(args) { if (args.grant?.provider) throw unconfigured(args.grant); return primary.create(args); } };
    if (primary.setGrant) overrides.setGrant = async (name, grant) => { if (grant?.provider) throw mismatch(); return primary.setGrant(name, grant); };
    return Object.assign(Object.create(primary), overrides);
  }

  let sandboxes = new Map(); // name → workspace, from OpenShell's last good list
  let seq = 0, changedAt = 0, running = false, down = null;
  // A list that started before a change made here is stale when it lands, so it is dropped.
  async function refresh() {
    const started = ++seq;
    running = true;
    try {
      const found = await openshell.list();
      if (started > changedAt) sandboxes = new Map(found.map(w => [w.name, w]));
      if (down) log("workspaced: OpenShell gateway is reachable again");
      down = null;
    } catch (e) {
      // A gateway outage keeps the last list and never touches the primary's workers.
      if (!down) log(`workspaced: could not list OpenShell sandboxes: ${e.message}`);
      down = e.message;
    } finally { if (started === seq) running = false; }
  }
  const changed = () => { changedAt = ++seq; refresh(); };
  refresh();
  if (refreshMs) setInterval(() => { if (!running) refresh(); }, refreshMs).unref?.();

  const ownerOf = name => (sandboxes.has(name) ? openshell : primary);
  const routed = method => async (name, ...args) => {
    const owner = ownerOf(name);
    try { return await owner[method](name, ...args); } finally { if (owner === openshell) changed(); }
  };

  const overrides = {
    refreshSandboxes: refresh,
    async list() {
      const mine = await primary.list();
      return [...mine, ...[...sandboxes.values()].filter(w => !mine.some(m => m.name === w.name))];
    },
    async create(args) {
      const target = args.grant?.provider === "openshell" ? openshell : primary;
      const taken = target === openshell ? (await primary.list()).some(w => w.name === args.name) : sandboxes.has(args.name);
      if (taken) throw grantError("workspace name taken", 409, "workspace_name_taken");
      const made = await target.create(args);
      if (target === openshell) {
        if (made && !sandboxes.has(args.name)) sandboxes = new Map(sandboxes).set(args.name, made);
        changed();
      }
    },
    scale: routed("scale"),
    restart: routed("restart"),
    reset: routed("reset"),
    setPinned: routed("setPinned"),
    async remove(name, opts) {
      const owner = ownerOf(name);
      await owner.remove(name, opts);
      if (owner === openshell) {
        sandboxes = new Map(sandboxes);
        sandboxes.delete(name);
        changed();
      }
    },
    upstream: name => ownerOf(name).upstream(name),
    async setGitHubAuth(auth) { await primary.setGitHubAuth(auth); await openshell.setGitHubAuth(auth); },
    async setModelAuth(content) { await primary.setModelAuth(content); await openshell.setModelAuth(content); },
  };
  if (primary.upgrade) overrides.upgrade = async name => { if (ownerOf(name) === primary) return primary.upgrade(name); };
  // Score resources are sidecars, which only Deployment workers have.
  if (primary.setScore) overrides.setScore = async (name, ...args) => { if (ownerOf(name) === primary) return primary.setScore(name, ...args); };
  if (primary.setGrant) {
    overrides.setGrant = async (name, grant) => {
      if (ownerOf(name) === openshell) throw grantError("an OpenShell worker keeps the grant it was created with; remove the project and add it again", 409, "grant_provider_mismatch");
      if (grant?.provider) throw mismatch();
      return primary.setGrant(name, grant);
    };
  }
  return Object.assign(Object.create(primary), overrides);
}
