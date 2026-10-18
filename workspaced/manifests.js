export const MANAGED_BY = "pi-ez-workspaced";
export const NAME_LABEL = "pi-ez.dev/workspace";
export const REPO_ANNOTATION = "pi-ez.dev/repository";
export const PIN_ANNOTATION = "pi-ez.dev/keep-awake";
export const GRANT_ANNOTATION = "pi-ez.dev/grant";
export const EGRESS_LABEL = "pi-ez.dev/egress";
export const WORKSPACE_PORT = 3141;
export const GITHUB_SECRET = "pi-ez-github-auth";
const GITHUB_DIR = "/run/secrets/pi-ez-github";
export const MODEL_SECRET = "pi-ez-model-auth";
const MODEL_DIR = "/run/secrets/pi-ez-model";
const DATA = "/data";
const HOME = `${DATA}/pi-ez-operator-home`;
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

// Kubernetes quantities ("250m", "512Mi", "123456789n") as base units: cores, bytes.
const SUFFIX = { n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 };
export function quantity(text) {
  const m = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(String(text ?? ""));
  return m && (m[2] === "" || m[2] in SUFFIX) ? Number(m[1]) * (SUFFIX[m[2]] ?? 1) : null;
}

export function validName(name) {
  return typeof name === "string" && NAME_RE.test(name);
}

export function slugFromRepository(repository) {
  const last = String(repository || "").trim().replace(/\.git$/, "").replace(/\/+$/, "").split(/[/:]/).pop() || "";
  const slug = last.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return validName(slug) ? slug : null;
}

function meta(name, repository) {
  return {
    name: `ws-${name}`,
    labels: { "app.kubernetes.io/managed-by": MANAGED_BY, [NAME_LABEL]: name },
    annotations: { [REPO_ANNOTATION]: repository },
  };
}

export function pvcManifest({ name, repository, storage = "20Gi", storageClassName }) {
  return {
    apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: meta(name, repository),
    spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage } }, ...(storageClassName ? { storageClassName } : {}) },
  };
}

export function serviceManifest({ name, repository }) {
  return {
    apiVersion: "v1", kind: "Service", metadata: meta(name, repository),
    spec: { selector: { [NAME_LABEL]: name }, ports: [{ name: "http", port: WORKSPACE_PORT, targetPort: WORKSPACE_PORT }] },
  };
}

// The grant (see grants.js) supplies the ServiceAccount, env Secrets, egress
// label and runtime class; nothing else may give a worker credentials.
export function deploymentManifest({ name, repository, image, grant = { name: "default", env: [] }, runtimeClassName = null, envConfigMap = null, imagePullSecret = null, resources = {}, dindImage = "docker:28-dind" }) {
  if (!validName(name)) throw new Error("invalid workspace name");
  runtimeClassName = grant.runtimeClass || runtimeClassName;
  const serviceAccountName = grant.serviceAccount || null;
  const env = [
    ["PORT", String(WORKSPACE_PORT)], ["PI_WEB_MODE", "real"],
    // Shared conversations name the machine that last wrote them; a worker is "web-<project>" in that list.
    ["PI_SYNC_DEVICE_LABEL", `web-${name}`],
    ["HOME", HOME], ["XDG_CONFIG_HOME", `${HOME}/.config`], ["XDG_DATA_HOME", `${HOME}/.local/share`], ["XDG_CACHE_HOME", `${HOME}/.cache`],
    ["PI_WEB_HOME", `${DATA}/pi-ez-web`], ["PI_CODING_AGENT_DIR", `${DATA}/pi-ez-agent`], ["PI_WEB_REPOS_ROOT", `${DATA}/repos`],
    ["PI_WEB_GITHUB_AUTH_FILE", `${GITHUB_DIR}/github-auth.json`],
    ["PI_WEB_MODEL_AUTH_FILE", `${MODEL_DIR}/auth.json`],
    ...(runtimeClassName ? [["DOCKER_HOST", "tcp://127.0.0.1:2375"]] : []),
  ].map(([n, value]) => ({ name: n, value }));
  const envFrom = [
    ...(envConfigMap ? [{ configMapRef: { name: envConfigMap, optional: true } }] : []),
    // Optional: a grant may name Secrets the deployer hasn't filled yet.
    ...(grant.env || []).map(secret => ({ secretRef: { name: secret, optional: true } })),
  ];
  const containers = [{
    name: "workspace", image, env, resources, ...(envFrom.length ? { envFrom } : {}),
    ports: [{ name: "http", containerPort: WORKSPACE_PORT }],
    readinessProbe: { httpGet: { path: "/api/health", port: WORKSPACE_PORT }, periodSeconds: 1 },
    // Startup allows a slow sandbox boot (Kata) without liveness killing it;
    // liveness then restarts a worker that stops answering for a minute.
    startupProbe: { httpGet: { path: "/api/health", port: WORKSPACE_PORT }, periodSeconds: 1, failureThreshold: 300 },
    livenessProbe: { httpGet: { path: "/api/health", port: WORKSPACE_PORT }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 6 },
    volumeMounts: [{ name: "data", mountPath: DATA }, { name: "github", mountPath: GITHUB_DIR, readOnly: true }, { name: "model", mountPath: MODEL_DIR, readOnly: true }],
  }];
  if (runtimeClassName) {
    // Privileged is confined to the sandbox VM; never emit it without a runtime class.
    containers.push({
      name: "docker", image: dindImage,
      // Kata shares the PVC over virtio-fs, which overlayfs can't use as an upper dir, so
      // Docker's data lives in a sparse ext4 image on the PVC, loop-mounted inside the VM.
      // shortcut: apk fetches e2fsprogs on each start; bake a dind image if that bites.
      command: ["sh", "-ec", [
        "apk add -q e2fsprogs",
        "img=/docker-data/docker.img",
        "[ -f $img ] || { truncate -s 20G $img; mkfs.ext4 -q -E lazy_itable_init=1,lazy_journal_init=1,nodiscard $img; }",
        "mount -o loop $img /var/lib/docker",
        "exec dockerd-entrypoint.sh",
      ].join("\n")],
      env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }],
      securityContext: { privileged: true, runAsUser: 0 },
      volumeMounts: [{ name: "data", mountPath: "/docker-data", subPath: "docker" }],
    });
  }
  return {
    apiVersion: "apps/v1", kind: "Deployment",
    metadata: { ...meta(name, repository), annotations: { [REPO_ANNOTATION]: repository, [GRANT_ANNOTATION]: grant.name } },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { [NAME_LABEL]: name } },
      template: {
        metadata: { labels: { "app.kubernetes.io/managed-by": MANAGED_BY, [NAME_LABEL]: name, ...(grant.egress ? { [EGRESS_LABEL]: grant.egress } : {}) } },
        spec: {
          // Workers have no business discovering each other via injected *_SERVICE_HOST env.
          enableServiceLinks: false,
          ...(serviceAccountName ? { serviceAccountName, automountServiceAccountToken: true } : { automountServiceAccountToken: false }),
          ...(runtimeClassName ? { runtimeClassName } : {}),
          ...(imagePullSecret ? { imagePullSecrets: [{ name: imagePullSecret }] } : {}),
          securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
          containers,
          volumes: [
            { name: "data", persistentVolumeClaim: { claimName: `ws-${name}` } },
            // Optional so workspaces start before the first web login; kubelet refreshes it after.
            { name: "github", secret: { secretName: GITHUB_SECRET, optional: true, defaultMode: 0o440 } },
            { name: "model", secret: { secretName: MODEL_SECRET, optional: true, defaultMode: 0o440 } },
          ],
        },
      },
    },
  };
}
