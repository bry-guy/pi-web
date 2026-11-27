// OpenShell supervisor middleware (HTTP hooks, protocol 1.0) that keeps OAuth tokens out of sandboxes: on a login's token
// endpoint it stores the real tokens in a gateway provider and hands the sandbox that provider's placeholders instead.
// docs/oauth-middleware.md describes the whole setup.
import { createPublicKey, verify as verifySignature } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { isTokenResponse, swapTokens } from "./swap.js";

const NAME = "pi-web/oauth-middleware";
const CONTRACT = "openshell.supervisor-middleware.contract";
const HTTP_HOOKS = "openshell.supervisor-middleware.http-hooks";
// Token responses are small; this also caps what a body costs in memory.
const MAX_BODY = 64 * 1024;
// Storing tokens waits for the sandboxes' supervisors to take the new value (provider update --wait).
const TIMEOUT_S = 30;

const PROTO = path.join(path.dirname(fileURLToPath(import.meta.url)), "proto");
export function loadProto() {
  const def = protoLoader.loadSync("supervisor_middleware.proto", { includeDirs: [PROTO], keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  return grpc.loadPackageDefinition(def).openshell.middleware.v1;
}

// Checks OpenShell's extension token (docs: extensibility/overview "Authenticating Extensions"). Returns its claims.
export function jwtVerifier({ key, gatewayId, audience, now = () => Date.now() / 1000 }) {
  const publicKey = typeof key === "string" && key.trim().startsWith("{") ? createPublicKey({ key: JSON.parse(key), format: "jwk" }) : createPublicKey(key);
  const b64 = s => Buffer.from(s, "base64url");
  return metadata => {
    const auth = String(metadata.get("authorization")[0] || "");
    const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(auth);
    if (!m) throw new Error("no bearer token");
    const header = JSON.parse(b64(m[1]));
    if (header.alg !== "EdDSA" || header.typ !== "openshell-ext+jwt") throw new Error("unexpected token type");
    if (!verifySignature(null, Buffer.from(`${m[1]}.${m[2]}`), publicKey, b64(m[3]))) throw new Error("bad signature");
    const claims = JSON.parse(b64(m[2]));
    if (!(claims.exp > now())) throw new Error("token expired");
    if (claims.nbf != null && claims.nbf > now() + 60) throw new Error("token not yet valid");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new Error("wrong audience");
    if (claims.iss !== `openshell-gateway:${gatewayId}`) throw new Error("wrong issuer");
    return claims;
  };
}

// logins: parseLogins output. placeholders(context, login) -> {access, refresh} for that sandbox. store(login, real)
// saves the real tokens. auth(metadata) -> claims, or null to run without authentication.
export function middlewareService({ logins, placeholders, store, auth = null, log = console.log }) {
  const pkg = loadProto();
  const check = (call, sandboxId) => {
    if (!auth) return;
    const claims = auth(call.metadata);
    if (sandboxId !== undefined && (claims.caller_kind !== "supervisor" || claims.sandbox_id !== sandboxId)) throw new Error("token is not from this sandbox");
  };
  const unauthenticated = (cb, e) => cb({ code: grpc.status.UNAUTHENTICATED, message: e.message });

  const supervisorMiddleware = {
    Describe(call, cb) {
      try { check(call); } catch (e) { return unauthenticated(cb, e); }
      const gw = call.request.gateway;
      if (!gw || gw.protocol_version?.major !== 1) return cb({ code: grpc.status.FAILED_PRECONDITION, message: "gateway did not provide protocol 1.x metadata" });
      if (!(gw.supported_capabilities || []).includes(HTTP_HOOKS)) return cb({ code: grpc.status.FAILED_PRECONDITION, message: `gateway lacks ${HTTP_HOOKS}` });
      cb(null, {
        name: NAME, service_version: "1",
        bindings: [{ operation: "SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_RESPONSE", phase: "SUPERVISOR_MIDDLEWARE_PHASE_PRE_RETURN", max_payload_bytes: MAX_BODY, request_timeout: { seconds: TIMEOUT_S } }],
        expected_audience: "",
        extension: { protocol_version: { major: 1, minor: 0 }, implementation_name: NAME, implementation_version: "1", supported_capabilities: [CONTRACT, HTTP_HOOKS], required_capabilities: [CONTRACT, HTTP_HOOKS] },
      });
    },
    ValidateConfig(call, cb) {
      try { check(call); } catch (e) { return unauthenticated(cb, e); }
      const login = call.request.config?.fields?.login?.stringValue;
      cb(null, logins[login] ? { valid: true, reason: "" } : { valid: false, reason: `config.login must be one of: ${Object.keys(logins).join(", ") || "(none configured)"}` });
    },
    EvaluateHttpRequest(_call, cb) { cb({ code: grpc.status.UNIMPLEMENTED, message: "HTTP hooks only" }); },
    EvaluateWebSocketSession(call) { call.emit("error", { code: grpc.status.UNIMPLEMENTED, message: "HTTP hooks only" }); },
  };

  const httpHooks = {
    EvaluateHttpRequestHook(call) { call.destroy({ code: grpc.status.UNIMPLEMENTED, message: "response hooks only" }); },
    EvaluateHttpResponseHook(call) {
      let login = null, context = null, done = false;
      const send = result => { if (!done) call.write(result); };
      const end = result => { send(result); done = true; call.end(); };
      const block = (reason, code) => end({ block_delivery: { diagnostics: { reason, reason_code: code } } });
      call.on("data", async event => {
        try {
          if (event.preflight) {
            const p = event.preflight;
            context = p.context || {};
            try { check(call, context.sandbox_id); } catch (e) { return block(e.message, "unauthenticated"); }
            const configured = p.config?.fields?.login?.stringValue;
            login = logins[configured];
            if (!login) return block(`unknown login ${configured}`, "unknown_login");
            const t = p.response?.target || {};
            if (!isTokenResponse(login, t, p.response?.status_code)) return end({ preflight_result: { continue_without_body: {} } });
            const max = Math.min(MAX_BODY, Number(p.limits?.max_whole_body_bytes || 0));
            if (!p.permitted_body_modes.includes("HTTP_BODY_MODE_WHOLE_BODY") || !max) return block("token response body is not inspectable", "uninspectable");
            return send({ preflight_result: { inspect: { whole_body: { max_body_bytes: max } } } });
          }
          if (event.whole_body && login) {
            let ph, swapped;
            try { ph = await placeholders(context, login); } catch (e) { log(`oauth-middleware: ${login.name}: no placeholders for sandbox ${context.sandbox}: ${e.message}`); return block("placeholders unavailable", "placeholders_unavailable"); }
            try { swapped = swapTokens(event.whole_body.data, ph); } catch (e) { return block(e.message, "unreadable_token_response"); }
            if (!swapped) return end({ whole_body_result: { unchanged: {} } });
            try { await store(login, swapped.real); } catch (e) { log(`oauth-middleware: ${login.name}: storing tokens failed: ${e.message}`); return block("could not store tokens", "store_failed"); }
            log(`oauth-middleware: ${login.name}: stored ${Object.keys(swapped.real).join(" and ")} token for sandbox ${context.sandbox}`);
            return end({ whole_body_result: { replacement: swapped.body, header_mutations: [] } });
          }
          if (event.session_end) { done = true; call.end(); }
        } catch (e) { block(`internal error: ${e.message}`, "internal_error"); }
      });
      call.on("end", () => { if (!done) { done = true; call.end(); } });
      call.on("error", () => { done = true; });
    },
  };
  return { pkg, supervisorMiddleware, httpHooks };
}

// Starts the gRPC server; resolves to {server, port}.
export function serve({ address, credentials, ...service }) {
  const { pkg, supervisorMiddleware, httpHooks } = middlewareService(service);
  const server = new grpc.Server({ "grpc.max_receive_message_length": 1 << 20, "grpc.max_send_message_length": 1 << 20 });
  server.addService(pkg.SupervisorMiddleware.service, supervisorMiddleware);
  server.addService(pkg.HttpHooks.service, httpHooks);
  return new Promise((resolve, reject) => server.bindAsync(address, credentials, (e, port) => e ? reject(e) : resolve({ server, port })));
}
