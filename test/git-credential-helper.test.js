import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gitCredentialEnvironment } from "../server/git-credentials.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(root, "server", "git-credential-helper.js");

function runCommand(command, args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function runHelper(args, input, env) {
  return runCommand(process.execPath, [helper, ...args], input, env);
}

function isolatedEnvironment(overrides = {}) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: overrides.PI_WEB_HOME || "/tmp/pi-ez-web-test-home",
    ...overrides,
  };
}

function runGitCredential(input, cwd, env) {
  return spawnSync("git", ["credential", "fill"], { input, cwd, encoding: "utf8", env });
}

test("Git credentials prefer the runtime token and fall back to stored OAuth", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-git-helper-"));
  try {
    const authPath = path.join(home, "github-auth.json");
    fs.writeFileSync(authPath, JSON.stringify({ accessToken: "stored-token" }));
    const input = "protocol=https\nhost=github.com\n\n";
    const environment = await runHelper(["get"], input, isolatedEnvironment({ PI_WEB_HOME: home, PI_WEB_GITHUB_TOKEN: "environment-token" }));
    assert.equal(environment.code, 0);
    assert.match(environment.stdout, /password=environment-token/);
    assert.doesNotMatch(environment.stdout, /stored-token/);
    assert.equal(environment.stderr, "");

    const stored = await runHelper(["get"], input, isolatedEnvironment({ PI_WEB_HOME: home }));
    assert.equal(stored.code, 0);
    assert.match(stored.stdout, /password=stored-token/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Git credentials are exact HTTPS GitHub get-only lookups", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-git-helper-"));
  try {
    const authPath = path.join(home, "github-auth.json");
    fs.writeFileSync(authPath, JSON.stringify({ accessToken: "stored-token" }));
    const env = isolatedEnvironment({ PI_WEB_HOME: home, PI_WEB_GITHUB_TOKEN: "environment-token" });
    for (const input of [
      "protocol=http\nhost=github.com\n\n",
      "protocol=https\nhost=github.com.evil\n\n",
      "protocol=https\nhost=example.test\n\n",
    ]) {
      const result = await runHelper(["get"], input, env);
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "");
    }
    for (const operation of ["store", "erase", "unknown"]) {
      const result = await runHelper([operation], "protocol=https\nhost=github.com\npassword=sentinel\n\n", env);
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
    const missing = await runHelper(["get"], "protocol=https\nhost=github.com\n\n", isolatedEnvironment({ PI_WEB_HOME: path.join(home, "missing") }));
    assert.equal(missing.code, 0);
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, "");
    const malformed = await runHelper(["get"], "protocol=https\nhost=github.com\n\n", { ...env, PI_WEB_GITHUB_TOKEN: "bad\nvalue" });
    assert.equal(malformed.code, 0);
    assert.equal(malformed.stdout, "");
    assert.equal(fs.readFileSync(authPath, "utf8"), JSON.stringify({ accessToken: "stored-token" }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("GitHub URL-scoped helper wins without changing unrelated hosts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-git-precedence-"));
  const cwd = path.join(tmp, "empty");
  const trace = path.join(tmp, "trace");
  fs.mkdirSync(cwd);
  const helperScript = (name) => {
    const file = path.join(tmp, `${name}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' ${name} >> \"$TRACE\"\nprintf 'protocol=https\\nhost=github.com\\nusername=${name}\\npassword=${name}\\n\\n'\n`);
    fs.chmodSync(file, 0o700);
    return file;
  };
  try {
    const generic = helperScript("generic");
    const urlOld = helperScript("url-old");
    const config = path.join(tmp, "config");
    fs.writeFileSync(config, `[credential]\n\thelper = ${generic}\n[credential \"https://github.com\"]\n\thelper = ${urlOld}\n`);
    const base = {
      HOME: path.join(tmp, "home"),
      PI_WEB_HOME: path.join(tmp, "pi-web"),
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      TRACE: trace,
      PI_WEB_GITHUB_TOKEN: "environment-token",
    };
    const run = (protocol, host) => {
      fs.writeFileSync(trace, "");
      const result = runGitCredential(`protocol=${protocol}\nhost=${host}\n\n`, cwd, gitCredentialEnvironment(base));
      return {
        status: result.status,
        invocations: fs.readFileSync(trace, "utf8").trim().split(/\r?\n/).filter(Boolean),
        authoritative: result.stdout.includes("username=x-access-token") && result.stdout.includes("password=environment-token"),
        generic: result.stdout.includes("username=generic"),
        urlOld: result.stdout.includes("username=url-old"),
      };
    };
    const github = run("https", "github.com");
    const unrelatedHttps = run("https", "example.test");
    const githubHttp = run("http", "github.com");
    const lookalike = run("https", "github.com.evil");
    assert.equal(github.status, 0);
    assert.deepEqual(github.invocations, []);
    assert.equal(github.authoritative, true);
    assert.equal(github.generic, false);
    assert.equal(github.urlOld, false);
    assert.deepEqual(unrelatedHttps.invocations, ["generic"]);
    assert.equal(unrelatedHttps.generic, true);
    assert.deepEqual(githubHttp.invocations, ["generic"]);
    assert.equal(githubHttp.generic, true);
    assert.deepEqual(lookalike.invocations, ["generic"]);
    assert.equal(lookalike.generic, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("installed helper wrappers forward Git protocol arguments", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-git-installed-helper-"));
  const home = path.join(tmp, "home");
  const wrapper = path.join(tmp, "git-helper");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "github-auth.json"), JSON.stringify({ accessToken: "stored-token" }));
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${helper} "$@"\n`);
  fs.chmodSync(wrapper, 0o700);
  try {
    const result = await runCommand(wrapper, ["get"], "protocol=https\nhost=github.com\n\n", isolatedEnvironment({ PI_WEB_HOME: home }));
    assert.equal(result.code, 0);
    assert.match(result.stdout, /password=stored-token/);
    assert.equal(result.stderr, "");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Git environment appends config without mutating or hiding inherited entries", () => {
  const source = {
    PATH: "/bin",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "helper-command",
    GIT_ASKPASS: "/tmp/inherited-askpass",
    GIT_ASKPASS_REQUIRE: "force",
  };
  const environment = gitCredentialEnvironment(source);
  assert.deepEqual(source, {
    PATH: "/bin",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "helper-command",
    GIT_ASKPASS: "/tmp/inherited-askpass",
    GIT_ASKPASS_REQUIRE: "force",
  });
  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
  assert.equal(environment.GIT_ASKPASS, undefined);
  assert.equal(environment.GIT_ASKPASS_REQUIRE, undefined);
  assert.equal(environment.GIT_CONFIG_COUNT, "3");
  assert.equal(environment.GIT_CONFIG_KEY_0, "credential.helper");
  assert.equal(environment.GIT_CONFIG_VALUE_0, "helper-command");
  assert.equal(environment.GIT_CONFIG_KEY_1, "credential.https://github.com.helper");
  assert.equal(environment.GIT_CONFIG_VALUE_1, "");
  assert.equal(environment.GIT_CONFIG_KEY_2, "credential.https://github.com.helper");
  assert.match(environment.GIT_CONFIG_VALUE_2, /^!'/);
  assert.throws(() => gitCredentialEnvironment({ GIT_CONFIG_COUNT: "not-a-count" }), error => error.code === "invalid_git_configuration");
  assert.throws(() => gitCredentialEnvironment({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper" }), error => error.code === "invalid_git_configuration");
});

// A role's bot in an OpenShell sandbox (PI_WEB_GITHUB_BOT): the placeholder file is the only source.
const PLACEHOLDER = "openshell:resolve:env:v3_OPENSHELL_GITHUB_PLACEHOLDER";

test("in a bot sandbox git gets the placeholder file's value and never a token variable or another file", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-git-helper-"));
  try {
    const authPath = path.join(home, "openshell-github-auth.json");
    // A login left in the default place must not be picked up.
    fs.writeFileSync(path.join(home, "github-auth.json"), JSON.stringify({ accessToken: "web-login" }));
    const input = "protocol=https\nhost=github.com\n\n";
    const env = isolatedEnvironment({ PI_WEB_HOME: home, PI_WEB_GITHUB_BOT: "pi-web-developer", PI_WEB_GITHUB_AUTH_FILE: authPath, PI_WEB_GITHUB_TOKEN: "environment-token" });

    const missing = await runHelper(["get"], input, env);
    assert.equal(missing.code, 0);
    assert.equal(missing.stdout, "", "no file yet: no credential, so git fails");

    fs.writeFileSync(authPath, `${JSON.stringify({ accessToken: PLACEHOLDER })}\n`);
    const served = await runHelper(["get"], input, env);
    assert.equal(served.stdout, `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${PLACEHOLDER}\n\n`);

    // The file is read on every call: a rewritten placeholder is used by the next git command.
    fs.writeFileSync(authPath, JSON.stringify({ accessToken: PLACEHOLDER.replace("v3", "v4") }));
    assert.match((await runHelper(["get"], input, env)).stdout, /password=openshell:resolve:env:v4_/);

    const { PI_WEB_GITHUB_AUTH_FILE: _, ...noFile } = env;
    assert.equal((await runHelper(["get"], input, noFile)).stdout, "", "no path set: nothing, not the default file");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the gh wrapper gives gh the bot's placeholder in a bot sandbox and nothing anywhere else", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-gh-wrapper-"));
  try {
    const authPath = path.join(home, "openshell-github-auth.json");
    const fakeGh = path.join(home, "gh");
    fs.writeFileSync(fakeGh, "#!/bin/sh\necho \"args=$*\"\necho \"GH_TOKEN=${GH_TOKEN-unset}\"\necho \"GITHUB_TOKEN=${GITHUB_TOKEN-unset}\"\nexit 7\n", { mode: 0o755 });
    const base = { PI_WEB_HOME: home, PI_WEB_GH_BIN: fakeGh, PI_WEB_GITHUB_AUTH_FILE: authPath, GH_TOKEN: "inherited-gh", GITHUB_TOKEN: "inherited-github" };
    const bot = isolatedEnvironment({ ...base, PI_WEB_GITHUB_BOT: "pi-web-developer" });

    const missing = await runHelper(["gh", "pr", "list"], "", bot);
    assert.equal(missing.code, 1);
    assert.equal(missing.stdout, "", "gh is not run without the bot's login, not even with an inherited token");
    assert.match(missing.stderr, /no GitHub login for pi-web-developer in this sandbox yet/);

    fs.writeFileSync(authPath, JSON.stringify({ accessToken: PLACEHOLDER }));
    const run = await runHelper(["gh", "pr", "create", "--title", "a b"], "", bot);
    assert.equal(run.code, 7, "gh's own exit status");
    assert.equal(run.stdout, `args=pr create --title a b\nGH_TOKEN=${PLACEHOLDER}\nGITHUB_TOKEN=unset\n`);

    // Not a bot sandbox: gh runs as it is. The stored file is web's login there and is not handed to gh.
    const plain = await runHelper(["gh", "auth", "status"], "", isolatedEnvironment(base));
    assert.equal(plain.stdout, "args=auth status\nGH_TOKEN=inherited-gh\nGITHUB_TOKEN=inherited-github\n");
    const { GH_TOKEN: _a, GITHUB_TOKEN: _b, ...bare } = base;
    assert.match((await runHelper(["gh", "auth", "status"], "", isolatedEnvironment(bare))).stdout, /GH_TOKEN=unset/);

    const absent = await runHelper(["gh", "version"], "", isolatedEnvironment({ ...base, PI_WEB_GH_BIN: path.join(home, "no-gh") }));
    assert.equal(absent.code, 127);
    assert.match(absent.stderr, /the GitHub CLI is not in this image/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
