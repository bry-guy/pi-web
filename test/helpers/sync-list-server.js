import http from "node:http";

// A stand-in for pi-syncd that only lists conversations (GET /v1/sessions). `sessions` holds ids or partial
// items and may be changed between requests; each is given the fields pi-sync's client requires.
export async function syncListServer(sessions = []) {
  const item = entry => ({
    title: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", headEntryId: "e1", etag: "1",
    devices: [{ label: "laptop", lastSeen: "2026-01-02T00:00:00.000Z" }],
    ...(typeof entry === "string" ? { sessionId: entry } : entry),
  });
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ formatVersion: 1, sessions: sessions.map(item) }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    sessions,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
