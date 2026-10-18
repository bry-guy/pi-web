import assert from "node:assert/strict";
import { test } from "node:test";
import { entriesToRecords } from "../server/supervisor/real.js";

test("real session entry mapping is stable and preserves custom bang records", () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "toolCall", id: "tc1", name: "read", arguments: { path: "README.md" } }] } },
    { type: "message", id: "tr1", parentId: "a1", message: { role: "toolResult", toolCallId: "tc1", content: "contents" } },
    { type: "custom", id: "b1", parentId: "tr1", customType: "pi-web:bang", data: { id: "bg1", cmd: "echo ok", meta: "exit 0", out: "ok\n" } },
  ];
  const first = entriesToRecords(entries);
  const second = entriesToRecords(entries);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(r => r.id), ["u1", "a:u1", "tc1", "bg1"]);
  assert.equal(first.find(r => r.id === "tc1").out, "contents");
  assert.equal(first.find(r => r.role === "bang").out, "ok\n");
});

test("thinking, timestamps, and pi-summarize entries map into the message model", () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "fix it" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "look first" }, { type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.js" } }] } },
    { type: "message", id: "tr1", parentId: "a1", message: { role: "toolResult", toolCallId: "tc1", content: "src" } },
    { type: "custom", id: "s1", parentId: "tr1", timestamp: "2026-01-01T00:00:05.000Z", customType: "pi-summarize", data: { text: "Read a.js", at: Date.parse("2026-01-01T00:00:05.000Z"), toolCallIds: ["tc1"] } },
    { type: "custom", id: "s2", parentId: "s1", timestamp: "2026-01-01T00:00:06.000Z", customType: "pi-summarize", data: { kind: "title", text: "A title", auto: true } },
  ];
  const records = entriesToRecords(entries);
  assert.equal(records.find(r => r.id === "u1").at, Date.parse("2026-01-01T00:00:00.000Z"));
  const assistant = records.find(r => r.id === "a:u1");
  assert.equal(assistant.thinking, "look first");
  assert.deepEqual(assistant.toolIds, ["tc1"]);
  assert.equal(assistant.text, "");
  assert.equal(records.find(r => r.id === "tc1").at, assistant.at);
  assert.deepEqual(records.filter(r => r.role === "summary").map(r => r.id), ["s1"], "title entries are not step summaries");
  assert.deepEqual(records.find(r => r.role === "summary"), { id: "s1", role: "summary", text: "Read a.js", at: Date.parse("2026-01-01T00:00:05.000Z"), toolCallIds: ["tc1"] });
});
