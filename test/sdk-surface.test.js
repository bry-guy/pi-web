// SDK drift detector: asserts the API names the real supervisor calls exist in
// the installed @earendil-works/pi-coding-agent — no credentials needed.
import assert from "node:assert/strict";
import { test } from "node:test";

test("pi SDK exposes the surface the real supervisor uses", async () => {
  const sdk = await import("@earendil-works/pi-coding-agent");
  assert.equal(typeof sdk.createAgentSession, "function");
  const SM = sdk.SessionManager;
  assert.equal(typeof SM, "function");
  for (const m of ["create", "open", "list", "forkFrom", "inMemory"]) {
    assert.equal(typeof SM[m], "function", `SessionManager.${m}`);
  }
  const smProto = SM.prototype;
  for (const m of ["getCwd", "getEntries", "getBranch", "getEntry", "appendCustomEntry", "getLeafId", "resetLeaf", "_rewriteFile"]) {
    assert.equal(typeof smProto[m], "function", `SessionManager.${m}`);
  }
  const proto = sdk.AgentSession.prototype;
  for (const m of ["prompt", "steer", "followUp", "abort", "subscribe", "setModel", "setSessionName", "dispose", "navigateTree", "bindExtensions", "getToolDefinition", "clearQueue", "getSteeringMessages", "getFollowUpMessages"]) {
    assert.equal(typeof proto[m], "function", `AgentSession.${m}`);
  }
  for (const g of ["sessionId", "sessionFile", "messages", "isStreaming", "isIdle", "sessionName", "model", "modelRuntime"]) {
    assert.ok(Object.getOwnPropertyDescriptor(proto, g)?.get, `AgentSession getter ${g}`);
  }
  const { session: surfaceSession } = await sdk.createAgentSession({
    cwd: process.cwd(), sessionManager: SM.inMemory(process.cwd()), noTools: "all",
  });
  assert.ok(surfaceSession.sessionManager);
  surfaceSession.dispose();
  assert.equal(typeof sdk.getAgentDir, "function");
  assert.equal(typeof sdk.SettingsManager?.fromStorage, "function");
  assert.equal(typeof sdk.DefaultResourceLoader, "function");
  assert.equal(typeof sdk.DefaultPackageManager, "function");
  assert.equal(typeof sdk.createBashToolDefinition, "function");
  assert.equal(typeof sdk.ModelRuntime, "function");
  assert.equal(typeof sdk.ModelRuntime.create, "function");
  for (const m of ["getAvailableSnapshot", "getAvailable", "getModel", "getProviders", "getProviderAuthStatus", "checkAuth", "login", "logout", "refresh"]) {
    assert.equal(typeof sdk.ModelRuntime.prototype[m], "function", `ModelRuntime.${m}`);
  }
});
