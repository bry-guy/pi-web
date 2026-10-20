import { DEFAULT_GRANT } from "./grants.js";
import { deploymentManifest, GITHUB_SECRET, GRANT_ANNOTATION, MODEL_SECRET, pvcManifest, quantity, serviceManifest, MANAGED_BY, NAME_LABEL, PIN_ANNOTATION, REPO_ANNOTATION, SCORE_ANNOTATION, WORKSPACE_PORT } from "./manifests.js";
import { scoreFromRecord } from "./score.js";

const MERGE_PATCH = "application/merge-patch+json";
const USAGE_TTL_MS = 5_000;
const USAGE_TIMEOUT_MS = 2_000;
// Merges containers by name instead of replacing the list.
const STRATEGIC_PATCH = "application/strategic-merge-patch+json";

// The score declaration a Deployment was built from (its record annotation), re-planned; null if none.
export function declaredOf(d) {
  const record = d?.metadata?.annotations?.[SCORE_ANNOTATION];
  return record ? scoreFromRecord(record) : null;
}

export function deploymentState(d) {
  if ((d.spec?.replicas ?? 1) === 0) return "sleeping";
  return (d.status?.readyReplicas || 0) > 0 ? "running" : "starting";
}

// A sandbox (Kata VM) or container that hasn't started after this long is stuck,
// not slow; kubelet keeps retrying but the user should hear about it.
export const STUCK_START_MS = 3 * 60_000;
const WAITING_PROBLEMS = new Set(["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "CreateContainerError", "RunContainerError", "InvalidImageName"]);

// What, if anything, is wrong with a worker, from its pod. Works the same for
// runc and Kata: an OOM inside the VM is still a container OOMKilled, a VM the
// kernel or kubelet kills shows as a restart or eviction, and a VM that never
// boots leaves the pod in ContainerCreating (sandbox errors are only events).
export function podProblem(pod, now = Date.now()) {
  if (!pod) return null;
  const s = pod.status || {};
  const c = (s.containerStatuses || []).find(x => x.name === "workspace") || (s.containerStatuses || [])[0];
  const restarts = c?.restartCount || 0;
  const last = c?.lastState?.terminated;
  const recent = last && { reason: last.reason || `exit ${last.exitCode}`, exitCode: last.exitCode, at: last.finishedAt || null };
  const oom = recent && (recent.reason === "OOMKilled" || recent.exitCode === 137);
  const problem = (reason, message, fatal) => ({ reason, message, fatal, restarts, last: recent || null });
  if (s.phase === "Failed") return problem(s.reason || "Failed", s.message || "The worker's pod failed.", true);
  const unsched = (s.conditions || []).find(x => x.type === "PodScheduled" && x.status === "False");
  if (unsched) return problem("Unschedulable", `No node can run it: ${unsched.message || unsched.reason}`, true);
  const waiting = c?.state?.waiting;
  if (waiting && WAITING_PROBLEMS.has(waiting.reason)) {
    const message = oom ? "It keeps running out of memory." : waiting.message || waiting.reason;
    return problem(oom ? "OOMKilled" : waiting.reason, message, true);
  }
  const created = Date.parse(pod.metadata?.creationTimestamp || "") || now;
  if (!c?.state?.running && !c?.state?.terminated && now - created > STUCK_START_MS) {
    return problem("StuckStarting", "It has not started after 3 minutes; the sandbox may be failing to boot.", true);
  }
  if (oom) return problem("OOMKilled", "It ran out of memory and was restarted; the turn that was running was lost.", false);
  if (recent && restarts) return problem(recent.reason, `It crashed (${recent.reason}) and was restarted.`, false);
  return null;
}

// Workspaces as ws-<name> PVC + Service + Deployment. The cluster's labels and
// annotations are the record of what exists; workspaced keeps no database.
// Requests keep a worker's share of a shared node; the memory limit stops one
// worker from taking the node. No CPU limit by default. An empty value unsets one.
export function kubernetesConfig(env = process.env) {
  const namespace = env.WORKSPACED_NAMESPACE || "pi-workspaced";
  const set = values => Object.fromEntries(Object.entries(values).filter(([, v]) => v));
  return {
    namespace,
    image: env.WORKSPACE_IMAGE || "ghcr.io/bry-guy/pi-ez-web:latest",
    storage: env.WORKSPACE_STORAGE || "20Gi",
    storageClassName: env.WORKSPACE_STORAGE_CLASS || null,
    envConfigMap: env.WORKSPACE_ENV_CONFIGMAP || null,
    imagePullSecret: env.WORKSPACE_IMAGE_PULL_SECRET || null,
    resources: {
      requests: set({ cpu: env.WORKSPACE_CPU_REQUEST ?? "250m", memory: env.WORKSPACE_MEMORY_REQUEST ?? "512Mi" }),
      limits: set({ cpu: env.WORKSPACE_CPU_LIMIT ?? null, memory: env.WORKSPACE_MEMORY_LIMIT ?? "4Gi" }),
    },
  };
}

function httpError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

// Each grant may place workers in its own namespace (default: config.namespace),
// so a powerful grant's ServiceAccount and Secrets never share a namespace with
// ordinary workers.
export function kubernetesProvider({ kube, config = kubernetesConfig(), grants = {}, removeTimeoutMs = 90_000, removePollMs = 2_000 }) {
  const home = config.namespace;
  const namespaces = [...new Set([home, ...Object.values(grants).map(g => g.namespace).filter(Boolean)])];
  const nsOf = grant => grant?.namespace || home;
  const apps = ns => `/apis/apps/v1/namespaces/${ns}/deployments`;
  const core = (kind, ns = home) => `/api/v1/namespaces/${ns}/${kind}`;
  const selector = encodeURIComponent(`app.kubernetes.io/managed-by=${MANAGED_BY}`);
  const located = new Map(); // workspace name → namespace, refreshed by list/locate
  let usageCache = { at: -Infinity, value: null };

  // Workers mount these Secrets read-only; kubelet refreshes them after updates.
  // They live in every worker namespace.
  async function putSecretFile(name, key, content) {
    for (const ns of namespaces) {
      const path = `${core("secrets", ns)}/${name}`;
      if (content === null) {
        const res = await kube.request("DELETE", path);
        if (res.status >= 300 && res.status !== 404) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
        continue;
      }
      const secret = { apiVersion: "v1", kind: "Secret", metadata: { name }, type: "Opaque", stringData: { [key]: content } };
      let res = await kube.request("PUT", path, secret);
      if (res.status === 404) res = await kube.request("POST", core("secrets", ns), secret);
      if (res.status >= 300) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
    }
  }

  async function create(path, manifest) {
    const res = await kube.request("POST", path, manifest);
    if (res.status === 409 || (res.status >= 200 && res.status < 300)) return;
    throw httpError(res.body?.message || `kubernetes ${res.status}`, 502, "kubernetes_error");
  }

  // The worker's Deployment, wherever its grant put it; null if none.
  async function locate(name) {
    const order = located.has(name) ? [located.get(name), ...namespaces.filter(n => n !== located.get(name))] : namespaces;
    for (const ns of order) {
      const res = await kube.request("GET", `${apps(ns)}/ws-${name}`);
      if (res.status === 200) { located.set(name, ns); return { ns, deployment: res.body }; }
      if (res.status !== 404) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
    }
    located.delete(name);
    return null;
  }
  async function mustLocate(name) {
    const found = await locate(name);
    if (!found) throw httpError("no such workspace", 404, "no_such_workspace");
    return found;
  }
  async function patch(name, body, type = MERGE_PATCH) {
    const { ns } = await mustLocate(name);
    const res = await kube.request("PATCH", `${apps(ns)}/ws-${name}`, body, type);
    if (res.status === 404) throw httpError("no such workspace", 404, "no_such_workspace");
    if (res.status >= 300) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
  }

  // Rebuilds the pod template for a grant and score declaration. A merge patch keeps keys it doesn't
  // name, so initContainers is nulled out explicitly when there are no sidecars.
  async function retemplate(name, deployment, grant, score) {
    const repository = deployment.metadata.annotations?.[REPO_ANNOTATION];
    const fresh = deploymentManifest({ name, repository, image: deployment.spec.template.spec.containers[0].image, grant,
      runtimeClassName: deployment.spec.template.spec.runtimeClassName || null, envConfigMap: config.envConfigMap, imagePullSecret: config.imagePullSecret, resources: config.resources, score });
    const template = fresh.spec.template;
    template.spec.initContainers ??= null;
    // Merge patch replaces arrays (containers, envFrom) wholesale and keeps replicas.
    await patch(name, { metadata: { annotations: { [GRANT_ANNOTATION]: grant.name, [SCORE_ANNOTATION]: score?.record ?? null } }, spec: { template } });
  }

  // metrics-server's pod metrics for the workers; null when the API is missing or forbidden.
  async function readUsage() {
    const out = {};
    for (const ns of namespaces) {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("metrics timeout")), USAGE_TIMEOUT_MS).unref());
      const res = await Promise.race([kube.request("GET", `/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods?labelSelector=${selector}`), timeout]);
      if (res.status !== 200) return null;
      for (const pod of res.body?.items || []) {
        const name = pod.metadata?.labels?.[NAME_LABEL];
        if (!name) continue;
        const sum = out[name] ??= { cpuMillicores: 0, memoryBytes: 0 };
        for (const c of pod.containers || []) {
          sum.cpuMillicores += Math.round((quantity(c.usage?.cpu) || 0) * 1000);
          sum.memoryBytes += quantity(c.usage?.memory) || 0;
        }
      }
    }
    return out;
  }

  // Pods (and, with pvc, the PVC) are gone; the PVC holds unpushed work, so it's only waited on when asked.
  async function waitGone(ns, name, { pvc = false, timeoutMs = removeTimeoutMs } = {}) {
    const pods = `${core("pods", ns)}?labelSelector=${encodeURIComponent(`${NAME_LABEL}=${name}`)}`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const podRes = await kube.request("GET", pods);
      const pvcGone = !pvc || (await kube.request("GET", `${core("persistentvolumeclaims", ns)}/ws-${name}`)).status === 404;
      if (pvcGone && !(podRes.body?.items || []).length) return;
      if (Date.now() > deadline) throw httpError("workspace is still terminating", 504, "workspace_remove_timeout");
      await new Promise(r => setTimeout(r, removePollMs));
    }
  }

  // Newest pod per workspace; pods are optional context, never fatal to listing.
  async function podsByName(ns) {
    const res = await kube.request("GET", `${core("pods", ns)}?labelSelector=${selector}`);
    const byName = new Map();
    if (res.status !== 200) return byName;
    for (const pod of res.body.items || []) {
      const name = pod.metadata?.labels?.[NAME_LABEL];
      const prev = byName.get(name);
      if (!prev || (pod.metadata.creationTimestamp || "") > (prev.metadata.creationTimestamp || "")) byName.set(name, pod);
    }
    return byName;
  }

  return {
    async usage() {
      if (Date.now() - usageCache.at < USAGE_TTL_MS) return usageCache.value;
      const value = await readUsage().catch(() => null);
      usageCache = { at: Date.now(), value };
      return value;
    },
    async list() {
      const out = [];
      for (const ns of namespaces) {
        const res = await kube.request("GET", `${apps(ns)}?labelSelector=${selector}`);
        if (res.status !== 200) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
        const pods = await podsByName(ns);
        for (const d of res.body.items || []) {
          const name = d.metadata.labels?.[NAME_LABEL];
          located.set(name, ns);
          const problem = deploymentState(d) === "sleeping" ? null : podProblem(pods.get(name));
          const declared = declaredOf(d);
          const sidecars = pods.get(name)?.status?.initContainerStatuses || [];
          const awake = deploymentState(d) !== "sleeping";
          out.push({
            problem,
            name,
            repository: d.metadata.annotations?.[REPO_ANNOTATION] || null,
            grant: d.metadata.annotations?.[GRANT_ANNOTATION] || DEFAULT_GRANT,
            ready: (d.status?.readyReplicas || 0) > 0,
            state: deploymentState(d),
            pinned: d.metadata.annotations?.[PIN_ANNOTATION] === "true",
            containers: !!d.spec?.template?.spec?.runtimeClassName,
            resources: d.spec?.template?.spec?.containers?.[0]?.resources ?? null,
            outdated: d.spec?.template?.spec?.containers?.[0]?.image !== config.image,
            score: declared && {
              record: declared.record,
              resources: declared.resources.map(r => ({ ...r, ready: awake && !!sidecars.find(s => s.name === `res-${r.id}`)?.ready })),
            },
          });
        }
      }
      return out;
    },
    scale: (name, replicas) => patch(name, { spec: { replicas } }),
    // Restarts an awake worker; a sleeping one just starts on it next wake.
    upgrade: name => patch(name, { spec: { template: { spec: { containers: [{ name: "workspace", image: config.image, resources: config.resources }] } } } }, STRATEGIC_PATCH),
    // The annotation is the record; workspaced keeps no database.
    setPinned: (name, pinned) => patch(name, { metadata: { annotations: { [PIN_ANNOTATION]: pinned ? "true" : null } } }),
    async create({ name, repository, grant, runtimeClassName = null, score = null }) {
      const existing = await locate(name);
      if (existing && existing.deployment.metadata?.annotations?.[REPO_ANNOTATION] !== repository) {
        throw httpError("workspace name taken", 409, "workspace_name_taken");
      }
      const ns = existing?.ns || nsOf(grant);
      if (ns !== nsOf(grant)) throw httpError("this workspace was created with a grant in another namespace; remove it first", 409, "grant_namespace_mismatch");
      await create(core("persistentvolumeclaims", ns), pvcManifest({ name, repository, storage: config.storage, storageClassName: config.storageClassName }));
      await create(core("services", ns), serviceManifest({ name, repository }));
      await create(apps(ns), deploymentManifest({ name, repository, image: config.image, grant, runtimeClassName,
        envConfigMap: config.envConfigMap, imagePullSecret: config.imagePullSecret, resources: config.resources, score }));
      located.set(name, ns);
    },
    // Re-grant in place. The PVC can't move namespaces, so a grant with another
    // namespace means remove + re-add (a fresh clone).
    async setGrant(name, grant) {
      const { ns, deployment } = await mustLocate(name);
      if (ns !== nsOf(grant)) throw httpError("that grant runs in another namespace; remove the project and add it again with it", 409, "grant_namespace_mismatch");
      await retemplate(name, deployment, grant, declaredOf(deployment));
    },
    // Score resources (sidecars and their env) take effect when the pod next starts.
    async setScore(name, grant, declared) {
      const { deployment } = await mustLocate(name);
      await retemplate(name, deployment, grant, declared);
    },
    async remove(name, { purge = false } = {}) {
      const ns = (await locate(name))?.ns || home;
      // The PVC holds unpushed work; keep it unless explicitly purged.
      const paths = [`${apps(ns)}/ws-${name}`, `${core("services", ns)}/ws-${name}`, ...(purge ? [`${core("persistentvolumeclaims", ns)}/ws-${name}`] : [])];
      for (const path of paths) {
        const res = await kube.request("DELETE", path);
        if (res.status >= 300 && res.status !== 404) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
      }
      // Return only once the pod (and purged PVC) are gone, so a re-add starts clean.
      await waitGone(ns, name, { pvc: purge });
      located.delete(name);
    },
    // A new pod with the same volume; the rollout annotation is what kubectl rollout restart sets.
    restart: name => patch(name, { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } } }),
    // Scale to zero, drop the PVC, and bring up a fresh clone. Stays awake.
    async reset(name) {
      const { ns, deployment } = await mustLocate(name);
      const repository = deployment.metadata.annotations?.[REPO_ANNOTATION];
      await patch(name, { spec: { replicas: 0 } });
      await waitGone(ns, name);
      const res = await kube.request("DELETE", `${core("persistentvolumeclaims", ns)}/ws-${name}`);
      if (res.status >= 300 && res.status !== 404) throw httpError(`kubernetes ${res.status}`, 502, "kubernetes_error");
      await waitGone(ns, name, { pvc: true });
      await create(core("persistentvolumeclaims", ns), pvcManifest({ name, repository, storage: config.storage, storageClassName: config.storageClassName }));
      await patch(name, { spec: { replicas: 1 } });
    },
    upstream: name => `http://ws-${name}.${located.get(name) || home}.svc.cluster.local:${WORKSPACE_PORT}`,
    setGitHubAuth: auth => putSecretFile(GITHUB_SECRET, "github-auth.json", auth ? JSON.stringify(auth) : null),
    setModelAuth: content => putSecretFile(MODEL_SECRET, "auth.json", content),
  };
}
