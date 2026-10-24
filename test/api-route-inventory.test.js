import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApi } from "../server/routes.js";

const routesBeforeA2 = [
  "GET /health",
  "GET /logs",
  "GET /state",
  "GET /models",
  "GET /providers",
  "GET /repository-sources",
  "GET /github/public-repos",
  "GET /github/repos",
  "POST /github/device-login",
  "GET /github/device-login/:id",
  "DELETE /github/device-login/:id",
  "POST /github/logout",
  "POST /providers/:id/login",
  "GET /auth-flows/:id",
  "POST /auth-flows/:id/input",
  "DELETE /auth-flows/:id",
  "POST /providers/:id/logout",
  "GET /events",
  "POST /sessions/:id/extension-ui/:requestId",
  "DELETE /sessions/:id/extension-ui/:requestId",
  "POST /chats",
  "POST /projects",
  "POST /projects/:id/fetch",
  "POST /projects/:id/sessions",
  "POST /sessions/:id/fork",
  "POST /sessions/:id/branch-context",
  "GET /projects/:id/files",
  "GET /projects/:id/file",
  "GET /sessions/:id/commands",
  "POST /sessions/:id/command",
  "GET /sessions/:id/export",
  "POST /sessions/:id/message",
  "POST /sessions/:id/stop",
  "GET /sessions/:id/transcript",
  "GET /sessions/:id/meta",
  "POST /sessions/:id/model",
  "GET /sessions/:id/context",
  "GET /sessions/:id/thinking",
  "POST /sessions/:id/thinking",
  "POST /sessions/:id/name",
  "POST /sessions/:id/worktree",
  "POST /sessions/:id/switch",
  "POST /sessions/:id/pull",
  "GET /sessions/:id/push-preview",
  "POST /sessions/:id/push",
  "POST /sessions/:id/merge-local",
  "POST /sessions/:id/merge",
  "POST /sessions/:id/hooks/:name",
  "POST /sessions/:id/bang",
  "POST /sessions/:id/close",
  "DELETE /projects/:id/branches/:branch",
  "POST /settings",
];

test("buildApi route inventory removes only the retired legacy merge route", () => {
  const retiredRoute = "POST /sessions/:id/merge";
  assert.equal(routesBeforeA2.length, 52);
  assert.equal(routesBeforeA2.filter(route => route === retiredRoute).length, 1);

  const api = buildApi({});
  const routesAfterA2 = api.routes.map(({ method, path }) => `${method} ${path}`);
  const addedSince = ["GET /projects/:id/synced-sessions", "GET /projects/:id/synced-sessions/:syncId", "POST /pi/reload", "GET /sessions/:id/history", "POST /sessions/:id/restore", "POST /projects/:id/end-idle", "DELETE /projects/:id", "POST /chats/import"];
  assert.deepEqual(routesAfterA2.filter(route => !addedSince.includes(route)), routesBeforeA2.filter(route => route !== retiredRoute));
  assert.equal(routesAfterA2.length, 51 + addedSince.length);
});

test("POST /pi/reload reloads Pi configuration and refuses while a turn is running", async () => {
  let busy = true;
  const sup = { reloadPiConfiguration: async () => {
    if (busy) throw Object.assign(new Error("pi_configuration_busy"), { code: "pi_configuration_busy" });
    return { profile: { status: "none" } };
  } };
  const api = buildApi(sup);
  const refused = await api.request("/pi/reload", { method: "POST" });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "pi_configuration_busy");
  busy = false;
  const ok = await api.request("/pi/reload", { method: "POST" });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).piConfiguration, { profile: { status: "none" } });
});
