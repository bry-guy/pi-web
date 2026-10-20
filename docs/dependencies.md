# Declaring dependencies

A project that needs a database declares it in a `score.yaml` at the root of its repository. When workspaced starts that project's worker, it runs the database as a sidecar in the same pod and gives the worker its connection settings. The database is disposable workspace data; nothing you do in a workspace touches a shared server.

This works only on the Kubernetes provider (`WORKSPACED_PROVIDER=kubernetes`). With the local provider, adding a project whose `score.yaml` declares resources fails with `score_unsupported`.

## Declare a Postgres database

```yaml
# score.yaml
apiVersion: score.dev/v1b1
metadata:
  name: personal-finances

containers:
  web:
    image: .
    variables:
      DATABASE_URL: ${resources.db.url}

resources:
  db:
    type: postgres
    params:
      version: 17
      database: finances
```

Keep tools in `mise.toml`. Services go in `score.yaml`, not in `mise.toml`; a `postgres` entry in `mise` builds from source and will not work in a workspace.

## Parameters

| Param | Default | Meaning |
| --- | --- | --- |
| `version` | `17` | Major version of the `postgres` image (`postgres:<version>`) |
| `database` | the resource id, with `-` as `_` | Database created at first start |
| `port` | `5432` | Port inside the pod. Change it only if two resources would clash |

Any other param is an error. An unknown `type` is an error. Both fail adding the project (or, on restart, leave the worker as it was) and name the resource.

## What the worker gets

Each declared resource exposes outputs as environment variables named `SCORE_RESOURCE_<ID>_<OUTPUT>`, with `-` replaced by `_` and upper-cased. For `db` on Postgres:

| Variable | Value |
| --- | --- |
| `SCORE_RESOURCE_DB_HOST` | `localhost` |
| `SCORE_RESOURCE_DB_PORT` | `5432` |
| `SCORE_RESOURCE_DB_NAME`, `…_DATABASE` | `finances` |
| `SCORE_RESOURCE_DB_USERNAME` | `postgres` |
| `SCORE_RESOURCE_DB_URL` | `postgresql://postgres@localhost:5432/finances` |

Variables under `containers.<first>.variables` whose value is built only from `${resources.<id>.<output>}` are also set on the worker. In the example, `DATABASE_URL` is set. Other variables are ignored: the app's own config stays in `mise.toml` or its environment. Only the first container's variables are read, so keep one container in the workload.

## When it applies

- **Adding a project:** `score.yaml` is read from the default branch before anything is created. A missing or invalid file fails the add with a message.
- **Waking a sleeping project:** the file is read again; changes apply as it starts.
- **Restarting a project:** changes apply as the new pod starts. A running project keeps its old resources until you restart it.
- If the file cannot be read (GitHub unreachable), a wake or restart keeps the current pod. Without a GitHub login, a missing file is treated the same way, because private repositories look missing to anonymous requests.
- Only GitHub repositories are read. Other repositories get no resources.

## Behaviour and limits

- **Data:** the database lives on the project's volume under `res/<id>`. It survives sleep and wake. Reset or removing the project with purge deletes it.
- **Network:** the server listens on the pod's loopback only, with trust authentication. Nothing else in the cluster can connect, but every process in the same pod can, including the worker.
- **Startup:** the worker starts after the database answers `pg_isready`. The entrypoint runs as root briefly to fix the data directory's ownership, then runs as `postgres`.
- **Memory:** each database is limited to 512Mi and counts against the namespace quota (24Gi in the current deployment).
- **Secrets:** the database gets no Secrets, no grant environment, and no ServiceAccount token. When a grant has a ServiceAccount, the token is mounted only in the workspace container.
- **Not yet:** no UI status or "restart to apply" marker. The status is in the workspaced API: `score.resources` (with `ready` per resource) on each workspace in `GET /v1/workspaces?detail=1`.

Design and open questions: [score-resources.md](score-resources.md).
