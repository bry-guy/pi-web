import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { effectivePiConfig, saveConfig } from "../server/config.js";
import { PiConfiguration, githubProfileSettingsUrl, recoverIncompleteGitPackages } from "../server/pi-configuration.js";

let tmp;
let previousWebHome;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-profile-"));
  previousWebHome = process.env.PI_WEB_HOME;
  process.env.PI_WEB_HOME = path.join(tmp, "web");
  fs.mkdirSync(process.env.PI_WEB_HOME, { recursive: true });
});

after(() => {
  if (previousWebHome === undefined) delete process.env.PI_WEB_HOME;
  else process.env.PI_WEB_HOME = previousWebHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("GitHub profile references support repository and blob URLs", () => {
  assert.equal(
    githubProfileSettingsUrl("https://github.com/bry-guy/dotfiles"),
    "https://raw.githubusercontent.com/bry-guy/dotfiles/HEAD/.pi/agent/settings.json",
  );
  assert.equal(
    githubProfileSettingsUrl("https://github.com/bry-guy/dotfiles/blob/main/.pi/profiles/rpiv/settings.json"),
    "https://raw.githubusercontent.com/bry-guy/dotfiles/main/.pi/profiles/rpiv/settings.json",
  );
});

test("recovery removes only incomplete explicitly configured Git packages", () => {
  const agentDir = path.join(tmp, "recover-agent");
  const bad = path.join(agentDir, "git", "github.com", "example", "bad");
  const good = path.join(agentDir, "git", "github.com", "example", "good");
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, "partial.txt"), "partial");
  fs.mkdirSync(path.join(good, ".git"), { recursive: true });

  const recovered = recoverIncompleteGitPackages(agentDir, {
    packages: ["git:github.com/example/bad", "git:github.com/example/good", "npm:untouched"],
  });

  assert.deepEqual(recovered, [bad]);
  assert.equal(fs.existsSync(bad), false);
  assert.equal(fs.existsSync(good), true);
});

test("a local profile overlays Pi settings, resolves resources, and keeps project overrides", async () => {
  const agentDir = path.join(tmp, "agent");
  const cwd = path.join(tmp, "project");
  const profileDir = path.join(tmp, "profile");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: ["npm:base-package"],
    quietStartup: false,
  }));
  fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
    packages: ["npm:project-package"],
    extensions: ["./project-extension.ts"],
    compaction: { reserveTokens: 333 },
  }));
  fs.writeFileSync(path.join(profileDir, "settings.json"), JSON.stringify({
    packages: ["npm:profile-package"],
    extensions: ["./extension.ts"],
    defaultThinkingLevel: "high",
    sessionDir: "/must/not/move/web/sessions",
    compaction: { reserveTokens: 222, keepRecentTokens: 111 },
  }));

  saveConfig({
    pi: {
      profile: profileDir,
      packages: ["npm:extra-package"],
      extensions: ["./web-extension.ts"],
    },
  });

  const configuration = new PiConfiguration();
  const { settingsManager } = await configuration.createSettingsManager(cwd, agentDir, SettingsManager);
  assert.deepEqual(settingsManager.getGlobalSettings().packages, ["npm:profile-package", "npm:extra-package"]);
  assert.deepEqual(settingsManager.getNpmCommand(), ["npm", "--legacy-peer-deps", "--include=dev"]);
  assert.deepEqual(settingsManager.getGlobalSettings().extensions, [
    path.join(profileDir, "extension.ts"),
    path.join(process.env.PI_WEB_HOME, "web-extension.ts"),
  ]);
  assert.equal(settingsManager.getDefaultThinkingLevel(), "high");
  assert.deepEqual(settingsManager.getCompactionSettings(), {
    enabled: true,
    reserveTokens: 333,
    keepRecentTokens: 111,
  });
  assert.equal(settingsManager.getSessionDir(), undefined);

  const packageSubset = await configuration.createSettingsManager(cwd, agentDir, SettingsManager, {
    packageSources: ["npm:profile-package"],
  });
  assert.deepEqual(packageSubset.settingsManager.getGlobalSettings().packages, ["npm:profile-package"]);

  const packageFree = await configuration.createSettingsManager(cwd, agentDir, SettingsManager, { loadPackages: false });
  assert.deepEqual(packageFree.settingsManager.getGlobalSettings().packages, []);
  assert.deepEqual(packageFree.settingsManager.getProjectSettings().packages, []);
  assert.deepEqual(packageFree.settingsManager.getProjectSettings().extensions, ["./project-extension.ts"]);
  assert.deepEqual(packageFree.settingsManager.getCompactionSettings(), {
    enabled: true,
    reserveTokens: 333,
    keepRecentTokens: 111,
  });
  assert.deepEqual(packageFree.settingsManager.getGlobalSettings().extensions, [
    path.join(profileDir, "extension.ts"),
    path.join(process.env.PI_WEB_HOME, "web-extension.ts"),
  ]);

  const state = await configuration.state();
  assert.equal(state.profile.status, "loaded");
  assert.equal(state.profile.packageCount, 2);
  assert.equal(state.config.profile, profileDir);
});

