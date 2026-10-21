// Grant shapes: what a project's worker may hold. The pi-ez-web deployer
// defines them (WORKSPACED_GRANTS, JSON); projects only pick one. A grant is
// usable by any project (anyProject) or only by listed repositories, so
// powerful grants stay repo-locked even if web or a worker is compromised.
//
//   { "default":  { "anyProject": true },
//     "operator": { "repos": ["bry-guy/infra"], "namespace": "pi-ez-operator",
//                   "serviceAccount": "infra-operator", "env": ["operator-env"], "egress": "open" } }
const K8S_NAME = /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/;
const LABEL_VALUE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,61}[a-zA-Z0-9])?$/;
export const DEFAULT_GRANT = "default";

function fail(message) { throw new Error(`WORKSPACED_GRANTS: ${message}`); }

export function parseGrants(text) {
  const raw = text ? JSON.parse(text) : { [DEFAULT_GRANT]: { anyProject: true } };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("must be an object of grants");
  const grants = {};
  for (const [name, g] of Object.entries(raw)) {
    if (!K8S_NAME.test(name)) fail(`invalid grant name ${name}`);
    if (!g || typeof g !== "object") fail(`${name} must be an object`);
    const repos = g.repos ?? [];
    const env = g.env ?? [];
    if (!Array.isArray(repos) || !repos.every(r => typeof r === "string" && r)) fail(`${name}.repos must be strings`);
    if (!Array.isArray(env) || !env.every(e => K8S_NAME.test(e))) fail(`${name}.env must be Secret names`);
    for (const key of ["namespace", "serviceAccount"]) if (g[key] != null && !K8S_NAME.test(g[key])) fail(`${name}.${key} is not a valid name`);
    // Refuse rather than silently drop: a grant that used to pick a sandbox must not quietly run without one.
    if (g.runtimeClass != null) fail(`${name}.runtimeClass is no longer supported; remove it from the grant`);
    if (g.egress != null && !LABEL_VALUE.test(g.egress)) fail(`${name}.egress is not a valid label value`);
    if (!g.anyProject && !repos.length) fail(`${name} needs anyProject or repos`);
    grants[name] = {
      name, anyProject: !!g.anyProject, repos, env,
      namespace: g.namespace || null, serviceAccount: g.serviceAccount || null,
      egress: g.egress || null,
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
