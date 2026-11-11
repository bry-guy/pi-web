// OpenShell sandbox workers only (loaded when PI_ANTHROPIC_PLACEHOLDER_FILE is set): Claude requests carry the
// marker from the worker's auth.json; this swaps it for the gateway placeholder, which the gateway's proxy swaps for
// the real token. The gateway rewrites only a header that is exactly `Bearer <placeholder>`.
// The placeholder is read per request from PI_ANTHROPIC_PLACEHOLDER_FILE (workspaced rewrites it after each new
// login, as a running process keeps the placeholder version it started with), else from the env.
import { readFileSync } from "node:fs";

const MARK = "sk-ant-oat01-openshell";

export default function () {
  const file = process.env.PI_ANTHROPIC_PLACEHOLDER_FILE;
  if (!file || globalThis.__openshellOauth) return;
  globalThis.__openshellOauth = true;

  const current = () => {
    try {
      const fromFile = readFileSync(file, "utf8").trim();
      if (fromFile) return fromFile;
    } catch { /* not written yet: the env placeholder */ }
    return process.env.OPENSHELL_ANTHROPIC_PLACEHOLDER || "";
  };

  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.get("authorization") !== `Bearer ${MARK}`) return orig(input, init);
    const placeholder = current();
    if (!placeholder) return orig(input, init);
    headers.set("authorization", `Bearer ${placeholder}`);
    return orig(input, { ...init, headers });
  };
}
