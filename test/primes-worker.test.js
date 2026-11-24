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

test("a worker hands web its follow-up requests and keeps web's list from the acknowledgement", async () => {
  const made = requestFollowUp({ session: "conv", in_minutes: 30, note: "Check again." });
  assert.deepEqual(await (await get("/api/follow-ups")).json(), { requests: [made] });
  assert.equal((await post("/api/follow-ups/ack", { ids: [made.id] })).status, 400, "no list, no acknowledgement");
  const scheduled = [{ id: made.id, due: made.due, note: made.note }];
  assert.equal((await post("/api/follow-ups/ack", { ids: [made.id], pending: scheduled })).status, 200);
  assert.deepEqual(await (await get("/api/follow-ups")).json(), { requests: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.PI_WEB_HOME, "follow-ups.json"), "utf8")), { requests: [], pending: scheduled });
});
