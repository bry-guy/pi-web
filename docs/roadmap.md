# Runtime environment roadmap

pi-ez-web should let repositories declare the tools and operating-system environment they need without permanently coupling those requirements to the web server. Repository declarations request an environment; deployment policy remains responsible for granting secrets, network access, kubeconfigs, and other privileges.

## Phase 1 — trusted operator and project hooks

The deployment is web (chats, logins) plus workspaced and one worker per project; each project's authority comes from a deployer-defined grant. See [secrets, grants and operations](plans/secrets-and-operations.md).

- Give the deployed image the small bootstrap toolset needed to run project hooks; repositories remain responsible for declaring their versioned tools.
- Add generic per-project hooks in deployment-owned pi-ez-web configuration. A project may use Mise (`mise install`, `mise run bootstrap`, `mise run check`), repository scripts (`./script/install`, `./script/check`), or another tool without changing pi-ez-web.
- Run the configured install hook after connecting a checkout and creating a worktree, and allow it to be rerun manually. Run check and other configured hooks only when explicitly requested.
- Treat configured projects and hooks as trusted. Phase 1 does not add approval prompts, declaration hashing, invalidation tracking, or a provisioning state machine.
- Execute hooks in the selected project workspace, wait for completion, and surface their exit status and output directly.
- Support multiple projects and project-specific tool versions without rebuilding the pi-ez-web server image. Mise is the recommended dogfood implementation, not an application requirement.
- For the site-specific dogfood deployment, explicitly grant GitHub write access, Git identity, 1Password/fnox access, operator kubeconfigs, SSH/network access, and the tools needed by the `pi-ez-web` and `infra` repositories.
- Keep credentials out of images, source control, URLs, command arguments, API responses, and build logs. Treat the operator pod and its agent shell as part of the credential trust boundary.

## Phase 2 — per-project workspaces

Split into web (UI + chats), workspaced (creates workspaces, grants, routing) and one worker per project, with per-project storage, secrets, and an optional ServiceAccount. See [project workspaces](plans/workspaced.md). This supersedes the earlier Dev Container and runtime-pod phases: the Pi SDK stays in-process with the project's environment, and grants stay operator-owned.

## Phase 3 — workspace polish

- Port proxying to dev servers, idle scale-to-zero, resource limits, and per-workspace NetworkPolicy.
- Run pi-ez-web inside arbitrary project images (for example a project's Dev Container image) by injecting it with an init container.
- Approval gates for destructive infrastructure actions.

## Non-goals

- Do not rebuild the monolithic pi-ez-web server whenever a project is added or its dependencies change.
- Do not allow a repository declaration to grant itself credentials or infrastructure privileges.
- Do not mistake hook configuration for a privilege grant; secrets and infrastructure access remain deployment-owned even though configured hooks are trusted.
