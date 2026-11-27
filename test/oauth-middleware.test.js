import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import grpc from "@grpc/grpc-js";
import { openshellGateway } from "../oauth-middleware/openshell.js";
import { jwtVerifier, loadProto, serve } from "../oauth-middleware/server.js";
import { isTokenResponse, parseLogins, swapTokens } from "../oauth-middleware/swap.js";

// A non-Google provider on purpose: nothing here is specific to one service.
const logins = parseLogins({ logins: { acme: { tokenUrl: "https://auth.example.com/oauth/token", provider: "acme-login", access: "ACME_ACCESS", refresh: "ACME_REFRESH" } } });
const PH = { access: "openshell:resolve:env:v1:ACME_ACCESS", refresh: "openshell:resolve:env:v1:ACME_REFRESH" };
const target = { scheme: "https", host: "auth.example.com", port: 443, method: "POST", path: "/oauth/token", query: "" };

test("parseLogins rejects bad config", () => {
  assert.throws(() => parseLogins({}), /logins object/);
  assert.throws(() => parseLogins({ logins: { a: { tokenUrl: "http://x/t", provider: "p", access: "A" } } }), /https/);
  assert.throws(() => parseLogins({ logins: { a: { tokenUrl: "https://x/t", access: "A" } } }), /provider/);
  assert.throws(() => parseLogins({ logins: { a: { tokenUrl: "https://x/t", provider: "p", access: "a-b" } } }), /env var/);
  assert.equal(logins.acme.port, 443);
});

test("isTokenResponse matches only a successful POST to the token URL", () => {
  assert.ok(isTokenResponse(logins.acme, target, 200));
  assert.ok(!isTokenResponse(logins.acme, target, 400));
  assert.ok(!isTokenResponse(logins.acme, { ...target, method: "GET" }, 200));
  assert.ok(!isTokenResponse(logins.acme, { ...target, path: "/oauth/tokeninfo" }, 200));
  assert.ok(!isTokenResponse(logins.acme, { ...target, host: "evil.example.com" }, 200));
});

test("swapTokens replaces tokens in JSON and form bodies and keeps the rest", () => {
  const json = swapTokens(Buffer.from(JSON.stringify({ access_token: "real-a", refresh_token: "real-r", expires_in: 3599, id_token: "idt" })), PH);
  assert.deepEqual(json.real, { access: "real-a", refresh: "real-r" });
  assert.deepEqual(JSON.parse(json.body), { access_token: PH.access, refresh_token: PH.refresh, expires_in: 3599, id_token: "idt" });
  const form = swapTokens(Buffer.from("access_token=real-a&token_type=bearer"), PH);
  assert.equal(form.body.toString(), `access_token=${encodeURIComponent(PH.access)}&token_type=bearer`);
  assert.equal(swapTokens(Buffer.from('{"error":"x"}'), PH), null);
  assert.throws(() => swapTokens(Buffer.from("<html>"), PH), /neither JSON/);
  assert.throws(() => swapTokens(Buffer.from('{"refresh_token":"r"}'), { access: PH.access }), /keeps none/);
});

