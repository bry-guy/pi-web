#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function validToken(value) {
  return typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value) ? value : null;
}

function storedToken() {
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
  if (environmentToken) return validToken(environmentToken);
  // OpenShell gateway providers (e.g. a role's GitHub App) inject placeholders the supervisor resolves.
  return storedToken() || validToken(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
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
