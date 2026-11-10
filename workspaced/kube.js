import { readFileSync } from "node:fs";
import https from "node:https";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

// The API through `kubectl proxy` (WORKSPACED_KUBE_URL, e.g. http://127.0.0.1:8001): workspaced run
// outside the cluster with the proxy's credentials. For development and tests against a real cluster;
// ignored inside a cluster, where it would replace the pod's own credentials with unauthenticated calls.
export function proxyKube(base, fetchImpl = globalThis.fetch) {
  return {
    async request(method, path, body, contentType = "application/json") {
      const res = await fetchImpl(base.replace(/\/+$/, "") + path, {
        method, signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": contentType }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.text();
      let json = null;
      try { json = data ? JSON.parse(data) : null; } catch { json = { message: data.slice(0, 500) }; }
      return { status: res.status, body: json };
    },
  };
}

export const kubeFromEnv = (env = process.env) => env.WORKSPACED_KUBE_URL && !env.KUBERNETES_SERVICE_HOST ? proxyKube(env.WORKSPACED_KUBE_URL) : inClusterKube();

// Minimal in-cluster Kubernetes API client; workspaced needs a handful of CRUD
// calls, which does not justify a client library dependency.
export function inClusterKube({ host = process.env.KUBERNETES_SERVICE_HOST, port = process.env.KUBERNETES_SERVICE_PORT || "443" } = {}) {
  if (!host) throw new Error("KUBERNETES_SERVICE_HOST is not set; workspaced must run in-cluster");
  const ca = readFileSync(`${SA_DIR}/ca.crt`);
  return {
    request(method, path, body, contentType = "application/json") {
      // Projected tokens rotate; re-read per request.
      const token = readFileSync(`${SA_DIR}/token`, "utf8").trim();
      const payload = body === undefined ? null : JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = https.request({
          host, port, path, method, ca,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(payload ? { "content-type": contentType, "content-length": Buffer.byteLength(payload) } : {}),
          },
          timeout: 15_000,
        }, res => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", chunk => { data += chunk; });
          res.on("end", () => {
            let json = null;
            try { json = data ? JSON.parse(data) : null; } catch { json = { message: data.slice(0, 500) }; }
            resolve({ status: res.statusCode, body: json });
          });
        });
        req.on("timeout", () => req.destroy(new Error("kubernetes api timeout")));
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
      });
    },
  };
}
