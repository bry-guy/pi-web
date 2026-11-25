import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensurePrimeAgentsFile } from "../server/pi-projects.js";
import { requestFollowUp } from "../server/follow-ups.js";
import { get, post, setupServerFixture, supervisor } from "./helpers/server-fixture.js";

setupServerFixture();

test("delete refuses a running session and removes an ended one", async () => {
  const { id } = await (await post("/api/chats")).json();
  assert.equal((await post(`/api/sessions/${id}/message`, { text: "hello" })).status, 200);
  const busy = await post(`/api/sessions/${id}/delete`);
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error, "session_streaming");
  for (let i = 0; i < 200 && supervisor.isStreaming(id); i++) await new Promise(r => setTimeout(r, 25));
  assert.ok(await supervisor.meta(id), "still there after the refusal");
  assert.equal((await post(`/api/sessions/${id}/delete`)).status, 200);
  assert.equal(await supervisor.meta(id), null);
  assert.equal((await post(`/api/sessions/${id}/delete`)).status, 404);
});

test("a prime's AGENTS.md is written once and never overwritten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prime-agents-"));
  const file = path.join(dir, "AGENTS.md");
  assert.equal(ensurePrimeAgentsFile(dir), true);
  assert.match(fs.readFileSync(file, "utf8"), /Read `notes\.md` first[\s\S]*update `notes\.md`[\s\S]*only memory between runs/);
  fs.writeFileSync(file, "the owner's own instructions\n");
  assert.equal(ensurePrimeAgentsFile(dir), false);
  assert.equal(fs.readFileSync(file, "utf8"), "the owner's own instructions\n");
});

test("a session gets the follow-up mark only when web says it collects its requests", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prime-projects-"));
  fs.mkdirSync(path.join(root, "eco"));
  fs.writeFileSync(path.join(root, "eco", "project.json"), JSON.stringify({ id: "p1", name: "eco" }));
  const before = process.env.PI_PROJECTS_DIR;
  process.env.PI_PROJECTS_DIR = root;
  const real = supervisor.createSession, asked = [];
  supervisor.createSession = function (options) { asked.push(options.followUpDepth); return real.call(this, options); };
  try {
    const create = body => post("/api/projects/pp-eco/sessions", body).then(r => r.status);
    // A prime's run of a web that collects; a follow-up run two deep; a role run (web sends no depth); a browser's own session.
    assert.deepEqual([
      await create({ agent: "labrat", kind: "run", followUpDepth: 0 }),
      await create({ agent: "labrat", kind: "run", followUpDepth: 2 }),
      await create({ agent: "app/dev", kind: "run" }),
      await create({ followUpDepth: 0 }),
      await create({ agent: "labrat", kind: "run", followUpDepth: "0" }),
    ], [200, 200, 200, 200, 200]);
    assert.deepEqual(asked, [0, 2, null, null, null]);
  } finally {
    supervisor.createSession = real;
    if (before === undefined) delete process.env.PI_PROJECTS_DIR; else process.env.PI_PROJECTS_DIR = before;
  }
});

test("a worker hands web its follow-up requests and keeps web's list from the acknowledgement", async () => {
  const made = requestFollowUp({ session: "conv", in_minutes: 30, note: "Check again." });
  assert.deepEqual(await (await get("/api/follow-ups")).json(), { requests: [made] });
  assert.equal((await post("/api/follow-ups/ack", { ids: [made.id] })).status, 400, "no list, no acknowledgement");
  const scheduled = [{ id: made.id, due: made.due, note: made.note }];
  const refusedOne = requestFollowUp({ session: "conv", in_minutes: 40, note: "One too many." });
  assert.equal((await post("/api/follow-ups/ack", { ids: [made.id, refusedOne.id], pending: scheduled, refused: [{ id: refusedOne.id, reason: "full" }] })).status, 200);
  assert.deepEqual(await (await get("/api/follow-ups")).json(), { requests: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.PI_WEB_HOME, "follow-ups.json"), "utf8")), { requests: [], pending: scheduled, refused: [{ id: refusedOne.id, due: refusedOne.due, note: "One too many.", reason: "full" }] });
});
