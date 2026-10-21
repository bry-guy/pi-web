# Plan: web + workspaced + worker

Status: live. The gateway and in-process projects are removed; web holds no
projects when workspaced is configured.

## Shape

```
pi.bry-guy.net
 web ──────── UI, chats (own Pi), GitHub login, sidebar. Works alone.
  │ HTTP+SSE, shared token; Projects hidden when unconfigured
 workspaced ─ create/remove workspaces, hand out grants, route session traffic
  │           providers: kubernetes (pods), local (processes)
 worker ───── one per project: today's pi-ez-web API (REST+SSE) scoped to one
              project, no UI. Pi SDK in-process, repo, tools, Docker, secrets.
```

Invariants: Pi runs via the SDK inside the worker. Web has no Kubernetes
client. One URL, one login, one chat list. Web alone = working chat app.
One image, three entrypoints.

## Steps (each lands and deploys on its own)

0. **Park the gateway.** Scale gateway and `ws-pi-ez-web` to 0 (PVC kept).
1. **Monorepo split, no behavior change.** npm workspaces `packages/web`,
   `packages/workspaced` (from server/gateway), `packages/worker`,
   `packages/shared`. Same commit updates Dockerfile, scripts, tests, CI and
   any infra command paths. Tests green.
2. **Vertical slice: one project on Kubernetes.** Worker = existing server API
   for one project. Web routes by owner and merges:
   - IDs namespaced `<project>:<id>`;
   - `/api/state` merges chats + each worker's projects/sessions;
   - web subscribes to each worker's `/api/events` via workspaced and re-emits
     on its single stream (`public/js/api.js` unchanged);
   - session-scoped calls (sessions, files, branches, hooks) forwarded by
     prefix;
   - pi-sync enrollment runs in the worker that owns the session.
   GitHub token passed from web's login via workspaced. Prove with pi-ez-web.
3. **Local provider.** workspaced runs worker processes for Compose. Required
   before in-process projects are removed.
4. **Migrate existing projects.** Snapshot pi-web PVC first. Keep in-pod paths
   (`/data/repos/<name>`, cwd-keyed Pi session dirs) so session files need no
   rewrite. Keep old Deployment manifests for rollback until verified.
5. **Remaining projects.** castaway (Compose), finances, each with
   its own grants. Remove gateway resources.

## Security
- **workspaced is the most privileged component** (creates pods, mounts
  Secrets). Web authenticates with a shared token from a Secret; a
  NetworkPolicy admits only the web pod.
- **Worker isolation:** NetworkPolicy in pi-ez-workspaces lets only workspaced
  reach workers on 3141; no worker-to-worker traffic. Required for trust
  option C to mean anything.
- **Known phase-1 limit:** one GitHub token reaches every worker. Replace with
  per-project GitHub App tokens later.

## Settled
- Personal config: web and workers fetch the latest dotfiles on every start.

## Worker lifecycle (implemented)
- Workers sleep (Deployment `replicas: 0`, PVC kept) after
  `WORKSPACED_IDLE_MINUTES` (default 5, fractions allowed, `0` off) without user traffic.
- Busy = a proxied request in flight (hooks, setup, bang) or the worker's
  `/api/health` `busy` (agent turn, compaction, queued prompt). Processes
  the agent left running don't count; they die on sleep.
- Any user call through workspaced wakes the worker (waits up to 45s, then
  `503 workspace_starting`). Web's own `/state`, `/events`, `/health`
  never wake one.
- Keep-awake pin = `pi-ez.dev/keep-awake` annotation; sidebar toggle.
- Web caches each worker's last projects in `remote-projects.json` so
  sleeping projects stay listed.
- Readiness probe 1s; startup logs carry ms since process start; workspaced
  logs wake→ready time.

## Cleanup backlog
- Existing workers don't get manifest changes: nothing reconciles. Patch by
  hand or add reconcile.
- Worker env: ship the prestart script as a file, not an env value.

## Open: worker sandbox (blocks egress limits)
Kata and gVisor are retired (Kata cost ~2Gi/250m per worker in `podFixed`
overhead). Workers run as plain pods; app dependencies are Score sidecars.
Candidates for a sandbox: smolvm (libkrun, elastic memory);
Gondolin (earendil-works; QEMU/libkrun microVM with built-in egress and
secret policy). Measure real per-worker overhead before choosing.
