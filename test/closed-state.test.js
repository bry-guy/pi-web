import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { appHome, loadClosed, saveClosed } from "../server/config.js";
import { closeSession } from "../server/lifecycle.js";

let home;
const previousHome = process.env.PI_WEB_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-closed-state-"));
  process.env.PI_WEB_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PI_WEB_HOME;
  else process.env.PI_WEB_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("missing closed archive loads as an empty set", () => {
  assert.deepEqual(loadClosed(), new Set());
  assert.equal(fs.existsSync(path.join(appHome(), "closed.json")), false);
});

test("invalid closed archive JSON is rethrown", () => {
  fs.writeFileSync(path.join(home, "closed.json"), "[");
  assert.throws(loadClosed, SyntaxError);
});

test("closed archive must be an array of nonempty session IDs", () => {
  const archive = path.join(home, "closed.json");
  for (const value of [null, "session-id", {}, 42, [null], [42], [{}], ["session-id", ""]]) {
    fs.writeFileSync(archive, JSON.stringify(value));
    assert.throws(loadClosed, TypeError);
  }
});

test("non-ENOENT closed archive read errors are rethrown", () => {
  fs.mkdirSync(path.join(home, "closed.json"));
  assert.throws(loadClosed, error => error.code === "EISDIR");
});

test("closing cannot overwrite a corrupt closed archive", async () => {
  const archive = path.join(home, "closed.json");
  const original = "[";
  fs.writeFileSync(archive, original);
  const events = [];

  await assert.rejects(closeSession({ allSessions: () => [] }, {
    emit: (...event) => events.push(event),
  }, "session-id"), SyntaxError);

  assert.equal(fs.readFileSync(archive, "utf8"), original);
  assert.deepEqual(events, []);
});

test("closed session IDs roundtrip", () => {
  const ids = new Set(["session-one", "session-two"]);
  saveClosed(ids);
  assert.deepEqual(loadClosed(), ids);
});

test("closing stops a turn and unloads the conversation and its forks, and gives pi-sync no command", async () => {
  const calls = [];
  const sup = {
    allSessions: () => [{ id: "child", parentSessionId: "root" }],
    isStreaming: id => id === "root",
    isOpen: id => id === "child",
    stop: async id => { calls.push(["stop", id]); },
    unload: async id => { calls.push(["unload", id]); },
    command: async (id, text) => { calls.push(["command", id, text]); },
  };
  const previous = process.env.PI_SYNC_SERVER_URL;
  process.env.PI_SYNC_SERVER_URL = "http://sync.test";
  try {
    assert.deepEqual(await closeSession(sup, { emit: () => {} }, "root"), { closed: true });
  } finally {
    if (previous === undefined) delete process.env.PI_SYNC_SERVER_URL;
    else process.env.PI_SYNC_SERVER_URL = previous;
  }
  assert.deepEqual(calls, [["stop", "root"], ["unload", "root"], ["unload", "child"]], "a detach would be written into the conversation");
  assert.deepEqual([...loadClosed()].sort(), ["child", "root"]);
});

test("a conversation that cannot be unloaded is closed all the same", async () => {
  const reports = [];
  const sup = { allSessions: () => [], unload: async () => { throw new Error("stuck"); } };
  await closeSession(sup, { emit: () => {} }, "root", { report: event => reports.push(event) });
  assert.deepEqual([...loadClosed()], ["root"]);
  assert.ok(reports.some(event => event.type === "warning" && /stuck/.test(event.message)));
});
