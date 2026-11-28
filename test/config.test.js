import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { appHome, exportSyncEnvironment, githubConfig, loadBindings, loadClosed, loadConfig, normalizeHooks, normalizePiConfig, normalizeThinkingLevel, prepareSessionVisibilityReplacement, repositorySource, saveBindings, saveClosed, saveConfig, worktreeRoot } from "../server/config.js";

let tmp;
const previousHome = process.env.PI_WEB_HOME;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-config-"));
  process.env.PI_WEB_HOME = tmp;
});

after(() => {
  if (previousHome === undefined) delete process.env.PI_WEB_HOME;
  else process.env.PI_WEB_HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("worktree root defaults beside Pi and respects an explicit override", () => {
  assert.equal(worktreeRoot({}), path.join(os.homedir(), ".pi", "worktrees"));
  assert.equal(worktreeRoot({ worktreeRoot: "/x" }), "/x");
});

test("config loading distinguishes missing and invalid files", () => {
  const configFile = path.join(appHome(), "config.json");
  fs.rmSync(configFile, { force: true });
  const defaults = loadConfig();
  assert.deepEqual(defaults.projects, []);
  assert.equal(fs.existsSync(configFile), false);

  fs.writeFileSync(configFile, JSON.stringify({ defaultModel: "mock/fast", projects: [] }));
  assert.equal(loadConfig().defaultModel, "mock/fast");

  const assertInvalid = (raw, message) => {
    fs.writeFileSync(configFile, raw);
    const original = fs.readFileSync(configFile);
    let saveReached = false;
    assert.throws(() => {
      const cfg = loadConfig();
      saveReached = true;
      cfg.defaultModel = "should-not-save";
      saveConfig(cfg);
    }, error => {
      assert.equal(error.code, "invalid_config");
      assert.equal(error.message, message);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error), /config-sentinel/);
      return true;
    });
    assert.equal(saveReached, false);
    assert.deepEqual(fs.readFileSync(configFile), original);
  };
  assertInvalid(`{"secret":"config-sentinel"`, "Configuration file contains invalid JSON.");
  assertInvalid("", "Configuration file contains invalid JSON.");
  for (const root of [null, ["config-sentinel"], "config-sentinel", 42, true]) {
    assertInvalid(JSON.stringify(root), "Configuration file must contain a JSON object.");
  }

  const original = fs.readFileSync(configFile);
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (file === configFile) throw Object.assign(new Error("read-sentinel"), { code: "EACCES" });
    return originalReadFileSync.call(fs, file, ...args);
  };
  let saveReached = false;
  try {
    assert.throws(() => {
      const cfg = loadConfig();
      saveReached = true;
      cfg.defaultModel = "should-not-save";
      saveConfig(cfg);
    }, error => {
      assert.equal(error.code, "config_unreadable");
      assert.equal(error.message, "Configuration file could not be read.");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error), /read-sentinel|config-sentinel/);
      return true;
    });
    assert.equal(saveReached, false);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.deepEqual(fs.readFileSync(configFile), original);
  fs.rmSync(configFile, { force: true });
});

