// Sleep/wake for workers. A sleeping worker is scaled to zero (its volume
// stays), so idle projects cost no memory. At most maxAwake run at once; the
// least recently used idle one sleeps to make room. idleMs optionally also
// sleeps workers after a fixed idle time. Activity = proxied requests other
// than the passive ones web makes on its own (state, events, health).
export const PASSIVE = /^\/api\/(events|state|health)$/;

export function createLifecycle({
  provider, fetchImpl = globalThis.fetch, log = console.log,
  idleMs = 0, maxAwake = 3, sweepMs = 60_000, wakeTimeoutMs = 45_000, pollMs = 500, cacheMs = 3_000, now = Date.now,
}) {
  const lastUsed = new Map();
  const inflight = new Map();
  const waking = new Map();
  // Wakes run one at a time: each start (and its preload)
  // briefly needs more memory than an idle worker, so they must not stack.
  let wakeQueue = Promise.resolve();
  let cache = { at: -Infinity, byName: new Map() };

  async function refresh() {
    const list = await provider.list();
    cache = { at: now(), byName: new Map(list.map(w => [w.name, w])) };
    for (const w of list) if (!lastUsed.has(w.name)) lastUsed.set(w.name, now());
    return list;
  }
  async function info(name) {
    if (now() - cache.at > cacheMs) await refresh();
    return cache.byName.get(name) || null;
  }
  const touch = name => lastUsed.set(name, now());
  const lastUsedAt = name => lastUsed.get(name) ?? null;
  // A request in flight, or the worker reporting an agent turn.
  const busy = async name => !!inflight.get(name) || !!(await health(name))?.busy;

  async function health(name) {
    const base = provider.upstream(name);
    if (!base) return null;
    try {
      const res = await fetchImpl(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  // Can this worker be put to sleep right now without interrupting anything?
  async function evictable(w) {
    if (w.state !== "running" || w.pinned || inflight.get(w.name)) return false;
    const h = await health(w.name);
    if (h?.busy) { touch(w.name); return false; }
    return true;
  }

  // LRU: keep at most maxAwake workers up (pinned ones count but are never
  // chosen); put the least recently used idle ones to sleep to make room.
  async function makeRoom(keep, reserve = 0) {
    if (!maxAwake) return;
    const list = [...(await refresh())];
    // A failed worker (crash loop, unschedulable, sandbox won't boot) holds no
    // running process worth counting; leave it for the user to see and restart.
    const awake = list.filter(w => w.state !== "sleeping" && w.state !== "failed" && !w.problem?.fatal && w.name !== keep);
    let excess = awake.length + reserve - maxAwake;
    const candidates = awake.sort((a, b) => (lastUsed.get(a.name) ?? 0) - (lastUsed.get(b.name) ?? 0));
    for (const w of candidates) {
      if (excess <= 0) break;
      if (!await evictable(w)) continue;
      await sleep(w.name, "least recently used").then(() => excess--, e => log(`workspaced: could not sleep ${w.name}: ${e.message}`));
    }
    if (excess > 0) log(`workspaced: ${excess} over the ${maxAwake}-worker limit; every awake worker is busy or pinned`);
  }

  async function doWake(name) {
    const started = now();
    await makeRoom(name, 1);
    await provider.scale(name, 1);
    const deadline = started + wakeTimeoutMs;
    while (now() < deadline) {
      const w = cache.byName.get(name);
      if (w?.problem?.fatal) { log(`workspaced: ${name} failed to start: ${w.problem.reason}`); return false; }
      if (await health(name)) {
        log(`workspaced: woke ${name} in ${now() - started}ms`);
        cache.at = -Infinity;
        touch(name);
        return true;
      }
      await new Promise(r => setTimeout(r, pollMs));
      await refresh().catch(() => {});
    }
    return false;
  }

  // Resolves true once the worker answers; false if it is still starting.
  async function ensureAwake(name) {
    const w = await info(name);
    if (w?.problem?.fatal) return false;
    if (w?.state !== "sleeping" && w?.state !== "starting") return true;
    if (!waking.has(name)) {
      const run = wakeQueue.then(() => doWake(name)).finally(() => waking.delete(name));
      wakeQueue = run.catch(() => {});
      waking.set(name, run);
    }
    return waking.get(name);
  }

  async function sleep(name, reason) {
    await provider.scale(name, 0);
    cache.at = -Infinity;
    log(`workspaced: slept ${name} (${reason})`);
  }

  // Busy = a request in flight (hooks, setup, bang commands) or the worker
  // reporting an agent turn; background processes the agent left don't count.
  async function sweep() {
    if (idleMs) {
      for (const w of await refresh()) {
        if (now() - (lastUsed.get(w.name) ?? now()) < idleMs || !await evictable(w)) continue;
        await sleep(w.name, "idle").catch(e => log(`workspaced: could not sleep ${w.name}: ${e.message}`));
      }
    }
    await makeRoom(null);
    await upgrade();
  }

  // Move workers onto workspaced's image: sleeping ones now (free), awake
  // ones only when idle, since it restarts them.
  async function upgrade() {
    if (!provider.upgrade) return;
    for (const w of await refresh()) {
      if (!w.outdated || (w.state !== "sleeping" && !await evictable(w))) continue;
      await provider.upgrade(w.name).then(() => log(`workspaced: upgraded ${w.name}`), e => log(`workspaced: could not upgrade ${w.name}: ${e.message}`));
    }
  }
  const timer = (idleMs || maxAwake) && sweepMs ? setInterval(() => sweep().catch(() => {}), sweepMs) : null;
  timer?.unref?.();
  if (timer) setTimeout(() => sweep().catch(() => {}), 0).unref?.();

  return {
    info, touch, lastUsedAt, busy, ensureAwake, sleep, sweep, refresh, makeRoom,
    // Clears a failed worker and makes room first, like a wake. The route refuses asleep and busy workers.
    async restart(name) {
      if (!provider.restart) throw Object.assign(new Error("restart unsupported"), { status: 501, code: "restart_unsupported" });
      await makeRoom(name, 1).catch(() => {});
      await provider.restart(name);
      cache.at = -Infinity;
      touch(name);
      log(`workspaced: restarted ${name}`);
    },
    begin(name) { inflight.set(name, (inflight.get(name) || 0) + 1); touch(name); },
    end(name) { inflight.set(name, Math.max(0, (inflight.get(name) || 1) - 1)); touch(name); },
    stop() { clearInterval(timer); },
  };
}
