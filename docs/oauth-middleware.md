# oauth-middleware: OAuth logins without tokens in the sandbox

Some CLIs sign in with OAuth and keep their own tokens: gcloud, the Antigravity CLI (`agy`), Azure CLI, app logins for
Slack or Linear. Run one in an [OpenShell sandbox worker](workspaced.md#openshell) and its real access and refresh
tokens normally land on the sandbox's disk, where anything in the sandbox can read and exfiltrate them.

`oauth-middleware` keeps them on the gateway instead. The CLI signs in and refreshes as usual, and sees only
placeholders. Nothing about it is specific to one CLI or identity provider.

## How it works

Each login has a gateway provider with two credentials, an access token and a refresh token, both with
`stable_placeholder: true`. A sandbox with the provider attached gets a placeholder for each in its environment.

| Step | What happens |
|---|---|
| Sign-in | The CLI exchanges its authorization code at the token endpoint. The response passes through the middleware (an OpenShell supervisor middleware, HTTP response hook), which stores the real tokens in the provider (`openshell provider update --wait`) and replaces them in the body with that sandbox's placeholders. |
| API calls | The CLI sends `Authorization: Bearer <placeholder>`; the sandbox supervisor puts the real access token in, only for the hosts the provider's profile lists. |
| Refresh | The CLI posts its refresh token (the placeholder) to the token endpoint; the profile's `request_body_credential_rewrite` makes the supervisor put the real one in. The response goes through the middleware like a sign-in. |

The middleware reads a sandbox's placeholders once (`openshell sandbox exec … printenv`, after checking the sandbox's
id) and caches them. It only reads responses with a 2xx status to a `POST` on a login's exact token URL; everything
else passes through unread. When it cannot do its job (no placeholders, the gateway refused the update, a body it can't
parse) it blocks the response, so a real token never reaches the sandbox by accident. It authenticates every call with
the gateway's extension token and refuses a response from a sandbox other than the token's.

The gateway refuses to start while a registered middleware is unavailable, so it runs as its own Deployment
(`deploy/k8s/workspaced/oauth-middleware.yaml`), not inside workspaced.

## Setting up a login

1. **Login config** (`deploy/k8s/workspaced/oauth-logins.json`): the token URL, the provider, and the credential keys,
   which are also the sandbox's environment variable names.

   ```json
   { "logins": { "acme": { "tokenUrl": "https://auth.example.com/oauth/token", "provider": "acme-login",
                           "access": "ACME_ACCESS_TOKEN", "refresh": "ACME_REFRESH_TOKEN" } } }
   ```

2. **Provider profile and provider** on the gateway (admin, once). Both credentials need `env_vars`, `stable_placeholder:
   true`, and `auth_style: bearer`; the token endpoint needs `request_body_credential_rewrite: true`; the API hosts are
   the other endpoints. Create the provider with any non-empty values, since the first sign-in overwrites them:
   `ACME_ACCESS_TOKEN=signed-out ACME_REFRESH_TOKEN=signed-out openshell provider create --name acme-login --type acme-login --credential ACME_ACCESS_TOKEN --credential ACME_REFRESH_TOKEN`.

3. **Grant** (`WORKSPACED_GRANTS`): attach the provider, allow the hosts, and run the middleware on the token host.

   ```json
   "acme": { "repos": ["bry-guy/example"], "provider": "openshell", "providers": ["acme-login"],
             "egress": [{ "host": "auth.example.com", "port": 443, "access": "read-write" },
                        { "host": "api.example.com", "port": 443 }],
             "middlewares": [{ "middleware": "oauth", "hosts": ["auth.example.com"], "config": { "login": "acme" } }] }
   ```

4. **Gateway registration** (infra), then restart the gateway:

   ```toml
   [[openshell.supervisor.middleware]]
   name = "oauth"
   grpc_endpoint = "https://pi-oauth-middleware.pi-workspaced.svc.cluster.local:50051"
   tls_ca_cert_path = "/path/to/its-ca.pem"
   max_payload_bytes = 65536
   timeout = "30s"
   binding_policy = "exact"
   bindings = ["http_response_pre_return"]
   ```

One login has one identity: every sandbox attached to its provider shares it, and a sign-in in any of them replaces it.

## Settings

| Variable | Meaning |
|---|---|
| `OAUTH_MIDDLEWARE_CONFIG` | Path of the login config (required) |
| `OAUTH_MIDDLEWARE_TLS_CERT`, `OAUTH_MIDDLEWARE_TLS_KEY` | Server certificate and key (OpenShell requires `https://`) |
| `OAUTH_MIDDLEWARE_JWT_KEY` | The gateway's extension-token public key, PEM or JWK |
| `OAUTH_MIDDLEWARE_GATEWAY_ID` | The gateway id; tokens must have `iss: openshell-gateway:<id>` |
| `OAUTH_MIDDLEWARE_NAME`, `OAUTH_MIDDLEWARE_AUDIENCE` | Registration name (default `oauth`) and the audience it implies |
| `OAUTH_MIDDLEWARE_INSECURE=1` | Plaintext, no caller authentication: local testing only |
| `PORT` | gRPC port (default 50051) |
| `OPENSHELL_*` | The CLI's gateway settings, as for workspaced |

## Limits

- Only tokens in token-endpoint responses are swapped. A CLI that sends its token in a URL, or to an endpoint the
  profile does not list, gets the placeholder there and fails.
- `id_token` passes through unchanged: it identifies the user but authorizes no API.
- The placeholders work from inside the sandbox against the provider's hosts; that is the point. They are useless
  outside it.
- Verified against OpenShell 0.1.10's protocol and docs, with unit tests; not yet run against a live gateway.

## Recipe: Antigravity CLI (agy)

The `agy` login in `oauth-logins.json`, with a provider `agy-google` whose profile lists `oauth2.googleapis.com` (path
`/token`, body rewrite) and `cloudcode-pa.googleapis.com` and `daily-cloudcode-pa.googleapis.com` as API hosts. The
grant adds those hosts to `egress`, the middleware on `oauth2.googleapis.com`, and the
`@estebanforge/pi-antigravity-bridge` package; the worker image provides `agy`.