test("invalid configuration stops startup before listening", () => {
  const configFile = path.join(appHome(), "config.json");
  const raw = `{"secret":"startup-sentinel"`;
  fs.writeFileSync(configFile, raw);
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { startServer } from ${JSON.stringify(new URL("../server/index.js", import.meta.url).href)};
      try {
        const { server } = startServer(0);
        console.log("started");
        server.close();
      } catch (error) {
        console.log(JSON.stringify({ code: error?.code, message: error?.message }));
      }
    `], {
      env: { ...process.env, PI_WEB_HOME: tmp, PI_WEB_MODE: "mock", PI_WEB_UI_ONLY: "0", PI_WEB_PRESTART_COMMAND: "" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
    assert.doesNotMatch(`${child.stdout}${child.stderr}`, /started|startup-sentinel/);
    assert.deepEqual(JSON.parse(child.stdout.trim()), { code: "invalid_config", message: "Configuration file contains invalid JSON." });
    assert.equal(fs.readFileSync(configFile, "utf8"), raw);
  } finally {
    fs.rmSync(configFile, { force: true });
  }
});

test("project hooks normalize commands and allow explicit removal", () => {
  assert.deepEqual(normalizeHooks({ setup: " mise install ", check: null, "bad name": "ignored", empty: "  " }), { setup: "mise install", check: null });
});

test("named project hook sets normalize deployment defaults", () => {
  saveConfig({ projectHookSets: { infra: { check: " mise run check ", "bad name": "ignored" }, "": { setup: "ignored" } } });
  assert.deepEqual(loadConfig().projectHookSets, { infra: { check: "mise run check" } });
});

test("Pi resource config normalizes a profile and unique package/extension sources", () => {
  assert.deepEqual(normalizePiConfig({
    profile: " https://github.com/bry-guy/dotfiles ",
    packages: ["npm:context-mode", "npm:context-mode", ""],
    extensions: [" ./extensions/test.ts "],
  }), {
    profile: "https://github.com/bry-guy/dotfiles",
    profileSource: "explicit",
    packages: ["npm:context-mode"],
    extensions: ["./extensions/test.ts"],
  });
  assert.throws(() => normalizePiConfig({ packages: "nope" }, { strict: true }), error => error.code === "invalid_pi_configuration");
});

test("default thinking mode accepts extended levels and rejects invalid settings", () => {
  assert.equal(normalizeThinkingLevel("xhigh"), "xhigh");
  assert.equal(normalizeThinkingLevel("max"), "max");
  assert.equal(normalizeThinkingLevel("unknown"), "medium");
  assert.throws(() => normalizeThinkingLevel("unknown", { strict: true }), error => error.code === "invalid_thinking_level");
  saveConfig({ defaultThinkingLevel: "xhigh" });
  assert.equal(loadConfig().defaultThinkingLevel, "xhigh");
});

test("legacy project modes are ignored", () => {
  saveConfig({ projects: [{ id: "p", name: "demo", repoPath: "/tmp/demo", mode: "auto" }] });
  assert.equal(loadConfig().projects[0].mode, undefined);
});

test("repository source config merges nested defaults and validates the default", () => {
  saveConfig({ repositorySources: { default: "github", github: { owner: "bry-guy" } } });
  const cfg = loadConfig();
  assert.equal(repositorySource(cfg), "github");
  assert.equal(cfg.repositorySources.github.owner, "bry-guy");
  assert.equal(cfg.repositorySources.github.clientId, null);

  saveConfig({ repositorySources: { default: "invalid" } });
  assert.equal(repositorySource(loadConfig()), "github");
});

test("environment overrides repository source settings", () => {
  const previous = {
    source: process.env.PI_WEB_REPOSITORY_SOURCE,
    client: process.env.PI_WEB_GITHUB_CLIENT_ID,
    owner: process.env.PI_WEB_GITHUB_OWNER,
  };
  process.env.PI_WEB_REPOSITORY_SOURCE = "git-url";
  process.env.PI_WEB_GITHUB_CLIENT_ID = "client-from-env";
  process.env.PI_WEB_GITHUB_OWNER = "owner-from-env";
  try {
    assert.equal(repositorySource({ repositorySources: { default: "local" } }), "git-url");
    assert.deepEqual(githubConfig({ repositorySources: { github: { clientId: "config-client", owner: "config-owner" } } }), { clientId: "client-from-env", owner: "owner-from-env" });
  } finally {
    for (const [key, value] of Object.entries({ PI_WEB_REPOSITORY_SOURCE: previous.source, PI_WEB_GITHUB_CLIENT_ID: previous.client, PI_WEB_GITHUB_OWNER: previous.owner })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("a deployment's PI_SYNC_ALL_SESSIONS survives startup, and the web setting still overrides it", () => {
  const keys = ["PI_SYNC_ALL_SESSIONS", "PI_SYNC_SERVER_URL", "PI_SYNC_CODE", "PI_WEB_SYNC_ALL_CONVERSATIONS"];
  const previous = keys.map(k => process.env[k]);
  try {
    for (const k of keys) delete process.env[k];
    const exported = sync => (exportSyncEnvironment({ sync }), process.env.PI_SYNC_ALL_SESSIONS);
    process.env.PI_SYNC_ALL_SESSIONS = "on"; // as workspaced pins it on a worker
    assert.equal(exported({}), "on", "an unset web setting leaves the worker's value");
    assert.equal(exported({ allConversations: "off" }), "off", "the web setting wins");
    assert.equal(exported({}), "on", "unsetting the web setting puts the worker's value back");
    assert.equal(exported({ allConversations: "on" }), "on");
    assert.equal(exported({}), "on", "also when the web setting matched it");
    delete process.env.PI_SYNC_ALL_SESSIONS; // no deployment value: unset is left to pi-sync
    assert.equal(exported({}), undefined);
    assert.equal(exported({ allConversations: "on" }), "on");
    assert.equal(exported({}), undefined, "a value this process wrote is removed when the setting is unset again");
  } finally {
    keys.forEach((k, i) => previous[i] === undefined ? delete process.env[k] : (process.env[k] = previous[i]));
  }
});

test("bindings v1 strings migrate to v2 objects and round-trip", () => {
  fs.mkdirSync(appHome(), { recursive: true });
  const file = path.join(appHome(), "bindings.json");
  fs.writeFileSync(file, JSON.stringify({ s1: "/tmp/old-worktree" }));
  assert.deepEqual(loadBindings(), { s1: { projectId: null, workspacePath: "/tmp/old-worktree" } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { s1: { projectId: null, workspacePath: "/tmp/old-worktree" } });

  saveBindings({ s2: { branch: "feat/new", workspacePath: "/tmp/new-worktree" } });
  assert.deepEqual(loadBindings(), { s2: { branch: "feat/new", workspacePath: "/tmp/new-worktree" } });
});

test("session replacement copies visibility without retiring the source", () => {
  const source = { projectId: "p1", workspacePath: "/tmp/project-b", branch: "feature/b" };
  const before = { source };
  saveBindings(before);
  saveClosed(new Set(["target"]));

  const replacement = prepareSessionVisibilityReplacement("source", "target", "/tmp/target-cwd");
  assert.equal(replacement.workspacePath, source.workspacePath);
  const committed = replacement.commit();
  assert.deepEqual(loadBindings(), { source, target: source });
  assert.deepEqual([...loadClosed()], []);

  committed.rollback();
  assert.deepEqual(loadBindings(), before);
  assert.deepEqual([...loadClosed()], ["target"]);

  saveBindings(before);
  saveClosed(new Set(["target"]));
  const closedFile = path.join(appHome(), "closed.json");
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to, ...args) => {
    if (to === closedFile) throw new Error("closed write failed");
    return originalRename(from, to, ...args);
  };
  try {
    assert.throws(() => prepareSessionVisibilityReplacement("source", "target", "/tmp/project-b").commit(), /closed write failed/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.deepEqual(loadBindings(), before);
  assert.deepEqual([...loadClosed()], ["target"]);

  saveBindings({ source, target: { projectId: "p2", workspacePath: "/tmp/other" } });
  assert.throws(() => prepareSessionVisibilityReplacement("source", "target", "/tmp/project-b"), error => error.code === "session_binding_conflict");

  saveBindings({ target: { projectId: "p2", workspacePath: "/tmp/other" } });
  saveClosed(new Set(["target"]));
  const unbound = prepareSessionVisibilityReplacement("source-unbound", "target", "/tmp/project-b");
  unbound.commit();
  assert.deepEqual(loadBindings(), { target: { projectId: "p2", workspacePath: "/tmp/other" } });
  assert.deepEqual([...loadClosed()], []);

  saveBindings({ same: { projectId: "p1", workspacePath: "/tmp/project-b" } });
  saveClosed(new Set(["same"]));
  prepareSessionVisibilityReplacement("same", "same", "/tmp/other").commit();
  assert.deepEqual(loadBindings(), { same: { projectId: "p1", workspacePath: "/tmp/project-b" } });
  assert.deepEqual([...loadClosed()], []);

  saveBindings({});
  saveClosed(new Set());
});
