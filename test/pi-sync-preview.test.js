import assert from "node:assert/strict";
import { test } from "node:test";
import { previewRecords } from "../server/pi-sync.js";

test("a shared conversation previews its active branch's user and assistant text", () => {
  const entry = (id, parentId, role, content) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message: { role, content } });
  const records = previewRecords({
    headEntryId: "a2",
    entries: [
      { type: "session_info", id: "info", parentId: null, timestamp: "2026-01-01T00:00:00Z" },
      entry("u1", "info", "user", "First question"),
      entry("a1", "u1", "assistant", [{ type: "thinking", thinking: "hm" }, { type: "text", text: "First answer" }]),
      entry("abandoned", "a1", "user", "A branch the head left"),
      entry("u2", "a1", "user", [{ type: "text", text: "Second question" }]),
      entry("tool", "u2", "toolResult", "ignored"),
      entry("a2", "tool", "assistant", [{ type: "toolCall", id: "t" }, { type: "text", text: "Second answer" }]),
    ],
  });
  assert.deepEqual(records.map(record => [record.role, record.text]), [
    ["user", "First question"], ["assistant", "First answer"], ["user", "Second question"], ["assistant", "Second answer"],
  ]);
});
