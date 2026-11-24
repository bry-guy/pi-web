#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Set by workspaced only in an OpenShell sandbox whose grant has a GitHub App (docs/workspaced.md#github-as-a-roles-bot).
// There PI_WEB_GITHUB_AUTH_FILE holds a gateway placeholder for the App's token and is the only source: no token
// variable and no other file, so git and gh fail rather than use another login.
const bot = process.env.PI_WEB_GITHUB_BOT;

function validToken(value) {
  return typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value) ? value : null;
}

function storedToken() {
  if (bot && !process.env.PI_WEB_GITHUB_AUTH_FILE) return null;
  const authPath = process.env.PI_WEB_GITHUB_AUTH_FILE || path.join(process.env.PI_WEB_HOME || path.join(process.env.HOME || ".", ".pi-web-ui"), "github-auth.json");
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    return validToken(auth?.accessToken);
  } catch {
    return null;
  }
}

function effectiveToken() {
  const environmentToken = process.env.PI_WEB_GITHUB_TOKEN;
  if (environmentToken && !bot) return validToken(environmentToken);
  return storedToken();
}

// `gh <args>`: the worker image's /usr/local/bin/gh runs this. gh reads no file, so the bot's placeholder goes in
// GH_TOKEN. Anywhere else gh runs as it is, with no login from pi-web.
if (process.argv[2] === "gh") {
  const env = { ...process.env };
  if (bot) {
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[name];
    const token = storedToken();
    if (!token) {
      console.error(`gh: no GitHub login for ${bot} in this sandbox yet; workspaced writes it at start and every few minutes`);
      process.exit(1);
    }
    env.GH_TOKEN = token;
  }
  const done = spawnSync(process.env.PI_WEB_GH_BIN || "/usr/bin/gh", process.argv.slice(3), { stdio: "inherit", env });
  if (done.error) console.error(`gh: ${done.error.code === "ENOENT" ? "the GitHub CLI is not in this image" : done.error.message}`);
  process.exit(done.error ? 127 : done.status ?? 1);
}

if (process.argv[2] !== "get") process.exit(0);

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const values = {};
  for (const line of input.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1);
  }
  if (values.protocol !== "https" || values.host?.toLowerCase() !== "github.com") return;
  const token = effectiveToken();
  if (!token) return;
  process.stdout.write(`protocol=https\nhost=github.com\nusername=x-access-token\npassword=${token}\n\n`);
});
