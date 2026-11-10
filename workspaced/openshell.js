import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  return {
    endpoint: env.OPENSHELL_GATEWAY_ENDPOINT.replace(/\/+$/, ""),
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
    "--expose", String(WORKSPACE_PORT), "--detach", "--no-tty",
    "--label", `${MANAGED_LABEL}=${MANAGED_BY}`, "--label", `${NAME_LABEL}=${name}`,
    "--annotation", `${GRANT_ANNOTATION}=${grant?.name || DEFAULT_GRANT}`, "--annotation", `${IMAGE_ANNOTATION}=${config.image}`,
    ...(repository ? ["--annotation", `${REPO_ANNOTATION}=${repository}`] : []),
    ...env.flatMap(e => ["--env", `${e.name}=${e.value}`]),
    "--driver-config-json", JSON.stringify(driver),
    "--", "node", "/app/server/index.js",
  ];
}

const httpError = (message, status, code) => Object.assign(new Error(message), { status, code });

// One `sandbox list -o json` entry as a workspace.
function toWorkspace(s) {
  const state = PHASE_STATE[s.phase] || "starting";
  const failure = (s.conditions || []).find(c => c.message)?.message;
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
export function openshellProvider({ kube, config, exec = promisify(execFile), waitMs = 90_000, pollMs = 2_000 }) {
  const env = { ...process.env, OPENSHELL_GATEWAY_ENDPOINT: config.endpoint, OPENSHELL_WORKSPACE: config.workspace, OPENSHELL_COLOR: "never" };
  const pvcs = `/api/v1/namespaces/${config.namespace}/persistentvolumeclaims`;
  const endpoint = new URL(config.endpoint);
  // shortcut: pins live in memory (the CLI cannot change a sandbox's annotations); persist them if pinning sandboxes matters.
  const pinned = new Set();

  async function run(args, timeout = 120_000) {
    try {
      return (await exec(config.bin, args, { env, timeout, maxBuffer: 16 * 1024 * 1024 })).stdout;
    } catch (e) {
      const detail = String(e.stderr || e.message || "").replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").filter(Boolean).pop();
      throw httpError(`openshell ${args.slice(0, 2).join(" ")} failed: ${detail}`, 502, "openshell_error");
    }
  }

  async function list() {
    const out = JSON.parse(await run(["sandbox", "list", "-o", "json", "--selector", `${MANAGED_LABEL}=${MANAGED_BY}`]) || "{}");
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
        return;
      }
      await ensurePvc(name, repository);
      const dir = mkdtempSync(path.join(tmpdir(), "openshell-policy-"));
      try {
        const policyFile = path.join(dir, "policy.yaml");
        writeFileSync(policyFile, YAML.stringify(sandboxPolicy(grant)));
        // Waits for the sandbox and its exposed port; pulling the image can take minutes.
        await run(createArgs({ name, repository, grant, config, policyFile }), 600_000);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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
    upstream: name => ({
      url: config.endpoint,
      headers: { host: `${config.workspace}--ws-${name}.${config.serviceDomain}${endpoint.port ? `:${endpoint.port}` : ""}` },
    }),
    // Role credentials for sandbox workers are a later step: they get no GitHub or model login yet.
    async setGitHubAuth() {},
    async setModelAuth() {},
  };
}

// Routes each workspace to the provider that owns it: OpenShell for sandboxes it lists, the primary
// (local or kubernetes) for the rest. A grant with provider "openshell" creates a sandbox; without
// an OpenShell provider such a grant fails create. Names are unique across both.
export function withOpenShell(primary, openshell, { log = console.log } = {}) {
  const unconfigured = grant => grantError(`grant ${grant.name} needs the ${grant.provider} provider, which is not configured (set OPENSHELL_GATEWAY_ENDPOINT)`, 501, "provider_unconfigured");
  const mismatch = () => grantError("that grant uses another provider; remove the project and add it again with it", 409, "grant_provider_mismatch");
  if (!openshell) {
    const overrides = { async create(args) { if (args.grant?.provider) throw unconfigured(args.grant); return primary.create(args); } };
    if (primary.setGrant) overrides.setGrant = async (name, grant) => { if (grant?.provider) throw mismatch(); return primary.setGrant(name, grant); };
    return Object.assign(Object.create(primary), overrides);
  }

  let sandboxes = new Set(); // names OpenShell owns, from its last good list
  async function listSandboxes() {
    const found = await openshell.list();
    sandboxes = new Set(found.map(w => w.name));
    return found;
  }
  async function ownerOf(name) {
    if (!sandboxes.has(name)) await listSandboxes().catch(() => {});
    return sandboxes.has(name) ? openshell : primary;
  }
  const routed = method => async (name, ...args) => (await ownerOf(name))[method](name, ...args);

  const overrides = {
    async list() {
      // A gateway outage hides sandboxes from the list but never breaks the primary's workers.
      const [mine, theirs] = await Promise.all([primary.list(), listSandboxes().catch(e => { log(`workspaced: could not list OpenShell sandboxes: ${e.message}`); return []; })]);
      return [...mine, ...theirs.filter(w => !mine.some(m => m.name === w.name))];
    },
    async create(args) {
      const target = args.grant?.provider === "openshell" ? openshell : primary;
      const taken = target === openshell
        ? (await primary.list()).some(w => w.name === args.name)
        : (await listSandboxes().catch(() => null))?.some(w => w.name === args.name) ?? sandboxes.has(args.name);
      if (taken) throw grantError("workspace name taken", 409, "workspace_name_taken");
      await target.create(args);
      if (target === openshell) sandboxes.add(args.name);
    },
    scale: routed("scale"),
    restart: routed("restart"),
    reset: routed("reset"),
    setPinned: routed("setPinned"),
    async remove(name, opts) {
      await (await ownerOf(name)).remove(name, opts);
      sandboxes.delete(name);
    },
    upstream: name => (sandboxes.has(name) ? openshell : primary).upstream(name),
    async setGitHubAuth(auth) { await primary.setGitHubAuth(auth); await openshell.setGitHubAuth(auth); },
    async setModelAuth(content) { await primary.setModelAuth(content); await openshell.setModelAuth(content); },
  };
  if (primary.upgrade) overrides.upgrade = async name => { if (await ownerOf(name) === primary) return primary.upgrade(name); };
  // Score resources are sidecars, which only Deployment workers have.
  if (primary.setScore) overrides.setScore = async (name, ...args) => { if (await ownerOf(name) === primary) return primary.setScore(name, ...args); };
  if (primary.setGrant) {
    overrides.setGrant = async (name, grant) => {
      if (await ownerOf(name) === openshell) throw grantError("an OpenShell worker keeps the grant it was created with; remove the project and add it again", 409, "grant_provider_mismatch");
      if (grant?.provider) throw mismatch();
      return primary.setGrant(name, grant);
    };
  }
  return Object.assign(Object.create(primary), overrides);
}
