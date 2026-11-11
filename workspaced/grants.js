// Grant shapes: what a project's worker may hold. The pi-ez-web deployer
// defines them (WORKSPACED_GRANTS, JSON); projects only pick one. A grant is
// usable by any project (anyProject) or only by listed repositories, so
// powerful grants stay repo-locked even if web or a worker is compromised.
//
//   { "default":  { "anyProject": true },
//     "operator": { "repos": ["bry-guy/infra"], "namespace": "pi-ez-operator",
//                   "serviceAccount": "infra-operator", "env": ["operator-env"], "egress": "open" },
//     "agent":    { "anyProject": true, "provider": "openshell",
//                   "egress": [{ "host": "api.github.com", "port": 443 }],
//                   "providers": ["labrat-kube"], "environment": { "TZ": "UTC" },
//                   "packages": ["npm:@gotgenes/pi-anthropic-auth@3.4.4"] } }
import { workerEnv } from "./manifests.js";

const K8S_NAME = /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/;
const LABEL_VALUE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,61}[a-zA-Z0-9])?$/;
export const DEFAULT_GRANT = "default";
export const PROVIDERS = ["openshell"];
const HOST = /^[A-Za-z0-9*]([A-Za-z0-9*.-]{0,252})$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GATEWAY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
// The gateway provider workspaced feeds the model login into, attached to every sandbox when fed.
export const MODEL_PROVIDER = "pi-web-anthropic";
// Sandbox variables workspaced sets itself, beside workerEnv.
export const SANDBOX_ENV = ["HOST", "PI_ANTHROPIC_PLACEHOLDER_FILE", "PI_WEB_PACKAGES"];
const RESERVED_ENV = new Set([...workerEnv({ name: "x", repository: "project:x" }).map(e => e.name), ...SANDBOX_ENV]);
const KNOWN_KEYS = new Set(["anyProject", "repos", "env", "namespace", "serviceAccount", "runtimeClass", "provider", "egress", "description", "providers", "environment", "packages"]);
const OPENSHELL_ONLY = ["providers", "environment", "packages"];

// An OpenShell grant's gateway providers, plain environment and pi packages.
function parseSandboxFields(name, g) {
  const providers = g.providers ?? [];
  if (!Array.isArray(providers) || !providers.every(p => typeof p === "string" && GATEWAY_NAME.test(p))) fail(`${name}.providers must be gateway provider names`);
  if (providers.includes(MODEL_PROVIDER)) fail(`${name}.providers: ${MODEL_PROVIDER} is attached by workspaced; remove it`);
  const environment = g.environment ?? {};
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) fail(`${name}.environment must be an object of strings`);
  for (const [k, v] of Object.entries(environment)) {
    if (!ENV_KEY.test(k) || typeof v !== "string") fail(`${name}.environment.${k} must be a variable name with a string value`);
    // The CLI refuses OPENSHELL_* (reserved), and workspaced's own variables must not be overridden.
    if (k.startsWith("OPENSHELL_") || RESERVED_ENV.has(k)) fail(`${name}.environment.${k} is reserved`);
  }
  const packages = g.packages ?? [];
  if (!Array.isArray(packages) || !packages.every(p => typeof p === "string" && /^\S+$/.test(p) && !/^[./~]/.test(p))) fail(`${name}.packages must be pi package sources (npm:, git:, https:)`);
  return { providers: [...new Set(providers)], environment: { ...environment }, packages: [...new Set(packages)] };
}

// An OpenShell grant's egress: default deny, plus these endpoints.
function parseEgressRules(name, rules) {
  if (!Array.isArray(rules)) fail(`${name}.egress must be a list of {host, port} for provider openshell`);
  return rules.map((r, i) => {
    const at = `${name}.egress[${i}]`;
    if (!r || typeof r !== "object") fail(`${at} must be an object`);
    const unknown = Object.keys(r).filter(k => !["host", "port", "binaries", "allowEncodedSlash"].includes(k));
    if (unknown.length) fail(`${at} has unknown fields ${unknown.join(", ")}`);
    if (typeof r.host !== "string" || !HOST.test(r.host)) fail(`${at}.host is not a host name`);
    if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) fail(`${at}.port must be a port number`);
    if (r.binaries != null && !(Array.isArray(r.binaries) && r.binaries.every(b => typeof b === "string" && b.startsWith("/")))) fail(`${at}.binaries must be absolute paths`);
    if (r.allowEncodedSlash != null && typeof r.allowEncodedSlash !== "boolean") fail(`${at}.allowEncodedSlash must be true or false`);
    return { host: r.host, port: r.port, ...(r.binaries ? { binaries: r.binaries } : {}), ...(r.allowEncodedSlash ? { allowEncodedSlash: true } : {}) };
  });
}

