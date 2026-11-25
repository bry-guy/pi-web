import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../server/config.js";
import { runPrestartCommand, startServer } from "../server/index.js";

function withEnv(values, fn) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("blank prestart commands are ignored", () => {
  withEnv({ PI_WEB_PRESTART_COMMAND: "  \n  ", PI_WEB_PRESTART_TIMEOUT_MS: "not-a-number" }, () => {
    runPrestartCommand();
  });
});

test("prestart commands preserve multiline shell and startup environment", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-prestart-"));
  const output = path.join(tmp, "environment.txt");
  const values = {
    HOME: path.join(tmp, "home"),
    XDG_CONFIG_HOME: path.join(tmp, "config"),
    XDG_DATA_HOME: path.join(tmp, "data"),
    XDG_CACHE_HOME: path.join(tmp, "cache"),
    PI_WEB_HOME: path.join(tmp, "web"),
    PI_CODING_AGENT_DIR: path.join(tmp, "agent"),
    PRESTART_OUTPUT: output,
    PI_WEB_PRESTART_TIMEOUT_MS: undefined,
    PI_WEB_PRESTART_COMMAND: `mkdir -p "${path.dirname(output)}"\nprintf '%s\\n' "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$PI_WEB_HOME" "$PI_CODING_AGENT_DIR" > "$PRESTART_OUTPUT"`,
  };
  try {
    withEnv(values, () => runPrestartCommand());
    assert.deepEqual(fs.readFileSync(output, "utf8").trimEnd().split("\n"), [
      values.HOME,
      values.XDG_CONFIG_HOME,
      values.XDG_DATA_HOME,
      values.XDG_CACHE_HOME,
      values.PI_WEB_HOME,
      values.PI_CODING_AGENT_DIR,
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("prestart runs before the server and configuration are initialized", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-prestart-order-"));
  const webHome = path.join(tmp, "web");
  try {
    withEnv({
      PI_WEB_HOME: webHome,
      PI_CODING_AGENT_DIR: path.join(tmp, "agent"),
      PI_WEB_MODE: "mock",
      PORT: undefined,
      PI_WEB_PRESTART_TIMEOUT_MS: undefined,
      PI_WEB_PRESTART_COMMAND: `mkdir -p "$PI_WEB_HOME"\nprintf '%s\\n' '{"defaultThinkingLevel":"xhigh"}' > "$PI_WEB_HOME/config.json"`,
    }, () => {
      const { server } = startServer(0);
      try {
        assert.equal(loadConfig().defaultThinkingLevel, "xhigh");
        assert.ok(fs.existsSync(path.join(webHome, "config.json")));
      } finally {
        server.closeAllConnections?.();
        server.close();
      }
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("prestart failures abort startup without exposing the command", () => {
  withEnv({ PI_WEB_PRESTART_COMMAND: "exit 23", PI_WEB_PRESTART_TIMEOUT_MS: undefined }, () => {
    assert.throws(() => runPrestartCommand(), error => {
      assert.equal(error.code, "prestart_failed");
      assert.match(error.message, /exited with status 23/);
      assert.doesNotMatch(error.message, /exit 23/);
      return true;
    });
  });
});

test("prestart timeout aborts startup", () => {
  withEnv({ PI_WEB_PRESTART_COMMAND: "sleep 1", PI_WEB_PRESTART_TIMEOUT_MS: "10" }, () => {
    assert.throws(() => runPrestartCommand(), error => {
      assert.equal(error.code, "prestart_failed");
      assert.match(error.message, /timed out after 10ms/);
      return true;
    });
  });
});

test("invalid prestart timeout aborts startup", () => {
  withEnv({ PI_WEB_PRESTART_COMMAND: "true", PI_WEB_PRESTART_TIMEOUT_MS: "0" }, () => {
    assert.throws(() => runPrestartCommand(), error => {
      assert.equal(error.code, "prestart_failed");
      assert.match(error.message, /positive integer/);
      return true;
    });
  });
});

test("the workers' prestart writes the role-grant trust anchor from PI_ROLES_SIGNER and removes it when that is empty", () => {
  const yaml = fs.readFileSync(new URL("../deploy/k8s/workspaced/workspace-env.yaml", import.meta.url), "utf8");
  const block = /^ {4}if \[ -n "\$\{PI_ROLES_SIGNER:-\}" \]; then\n[\s\S]*?^ {4}fi$/m.exec(yaml)?.[0];
  assert.ok(block, "the PI_ROLES_SIGNER step of PI_WEB_PRESTART_COMMAND");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-prestart-signer-"));
  const anchor = path.join(home, ".local/state/pi-roles/allowed_signers");
  const run = signer => execFileSync("sh", ["-euc", block], { env: { PATH: process.env.PATH, HOME: home, PI_ROLES_SIGNER: signer } });
  try {
    run(""); // nothing to remove on a new disk
    run("ssh-ed25519 AAAA");
    assert.equal(fs.readFileSync(anchor, "utf8"), "pi-roles ssh-ed25519 AAAA\n");
    run("");
    assert.equal(fs.existsSync(anchor), false, "an emptied signer leaves no old trust anchor on the worker's disk");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
