# pi-ez-web

A self-hosted web UI for [Pi](https://github.com/earendil-works/pi), the coding agent: chat with an agent about your repositories from desktop or mobile, with the same extensions and tools as the Pi CLI.

![pi-ez-web desktop screenshot](design/screenshots/pi-ez-web-desktop.png)

<details>
<summary>Mobile screenshot</summary>

<img src="design/screenshots/pi-ez-web-mobile.png" width="280" alt="pi-ez-web on mobile">

</details>

> [!WARNING]
> pi-ez-web has no login. Anyone who can reach it can run shell commands as its user. Keep it on `127.0.0.1`, an SSH tunnel, or behind an authenticating reverse proxy on a private network.

## What you host

Everything comes from one image, `ghcr.io/bry-guy/pi-ez-web`, run with different commands:

```text
 browser ──▶ web ──HTTP + token──▶ workspaced ──▶ worker (project A)
            :3141                    :3150     └──▶ worker (project B) …
```

| Component | Command | Required | Role |
| --- | --- | --- | --- |
| [**web**](docs/web.md) | `node server/index.js` (default) | yes | The site: sidebar, settings, model and GitHub sign-in; routes every conversation to a worker |
| [**workspaced**](docs/workspaced.md) | `node workspaced/index.js` | for separate or isolated workers | Starts, sleeps and wakes one worker per project and one for chats; hands out grants |
| [**worker**](docs/worker.md) | started by workspaced | — | Runs Pi for one repository with that project's tools and secrets |
| [pi-sync](https://github.com/bry-guy/pi-sync) | separate image | no | Syncs conversations with the Pi CLI on your other machines |

Every chat and project runs in a worker. web alone is still a complete app: with `PI_WEB_WORKSPACED_URL=local` (the default for `npm start` and `compose.yaml`) it runs workspaced inside itself and starts workers as child processes. Run workspaced separately when workers should have their own container, or, with Kubernetes, their own pod, volume, tools and secrets.

## What to configure

**web**: a persistent volume for `PI_WEB_HOME`, `PI_CODING_AGENT_DIR` and `HOME`. `PI_WEB_WORKSPACED_URL` is `local` (built-in workspaced) or the URL of a separate workspaced plus its `WORKSPACED_TOKEN`. Models, GitHub and the default repository source are set in **Settings**. → [web](docs/web.md), [Configuration](docs/configuration.md)

**workspaced**: the same `WORKSPACED_TOKEN` and a provider. With `WORKSPACED_PROVIDER=local`, workers are child processes. With `kubernetes`, each worker is a pod with its own PVC, and you also set `WORKSPACE_IMAGE` and RBAC. Optional: `WORKSPACED_GRANTS` (what each project's worker may hold) and `WORKSPACED_MAX_AWAKE` (default 3; the least recently used idle worker sleeps to make room). → [workspaced](docs/workspaced.md)

**workers**: nothing to deploy. Each project brings its own tools (`mise.toml`, `script/bootstrap`, …) installed by its **setup** hook. Secrets and cluster access come from the grant you pick when adding the repository. For OS packages, build a derived image (`FROM ghcr.io/bry-guy/pi-ez-web`) and set `WORKSPACE_IMAGE`. → [worker](docs/worker.md)

## Try it with Docker Compose

You need Docker with the Compose plugin.

**1. web only.** One container; each chat and project runs in a worker process inside it.

```sh
git clone https://github.com/bry-guy/pi-ez-web.git && cd pi-ez-web
docker compose up --build -d
```

Open <http://127.0.0.1:3141>. In **Settings**, sign in to a model provider, then use **Projects → Git URL** to clone a public repository and start a chat.

**2. Separate workspaced.** Moves the workers to a workspaced container of their own.

```sh
echo "WORKSPACED_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose -f compose.yaml -f compose.workers.yaml up --build -d
```

Workers in Compose share one container and one user, so this separates state, not trust. For real isolation (own pod, volume, ServiceAccount, egress policy), run workspaced with `WORKSPACED_PROVIDER=kubernetes`; see [workspaced](docs/workspaced.md#grants).

State lives in the `pi-ez-web-data` and `pi-ez-workspaced-data` volumes. `docker compose down` keeps them; `down --volumes` deletes them.

## Access from another device

Compose binds to `127.0.0.1:3141`; change the port with `PI_WEB_PORT` in `.env`. From another machine, tunnel:

```sh
ssh -L 3141:127.0.0.1:3141 user@your-server
```

For shared access, put web behind a TLS reverse proxy that authenticates users and passes the `/api/events` stream unbuffered. Never expose workspaced or workers; only web talks to them.

## Upgrade and back up

```sh
git pull && docker compose up --build -d   # add the same -f flags you started with
```

Back up the volumes first. [Deployment](docs/deployment.md) has backup, restore and rollback steps.

## Docs

[web](docs/web.md) · [workspaced](docs/workspaced.md) · [worker](docs/worker.md) · [Configuration](docs/configuration.md) · [Dependencies](docs/dependencies.md) · [Deployment](docs/deployment.md) · [Implementation](docs/implementation.md) · [Roadmap](docs/roadmap.md)

Development: `npm test`; `PORT=3141 npm run dev` starts a mock server with no model access, and `npm run browser -- --device="iPhone 13" http://localhost:3141` opens it in a mobile browser.
