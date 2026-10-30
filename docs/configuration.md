# Configuration

Most installations can be set up in the browser. You do not need a config file to start: connect a provider in **Settings**, choose a model, and add a project. Advanced settings are optional.

With Docker Compose, the app config lives at `/data/pi-ez-web/config.json` inside the persistent volume. This is `$PI_WEB_HOME/config.json` in the container. The credential-free [config.example.json](../config.example.json) shows the available options.

## Models and providers

In **Settings**, sign in to a provider or add an API key, then choose a default model. Pi stores provider credentials below `$PI_CODING_AGENT_DIR`; the Compose setup keeps this directory in the persistent volume. `defaultModel: null` selects the first available model; an explicit value uses the `provider/modelId` format.

## Add repositories

The project picker offers two sources. Both clone into `reposRoot` (`/data/repos` in Compose), or into the worker's own volume when workspaced is configured:

- **GitHub** can browse public or private repositories. Private access uses GitHub sign-in; the server needs a public OAuth App client ID (`PI_WEB_GITHUB_CLIENT_ID`), not a client secret. Alternatively, set an externally managed `PI_WEB_GITHUB_TOKEN` in the service environment; it takes precedence over stored sign-in. The owner filter (`PI_WEB_GITHUB_OWNER`) is optional.
- **Git URL** clones public HTTPS Git URLs. SSH URLs are not supported.

Existing checkouts on the host can't be connected; push them somewhere and clone. GitHub sign-in credentials are stored in `$PI_WEB_HOME/github-auth.json`; provider credentials are separate and remain in Pi's auth directory.

## Optional config file

Use `config.json` when you want to predefine projects or change settings that are not managed in **Settings**. The main options are:

| Setting | Purpose |
| --- | --- |
| `projects` | Repositories and optional project hooks |
| `reposRoot` | Where repositories are cloned |
| `worktreeRoot` | Where the app creates worktrees; use a stable absolute path |
| `defaultModel` | Automatic selection (`null`) or a `provider/modelId` |
| `defaultThinkingLevel` | Default reasoning level for new chats; unset follows the Pi profile, then `medium` |
| `pi` | Explicit Pi profile, packages, and extensions |
| `repositorySources` | Default project-picker source and GitHub options |
| `sync` | Optional pi-sync server and conversation setting |

`PI_WEB_SKIP_PACKAGES` (comma-separated package sources) leaves those packages out of the Pi profile, for example laptop-only extensions on always-on workers.

Without `worktreeRoot`, Compose uses `/data/pi-ez-operator-home/.pi/worktrees`; the example config uses `/data/pi-ez-worktrees`. Git records absolute worktree paths, so keep this location stable.

<details>
<summary>Install the example config into an existing Compose volume</summary>

This stops the service and refuses to overwrite an existing config:

```sh
set -e
docker compose stop
docker compose run --rm --no-deps -T --entrypoint /bin/sh pi-ez-web -c '
  set -e
  umask 077
  mkdir -p "$PI_WEB_HOME"
  if [ -e "$PI_WEB_HOME/config.json" ] || [ -L "$PI_WEB_HOME/config.json" ]; then
    printf "%s\n" "config.json already exists" >&2
    exit 1
  fi
  set -C
  cat > "$PI_WEB_HOME/config.json"
  chmod 600 "$PI_WEB_HOME/config.json"
' < config.example.json
docker compose up -d
```

</details>

## Environment variables

Environment values override matching JSON settings, which override built-in defaults. The Compose `.env` file controls Compose interpolation only; it does **not** pass arbitrary variables into the container. Add only the variables you need under the service's `environment` in a local Compose override; do not commit the override or `.env` values.

For GitHub sign-in, add only the public client ID; no client secret is needed:

```yaml
services:
  pi-ez-web:
    environment:
      PI_WEB_GITHUB_CLIENT_ID: ${PI_WEB_GITHUB_CLIENT_ID:?set PI_WEB_GITHUB_CLIENT_ID}
```

To use a GitHub token instead, use this variable **instead of** the client ID above:

```yaml
services:
  pi-ez-web:
    environment:
      PI_WEB_GITHUB_TOKEN: ${PI_WEB_GITHUB_TOKEN:?set PI_WEB_GITHUB_TOKEN}
```

For a project secret, add only its source variable:

```yaml
services:
  pi-ez-web:
    environment:
      HOST_API_TOKEN: ${HOST_API_TOKEN:?set HOST_API_TOKEN}
```

In the target project's existing entry in `config.json`, map the command's destination name to the environment variable's source name. Merge this field into the existing config; do not replace other projects:


```json
{
  "projects": [
    {
      "id": "my-project",
      "name": "my-project",
      "repoPath": "/data/repos/my-project",
      "environment": {
        "API_TOKEN": "HOST_API_TOKEN"
      }
    }
  ]
}
```

Put referenced values in the ignored root `.env` file, then start with the local override:

```sh
docker compose -f compose.yaml -f /path/to/compose.private.yaml up -d
```

Use the same `-f` options for every start and upgrade; without them, Compose will not apply the override. If a source variable is missing, the command does not start. The mapping stores variable names, not values, and is a convenience—not a security boundary. Trusted hooks and Pi commands run with the app's authority and can read its environment.

Other useful deployment variables include `PI_WEB_REPOS_ROOT` (repository root), `PI_WEB_SYNC_ALL_CONVERSATIONS`, and `PI_SYNC_SERVER_URL`.

## Optional integrations

Hooks, Pi packages, and extensions are trusted code running as the app user. If a hook needs a tool not in the image, [build a derived image](deployment.md#custom-tools-for-hooks) rather than adding a sidecar.

pi-sync is optional and synchronizes conversation JSONL and metadata—not repository files, Git history, worktrees, or credentials. Set `PI_SYNC_SERVER_URL` for the web app and the Pi extension; leave `allConversations` disabled unless you want every conversation eligible for sync.
