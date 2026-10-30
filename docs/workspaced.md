# workspaced

The control plane. It creates, wakes, sleeps and deletes one worker per project and proxies web's requests to them. It is `node workspaced/index.js` from the same pi-ez-web image, on port 3150. It is the only component that needs a Kubernetes client, and the most privileged one: it can do whatever its largest grant allows.

web can also run it inside itself: with `PI_WEB_WORKSPACED_URL=local`, web builds the same gateway with the `local` provider and calls it in-process (no port, a random token), with workers under `PI_WEB_HOME/workspaces`. See [web](web.md).

## Providers

| `WORKSPACED_PROVIDER` | Workers are | Isolation |
| --- | --- | --- |
| `local` (default) | Child processes in workspaced's container, state under `WORKSPACED_ROOT` | None: one user, one HOME, one trust zone. Grants are recorded, not enforced |
| `kubernetes` | A Deployment, Service and PVC named `ws-<project>` each | Own pod, volume and ServiceAccount, enforced grants, NetworkPolicy-ready labels |

## Configure

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3150` | Listen port |
| `WORKSPACED_TOKEN` | required | Bearer token web must send |
| `WORKSPACED_AUTH` | `token` | `network` drops the token and trusts a NetworkPolicy that admits only web. Use it only where policies are enforced |
| `WORKSPACED_MAX_AWAKE` | `3` | At most this many workers run at once. Waking another puts the least recently used idle one to sleep (never a pinned or busy one). `0` disables. Sleeping keeps the volume; background processes stop unless the project is pinned *Keep awake* |
| `WORKSPACED_IDLE_MINUTES` | `0` (off) | Optionally also sleep any worker after this long without use |
| `WORKSPACED_GRANTS` | `{"default":{"anyProject":true}}` | Grant shapes as JSON, see below |
| `WORKSPACED_ROOT` | `~/.pi-workspaced` | local: where workers' state lives |
| `WORKSPACED_NAMESPACE` | `pi-workspaced` | kubernetes: home namespace for workers |
| `WORKSPACE_IMAGE` | `ghcr.io/bry-guy/pi-ez-web:latest` | kubernetes: worker image. Pin a digest |
| `WORKSPACE_IMAGE_PULL_SECRET` | unset | kubernetes: pull Secret name |
| `WORKSPACE_STORAGE` / `WORKSPACE_STORAGE_CLASS` | `20Gi` / cluster default | kubernetes: each worker's PVC |
| `WORKSPACE_ENV_CONFIGMAP` | unset | kubernetes: ConfigMap loaded into every worker's environment, e.g. `PI_WEB_PRESTART_COMMAND` |
| `WORKSPACE_CPU_REQUEST` / `WORKSPACE_MEMORY_REQUEST` | `250m` / `512Mi` | kubernetes: each worker's requests. Empty unsets |
| `WORKSPACE_CPU_LIMIT` / `WORKSPACE_MEMORY_LIMIT` | unset / `4Gi` | kubernetes: each worker's limits. Empty unsets. Existing workers pick up changes when they next move to a new image |

workspaced's own ServiceAccount needs, in each worker namespace: create/get/list/patch/delete on Deployments, Services and PVCs, plus create/update on the two auth Secrets `pi-ez-github-auth` and `pi-ez-model-auth`. It does not need to create ServiceAccounts, Roles or other Secrets.

For live CPU and memory in the sidebar, grant one more read: `get` and `list` on `pods` in apiGroup `metrics.k8s.io`, in each worker namespace (a namespaced Role and RoleBinding). Without it, or without metrics-server, usage shows as unavailable and nothing else changes. This repository ships no RBAC manifests; add the rule to your deployment's Role.

## Service dependencies

With `WORKSPACED_PROVIDER=kubernetes`, a repository's root `score.yaml` can declare resources (today: `postgres`). Each runs as a native sidecar in the worker's pod with its data on the worker's volume, and its connection settings reach the worker's environment. Users: [dependencies](dependencies.md). Design: [score-resources](score-resources.md).

## Grants

A grant says what a project's worker may hold. The deployer defines grants; a user picks one when adding a repository, and the sidebar shows it read-only. A repository-locked grant refuses other repositories, also when a worker wakes.

```json
{
  "default": { "anyProject": true, "description": "No secrets, internet only." },
  "deployer": {
    "repos": ["you/infra"],
    "serviceAccount": "infra-operator",
    "env": ["operator-env"],
    "namespace": "pi-workspaced",
    "egress": "open",
    "description": "Cluster access and deploy secrets for the infra repo only."
  }
}
```

| Field | Effect on the worker (kubernetes) |
| --- | --- |
| `anyProject` / `repos` | Who may use it; a `default` grant is required |
| `serviceAccount` | Pod ServiceAccount, token mounted. You create it and its RBAC |
| `env` | Secret names loaded with `envFrom` (optional, so they may be filled later) |
| `namespace` | Where the worker runs |
| `egress` | Value of the pod label `pi-ez.dev/egress`, for your NetworkPolicies to match |

How Secrets get filled (kubectl, External Secrets, a CI job) is your choice. Workers never talk to a secret manager; they see plain environment variables.

## API

All routes need `Authorization: Bearer $WORKSPACED_TOKEN`. `GET /v1/workspaces` (add `?detail=1` for `busy`, `lastUsed`, `usage` per workspace and `usageAvailable`; usage is `{cpuMillicores, memoryBytes}` from metrics-server, or from `ps` for the local provider, which reports one process and its CPU averaged over its life), `POST /v1/workspaces` (`{"repository": …, "grant"?: …}`, `{"project": "<name>"}` for a pi project's worker, or `{"chats": true}` for the repository-less `chats` worker), `DELETE /v1/workspaces/:name`, `POST …/:name/wake`, `POST …/:name/sleep` (409 `workspace_busy` for a busy worker unless `?force=1`), `PUT …/:name/pin`, `PUT …/:name/grant`,
`POST …/:name/restart` (new pods, same volume; the worker stays awake and re-runs `PI_WEB_PRESTART_COMMAND`), `POST …/:name/reset` (wipes the volume: scale to 0, drop the PVC, recreate it, scale up; body must be `{"confirm": "<name>"}` or `400`; the project must be added again afterwards), `POST …/:name/reload` (re-fetches the Pi profile and dotfiles resources and reloads Pi; never wakes a sleeping worker, `409 asleep`). Restart, reset and sleep refuse a busy worker with `409 workspace_busy` unless `?force=1`; reload's busy case is the worker's `409 pi_configuration_busy`. Restart and reset also refuse sleeping workers with `409 asleep`.
 `GET /v1/grants`, `PUT /v1/github-auth`, `PUT /v1/model-auth`, and `/w/:name/*`, which proxies to the worker. Requests to a sleeping worker wake it and wait about 45 s, or return `503 workspace_starting` with `Retry-After`. A worker that cannot start (crash loop, out of memory, no node can schedule it, a worker that has not started after 3 minutes) returns `503 workspace_failed` with a `problem` right away, and `GET /v1/workspaces` reports the same `problem` per worker. Wakes run one at a time so start-up memory spikes don't stack.

The web server exposes the same to the settings page, under `/api`: `GET /api/remote-workspaces` → `{ usageAvailable, workspaces: [{ name, repository, state, ready, keepAwake, busy, lastUsed, resources, usage, grant: { name, description, namespace, serviceAccount, egress, env } }] }` (`env` lists Secret names only); `POST /api/remote-workspaces/:name/restart|reset|reload|sleep` (add `?force=1` for a busy worker; reset takes `{"confirm": "<name>"}`), answering with workspaced's status and body; `DELETE /api/remote-workspaces/:name` (deletes the worker, keeping its volume unless `?purge=1`); and `POST /api/remote-workspaces/reload` → `{ results: [{ name, ok, status, error }] }` for every awake worker.
