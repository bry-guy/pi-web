import { parse } from "yaml";
import { repoKey } from "./grants.js";
import { WORKSPACE_PORT } from "./manifests.js";

// Score resources: a repo's root score.yaml declares service dependencies
// (today: postgres). Each becomes a native sidecar in the worker's pod and its
// outputs become SCORE_RESOURCE_<ID>_<OUTPUT> env vars. See docs/score-resources.md.
export const SCORE_FILE = "score.yaml";
const RESOURCE_ID = /^[a-z][a-z0-9-]{0,30}$/;
const REF = /\$\{resources\.([a-z][a-z0-9-]{0,30})\.([a-z]+)\}/g;
// After repoKey strips github.com URLs, anything still holding a scheme, host or user is not GitHub.
const GITHUB_REPO = /^[^/\s:@]+\/[^/\s:@]+$/;
const PG_VERSION = /^\d{1,2}(\.\d{1,2})?$/;
const PG_DATABASE = /^[a-z_][a-z0-9_]{0,62}$/;
const PG_DATA = "/var/lib/postgresql/data";

function invalid(message) {
  return Object.assign(new Error(message), { status: 422, code: "invalid_score" });
}

function referencesOnlyResources(text) {
  return [...text.matchAll(REF)].length > 0 && !text.replace(REF, "").includes("${");
}

function envKey(text) {
  return text.toUpperCase().replace(/-/g, "_");
}

// Rejects params a provisioner does not know, so typos fail instead of being ignored.
function onlyParams(resource, allowed) {
  for (const key of Object.keys(resource.params)) {
    if (!allowed.includes(key)) throw invalid(`resource ${resource.id} (${resource.type}): unsupported param "${key}"`);
  }
}

// Each provisioner gets one declared resource and returns its sidecar (a
// native sidecar: initContainer with restartPolicy Always) and outputs. It
// owns its params: an unknown param is an error, never ignored.
const provisioners = {
  postgres(resource) {
    onlyParams(resource, ["version", "database", "port"]);
    const { id, params } = resource;
    const version = String(params.version ?? "17");
    if (!PG_VERSION.test(version)) throw invalid(`resource ${id}: postgres version "${version}" is not a major version like 17`);
    const database = params.database ?? id.replace(/-/g, "_");
    if (!PG_DATABASE.test(database)) throw invalid(`resource ${id}: database "${database}" must be a lowercase identifier`);
    const port = params.port ?? 5432;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw invalid(`resource ${id}: port must be an integer from 1024 to 65535`);
    const ready = { exec: { command: ["pg_isready", "-p", String(port)] } };
    const sidecar = {
      name: `res-${id}`,
      image: `postgres:${version}`,
      restartPolicy: "Always",
      // Trust auth is safe only because listen_addresses keeps the server on the pod's loopback.
      args: ["-p", String(port), "-c", "listen_addresses=localhost"],
      env: [{ name: "POSTGRES_HOST_AUTH_METHOD", value: "trust" }, { name: "POSTGRES_DB", value: database }],
      // The entrypoint runs as root only to fix ownership of the subPath, then drops to postgres.
      securityContext: { runAsUser: 0 },
      volumeMounts: [{ name: "data", mountPath: PG_DATA, subPath: `res/${id}` }],
      startupProbe: { ...ready, periodSeconds: 1, failureThreshold: 120 },
      readinessProbe: { ...ready, periodSeconds: 5 },
      resources: { limits: { memory: "512Mi" } },
    };
    const outputs = {
      host: "localhost", port, name: database, database, username: "postgres",
      url: `postgresql://postgres@localhost:${port}/${database}`,
    };
    return { sidecar, outputs, port };
  },
};

// Validates a parsed score.yaml and plans what the pod needs. Throws on any
// unknown type, unsupported param, or port clash, so a create fails clearly.
function plan(resources, variables) {
  const sidecars = [];
  const env = [];
  const outputsById = new Map();
  const ports = new Set([WORKSPACE_PORT]);
  for (const resource of resources) {
    const provision = Object.hasOwn(provisioners, resource.type) ? provisioners[resource.type] : null;
    if (!provision) throw invalid(`resource ${resource.id}: unknown type "${resource.type}" (supported: ${Object.keys(provisioners).join(", ")})`);
    const { sidecar, outputs, port } = provision(resource);
    if (ports.has(port)) throw invalid(`resource ${resource.id}: port ${port} is already used; set params.port`);
    ports.add(port);
    sidecars.push(sidecar);
    outputsById.set(resource.id, outputs);
    for (const [key, value] of Object.entries(outputs)) {
      env.push({ name: `SCORE_RESOURCE_${envKey(resource.id)}_${envKey(key)}`, value: String(value) });
    }
  }
  for (const [name, text] of variables) {
    const refs = [...text.matchAll(REF)];
    for (const [, id, key] of refs) {
      if (!outputsById.get(id)?.[key]) throw invalid(`variable ${name} references ${id}.${key}, which is not an output of a declared resource`);
    }
    env.push({ name, value: text.replace(REF, (_, id, key) => String(outputsById.get(id)[key])) });
  }
  const resourceList = resources.map(({ id, type }) => ({ id, type }));
  return { sidecars, env, resources: resourceList };
}

