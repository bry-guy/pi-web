import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWorkspaced } from "../workspaced/index.js";
import { createScoreSource, scoreFromFile, scoreFromRecord, withScore } from "../workspaced/score.js";
import { deploymentManifest, SCORE_ANNOTATION } from "../workspaced/manifests.js";
import { declaredOf, kubernetesConfig, kubernetesProvider } from "../workspaced/kubernetes.js";
import { localProvider } from "../workspaced/local.js";
import { parseGrants } from "../workspaced/grants.js";

const TOKEN = "secret-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const POSTGRES = `
apiVersion: score.dev/v1b1
metadata:
  name: personal-finances
containers:
  web:
    image: .
    variables:
      DATABASE_URL: \${resources.db.url}
      LOG_LEVEL: debug
      SESSION_KEY: \${metadata.name}
resources:
  db:
    type: postgres
    params:
      version: 17
      database: finances
`;

const sidecarOf = declared => declared.sidecars.find(s => s.name === "res-db");

test("no score.yaml, or one without resources, declares nothing", () => {
  assert.equal(scoreFromFile(null), null);
  assert.equal(scoreFromFile("apiVersion: score.dev/v1b1\ncontainers: {web: {image: .}}\n"), null);
});

test("postgres becomes a native sidecar with a PVC subpath, trust auth, and a memory limit", () => {
  const declared = scoreFromFile(POSTGRES);
  const sidecar = sidecarOf(declared);
  assert.equal(sidecar.image, "postgres:17");
  assert.equal(sidecar.restartPolicy, "Always");
  assert.deepEqual(sidecar.volumeMounts, [{ name: "data", mountPath: "/var/lib/postgresql/data", subPath: "res/db" }]);
  assert.deepEqual(sidecar.resources, { limits: { memory: "512Mi" } });
  assert.deepEqual(sidecar.readinessProbe.exec.command, ["pg_isready", "-p", "5432"]);
  assert.ok(sidecar.args.includes("listen_addresses=localhost"), "trust auth must not listen beyond the pod");
  assert.deepEqual(sidecar.env, [{ name: "POSTGRES_HOST_AUTH_METHOD", value: "trust" }, { name: "POSTGRES_DB", value: "finances" }]);
  assert.equal(sidecar.envFrom, undefined);
  assert.equal(sidecar.secretRef, undefined);
});

test("outputs become SCORE_RESOURCE_* env, and only resource-built variables reach the workspace", () => {
  const { env, container } = scoreFromFile(POSTGRES);
  const value = name => env.find(e => e.name === name)?.value;
  assert.equal(value("SCORE_RESOURCE_DB_HOST"), "localhost");
  assert.equal(value("SCORE_RESOURCE_DB_PORT"), "5432");
  assert.equal(value("SCORE_RESOURCE_DB_DATABASE"), "finances");
  assert.equal(value("DATABASE_URL"), "postgresql://postgres@localhost:5432/finances");
  assert.equal(env.some(e => e.name === "LOG_LEVEL" || e.name === "SESSION_KEY"), false);
  assert.equal(container, "web");
});

test("the record keeps only what is needed to rebuild the pod, never app config", () => {
  const declared = scoreFromFile(POSTGRES);
  assert.equal(declared.record.includes("LOG_LEVEL"), false);
  assert.deepEqual(scoreFromRecord(declared.record).env, declared.env);
});

test("unknown types, params, ids, and clashing ports fail with a message naming the resource", () => {
  const doc = (resources, extra = "") => `resources:\n${resources}\n${extra}`;
  assert.throws(() => scoreFromFile(doc("  cache:\n    type: redis\n")), /cache: unknown type "redis" \(supported: postgres\)/);
  assert.throws(() => scoreFromFile(doc("  db:\n    type: postgres\n    params:\n      size: big\n")), /db \(postgres\): unsupported param "size"/);
  assert.throws(() => scoreFromFile(doc("  db:\n    type: postgres\n    params:\n      version: latest\n")), /postgres version "latest"/);
  assert.throws(() => scoreFromFile(doc("  db:\n    type: postgres\n    params:\n      port: 3141\n")), /port 3141 is already used/);
  assert.throws(() => scoreFromFile(doc("  db:\n    type: postgres\n  other:\n    type: postgres\n")), /other: port 5432 is already used/);
  assert.throws(() => scoreFromFile(doc("  DB:\n    type: postgres\n")), /id must be lowercase/);
  assert.throws(() => scoreFromFile(doc("  db: {}\n")), /db: needs a type/);
  assert.throws(() => scoreFromFile("resources: [\n"), /not valid YAML/);
  assert.throws(() => scoreFromFile(POSTGRES.replace("${resources.db.url}", "${resources.nope.url}")), /references nope\.url/);
  assert.throws(() => scoreFromFile(POSTGRES.replace("${resources.db.url}", "${resources.db.nope}")), /references db\.nope/);
});

test("without score.yaml the Deployment is byte-identical to the one workspaced always made", () => {
  const plain = deploymentManifest({ name: "srvivor", repository: "bry-guy/srvivor", image: "img:1" });
  const sandboxed = deploymentManifest({ name: "srvivor", repository: "bry-guy/srvivor", image: "img:1", grant: { name: "operator", env: ["operator-env"], serviceAccount: "infra-operator", egress: "open", runtimeClass: "kata" }, runtimeClassName: "kata", imagePullSecret: "ghcr-pull", envConfigMap: "cm", resources: { requests: { cpu: "250m" }, limits: { memory: "4Gi" } } });
  const golden = readFileSync(new URL("./fixtures/workspace-deployment.golden.json", import.meta.url), "utf8");
  assert.equal(JSON.stringify({ plain, sandboxed }, null, 2) + "\n", golden);
});

test("with score.yaml the Deployment gets sidecars, the injected env, and the record", () => {
  const d = deploymentManifest({ name: "fin", repository: "bry-guy/fin", image: "img:1", score: scoreFromFile(POSTGRES) });
  const pod = d.spec.template.spec;
  assert.equal(pod.initContainers[0].name, "res-db");
  assert.equal(pod.containers.length, 1, "no extra workspace containers");
  assert.ok(pod.containers[0].env.some(e => e.name === "DATABASE_URL"));
  assert.ok(pod.containers[0].env.some(e => e.name === "SCORE_RESOURCE_DB_URL"));
  assert.equal(d.metadata.annotations[SCORE_ANNOTATION], scoreFromFile(POSTGRES).record);
  assert.equal(declaredOf(d).resources[0].id, "db");
});

test("score sources read the default branch from GitHub, authenticated when a token is set", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.headers.authorization || null]);
    if (url.includes("missing")) return new Response("", { status: 404 });
    if (url.includes("broken")) return new Response("", { status: 500 });
    return new Response(POSTGRES, { status: 200 });
  };
  const scores = createScoreSource({ fetchImpl });
  assert.equal(await scores.read("https://github.com/bry-guy/fin.git"), POSTGRES);
  assert.equal(seen[0][0], "https://api.github.com/repos/bry-guy/fin/contents/score.yaml");
  assert.equal(seen[0][1], null);
  scores.setToken("gh-token");
  assert.equal(scores.authenticated(), true);
  await scores.read("bry-guy/fin");
  assert.equal(seen[1][1], "Bearer gh-token");
  assert.equal(await scores.read("bry-guy/missing"), null);
  await assert.rejects(scores.read("bry-guy/broken"), e => e.code === "score_unavailable" && e.status === 502);
  const before = seen.length;
  assert.equal(await scores.read("git@example.com:team/fin.git"), null, "non-GitHub repositories are not read");
  assert.equal(seen.length, before);
});

test("kubernetes create writes sidecars; local refuses score resources; a bad score.yaml fails before anything is created", async () => {
  const posted = [];
  const kube = { request: async (method, p, body) => { if (method === "POST") posted.push([p, body]); return { status: method === "POST" ? 201 : 404, body: {} }; } };
  const scores = { read: async () => POSTGRES, setToken() {}, authenticated: () => true };
  const app = createWorkspaced({ provider: kubernetesProvider({ kube, config: kubernetesConfig({}) }), token: TOKEN, scores });
  assert.equal((await app.request("/v1/workspaces", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ repository: "bry-guy/fin" }) })).status, 201);
  const deployment = posted.find(([p]) => p.endsWith("/deployments"))[1];
  assert.equal(deployment.spec.template.spec.initContainers[0].name, "res-db");

  const local = createWorkspaced({ provider: localProvider({ root: "/tmp/score-test-unused", spawnImpl: () => { throw new Error("no spawn"); } }), token: TOKEN, scores });
  const refused = await local.request("/v1/workspaces", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ repository: "bry-guy/fin" }) });
  assert.equal(refused.status, 501);
  assert.equal((await refused.json()).error, "score_unsupported");

  const broken = createWorkspaced({ provider: { create: async () => assert.fail("must not create") }, token: TOKEN, scores: { read: async () => POSTGRES.replace("type: postgres", "type: mysql") } });
  const res = await broken.request("/v1/workspaces", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ repository: "bry-guy/fin" }) });
  assert.equal(res.status, 422);
  assert.match((await res.json()).message, /unknown type "mysql"/);
});

test("waking or restarting applies a changed score.yaml; an unreadable one keeps the pod as it is", async () => {
  const calls = [];
  let text = POSTGRES;
  let current = null;
  const base = {
    list: async () => [{ name: "fin", repository: "bry-guy/fin", grant: "default", score: current }],
    setScore: async (name, grant, declared) => { calls.push(["setScore", name, grant.name, declared?.record ?? null]); current = declared && { record: declared.record, resources: declared.resources }; },
    scale: async (name, replicas) => calls.push(["scale", name, replicas]),
    restart: async name => calls.push(["restart", name]),
  };
  const scores = { read: async () => { if (text instanceof Error) throw text; return text; }, authenticated: () => true };
  const provider = withScore(base, scores, parseGrants(""), () => {});

  await provider.scale("fin", 1);
  assert.deepEqual(calls.map(c => c[0]), ["setScore", "scale"]);
  calls.length = 0;

  await provider.scale("fin", 1); // unchanged: nothing to apply
  assert.deepEqual(calls, [["scale", "fin", 1]]);
  calls.length = 0;

  text = `${POSTGRES}`.replace("version: 17", "version: 16");
  await provider.restart("fin"); // changed: the template change rolls the pod, so no second restart
  assert.deepEqual(calls.map(c => c[0]), ["setScore"]);
  assert.equal(scoreFromRecord(current.record).sidecars[0].image, "postgres:16");
  calls.length = 0;

  text = new Error("GitHub is down");
  await provider.scale("fin", 1);
  assert.deepEqual(calls, [["scale", "fin", 1]], "a failed read still wakes the worker");
  calls.length = 0;

  text = null; // missing file without a token may be a private repo: keep resources
  scores.authenticated = () => false;
  await provider.scale("fin", 1);
  assert.deepEqual(calls, [["scale", "fin", 1]]);
});

test("kubernetes setScore rebuilds the template; removing score.yaml nulls the sidecars and annotation", async () => {
  const seen = [];
  const withSidecars = { metadata: { annotations: { "pi-ez.dev/repository": "bry-guy/fin", [SCORE_ANNOTATION]: scoreFromFile(POSTGRES).record } }, spec: { replicas: 1, template: { spec: { containers: [{ name: "workspace", image: "img:1" }] } } } };
  const kube = { request: async (method, p, body, type) => {
    if (method === "GET") return { status: 200, body: withSidecars };
    seen.push([method, p, body, type]);
    return { status: 200, body: {} };
  } };
  const provider = kubernetesProvider({ kube, config: kubernetesConfig({}) });
  await provider.setScore("fin", parseGrants("").default, null);
  const patch = seen.at(-1)[2];
  assert.equal(patch.spec.template.spec.initContainers, null);
  assert.equal(patch.metadata.annotations[SCORE_ANNOTATION], null);

  await provider.setGrant("fin", parseGrants("").default);
  assert.ok(seen.at(-1)[2].spec.template.spec.initContainers.some(c => c.name === "res-db"), "a grant change keeps the declared resources");
});

test("kubernetes list reports each declared resource and whether its sidecar is up", async () => {
  const record = scoreFromFile(POSTGRES).record;
  const deployment = { metadata: { name: "ws-fin", labels: { "pi-ez.dev/workspace": "fin" }, annotations: { "pi-ez.dev/repository": "bry-guy/fin", "pi-ez.dev/grant": "default", [SCORE_ANNOTATION]: record } }, spec: { replicas: 1, template: { spec: { containers: [{ name: "workspace", image: "img", resources: {} }] } } }, status: { readyReplicas: 1 } };
  const pod = { metadata: { name: "ws-fin-1", labels: { "pi-ez.dev/workspace": "fin" }, creationTimestamp: "2026-01-01T00:00:00Z" }, status: { phase: "Running", initContainerStatuses: [{ name: "res-db", ready: true }] } };
  const kube = { request: async (method, p) => {
    if (p.includes("/deployments?")) return { status: 200, body: { items: [deployment] } };
    if (p.includes("/pods?")) return { status: 200, body: { items: [pod] } };
    return { status: 404, body: {} };
  } };
  const [w] = await kubernetesProvider({ kube, config: kubernetesConfig({}) }).list();
  assert.deepEqual(w.score, { record, resources: [{ id: "db", type: "postgres", ready: true }] });
});
