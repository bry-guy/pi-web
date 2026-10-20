# Score resources (design note)

Status: implemented for `postgres` on the Kubernetes provider. Plan: `bry-guy/infra` `docs/plans/score-app-dependencies-plan.md`. User guide: [dependencies.md](dependencies.md).

## Decisions

- **Source of truth:** the repository's root `score.yaml`, read from GitHub's contents API on the default branch. workspaced has no clone before the pod exists, so it cannot read the checkout. It uses the GitHub login web pushes to it (`PUT /v1/github-auth`), held in memory only, and falls back to anonymous reads for public repositories.
- **Record:** the declaration is stored as the Deployment annotation `pi-ez.dev/score`, containing only resource declarations and the variables that reference resources. Everything else (sidecars, env, probes) is re-planned from that record whenever the template is rebuilt, so grant changes and restarts keep the resources without another GitHub read. App config and possible secrets in `score.yaml` are never stored.
- **Provisioners:** a built-in table keyed by `type`, currently `postgres` only. Each validates its own params; unknown types and params fail the add with a message naming the resource.
- **Sidecars:** native sidecars (initContainers with `restartPolicy: Always`). k3s in `bry-guy/infra` is 1.34.5+k3s1 (`selfhost/images/homelab-fedora-bootc/Containerfile`), above the 1.29 minimum. A startup probe (`pg_isready`) holds the worker until the database is up.
- **Isolation:** the sidecar has only provisioner env, no envFrom, no Secret volumes, and mounts only its `res/<id>` subpath. Pods with sidecars turn off the pod-wide ServiceAccount automount; the token is projected into the workspace container only (same paths as the automount).
- **Trust auth:** safe only because `listen_addresses=localhost`. Without it, any pod in the cluster could reach the database by IP.
- **Injection:** outputs become `SCORE_RESOURCE_*`; resource-only variables become worker env. A collision with a workspace setting fails the add.

## Lifecycle

| Event | Score applied? |
| --- | --- |
| Add project | Read; invalid file fails the add |
| Wake (sleeping → running) | Read; template rebuilt if the record changed |
| Restart | Read; template rebuilt if changed (the rebuild rolls the pod, so no second restart) |
| Read fails or file missing without token | Keep the current template |
| Grant change, reset | Keep the record |

## Skipped

- UI status and "restart to apply" (a pending indicator would need a GitHub read on every list). The API exposes per-resource readiness instead.
- Local provider: refuses score resources rather than emulating them.
- Other resource types, multi-container workloads, and Score's own prod generation (infra phase 3).
- A NetworkPolicy isolating the database from other pods: the loopback listener makes it unnecessary.