// --- gRPC: a real server and client over loopback.

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const AUD = "urn:openshell:extension:middleware:oauth";
function token(claims, key = privateKey) {
  const enc = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "EdDSA", typ: "openshell-ext+jwt" });
  const body = enc({ iss: "openshell-gateway:gw1", aud: AUD, exp: Date.now() / 1000 + 300, ...claims });
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), key).toString("base64url")}`;
}

async function harness(t, { placeholders = async () => PH, store = async () => {}, auth = jwtVerifier({ key: publicKey.export({ format: "pem", type: "spki" }), gatewayId: "gw1", audience: AUD }) } = {}) {
  const stored = [];
  const { server, port } = await serve({ address: "127.0.0.1:0", credentials: grpc.ServerCredentials.createInsecure(), logins, auth, log: () => {}, placeholders, store: async (l, real) => { await store(l, real); stored.push([l.name, real]); } });
  const pkg = loadProto();
  const hooks = new pkg.HttpHooks(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  const mw = new pkg.SupervisorMiddleware(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  t.after(() => { hooks.close(); mw.close(); server.forceShutdown(); });
  const md = claims => { const m = new grpc.Metadata(); if (claims) m.set("authorization", `Bearer ${token(claims)}`); return m; };
  // Runs one response exchange; returns every result the service sent.
  const exchange = (events, claims = { caller_kind: "supervisor", sandbox_id: "sb-1" }) => new Promise((resolve, reject) => {
    const results = [];
    const call = hooks.EvaluateHttpResponseHook(md(claims));
    call.on("data", r => {
      results.push(r);
      if (r.preflight_result?.inspect) { call.write({ begin: { headers: [] } }); call.write({ whole_body: { data: events.body, trailers: [] } }); }
    });
    call.on("end", () => resolve(results));
    call.on("error", reject);
    call.write({ preflight: { response: { target: events.target ?? target, status_code: events.status ?? 200, headers: [], request_headers: [] }, phase: "SUPERVISOR_MIDDLEWARE_PHASE_PRE_RETURN", context: { request_id: "r1", sandbox_id: "sb-1", sandbox: "ws-demo" }, middleware_name: "oauth", config: { fields: { login: { string_value: "acme" } } }, permitted_body_modes: ["HTTP_BODY_MODE_WHOLE_BODY"], limits: { max_whole_body_bytes: 1 << 20 } } });
  });
  return { exchange, stored, mw, md };
}

test("sign-in response: real tokens are stored, the sandbox gets placeholders", async t => {
  const h = await harness(t);
  const res = await h.exchange({ body: Buffer.from(JSON.stringify({ access_token: "ya-real", refresh_token: "1//real", expires_in: 3599 })) });
  assert.deepEqual(res[0].preflight_result.inspect.whole_body, { max_body_bytes: 65536 });
  const out = JSON.parse(Buffer.from(res[1].whole_body_result.replacement));
  assert.equal(out.access_token, PH.access);
  assert.equal(out.refresh_token, PH.refresh);
  assert.ok(!Buffer.from(res[1].whole_body_result.replacement).toString().includes("real"));
  assert.deepEqual(h.stored, [["acme", { access: "ya-real", refresh: "1//real" }]]);
});

test("other paths pass through unread", async t => {
  const h = await harness(t);
  const res = await h.exchange({ target: { ...target, path: "/userinfo" }, body: Buffer.from("{}") });
  assert.equal(res.length, 1);
  assert.ok(res[0].preflight_result.continue_without_body);
  assert.equal(h.stored.length, 0);
});

test("fails closed: wrong sandbox token, missing placeholders, store failure, unreadable body", async t => {
  const body = Buffer.from(JSON.stringify({ access_token: "ya-real" }));
  const blocked = r => r.at(-1).block_delivery?.diagnostics.reason_code;
  const h = await harness(t);
  assert.equal(blocked(await h.exchange({ body }, { caller_kind: "supervisor", sandbox_id: "sb-other" })), "unauthenticated");
  assert.equal(blocked(await h.exchange({ body }, null)), "unauthenticated");
  assert.equal(blocked(await h.exchange({ body: Buffer.from("<html>") })), "unreadable_token_response");
  const h2 = await harness(t, { placeholders: async () => { throw new Error("nope"); } });
  assert.equal(blocked(await h2.exchange({ body })), "placeholders_unavailable");
  const h3 = await harness(t, { store: async () => { throw new Error("gateway down"); } });
  assert.equal(blocked(await h3.exchange({ body })), "store_failed");
});

test("Describe and ValidateConfig", async t => {
  const h = await harness(t);
  const call = (m, req, claims = { caller_kind: "gateway" }) => new Promise((res, rej) => h.mw[m](req, h.md(claims), (e, r) => e ? rej(e) : res(r)));
  const gateway = { protocol_version: { major: 1, minor: 0 }, implementation_name: "openshell/gateway", implementation_version: "0.1.10", supported_capabilities: ["openshell.supervisor-middleware.contract", "openshell.supervisor-middleware.http-hooks"], required_capabilities: ["openshell.supervisor-middleware.contract"] };
  const m = await call("Describe", { gateway });
  assert.equal(m.bindings[0].operation, "SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_RESPONSE");
  assert.deepEqual(m.extension.required_capabilities, ["openshell.supervisor-middleware.contract", "openshell.supervisor-middleware.http-hooks"]);
  await assert.rejects(call("Describe", {}), /protocol 1/);
  await assert.rejects(call("Describe", { gateway }, null), /bearer/);
  assert.equal((await call("ValidateConfig", { config: { fields: { login: { string_value: "acme" } } } })).valid, true);
  assert.match((await call("ValidateConfig", { config: { fields: {} } })).reason, /acme/);
});

test("openshellGateway reads placeholders once per sandbox and stores tokens through the env only", async () => {
  const calls = [];
  const exec = async (_bin, args, opts) => {
    calls.push({ args, env: opts.env });
    if (args[1] === "get") return { stdout: JSON.stringify({ id: "sb-1" }) };
    if (args[1] === "exec") return { stdout: `${PH.access}\n${PH.refresh}\n` };
    return { stdout: "" };
  };
  const gw = openshellGateway({ exec });
  const ctx = { sandbox_id: "sb-1", sandbox: "ws-demo" };
  assert.deepEqual(await gw.placeholders(ctx, logins.acme), PH);
  assert.deepEqual(await gw.placeholders(ctx, logins.acme), PH);
  assert.equal(calls.length, 2);
  await assert.rejects(gw.placeholders({ sandbox_id: "sb-2", sandbox: "ws-demo" }, logins.acme), /is not sb-2/);
  await gw.store(logins.acme, { access: "ya-real" });
  const upd = calls.at(-1);
  assert.deepEqual(upd.args, ["provider", "update", "acme-login", "--credential", "ACME_ACCESS", "--wait", "--timeout", "25"]);
  assert.equal(upd.env.ACME_ACCESS, "ya-real");
  assert.ok(!upd.args.join(" ").includes("ya-real"));
  const bad = openshellGateway({ exec: async (_b, args) => ({ stdout: args[1] === "get" ? '{"id":"sb-1"}' : "real-token\nx\n" }) });
  await assert.rejects(bad.placeholders(ctx, logins.acme), /not provider placeholders/);
});
