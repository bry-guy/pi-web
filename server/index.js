import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHome, exportSyncEnvironment, loadConfig } from "./config.js";
import { hub } from "./events.js";
import { buildApi } from "./routes.js";
import { createSupervisor } from "./supervisor/index.js";
import { publicError } from "./pi-configuration.js";
import { writeLog } from "./logging.js";
import { BUILD_ID } from "./version.js";

// Workers borrow web's model logins via a read-only file; Pi reads auth.json through the link.
export function linkModelAuth(env = process.env) {
  const target = env.PI_WEB_MODEL_AUTH_FILE;
  const dir = env.PI_CODING_AGENT_DIR;
  if (!target || !dir) return;
  const link = path.join(dir, "auth.json");
  try { if (readlinkSync(link) === target) return; } catch { /* missing or a regular file */ }
  mkdirSync(dir, { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(target, link);
}

// Pi compiles extensions with jiti into os.tmpdir()/jiti, which a restarted
// container loses (~9s of recompiling). Point it at the persistent cache dir.
// TMPDIR itself stays put: the agent's scratch files belong in /tmp.
export function linkJitiCache(env = process.env, tmp = os.tmpdir()) {
  const target = path.join(env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), ".cache"), "pi-ez-web", "jiti");
  const link = path.join(tmp, "jiti");
  try {
    try { if (readlinkSync(link) === target) return; } catch (e) { if (e.code === "EINVAL" && lstatSync(link).isDirectory()) rmSync(link, { recursive: true, force: true }); }
    mkdirSync(target, { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(target, link);
  } catch (error) { console.error(`pi-ez-web: could not persist the extension cache: ${error.message}`); }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_ONLY_CONFIG = Object.freeze({
  preview: true,
  productionData: true,
  apiBasePath: "/api",
  label: "Preview UI · production data",
});
const DEFAULT_PRESTART_TIMEOUT_MS = 120_000;

function prestartFailure(message) {
  return Object.assign(new Error(message), { code: "prestart_failed" });
}

function prestartTimeout() {
  const raw = process.env.PI_WEB_PRESTART_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PRESTART_TIMEOUT_MS;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw prestartFailure("PI_WEB_PRESTART_TIMEOUT_MS must be a positive integer.");
  }
  return value;
}

export function runPrestartCommand() {
  const command = process.env.PI_WEB_PRESTART_COMMAND;
  if (typeof command !== "string" || !command.trim()) return;
  const timeout = prestartTimeout();
  console.log(`pi-ez-web: running prestart command (+${Math.round(performance.now())}ms)`);
  try {
    execFileSync("/bin/sh", ["-c", command], {
      stdio: ["ignore", "inherit", "inherit"],
      timeout,
      killSignal: "SIGTERM",
    });
  } catch (error) {
    const detail = error?.code === "ETIMEDOUT"
      ? `timed out after ${timeout}ms`
      : typeof error?.status === "number"
        ? `exited with status ${error.status}`
        : error?.signal
          ? `was terminated by ${error.signal}`
          : "failed";
    throw prestartFailure(`Prestart command ${detail}.`);
  }
  console.log(`pi-ez-web: prestart command completed (+${Math.round(performance.now())}ms)`);
}

function uiOnlyEnabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.PI_WEB_UI_ONLY || "").trim().toLowerCase());
}

function addStaticRoutes(app, { uiOnly }) {
  app.get("/ui-health", c => {
    c.header("cache-control", "no-store");
    return c.json({ ok: true, mode: uiOnly ? "ui-only" : "full", buildId: BUILD_ID });
  });
  app.get("/ui-config.json", c => {
    c.header("cache-control", "no-store");
    return c.json(uiOnly ? UI_ONLY_CONFIG : { ...UI_ONLY_CONFIG, preview: false, productionData: false, label: null });
  });
  // PWA clients must always revalidate the shell and service worker after a
  // rollout. The service worker supplies offline fallback itself; HTTP caches
  // should never pin an older UI or worker in Safari.
  app.use("/*", async (c, next) => {
    c.header("cache-control", "no-cache");
    await next();
  });
  const root = path.join(here, "..");
  // Expose only the two browser assets needed for rich, sanitized Markdown;
  // do not make node_modules generally web-accessible.
  app.get("/vendor/marked.umd.js", serveStatic({ root, path: "node_modules/marked/lib/marked.umd.js" }));
  app.get("/vendor/dompurify.min.js", serveStatic({ root, path: "node_modules/dompurify/dist/purify.min.js" }));
  app.use("/*", serveStatic({ root: path.join(root, "public") }));
}

export function createApp({ uiOnly = uiOnlyEnabled() } = {}) {
  const app = new Hono();
  let sup = null;
  app.onError((error, c) => {
    const requestId = c.get("requestId") || randomUUID();
    const stack = publicError(error instanceof Error ? error.stack : String(error));
    const details = { requestId, method: c.req.method, path: c.req.path, stack };
    writeLog("error", "Request failed", { source: "request", ...details });
    console.error("pi-ez-web request failed", details);
    c.header("x-request-id", requestId);
    const code = typeof error?.code === "string" ? error.code : "";
    const status = Number(error?.status);
    if (status >= 400 && status < 500 && ["session_busy", "session_streaming", "session_compacting", "sync_open_failed", "workspace_mismatch", "workspace_required"].includes(code)) {
      return c.json({ error: code, ...(error.message ? { message: error.message } : {}), ...(error.details ? { details: error.details } : {}) }, status);
    }
    return c.json({ error: "internal_error", requestId }, 500);
  });
  if (!uiOnly) {
    ensureHome();
    linkModelAuth();
    if ((process.env.PI_WEB_MODE || "real") !== "mock") linkJitiCache();
    sup = createSupervisor(hub);
    const realMode = (process.env.PI_WEB_MODE || "real") !== "mock";
    // Mock mode has no SDK sessions, so no extension UI to bind.
    const extensionUi = realMode ? sup.extensionUi : null;
    if (realMode) exportSyncEnvironment();
    app.use("/api/*", async (c, next) => {
      const requestId = randomUUID();
      c.set("requestId", requestId);
      c.header("x-request-id", requestId);
      await next();
    });
    app.route("/api", buildApi(sup, { extensionUi }));
  }
  addStaticRoutes(app, { uiOnly });
  return { app, sup };
}

export function startServer(port, options = {}) {
  runPrestartCommand();
  const uiOnly = options.uiOnly ?? uiOnlyEnabled();
  const cfg = uiOnly ? null : loadConfig();
  // Git is observed live; startup must not prune worktrees or inspect/mutate
  // application-owned transfer stashes.
  const { app, sup } = createApp({ ...options, uiOnly });
  const server = serve({ fetch: app.fetch, port: port ?? Number(process.env.PORT || cfg?.port || 3141) });
  return { server, app, sup };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, sup } = startServer();
  server.once("listening", () => {
    const repo = loadConfig().projects[0]?.repoPath;
    if (sup?.prewarm) setTimeout(() => void sup.prewarm(repo || process.cwd()), 0);
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`pi-web-ui: port ${e.port} is already in use (another instance running?). Set PORT to change it.`);
      process.exit(1);
    }
    throw e;
  });
  const announce = () => {
    const addr = server.address();
    if (addr) console.log(`pi-web-ui (${process.env.PI_WEB_MODE || "real"} mode) → http://localhost:${addr.port} (+${Math.round(performance.now())}ms)`);
  };
  if (server.listening) announce();
  else server.on("listening", announce);
}
