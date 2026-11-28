import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { closeSession } from "../server/lifecycle.js";
import { loadClosed, saveClosed } from "../server/config.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("concurrent closes preserve all closed descendants and events", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-concurrent-close-"));
  const previousHome = process.env.PI_WEB_HOME;
  process.env.PI_WEB_HOME = home;
  try {
    saveClosed(new Set(["existing"]));
    const lookups = [deferred(), deferred()];
    let lookupCount = 0;
    const sup = { allSessions: () => lookups[lookupCount++].promise };
    const events = [];
    const hub = { emit: (...event) => events.push(event) };
    const reports = { A: [], B: [] };
    const pendingA = closeSession(sup, hub, "A", { report: event => reports.A.push(event) });
    const pendingB = closeSession(sup, hub, "B", { report: event => reports.B.push(event) });
    const phasesBeforeLookup = Object.fromEntries(Object.entries(reports).map(([id, items]) => [id, items.map(item => item.phase)]));
    const sessions = [
      { id: "A-child", parentSessionId: "A" },
      { id: "A-grandchild", parentSessionId: "A-child" },
      { id: "B-child", parentSessionId: "B" },
    ];
    lookups[0].resolve(sessions);
    lookups[1].resolve(sessions);

    assert.deepEqual(await Promise.all([pendingA, pendingB]), [
      { closed: true },
      { closed: true },
    ]);
    assert.deepEqual([...loadClosed()].sort(), ["A", "A-child", "A-grandchild", "B", "B-child", "existing"]);
    assert.deepEqual(phasesBeforeLookup, { A: [], B: [] });
    assert.deepEqual(Object.fromEntries(Object.entries(reports).map(([id, items]) => [id, items.map(item => item.phase)])), {
      A: ["closed-read", "closed-write", "session-event"],
      B: ["closed-read", "closed-write", "session-event"],
    });
    // Each close unloads its sessions one by one, so which close announces first is not fixed.
    assert.deepEqual(events.sort((a, b) => a[0].localeCompare(b[0])), [
      ["A", "session_closed", { sessionId: "A" }],
      ["A-child", "session_closed", { sessionId: "A-child" }],
      ["A-grandchild", "session_closed", { sessionId: "A-grandchild" }],
      ["B", "session_closed", { sessionId: "B" }],
      ["B-child", "session_closed", { sessionId: "B-child" }],
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.PI_WEB_HOME;
    else process.env.PI_WEB_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
