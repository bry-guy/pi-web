// Entry point: node oauth-middleware/index.js. Settings are environment variables; see docs/oauth-middleware.md.
import { readFileSync } from "node:fs";
import grpc from "@grpc/grpc-js";
import { openshellGateway } from "./openshell.js";
import { jwtVerifier, serve } from "./server.js";
import { parseLogins } from "./swap.js";

const env = process.env;
const need = name => env[name] || (console.error(`oauth-middleware: ${name} is required`), process.exit(1));
const logins = parseLogins(JSON.parse(readFileSync(need("OAUTH_MIDDLEWARE_CONFIG"), "utf8")));
const insecure = env.OAUTH_MIDDLEWARE_INSECURE === "1";

const credentials = insecure ? grpc.ServerCredentials.createInsecure()
  : grpc.ServerCredentials.createSsl(null, [{ cert_chain: readFileSync(need("OAUTH_MIDDLEWARE_TLS_CERT")), private_key: readFileSync(need("OAUTH_MIDDLEWARE_TLS_KEY")) }], false);
const auth = insecure ? null : jwtVerifier({
  key: readFileSync(need("OAUTH_MIDDLEWARE_JWT_KEY"), "utf8"),
  gatewayId: need("OAUTH_MIDDLEWARE_GATEWAY_ID"),
  audience: env.OAUTH_MIDDLEWARE_AUDIENCE || `urn:openshell:extension:middleware:${env.OAUTH_MIDDLEWARE_NAME || "oauth"}`,
});
if (insecure) console.log("oauth-middleware: OAUTH_MIDDLEWARE_INSECURE=1: plaintext and no caller authentication");

const { port } = await serve({ address: `0.0.0.0:${env.PORT || 50051}`, credentials, logins, auth, ...openshellGateway() });
console.log(`oauth-middleware: serving logins ${Object.keys(logins).join(", ")} on port ${port}`);
