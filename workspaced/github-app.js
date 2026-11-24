// GitHub App installation tokens for role workers (docs/workspaced.md#github-as-a-roles-bot). workspaced holds
// the App's key and mints a one-hour token limited to a grant's repositories and permissions. Nothing here
// logs, and no error message carries the key, the JWT or a token.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const unavailable = message => Object.assign(new Error(message), { status: 502, code: "github_token_unavailable" });

// RS256 App JWT. GitHub accepts at most 10 minutes; iat is a minute back for clock drift.
export function appJwt({ appId, privateKey, now = Date.now() }) {
  const part = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(now / 1000) - 60;
  const body = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat, exp: iat + 600, iss: String(appId) })}`;
  return `${body}.${sign("sha256", Buffer.from(body), privateKey).toString("base64url")}`;
}

// repos: ["owner/name", …] of one owner; permissions: { contents: "write", … }. Resolves { token, expiresAt (ms) }.
// GitHub refuses a repository the installation lacks and a permission the App lacks (422), so a grant can only narrow.
export async function mintInstallationToken({ app, appId, privateKey, repos, permissions, fetchImpl = fetch, api = "https://api.github.com", now = Date.now }) {
  let key = null;
  try { key = createPrivateKey(privateKey); } catch { /* reported below, without the parser's text */ }
  if (key?.asymmetricKeyType !== "rsa") throw unavailable(`GitHub App ${app}: private-key is not an RSA private key in PEM form`);
  if (!/^\d+$/.test(appId)) throw unavailable(`GitHub App ${app}: app-id is not a number`);
  const jwt = appJwt({ appId, privateKey: key, now: now() });
  async function call(method, route, body) {
    let res;
    try {
      res = await fetchImpl(`${api}${route}`, {
        method, signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${jwt}`, "user-agent": "pi-web-workspaced", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw unavailable(`GitHub App ${app}: ${method} ${route} did not answer (${e.cause?.code || e.name})`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw unavailable(`GitHub App ${app}: ${method} ${route} answered ${res.status}${typeof data?.message === "string" ? ` (${data.message.replaceAll(jwt, "[redacted]").slice(0, 200)})` : ""}`);
    return data;
  }
  const installation = await call("GET", `/repos/${repos[0]}/installation`);
  if (!Number.isInteger(installation?.id)) throw unavailable(`GitHub App ${app}: no installation id for ${repos[0]}`);
  const made = await call("POST", `/app/installations/${installation.id}/access_tokens`, { repositories: repos.map(r => r.split("/")[1]), permissions });
  const expiresAt = Date.parse(made?.expires_at);
  if (typeof made?.token !== "string" || !made.token || /\s/.test(made.token) || !(expiresAt > now())) throw unavailable(`GitHub App ${app}: GitHub answered without a usable token`);
  return { token: made.token, expiresAt };
}

// dir/<app>-github-app/{app-id,private-key}: the Secret <app>-github-app as mounted. Read at every mint, so a
// rotated key needs no restart. Returns mint({ app, repos, permissions }).
export function githubAppMinter({ dir, ...options }) {
  return async ({ app, repos, permissions }) => {
    const read = file => {
      try { return readFileSync(path.join(dir, `${app}-github-app`, file), "utf8").trim(); } catch (e) {
        throw unavailable(`GitHub App ${app}: cannot read ${file} of Secret ${app}-github-app (${e.code || "error"})`);
      }
    };
    return mintInstallationToken({ app, appId: read("app-id"), privateKey: read("private-key"), repos, permissions, ...options });
  };
}
