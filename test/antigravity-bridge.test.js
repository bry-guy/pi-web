import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isAntigravityBridgeSource, isPiAntigravitySource } from "../server/pi-configuration.js";
import { RealSupervisor, entriesToRecords } from "../server/supervisor/real.js";

function fakePackage(dir, name, source) {
  fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, type: "module", pi: { extensions: ["./extensions"] } }));
  fs.writeFileSync(path.join(dir, "extensions", "index.js"), source);
}

test("package sources tell the bridge from pi-antigravity", () => {
  for (const source of ["npm:@estebanforge/pi-antigravity-bridge@1.16.0", "npm:@estebanforge/pi-antigravity-bridge", "git:github.com/EstebanForge/pi-antigravity-bridge@v1", "/opt/pi-antigravity-bridge"]) {
    assert.equal(isAntigravityBridgeSource(source), true, source);
    assert.equal(isPiAntigravitySource(source), false, source);
  }
  for (const source of ["npm:pi-antigravity@0.15.0", "npm:pi-antigravity", "git:github.com/x/pi-antigravity.git"]) {
    assert.equal(isPiAntigravitySource(source), true, source);
    assert.equal(isAntigravityBridgeSource(source), false, source);
  }
  assert.equal(isPiAntigravitySource("npm:pi-antigravity-usage"), false);
});

test("with the bridge among the packages, only its antigravity provider registers and its models resolve before any session", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-agy-bridge-"));
  try {
    const bridge = path.join(tmp, "pkgs", "pi-antigravity-bridge");
    const legacy = path.join(tmp, "pkgs", "pi-antigravity");
    const provider = (id, extra) => `export default function (pi) {
      pi.registerProvider("antigravity", { name: ${JSON.stringify(id)}, baseUrl: "agy-bridge://antigravity", apiKey: "not-used", api: "agy-bridge",
        models: ${JSON.stringify(extra)}.map(id => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 })),
        streamSimple: () => { throw new Error("not in tests"); } });
    }`;
    fakePackage(bridge, "@estebanforge/pi-antigravity-bridge", provider("Antigravity (agy)", ["gemini-3-8-flash", "gemini-3-1-pro"]));
    fakePackage(legacy, "pi-antigravity", provider("Hybrid", ["legacy-only"]));
    const cwd = path.join(tmp, "work");
    fs.mkdirSync(cwd);
    const script = `
      import { EventHub } from './server/events.js';
      import { RealSupervisor } from './server/supervisor/real.js';
      const supervisor = new RealSupervisor(new EventHub());
      const ids = models => models.filter(m => m.provider === "antigravity").map(m => m.id).sort();
      const before = ids(await supervisor.listModels());
      const resolved = await supervisor._resolveModel("antigravity/gemini-3-8-flash");
      const { id } = await supervisor.createSession({ cwd: ${JSON.stringify(cwd)} });
      await supervisor._attachById(id);
      const after = ids(await supervisor.listModels());
      const loaded = supervisor.piConfiguration.runtime;
      const extensions = loaded.extensions.map(e => e.path.split("/").slice(-3).join("/"));
      console.log(JSON.stringify({ before, resolved: { provider: resolved.provider, id: resolved.id, api: resolved.api }, after, extensions, errors: loaded.errors }));
      process.exit(0);
    `;
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve("."),
      env: { ...process.env, PI_WEB_HOME: path.join(tmp, "web"), PI_CODING_AGENT_DIR: path.join(tmp, "pi"), PI_WEB_PACKAGES: JSON.stringify([bridge, legacy]), PI_OFFLINE: "1" },
      encoding: "utf8",
      timeout: 60_000,
    });
    const result = JSON.parse(output.trim().split("\n").at(-1));
    assert.deepEqual(result.before, ["antigravity/gemini-3-1-pro", "antigravity/gemini-3-8-flash"]);
    assert.deepEqual(result.resolved, { provider: "antigravity", id: "gemini-3-8-flash", api: "agy-bridge" });
    assert.deepEqual(result.after, result.before, "the session's pi-antigravity extension did not merge into the provider");
    assert.deepEqual(result.errors, []);
    assert.ok(result.extensions.includes("server/extensions/agy-sign-in.js"), result.extensions.join(", "));
    assert.ok(result.extensions.includes("pi-antigravity-bridge/extensions/index.js"));
    assert.ok(!result.extensions.includes("pi-antigravity/extensions/index.js"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

const nativeEntries = [
  { type: "custom", id: "n1", parentId: "a1", timestamp: "2026-01-01T00:00:01.000Z", customType: "agy-native-event", data: { name: "Edit", status: "completed", path: "/w/a.js", diff: "-old\n+new", output: "edited" } },
  { type: "custom", id: "n2", parentId: "n1", timestamp: "2026-01-01T00:00:02.000Z", customType: "agy-native-event", data: { name: "Run", status: "failed", command: "npm test\n--watch", diff: "x", output: "1 failing" } },
];

test("agy's native tool steps show as read-only tool cards in history", () => {
  const records = entriesToRecords([{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "go" } }, ...nativeEntries]);
  assert.deepEqual(records.slice(1), [
    { id: "n1", role: "tool", tool: "Edit", arg: "/w/a.js", meta: "", out: "-old\n+new", at: Date.parse("2026-01-01T00:00:01.000Z") },
    { id: "n2", role: "tool", tool: "Run", arg: "npm test", meta: "error", out: "1 failing", at: Date.parse("2026-01-01T00:00:02.000Z") },
  ]);
});

test("agy's native tool steps stream as finished tool cards", () => {
  const events = [];
  const supervisor = new RealSupervisor({ emit: (id, type, data) => events.push({ type, data }) });
  const st = { liveRecords: new Map(), pendingMessages: [] };
  for (const entry of nativeEntries) supervisor._onEvent("s", st, { type: "entry_appended", entry });
  assert.deepEqual(events, [
    { type: "tool_start", data: { toolId: "n1", name: "Edit", argsSummary: "/w/a.js" } },
    { type: "tool_end", data: { toolId: "n1", ok: true, output: "-old\n+new", meta: "" } },
    { type: "tool_start", data: { toolId: "n2", name: "Run", argsSummary: "npm test" } },
    { type: "tool_end", data: { toolId: "n2", ok: false, output: "1 failing", meta: "error" } },
  ]);
  assert.equal(st.liveRecords.get("n2").meta, "error");
});
