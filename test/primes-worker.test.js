import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensurePrimeAgentsFile } from "../server/pi-projects.js";
import { post, setupServerFixture, supervisor } from "./helpers/server-fixture.js";

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