test("the default npm command resolves through PATH and honors profile overrides", async () => {
  const npmBin = path.join(tmp, "npm-bin");
  fs.mkdirSync(npmBin, { recursive: true });
  const npm = path.join(npmBin, "npm");
  fs.writeFileSync(npm, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(npm, 0o755);

  const configuration = new PiConfiguration();
  const resolved = await configuration.resolve({ profile: null, packages: [], extensions: [] });
  assert.deepEqual(resolved.settings.npmCommand, ["npm", "--legacy-peer-deps", "--include=dev"]);
  const executed = spawnSync(resolved.settings.npmCommand[0], resolved.settings.npmCommand.slice(1), {
    env: { ...process.env, PATH: npmBin },
    encoding: "utf8",
  });
  assert.equal(executed.error, undefined);
  assert.equal(executed.status, 0);
  assert.equal(executed.stderr, "");
  assert.equal(executed.stdout, "--legacy-peer-deps\n--include=dev\n");

  const explicitProfile = path.join(tmp, "explicit-npm-profile");
  fs.mkdirSync(explicitProfile, { recursive: true });
  fs.writeFileSync(path.join(explicitProfile, "settings.json"), JSON.stringify({ npmCommand: ["/custom/npm", "--profile-flag"] }));
  const explicit = await configuration.resolve({ profile: explicitProfile, packages: [], extensions: [] });
  assert.deepEqual(explicit.settings.npmCommand, ["/custom/npm", "--profile-flag"]);
});

test("an external profile loads declarative package sources and ignores its machine-local paths", async () => {
  let requested;
  const configuration = new PiConfiguration({
    fetchImpl: async url => {
      if (url === "https://api.github.com/repos/bry-guy/dotfiles") return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
      requested = url;
      return new Response(JSON.stringify({
        packages: ["npm:context-mode"],
        extensions: ["/Users/example/private-extension.ts"],
        defaultThinkingLevel: "xhigh",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const pi = {
    profile: "https://github.com/bry-guy/dotfiles",
    packages: [],
    extensions: [],
  };
  const resolved = await configuration.resolve(pi);
  assert.equal(requested, "https://raw.githubusercontent.com/bry-guy/dotfiles/main/.pi/agent/settings.json");
  assert.equal(resolved.profile.status, "loaded");
  assert.deepEqual(resolved.settings.packages, ["npm:context-mode"]);
  assert.deepEqual(resolved.settings.extensions, []);
  assert.match(resolved.warnings[0], /Ignored remote profile extension path/);

  configuration.fetchImpl = async () => { throw new Error("offline"); };
  configuration.invalidate();
  const cached = await configuration.resolve(pi);
  assert.equal(cached.profile.status, "cached");
  assert.deepEqual(cached.settings.packages, ["npm:context-mode"]);
  assert.ok(cached.warnings.some(warning => /Using cached Pi profile/.test(warning)));
});

test("GitHub profiles fetch dotfiles agent skills into local resources", async () => {
  const metadataUrl = "https://api.github.com/repos/bry-guy/dotfiles";
  const settingsUrl = "https://raw.githubusercontent.com/bry-guy/dotfiles/master/.pi/agent/settings.json";
  const treeUrl = "https://api.github.com/repos/bry-guy/dotfiles/git/trees/master?recursive=1";
  const skillUrl = "https://raw.githubusercontent.com/bry-guy/dotfiles/master/.agents/skills/todo-discipline/SKILL.md";
  const skill = "---\\nname: todo-discipline\\ndescription: Keep TODOs disciplined.\\n---\\n\\nUse bounded tasks.\\n";
  const requests = [];
  const configuration = new PiConfiguration({
    fetchImpl: async url => {
      requests.push(url);
      if (url === metadataUrl) return new Response(JSON.stringify({ default_branch: "master" }), { status: 200 });
      if (url === settingsUrl) return new Response(JSON.stringify({ packages: [] }), { status: 200 });
      if (url === treeUrl) return new Response(JSON.stringify({ tree: [
        { path: ".agents/skills/todo-discipline/SKILL.md", type: "blob", size: skill.length },
      ] }), { status: 200 });
      if (url === skillUrl) return new Response(skill, { status: 200 });
      throw new Error(`unexpected profile request: ${url}`);
    },
  });

  const resolved = await configuration.resolve({ profile: "https://github.com/bry-guy/dotfiles", packages: [], extensions: [] });
  const skillPath = resolved.settings.skills?.find(file => file.endsWith(".agents/skills/todo-discipline/SKILL.md"));
  assert.ok(skillPath);
  assert.equal(fs.readFileSync(skillPath, "utf8"), skill);
  assert.deepEqual(requests, [metadataUrl, settingsUrl, treeUrl, skillUrl]);
});

test("runtime state enumerates loaded skills", () => {
  const configuration = new PiConfiguration();
  configuration.recordRuntime({
    getSkills: () => ({ skills: [{ name: "todo-discipline", description: "Keep TODOs bounded.", filePath: "/tmp/SKILL.md", sourceInfo: { source: "profile" }, disableModelInvocation: false }] }),
    getPrompts: () => ({ prompts: [] }),
  }, { extensions: [], errors: [] });
  assert.deepEqual(configuration.runtime.skills, [{
    name: "todo-discipline",
    description: "Keep TODOs bounded.",
    path: "/tmp/SKILL.md",
    source: "profile",
    disableModelInvocation: false,
  }]);
});

test("profile load errors remain visible while inline resources stay usable", async () => {
  const configuration = new PiConfiguration({ fetchImpl: async () => { throw new Error("network unavailable"); } });
  const resolved = await configuration.resolve({
    profile: "https://example.com/settings.json",
    packages: ["npm:fallback"],
    extensions: [],
  });
  assert.equal(resolved.profile.status, "error");
  assert.match(resolved.profile.error, /network unavailable/);
  assert.deepEqual(resolved.settings.packages, ["npm:fallback"]);
});

test("profiles require explicit configuration", async () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches++;
    throw new Error("profile fetch should not run");
  };
  const ownerOnly = { pi: { profile: null, profileSource: "auto", packages: [], extensions: [] }, repositorySources: { github: { owner: "alice" } } };
  assert.equal(effectivePiConfig(ownerOnly).profile, null);
  assert.equal((await new PiConfiguration({ fetchImpl }).resolve(effectivePiConfig(ownerOnly))).profile.status, "none");

  fs.writeFileSync(path.join(process.env.PI_WEB_HOME, "github-auth.json"), JSON.stringify({ account: { login: "stored-owner" } }));
  const storedIdentityOnly = { pi: { profile: null, profileSource: "auto", packages: [], extensions: [] }, repositorySources: { github: { owner: null } } };
  assert.equal(effectivePiConfig(storedIdentityOnly).profile, null);
  assert.equal((await new PiConfiguration({ fetchImpl }).resolve(effectivePiConfig(storedIdentityOnly))).profile.status, "none");
  assert.equal(fetches, 0);

  const explicit = effectivePiConfig({ pi: { profile: "https://example.com/settings.json", profileSource: "explicit", packages: [], extensions: [] }, repositorySources: { github: { owner: "alice" } } });
  assert.equal(explicit.profile, "https://example.com/settings.json");

  const disabled = effectivePiConfig({
    pi: { profile: "https://example.com/disabled.json", profileSource: "disabled", packages: ["npm:kept"], extensions: ["./kept.ts"] },
    repositorySources: { github: { owner: "alice" } },
  });
  assert.equal(disabled.profile, null);
  assert.equal(disabled.profileSource, "disabled");
  assert.deepEqual(disabled.packages, ["npm:kept"]);
  assert.deepEqual(disabled.extensions, ["./kept.ts"]);
  assert.equal((await new PiConfiguration({ fetchImpl }).resolve(disabled)).profile.status, "none");
  assert.equal(fetches, 0);
});

test("profile refresh replaces stale skills and materializes declared extensions", async () => {
  let revision = 1;
  const skillOne = "---\\nname: first\\ndescription: First skill.\\n---\\nfirst\\n";
  const skillTwo = "---\\nname: second\\ndescription: Second skill.\\n---\\nsecond\\n";
  const extension = "export default function () {}\\n";
  const configuration = new PiConfiguration({
    fetchImpl: async url => {
      if (url === "https://api.github.com/repos/example/dotfiles") return new Response(JSON.stringify({ default_branch: "master" }), { status: 200 });
      if (url === "https://raw.githubusercontent.com/example/dotfiles/master/.pi/agent/settings.json") return new Response(JSON.stringify({ extensions: ["./.pi/agent/extensions/example.ts"] }), { status: 200 });
      if (url === "https://api.github.com/repos/example/dotfiles/git/trees/master?recursive=1") {
        const paths = revision === 1
          ? [".agents/skills/first/SKILL.md", ".agents/skills/first/references/example.md", ".pi/agent/extensions/example.ts"]
          : [".agents/skills/second/SKILL.md", ".pi/agent/extensions/example.ts"];
        return new Response(JSON.stringify({ sha: `commit-${revision}`, tree: paths.map(path => ({ path, type: "blob", size: 40 })) }), { status: 200 });
      }
      if (url.endsWith(".agents/skills/first/SKILL.md")) return new Response(skillOne, { status: 200 });
      if (url.endsWith(".agents/skills/first/references/example.md")) return new Response("reference", { status: 200 });
      if (url.endsWith(".agents/skills/second/SKILL.md")) return new Response(skillTwo, { status: 200 });
      if (url.endsWith(".pi/agent/extensions/example.ts")) return new Response(extension, { status: 200 });
      throw new Error(`unexpected profile request: ${url}`);
    },
  });
  const pi = { profile: "https://github.com/example/dotfiles", profileSource: "explicit", packages: [], extensions: [] };
  const first = await configuration.resolve(pi);
  const stalePath = first.settings.skills.find(value => value.endsWith("first/SKILL.md"));
  assert.ok(stalePath);
  assert.ok(first.settings.extensions.some(value => value.endsWith("example.ts")));
  assert.equal(fs.existsSync(path.join(path.dirname(stalePath), "references", "example.md")), true);

  revision = 2;
  configuration.invalidate();
  const second = await configuration.resolve(pi);
  assert.equal(second.profile.commit, "commit-2");
  assert.ok(second.settings.skills.some(value => value.endsWith("second/SKILL.md")));
  assert.equal(second.settings.skills.some(value => value.endsWith("first/SKILL.md")), false);
  assert.equal(fs.existsSync(stalePath), false);
});

test("PI_WEB_SKIP_PACKAGES leaves the listed profile packages out", async () => {
  const configuration = new PiConfiguration({
    fetchImpl: async url => {
      if (url === "https://api.github.com/repos/bry-guy/dotfiles") return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: [] }), { status: 200 });
      return new Response(JSON.stringify({ packages: ["npm:keep", "git:github.com/bry-guy/pi-background", { source: "git:github.com/bry-guy/pi-keepalive" }] }), { status: 200 });
    },
  });
  const previous = process.env.PI_WEB_SKIP_PACKAGES;
  process.env.PI_WEB_SKIP_PACKAGES = "git:github.com/bry-guy/pi-background, git:github.com/bry-guy/pi-keepalive";
  try {
    const resolved = await configuration.resolve({ profile: "https://github.com/bry-guy/dotfiles", packages: [], extensions: [] });
    assert.deepEqual(resolved.settings.packages, ["npm:keep"]);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_SKIP_PACKAGES;
    else process.env.PI_WEB_SKIP_PACKAGES = previous;
  }
});
