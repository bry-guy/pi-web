import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appJwt, githubAppMinter, mintInstallationToken } from "../workspaced/github-app.js";

// A key made for this run: never a real App key.
const { privateKey: KEY } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const KEY_BODY = KEY.split("\n")[1];
const TOKEN = "ghs_FAKEinstallationTOKEN0123456789";
const NOW = Date.parse("2026-11-24T06:00:00Z");
const GITHUB = { app: "pi-web-developer", repos: ["bry-guy/pi-web", "bry-guy/pi-sync"], permissions: { contents: "write", pull_requests: "write" } };

// GitHub's two routes; `answers` overrides a route's [status, body].
function fakeGitHub(answers = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const route = `${init.method} ${new URL(url).pathname}`;
    calls.push({ route, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const [status, body] = answers[route] || {
      "GET /repos/bry-guy/pi-web/installation": [200, { id: 4242 }],
      "POST /app/installations/4242/access_tokens": [201, { token: TOKEN, expires_at: new Date(NOW + 3_600_000).toISOString() }],
    }[route] || [404, { message: "Not Found" }];
    return { ok: status < 300, status, json: async () => body };
  };
  return { calls, fetchImpl };
}
const mint = (gh, extra = {}) => mintInstallationToken({ ...GITHUB, appId: "5662729", privateKey: KEY, fetchImpl: gh.fetchImpl, now: () => NOW, ...extra });
const secretFree = text => { assert.ok(!text.includes(KEY_BODY) && !text.includes(TOKEN) && !/eyJ[A-Za-z0-9_-]+\./.test(text), text); };

test("the App JWT is RS256, signed by the key, issued a minute back and good for nine minutes", () => {
  const [header, payload, signature] = appJwt({ appId: "5662729", privateKey: KEY, now: NOW }).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), { iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: "5662729" });
  assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), createPublicKey(KEY), Buffer.from(signature, "base64url")));
});

test("a token is minted for exactly the grant's repositories and permissions", async () => {
  const gh = fakeGitHub();
  assert.deepEqual(await mint(gh), { token: TOKEN, expiresAt: NOW + 3_600_000 });
  assert.deepEqual(gh.calls.map(c => c.route), ["GET /repos/bry-guy/pi-web/installation", "POST /app/installations/4242/access_tokens"]);
  assert.deepEqual(gh.calls[1].body, { repositories: ["pi-web", "pi-sync"], permissions: { contents: "write", pull_requests: "write" } });
  for (const c of gh.calls) assert.match(c.headers.authorization, /^Bearer eyJ/);
});

test("every failure is github_token_unavailable (502) and names no key, JWT or token", async () => {
  const cases = [
    ["a refused permission", fakeGitHub({ "POST /app/installations/4242/access_tokens": [422, { message: "The permissions requested are not granted to this installation." }] }), {}, /access_tokens answered 422 \(The permissions requested are not granted/],
    ["an App that is not installed", fakeGitHub({ "GET /repos/bry-guy/pi-web/installation": [404, { message: "Not Found" }] }), {}, /installation answered 404 \(Not Found\)/],
    ["an answer without a token", fakeGitHub({ "POST /app/installations/4242/access_tokens": [201, { expires_at: new Date(NOW + 1).toISOString() }] }), {}, /without a usable token/],
    ["a token already expired", fakeGitHub({ "POST /app/installations/4242/access_tokens": [201, { token: TOKEN, expires_at: new Date(NOW - 1).toISOString() }] }), {}, /without a usable token/],
    ["GitHub echoing the JWT", { calls: [], fetchImpl: async (url, init) => ({ ok: false, status: 401, json: async () => ({ message: `bad credentials ${init.headers.authorization.slice(7)}` }) }) }, {}, /answered 401 \(bad credentials \[redacted\]\)/],
    ["no network", { calls: [], fetchImpl: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); } }, {}, /did not answer \(ENOTFOUND\)/],
    ["a key that is not a key", fakeGitHub(), { privateKey: `not a key ${KEY_BODY}` }, /private-key is not an RSA private key/],
    ["an app id that is not a number", fakeGitHub(), { appId: "abc" }, /app-id is not a number/],
  ];
  for (const [what, gh, extra, message] of cases) {
    await assert.rejects(mint(gh, extra), e => {
      assert.equal(e.code, "github_token_unavailable", what);
      assert.equal(e.status, 502, what);
      assert.match(e.message, message, what);
      secretFree(e.message);
      return true;
    });
  }
});

test("the minter reads the mounted Secret at every mint and says which file is missing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "github-apps-"));
  try {
    const gh = fakeGitHub();
    const minter = githubAppMinter({ dir, fetchImpl: gh.fetchImpl, now: () => NOW });
    await assert.rejects(minter(GITHUB), e => e.code === "github_token_unavailable" && /cannot read app-id of Secret pi-web-developer-github-app \(ENOENT\)/.test(e.message));
    mkdirSync(path.join(dir, "pi-web-developer-github-app"));
    writeFileSync(path.join(dir, "pi-web-developer-github-app", "app-id"), "5662729\n");
    await assert.rejects(minter(GITHUB), /cannot read private-key of Secret/);
    // The Secret arrives (or is rotated) with no restart.
    writeFileSync(path.join(dir, "pi-web-developer-github-app", "private-key"), KEY);
    assert.equal((await minter(GITHUB)).token, TOKEN);
    assert.equal(JSON.parse(Buffer.from(gh.calls[0].headers.authorization.split(".")[1], "base64url")).iss, "5662729");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
