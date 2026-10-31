export const API_CONTRACT_VERSION = 5;
export const API_CAPABILITIES = Object.freeze([
  "provider-auth",
  "github-device-auth",
  "repository-sources",
  "session-activity",
  "slash-commands",
  "project-hooks",
  "workspace-contexts",
  "workspace-branches",
  "pi-resources",
  "extension-activity",
  "extension-ui",
  "subagent-activity",
  "file-explorer",
  "pi-sync",
]);
export const BUILD_ID = process.env.PI_WEB_BUILD_ID || "development";
/** When this server started: a deploy restarts it, so this is when the running build went live. */
export const STARTED_AT = new Date().toISOString();
