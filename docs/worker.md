# worker

One per project, plus one named `chats` for plain chats. A worker is the same server as [web](web.md), running the Pi SDK in-process against a single cloned repository, with that project's tools and secrets. The `chats` worker has no repository and always uses a grant any project may use; it gets the same environment and dotfiles as project workers. workspaced starts it; you never deploy one by hand.

## Project workers

A [pi project](https://github.com/bry-guy/pi-projects) (a named folder of repositories, memory and sessions) gets one worker named after it, created with **New project** (`POST /v1/workspaces {"project": "<name>"}`). It sets `PI_PROJECTS_DIR=/data/projects` and `PI_WEB_PROJECT=<name>` on the worker's volume. On start the worker sparse-clones only that project from `PI_PROJECTS_STATE_REMOTE` (pi-projects' state repo, through web's GitHub login), or creates the folder when the project is new. Each repository in its `project.json` becomes one of the worker's projects (cloned into `repos/<name>`, worktrees in `worktrees/<name>/<branch>`), and the sidebar shows them as one entry named after the project. The project folder itself is listed too (id `pp-<name>`, kind `folder`, no Git, since it sits in the state repo): sessions started or opened there need no repository, and **New session** starts there by default. GitHub SSH remotes from a laptop clone over HTTPS, and a repository is served only once its clone completes. Adding or removing a repository in the Project menu updates `project.json` and pushes it, so the laptop and other workers see it. The project is the trust boundary: one project per worker, which sleeps and wakes like any other.

## What a worker gets

| From | What |
| --- | --- |
| workspaced | `PORT=3141`, `PI_WEB_HOME`, `PI_CODING_AGENT_DIR`, `PI_WEB_REPOS_ROOT` on its own volume; `PI_WEB_GITHUB_AUTH_FILE` and `PI_WEB_MODEL_AUTH_FILE` pointing at the logins web shared |
| `WORKSPACE_ENV_CONFIGMAP` | Shared environment, typically `PI_WEB_PRESTART_COMMAND` (dotfiles, default setup hook) and `PI_SYNC_SERVER_URL` |
| its grant | ServiceAccount, `envFrom` Secrets, namespace, egress label. See [grants](workspaced.md#grants) |
| the repository | Its own tools: `mise.toml`, `script/bootstrap`, `gradlew`, whatever the project uses. The **setup** hook (e.g. `mise trust --yes && mise install`) installs them once after cloning |

## The image

Workers use the pi-ez-web image (`WORKSPACE_IMAGE`). It ships git, ssh, curl, jq, build tools, Node 22 and [mise](https://mise.jdx.dev). Project-specific tools such as Go or kubectl come from the repository's `mise.toml`, not the image. If a project needs OS packages mise can't install, build a derived image and point `WORKSPACE_IMAGE` at it:

```dockerfile
FROM ghcr.io/bry-guy/pi-ez-web:sha-<commit>
USER root
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
USER node
```

## Lifecycle

When more than `WORKSPACED_MAX_AWAKE` workers would run, the least recently used idle one sleeps: its volume stays, its processes stop, and the next request wakes it. Expanding or opening a sleeping project in the sidebar starts waking it right away. After start, a worker preloads Pi and its extensions in the background, and keeps compiled extensions in `~/.cache/pi-ez-web/jiti` so restarts don't recompile them. A worker is busy, and never put to sleep, while an agent turn, compaction or queued prompt is running. Pin a project with **Keep awake** to keep dev servers running.

**Reload** (`POST /api/pi/reload`, reached through workspaced's `…/reload`) re-fetches the Pi profile and its dotfiles resources and reloads Pi. It answers `409 pi_configuration_busy` while an agent turn runs. It does not re-run `PI_WEB_PRESTART_COMMAND`, which runs only when the worker starts; **restart** does that.

### When a worker breaks
Kubernetes restarts a worker that exits, runs out of memory, or stops answering `/api/health` for a minute (liveness); a startup probe gives a slow first boot up to 5 minutes. Chats survive on the volume; only a running turn is lost. The sidebar marks a worker that crashed, and replaces its status with **restart** when it cannot run (crash loop, image pull failure, unschedulable, stuck start, eviction). The local (Compose) provider restarts a crashed worker up to 3 times in 10 minutes, then marks it failed.

## Health

`GET /api/health` returns `ok`, `buildId` and `busy`. It is the readiness probe.
