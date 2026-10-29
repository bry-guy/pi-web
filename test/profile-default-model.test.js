import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("without a web default, the Pi profile's default model wins over the first listed model", async () => {
  process.env.PI_WEB_HOME = mkdtempSync(path.join(tmpdir(), "profile-default-"));
  const { RealSupervisor } = await import("../server/supervisor/real.js");
  const sup = Object.create(RealSupervisor.prototype);
  sup.listModels = async () => [{ id: "openai-codex/spark" }, { id: "openai-codex/luna" }];
  sup.piConfiguration = { resolve: async () => ({ settings: { defaultProvider: "openai-codex", defaultModel: "luna" } }) };
  assert.equal((await sup.modelState()).effectiveDefault, "openai-codex/luna");
  sup.piConfiguration = { resolve: async () => ({ settings: { defaultProvider: "openai-codex", defaultModel: "gone" } }) };
  assert.equal((await sup.modelState()).effectiveDefault, "openai-codex/spark");
  sup.piConfiguration = { resolve: async () => ({ settings: { enabledModels: ["anthropic/missing", "openai-codex/luna:low"] } }) };
  assert.equal((await sup.modelState()).effectiveDefault, "openai-codex/luna", "the first available enabled model, like the Pi CLI");
});
