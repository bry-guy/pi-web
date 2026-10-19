import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createLifecycle, PASSIVE } from "./lifecycle.js";
import { slugFromRepository, validName } from "./manifests.js";
import { grantAllows, parseGrants, resolveGrant, withGrantCheck } from "./grants.js";

// Hop-by-hop and length/encoding headers; fetch() re-frames bodies itself.
const DROP_HEADERS = ["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding", "authorization"];

function tokenMatches(header, token) {
  const given = Buffer.from(String(header || "").replace(/^Bearer /, ""));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

// workspaced: creates/removes per-project workspaces, holds grants, and routes
// web's session traffic to each workspace's worker. Only web calls it.
// auth "network" means a NetworkPolicy admits only web; otherwise a bearer token.
export function createWorkspaced({ provider, grants = parseGrants(""), token, auth = "token", fetchImpl = globalThis.fetch, lifecycle = createLifecycle({ provider, fetchImpl, idleMs: 0 }) }) {
  if (auth !== "network" && !token) throw new Error("WORKSPACED_TOKEN is required unless WORKSPACED_AUTH=network");
  const app = new Hono();
  const named = handler => async c => {
    const name = c.req.param("name");
    return validName(name) ? handler(c, name) : c.json({ error: "invalid_name" }, 400);
  };

  app.get("/healthz", c => c.json({ ok: true }));
  app.use("/v1/*", async (c, next) => {
    if (auth !== "network" && !tokenMatches(c.req.header("authorization"), token)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/v1/workspaces", async c => {
    const list = await provider.list();
    if (c.req.query("detail") !== "1") return c.json({ workspaces: list });
    const usage = await provider.usage?.() ?? null;
    const workspaces = await Promise.all(list.map(async w => ({
      ...w, lastUsed: lifecycle.lastUsedAt(w.name), busy: await lifecycle.busy(w.name), usage: usage?.[w.name] ?? null,
    })));
    return c.json({ workspaces, usageAvailable: usage !== null });
  });

  // Grant shapes, optionally only those a repository may use (the add-project picker).
  app.get("/v1/grants", c => {
    const repository = c.req.query("repository");
    const shown = Object.values(grants).filter(g => !repository || grantAllows(g, repository));
    return c.json({ grants: shown });
  });

  app.post("/v1/workspaces", async c => {
    const body = await c.req.json().catch(() => null);
    const repository = typeof body?.repository === "string" ? body.repository.trim() : "";
    if (!repository || repository.length > 300 || /\s/.test(repository)) return c.json({ error: "invalid_repository" }, 400);
    const name = body.name ?? slugFromRepository(repository);
    if (!validName(name)) return c.json({ error: "invalid_name" }, 400);
    const runtimeClassName = body.containers ? "kata" : null;
    const grant = resolveGrant(grants, body.grant, repository);
    await lifecycle.makeRoom(name, 1).catch(() => {}); // best effort; never blocks adding a project
    await provider.create({ name, repository, runtimeClassName, grant });
    return c.json({ name }, 201);
  });

  app.delete("/v1/workspaces/:name", async c => {
    const name = c.req.param("name");
    if (!validName(name)) return c.json({ error: "invalid_name" }, 400);
    await provider.remove(name, { purge: c.req.query("purge") === "1" });
    return c.json({ ok: true });
  });

  app.post("/v1/workspaces/:name/wake", named(async (c, name) => {
    lifecycle.touch(name);
    return await lifecycle.ensureAwake(name) ? c.json({ ok: true }) : await starting(c, name);
  }));
  // Busy workers refuse disruptive actions (sleep, restart, reset) unless ?force=1.
  const refuseBusy = async (c, name) => c.req.query("force") !== "1" && await lifecycle.busy(name)
    ? c.json({ error: "workspace_busy", name, message: "This project is busy. Try again when it is idle, or force it." }, 409)
    : null;
  // Restart and reset need an awake worker; a sleeping one is never woken by them.
  const refuseAsleep = async (c, name) => (await lifecycle.info(name))?.state === "sleeping"
    ? c.json({ error: "asleep", name, message: "This project is asleep. Wake it first." }, 409)
    : null;
  app.post("/v1/workspaces/:name/restart", named(async (c, name) => {
    const refusal = await refuseAsleep(c, name) || await refuseBusy(c, name);
    if (refusal) return refusal;
    await lifecycle.restart(name);
    return c.json({ ok: true });
  }));
  app.post("/v1/workspaces/:name/reset", named(async (c, name) => {
    const body = await c.req.json().catch(() => null);
    if (body?.confirm !== name) return c.json({ error: "confirm_required", message: `Send {"confirm": "${name}"} to wipe this project's data.` }, 400);
    const refusal = await refuseAsleep(c, name) || await refuseBusy(c, name);
    if (refusal) return refusal;
    await provider.reset(name);
    return c.json({ ok: true });
  }));
  // Re-fetches the profile and dotfiles resources and reloads Pi; the worker answers 409 when busy.
  app.post("/v1/workspaces/:name/reload", named(async (c, name) => {
    const refusal = await refuseAsleep(c, name);
    if (refusal) return refusal;
    const base = provider.upstream(name);
    if (!base) return c.json({ error: "workspace_unavailable", name }, 502);
    lifecycle.begin(name);
    try {
      const res = await fetchImpl(`${base}/api/pi/reload`, { method: "POST", signal: AbortSignal.timeout(120_000) });
      return c.json(await res.json().catch(() => ({ error: "workspace_unavailable", name })), res.status);
    } catch {
      return c.json({ error: "workspace_unavailable", name }, 502);
    } finally {
      lifecycle.end(name);
    }
  }));
  app.post("/v1/workspaces/:name/sleep", named(async (c, name) => {
    const refusal = await refuseBusy(c, name);
    if (refusal) return refusal;
    await lifecycle.sleep(name, "requested");
    return c.json({ ok: true });
  }));
  app.put("/v1/workspaces/:name/pin", named(async (c, name) => {
    const body = await c.req.json().catch(() => null);
    await provider.setPinned(name, !!body?.pinned);
    lifecycle.touch(name);
    return c.json({ ok: true, pinned: !!body?.pinned });
  }));

  app.put("/v1/workspaces/:name/grant", named(async (c, name) => {
    const body = await c.req.json().catch(() => null);
    const w = (await provider.list()).find(x => x.name === name);
    if (!w) return c.json({ error: "no_such_workspace" }, 404);
    const grant = resolveGrant(grants, body?.grant, w.repository);
    if (!provider.setGrant) return c.json({ error: "grants_unsupported" }, 501);
    await provider.setGrant(name, grant);
    return c.json({ ok: true, grant: grant.name });
  }));

  app.put("/v1/github-auth", async c => {
    const body = await c.req.json().catch(() => null);
    await provider.setGitHubAuth(body?.accessToken ? body : null);
    return c.json({ ok: true });
  });

  // Body is web's Pi auth.json verbatim; workers link their auth.json to it.
  app.put("/v1/model-auth", async c => {
    const content = await c.req.text();
    let parsed;
    try { parsed = JSON.parse(content); } catch { parsed = null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return c.json({ error: "invalid_model_auth" }, 400);
    await provider.setModelAuth(content);
    return c.json({ ok: true });
  });

  app.all("/v1/workspaces/:name/api/*", async c => {
    const name = c.req.param("name");
    if (!validName(name)) return c.json({ error: "invalid_name" }, 400);
    const rest = c.req.path.slice(`/v1/workspaces/${name}`.length);
    // Web's own polling never wakes a worker; anything the user does does.
    if (PASSIVE.test(rest)) {
      if ((await lifecycle.info(name))?.state === "sleeping") return c.json({ error: "workspace_sleeping", name }, 503);
    } else if (!await lifecycle.ensureAwake(name)) return await starting(c, name);
    const base = provider.upstream(name);
    if (!base) return c.json({ error: "workspace_unavailable", name }, 502);
    const raw = c.req.url;
    const search = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
    const target = base + rest + search;
    const active = !PASSIVE.test(rest);
    const headers = new Headers(c.req.raw.headers);
    for (const h of DROP_HEADERS) headers.delete(h);
    const hasBody = !["GET", "HEAD"].includes(c.req.method);
    let upstream;
    if (active) lifecycle.begin(name);
    try {
      upstream = await fetchImpl(target, { method: c.req.method, headers, body: hasBody ? c.req.raw.body : undefined, duplex: "half", signal: c.req.raw.signal, redirect: "manual" });
    } catch {
      return c.json({ error: "workspace_unavailable", name }, 502);
    } finally {
      if (active) lifecycle.end(name);
    }
    const out = new Headers(upstream.headers);
    for (const h of DROP_HEADERS) out.delete(h);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  });

  async function starting(c, name) {
    const w = await lifecycle.info(name).catch(() => null);
    if (w?.problem?.fatal) return c.json({ error: "workspace_failed", name, problem: w.problem, message: `This project's worker is not running. ${w.problem.message}` }, 503);
    c.header("retry-after", "5");
    return c.json({ error: "workspace_starting", name, message: "This project is starting. Try again in a few seconds." }, 503);
  }

  app.onError((e, c) => c.json({ error: e.code || "internal_error", message: e.message }, e.status || 500));
  return app;
}

async function providerFromEnv(grants, env = process.env) {
  if ((env.WORKSPACED_PROVIDER || "local") === "kubernetes") {
    const { inClusterKube } = await import("./kube.js");
    const { kubernetesProvider } = await import("./kubernetes.js");
    return kubernetesProvider({ kube: inClusterKube(), grants });
  }
  const { localProvider } = await import("./local.js");
  const provider = localProvider({ root: env.WORKSPACED_ROOT || `${env.HOME}/.pi-ez-workspaces` });
  await provider.init();
  return provider;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3150);
  const grants = parseGrants(process.env.WORKSPACED_GRANTS || "");
  const provider = withGrantCheck(await providerFromEnv(grants), grants);
  const idleMinutes = Number(process.env.WORKSPACED_IDLE_MINUTES ?? 0);
  const maxAwake = Number(process.env.WORKSPACED_MAX_AWAKE ?? 3);
  const lifecycle = createLifecycle({ provider, idleMs: idleMinutes * 60_000, maxAwake });
  serve({ fetch: createWorkspaced({ provider, grants, lifecycle, token: process.env.WORKSPACED_TOKEN, auth: process.env.WORKSPACED_AUTH }).fetch, port, hostname: process.env.WORKSPACED_HOST || "0.0.0.0" });
  console.log(`workspaced (${process.env.WORKSPACED_PROVIDER || "local"}) → :${port}`);
  // Existing workers keep the manifest they were created with; re-apply the current one (Kubernetes
  // only rolls a worker whose template actually changed, e.g. new env).
  if (provider.setGrant) for (const w of await provider.list().catch(() => [])) {
    const grant = grants[w.grant];
    if (grant) await provider.setGrant(w.name, grant).catch(e => console.warn(`workspaced: could not refresh ${w.name}: ${e.message}`));
  }
}