// Parses score.yaml text into a record (the canonical declaration, stored on the
// Deployment) and its plan. Returns null when there is nothing to provision.
export function scoreFromFile(text) {
  if (text == null) return null;
  let doc;
  try { doc = parse(text) ?? {}; } catch (e) { throw invalid(`${SCORE_FILE} is not valid YAML: ${e.message}`); }
  if (typeof doc !== "object" || Array.isArray(doc)) throw invalid(`${SCORE_FILE} must be a map`);
  const declared = doc.resources ?? {};
  if (typeof declared !== "object" || Array.isArray(declared)) throw invalid(`${SCORE_FILE}: resources must be a map`);
  const resources = Object.entries(declared).map(([id, r]) => {
    if (!RESOURCE_ID.test(id)) throw invalid(`resource ${id}: id must be lowercase letters, digits and dashes`);
    if (!r || typeof r !== "object" || typeof r.type !== "string") throw invalid(`resource ${id}: needs a type`);
    const params = r.params ?? {};
    if (typeof params !== "object" || Array.isArray(params)) throw invalid(`resource ${id}: params must be a map`);
    return { id, type: r.type, params };
  });
  const containers = doc.containers && typeof doc.containers === "object" ? doc.containers : {};
  const [first] = Object.values(containers);
  // Only variables built from ${resources.*} are kept (and so stored on the Deployment); the rest is app config, possibly secret.
  const variables = Object.entries(first?.variables && typeof first.variables === "object" ? first.variables : {})
    .filter(([, v]) => typeof v === "string" && referencesOnlyResources(v));
  if (!resources.length) return null;
  return scoreFromRecord(JSON.stringify({ resources, variables, container: Object.keys(containers)[0] ?? null }));
}

// Re-plans a stored record; used whenever a Deployment's template is rebuilt.
export function scoreFromRecord(record) {
  const { resources, variables, container } = JSON.parse(record);
  return { record, container, ...plan(resources, variables) };
}

// Reads score.yaml from a repository's default branch. null: no file, or a
// repository that is not on GitHub (no discovery there).
export function createScoreSource({ fetchImpl = globalThis.fetch } = {}) {
  let token = null;
  return {
    setToken(value) { token = value || null; },
    authenticated: () => !!token,
    async read(repository) {
      const key = repoKey(repository);
      if (!GITHUB_REPO.test(key)) return null;
      const [owner, name] = key.split("/");
      const headers = { accept: "application/vnd.github.raw", "x-github-api-version": "2022-11-28", "user-agent": "pi-ez-workspaced" };
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${SCORE_FILE}`,
        { headers, signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw Object.assign(new Error(`could not read ${SCORE_FILE} from ${key} (GitHub ${res.status})`), { status: 502, code: "score_unavailable" });
      return res.text();
    },
  };
}

// Declares a worker's resources on each start (wake) and restart, so score.yaml
// edits apply then. A read that fails keeps the pod as it is. A missing file
// without a GitHub token is ambiguous (private repos look missing), so it also keeps it.
export function withScore(provider, scores, grants, log = console.log) {
  if (!provider.setScore) return provider;
  async function apply(name) {
    const w = (await provider.list()).find(x => x.name === name);
    if (!w) return false;
    const text = await scores.read(w.repository);
    if (text === null && !scores.authenticated() && w.score) return false;
    const declared = scoreFromFile(text);
    if ((declared?.record ?? null) === (w.score?.record ?? null)) return false;
    const grant = grants[w.grant];
    if (!grant) throw new Error(`no such grant ${w.grant}`);
    await provider.setScore(name, grant, declared);
    log(`workspaced: ${name} score resources ${declared ? "updated" : "removed"}`);
    return true;
  }
  const attempt = (name, fallback) => apply(name).catch(e => { log(`workspaced: ${name} score.yaml not applied: ${e.message}`); return fallback; });
  return Object.assign(Object.create(provider), {
    async scale(name, replicas) {
      if (replicas > 0) await attempt(name, false);
      return provider.scale(name, replicas);
    },
    // A changed template rolls the pod already, so the plain restart is skipped.
    async restart(name) {
      if (!await attempt(name, false)) return provider.restart(name);
    },
  });
}