function fail(message) { throw new Error(`WORKSPACED_GRANTS: ${message}`); }

export function parseGrants(text, { log = console.log } = {}) {
  const raw = text ? JSON.parse(text) : { [DEFAULT_GRANT]: { anyProject: true } };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("must be an object of grants");
  const grants = {};
  for (const [name, g] of Object.entries(raw)) {
    if (!K8S_NAME.test(name)) fail(`invalid grant name ${name}`);
    if (!g || typeof g !== "object") fail(`${name} must be an object`);
    for (const key of Object.keys(g)) if (!KNOWN_KEYS.has(key)) log(`workspaced: grant ${name} has an unknown field ${key}; it is ignored`);
    const repos = g.repos ?? [];
    const env = g.env ?? [];
    if (!Array.isArray(repos) || !repos.every(r => typeof r === "string" && r)) fail(`${name}.repos must be strings`);
    if (!Array.isArray(env) || !env.every(e => K8S_NAME.test(e))) fail(`${name}.env must be Secret names`);
    for (const key of ["namespace", "serviceAccount"]) if (g[key] != null && !K8S_NAME.test(g[key])) fail(`${name}.${key} is not a valid name`);
    // Refuse rather than silently drop: a grant that used to pick a sandbox must not quietly run without one.
    if (g.runtimeClass != null) fail(`${name}.runtimeClass is no longer supported; remove it from the grant`);
    if (g.provider != null && !PROVIDERS.includes(g.provider)) fail(`${name}.provider must be one of ${PROVIDERS.join(", ")}`);
    if (g.provider === "openshell") {
      // Refuse what an OpenShell worker cannot hold yet, rather than run without it.
      for (const key of ["namespace", "serviceAccount"]) if (g[key] != null) fail(`${name}.${key} is not supported with provider openshell`);
      if (env.length) fail(`${name}.env is not supported with provider openshell`);
    } else if (OPENSHELL_ONLY.some(k => g[k] != null)) {
      fail(`${name}.${OPENSHELL_ONLY.find(k => g[k] != null)} needs provider openshell`);
    } else if (g.egress != null && (typeof g.egress !== "string" || !LABEL_VALUE.test(g.egress))) fail(`${name}.egress is not a valid label value`);
    if (!g.anyProject && !repos.length) fail(`${name} needs anyProject or repos`);
    grants[name] = {
      name, anyProject: !!g.anyProject, repos, env,
      namespace: g.namespace || null, serviceAccount: g.serviceAccount || null,
      egress: g.provider === "openshell" ? parseEgressRules(name, g.egress ?? []) : g.egress || null,
      provider: g.provider || null,
      ...(g.provider === "openshell" ? parseSandboxFields(name, g) : {}),
      description: typeof g.description === "string" ? g.description : "",
    };
  }
  if (!grants[DEFAULT_GRANT]) fail(`a "${DEFAULT_GRANT}" grant is required`);
  return grants;
}

// "bry-guy/infra", "https://github.com/bry-guy/infra.git" and
// "git@github.com:bry-guy/infra" are the same repository.
export function repoKey(repository) {
  return String(repository || "").trim().toLowerCase()
    .replace(/\.git$/, "").replace(/\/+$/, "")
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?github\.com\//, "")
    .replace(/^git@github\.com:/, "");
}

export function grantAllows(grant, repository) {
  if (!grant) return false;
  if (grant.anyProject) return true;
  const key = repoKey(repository);
  return grant.repos.some(r => repoKey(r) === key);
}

export function grantError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

export function resolveGrant(grants, name, repository) {
  const grant = grants[name || DEFAULT_GRANT];
  if (!grant) throw grantError("no such grant", 400, "no_such_grant");
  if (!grantAllows(grant, repository)) throw grantError("this repository may not use that grant", 403, "grant_not_allowed");
  return grant;
}

// Re-check a worker's grant every time it wakes, so narrowing a grant in
// deploy code takes effect without trusting what was allowed at creation.
export function withGrantCheck(provider, grants) {
  return Object.assign(Object.create(provider), {
    async scale(name, replicas) {
      if (replicas > 0) {
        const w = (await provider.list()).find(x => x.name === name);
        if (w) resolveGrant(grants, w.grant, w.repository);
      }
      return provider.scale(name, replicas);
    },
  });
}
