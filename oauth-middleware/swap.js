// Token-response rewriting for OAuth logins whose real tokens stay on the OpenShell gateway (docs/oauth-middleware.md).
// Pure: no I/O, so the gRPC server and the tests share it.

// A login from the service config: the token endpoint it watches, the gateway provider that holds its tokens, and the
// provider credential keys (also the sandbox env names of their placeholders).
export function parseLogins(raw) {
  const logins = raw?.logins;
  if (!logins || typeof logins !== "object" || Array.isArray(logins)) throw new Error("config needs a logins object");
  const out = {};
  for (const [name, l] of Object.entries(logins)) {
    const at = `logins.${name}`;
    let url;
    try { url = new URL(l?.tokenUrl); } catch { throw new Error(`${at}.tokenUrl must be a URL`); }
    if (url.protocol !== "https:" || url.search || url.hash) throw new Error(`${at}.tokenUrl must be an https URL without query or fragment`);
    for (const k of ["provider", "access"]) if (typeof l[k] !== "string" || !l[k]) throw new Error(`${at}.${k} is required`);
    for (const k of ["access", "refresh"]) if (l[k] != null && !/^[A-Z_][A-Z0-9_]*$/.test(l[k])) throw new Error(`${at}.${k} must be an env var name`);
    out[name] = { name, host: url.hostname, port: Number(url.port || 443), path: url.pathname, provider: l.provider, access: l.access, refresh: l.refresh || null };
  }
  return out;
}

// Whether a response is a token endpoint's answer worth reading: a successful POST to the login's token URL.
export function isTokenResponse(login, { host, port, method, path }, status) {
  return status >= 200 && status < 300 && method === "POST" && host === login.host && Number(port) === login.port && path === login.path;
}

// Reads a token response (JSON, or form-encoded as some older endpoints answer) and puts the placeholders in place of
// the real tokens. Returns null when the body holds no token. Throws on a body it cannot read, so the caller blocks it:
// an unreadable token response may still carry a token.
export function swapTokens(body, placeholders) {
  const text = Buffer.from(body).toString("utf8");
  let fields, form = false;
  try { fields = JSON.parse(text); } catch {
    if (!/^[\w.%+-]+=/.test(text)) throw new Error("token response is neither JSON nor a form");
    fields = Object.fromEntries(new URLSearchParams(text));
    form = true;
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("token response is not an object");
  const real = {};
  if (typeof fields.access_token === "string" && fields.access_token) real.access = fields.access_token;
  if (typeof fields.refresh_token === "string" && fields.refresh_token) real.refresh = fields.refresh_token;
  if (!real.access && !real.refresh) return null;
  if (real.refresh && !placeholders.refresh) throw new Error("token response has a refresh token but the login keeps none");
  const swapped = { ...fields };
  if (real.access) swapped.access_token = placeholders.access;
  if (real.refresh) swapped.refresh_token = placeholders.refresh;
  const out = form ? new URLSearchParams(swapped).toString() : JSON.stringify(swapped);
  return { real, body: Buffer.from(out, "utf8") };
}
