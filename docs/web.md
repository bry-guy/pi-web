# web

The site you open: chats, the sidebar, settings, model and GitHub sign-in. It is `node server/index.js` from the pi-ez-web image (the image's default command), listening on port 3141.

Web runs no conversations itself. Every project lives in a worker, plain chats live in one more worker named `chats`, and web only proxies to them; an id no worker owns answers 404. `PI_WEB_WORKSPACED_URL=local` runs workspaced inside web with the local provider: workers are child processes under `PI_WEB_HOME/workspaces` (or `WORKSPACED_ROOT`), share web's `HOME`, and skip `PI_WEB_PRESTART_COMMAND` because web already ran it. That is the one-container setup (`npm start` and `compose.yaml` default to it). With a URL, web talks to a separate workspaced. Only mock mode and tests leave it unset, which serves everything in-process.

Web creates the chats worker with the first chat. Chats that web ran itself before workers are copied into it once, on the first state poll after start: chat folders, Pi session files, ended chats and their pi-sync records. Web keeps its copies but does not list them; they appear once the copy reaches the chats worker (marker: `chats-moved.json` in `PI_WEB_HOME`; a failed copy retries every minute).

## Configure

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_WEB_HOME` | `~/.pi-web-ui` | App state: `config.json`, chat bindings, the GitHub login, the snapshot cache of worker projects |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's directory: model logins (`auth.json`) and sessions |
| `HOME`, `XDG_*_HOME` | | Keep on the persistent volume so tools and caches survive restarts |
| `PI_WEB_WORKSPACED_URL` | `local` with `npm start` and Compose | `local` (built-in workspaced, workers as child processes) or the base URL of a separate workspaced. Unset only in mock mode and tests |
| `WORKSPACED_TOKEN` | unset | Bearer token for a separate workspaced. Must match workspaced's token |
| `WORKSPACED_MAX_AWAKE`, `WORKSPACED_IDLE_MINUTES`, `WORKSPACED_ROOT` | 3, 0, `PI_WEB_HOME/workspaces` | With `local`: as for [workspaced](workspaced.md) |
| `PI_WEB_GITHUB_CLIENT_ID` / `PI_WEB_GITHUB_TOKEN` | unset | GitHub sign-in (public OAuth client ID) or a fixed token. See [Configuration](configuration.md) |
| `PI_WEB_PRESTART_COMMAND` | unset | Shell run before start, e.g. fetching dotfiles or seeding `config.json` (120 s limit) |
| `PI_SYNC_SERVER_URL` | unset | Optional [pi-sync](https://github.com/bry-guy/pi-sync) server |

Everything else (default model, Pi profile and packages, repository source) is in **Settings** or [`config.json`](configuration.md).

## Chat header

A project conversation's title block (title, then branch, commit, Git state and sync state as plain text) is one target that opens the session panel (below); it gets a quiet background on hover. The sidebar and Files buttons keep their own taps. The header's left button toggles the sidebar (a panel glyph; a hamburger on a phone) and the right button toggles the file tree (a `</>` code glyph). The sidebar's footer row is the settings button.

Async results (fetch, pull, a hook finishing) are announced as a short toast at the bottom of the screen, and disappear after a few seconds.

Visual tokens live at the top of `public/app.css`: radius (`--radius-sm` … `--radius-pill`), space (`--space-1` … `--space-6`), type (`--text-xs` … `--text-xl`) and one motion duration (`--duration`, 150 ms). New components use them rather than literal values. Buttons: `.btn-primary` (one per view), `.btn-secondary`, `.btn-caution` (destructive; always confirms), `.btn-ghost`.

The header's second line shows the project's Git context (branch · commit · clean, dirty or unknown, with ↑ahead and ↓behind) and, on the same line, the conversation's sync state as one label, `<state>: <message>`: `Synced: up to date`, `In use: <device>`, `Sync error: <reason>`, or `Sync: <status>` when it is not synchronized. Tap the label, or hover it, for the full detail. On a phone the line stays one line and ends in an ellipsis.

## Chat activity

While a turn runs, the chat shows a small dot spinner (a 2×3 grid of dots, every one of which lights in turn) and one live line: pi-summarize's working message, else pi's default `Working…`. Tool calls and thinking are not shown inline. When the turn ends, a quiet row reads `Worked 42s · 6 steps ›`. Tapping it opens **Steps** in place of the chat, with a `<` back button and a `#steps=…` address, so Back returns to the chat at the same scroll position. Steps lists pi-summarize summaries, each expandable to the thinking and tool calls behind it; a turn without summaries lists its tool calls and thinking in order. Thinking is kept with the message, so it is available after a reload.

While a reply streams, the chat follows it only if you are at the bottom. Scroll up and it stops following, so you can read earlier messages while the reply grows off screen; scroll back to the bottom (or send a message) to follow again.

Each finished turn has one copy button, under its last reply, and your own messages have one too: with a mouse it appears on hover, on a phone it is always shown under replies and appears when you tap your own message. It copies that message's text (markdown for replies) and shows a check for a moment. Earlier replies in the same turn (notes between tool calls) have no copy button and sit closer together; when there are several, **Copy all N** next to the button copies every reply in the turn, separated by blank lines.

Untitled chats are named by their first prompt. A chat or project session that was never prompted or named, and is not open, is left out of the sidebar; its file is kept.

The `+` on a project's sidebar row (always shown; **Add project** under the list adds one), or `/new` in a project session, opens a new session right away on the project's main checkout, with no dialog. It is not listed in the sidebar until you send its first prompt, so an abandoned new session leaves nothing behind. Main is then fetched and fast-forwarded in the background; that is skipped, and logged in History, when main is dirty, has diverged, another Git operation is running, or a session on main is mid-reply. Use **Switch…** in the session panel to move the session to another branch. If the checkout has been moved off main (by hand, or by an agent working there) and another session is using it, it is left where it is: the new session starts on that branch and a notice says so. Nothing switches the checkout in the background.

**Ending** a session or chat (the sidebar's `×`, or **End** in the session panel) stops a running reply, withdraws it from pi-sync on this server (`/sync detach`; the server copy and other devices keep it), and archives it with its forks. Git is not touched. The detach is recorded in the conversation, so it is not shared again even with *sync all conversations* on.

After an end, a toast offers **Undo** for a few seconds. Ended project sessions are listed under **Past sessions** in the Project menu (newest 20); opening one brings it and its forks back into the project's list. The pi-sync detach stays, so attach it again to share it. If the ended session was the last one on a worktree that is clean and fully merged into main, a second toast offers **Delete branch…**, which opens the usual delete confirmation.

## Files

**Files** (the header's `</>` button) lists the project's tree beside the chat; on a phone it covers the whole screen, and its `>` closes it. Folders come first; among folders and among files, dot-names (`.github`, `.env`) come first. **Settings → Appearance → Show hidden files** (on by default, stored in this browser) hides every name that starts with a dot. Tapping a file replaces the chat pane with the file and a `<` that returns to the chat at the same scroll position; browser Back does the same (the address becomes `#file/<path>`). On a phone the file fills the screen and the tree is hidden until you return. Escape also returns to the chat.

The viewer follows the theme: a light code palette in light mode, a dark one in dark mode. Highlighting is server-side (highlight.js, including Dockerfiles). A file with changes against the diff target opens as its diff: added and removed lines keep their green and red backgrounds, and the code on every line is highlighted (removed lines from the base version, the rest from the working file).

## Session panel

Tap the chat header to open the session panel; it is a modal with a `×` (full screen on a phone). It has three sections:

- **Session**: **Fork…** and **Setup**, each with a line saying what it does, plus any other project hooks. **End** ends this session. **Fork…** opens a step asking for a name and a branch; left empty, the name is the session's name plus the first free `(fork)`, `(fork 2)`, … among the project's sessions, and the branch is derived from that name (made unique). The copy gets its own worktree and opens; this session stays where it is. **Setup** runs the project's setup script (for example `npm ci`) in this worktree. Sync facts appear here when the conversation is shared.
- **Git**: branch, commit, workspace and status, then **Fetch**, **Pull**, **Push** and **Switch…** on the right, and **Delete branch** (caution, asks first) and **Merge to main** (primary, asks first) for a non-primary branch. **Switch…** opens a step listing the branches (the current one is marked) and a field for a new branch; choosing one moves this session onto it.
- **History**: what ran in this workspace, newest first: setup and other hooks, fetches, pulls, pushes, merges, forks and switches, each with its time, status and output (tap an entry to expand it). An operation still running is listed at the top until it finishes; results are also announced as a toast. A switch or merge is logged both where the session was and where it lands, a fork in both the source and the copy. The log is append-only JSON lines in the app state dir, one file per workspace path, capped at 16 KB of output per entry. Removing the state dir removes the log. It records operations run by the process that serves the request.

Steps show a `<` that returns to the panel's main screen. `Esc` closes the topmost modal (a step goes back first; a confirmation that is mid-request stays). The panel keeps its frame while its contents update, so it does not flash or re-animate.

### Project menu

Clicking a project's sidebar row opens the Project menu. The row shows only the name and session count; the worker's state is in the menu's worker card. The menu has:

- **New session** and **End idle sessions** (ends every session tree in the project with no activity for a day and nothing running).
- **Past sessions**: ended sessions, newest first. Tap one to preview its last messages (like a History entry); **Open** under the preview brings it back.
- **From other devices**: conversations shared for this repository. Tap one to preview it (read from the sync server, without taking it over); **Open** under the preview adds it as a new session.
- **Worker**, for a project with one: the same facts and actions as **Settings → Workers**.
- **Remove project…**: for a worker-backed project, deletes its worker (its disk is kept unless *Also delete its disk* is ticked); for a local project, ends its sessions and removes it from the list. The checkout is kept either way, and adding the repository again picks it back up.

## Questions from Pi

When Pi or an extension asks something (`ask_user_question`, a confirmation, a value to type), it appears as a card above the composer, not a modal: the rest of the app stays usable. Options are buttons with their descriptions and multi-select questions are checkboxes (ticks are kept per question). Anything typed (*Type something.*, a value, extra text for a multi-select) goes in the message box, whose send button reads **Answer** while the question waits, so the draft is kept per conversation like any other. A question belongs to its conversation: switch away and it waits there. It goes away once answered, dismissed (`×` or `Esc`), timed out, or when the turn that asked ends.

## Settings

**Settings** lists its categories on the left (on a phone, first): Providers, Pi, Workers, Sync, Repositories, Defaults, Appearance. Each category has its own address (`#settings/workers`, `#settings/pi`, …), so reloading or using Back returns to it. `<` returns to the chat, and on a phone `<` on a category returns to the list. Settings has one header: while it is open the chat header steps aside, so there is a single `<` and a single title. Pi shows what loaded (Extensions and Skills each open a list), any load errors, the dotfiles profile, then the build and server logs.

- **Pi**: the chats worker's dotfiles profile, extra packages to load, and local extension paths (advanced), with what Pi loaded and any problems. **Save & reload** fetches the profile, installs missing packages, and reloads idle chats. It is refused while a chat is running; stop it first. Project workers keep their own setup; reload them from **Workers**.
- **Workers** (needs workspaced; otherwise the page says workers are not enabled): every worker, including `chats` (plain chats, no repository, and no **Delete**). Each worker's state (asleep, starting, awake, busy), keep-awake, last use, resource requests and limits, live usage (`n/a` when workspaced reports none), and its grant: name, service account, namespace, egress, runtime class, and environment variable names (never values). **Reload** re-reads one worker's profile and extensions; **Reload all awake workers** does every awake worker and lists each result. **Restart** starts a fresh pod and reruns startup; the disk is kept. **Stop** puts it to sleep now (disk kept, it wakes on use). **Reset** wipes the worker's disk and needs its name typed; add the project again afterwards. **Delete** deletes the worker, so its project and sessions leave the list; its disk is kept (adding the repository again picks it back up) unless you tick **Also delete its disk**. A busy or asleep worker refuses restart and reset, and the page says why. The page refreshes every 5 seconds while it is visible.
- The sidebar's **Chats** heading opens the Chats menu: **New chat**, **Past chats** (ended chats; preview one, and **Open** brings it back) and the `chats` worker's card with Restart and Stop. Ended chats stay on the chats worker's disk; pi-sync is only for other devices.
- The sidebar shows each project's worker state; a small dot marks a worker kept awake. A worker that crashed shows an amber state; one that cannot run (crash loop, out of memory, unschedulable, stuck starting) shows **restart** in red, and tapping it restarts the worker. The reason is in its tooltip, and [Worker](worker.md#when-a-worker-breaks) explains recovery.

`mise run dev` (mock mode) shows three fixed sample workers, so the Workers page can be tried without a cluster.

## Logins reach workers

When you sign in to GitHub or a model provider, web sends the login to workspaced (`PUT /v1/github-auth`, `PUT /v1/model-auth`), and workspaced hands it to every worker read-only. Every worker can therefore read those logins. You sign in once, in web.

## Security

web has no authentication. Anyone who can reach it can run commands as its user, and through workspaced, in every worker. Put it behind an authenticating, streaming-capable reverse proxy on a private network. See [Deployment](deployment.md).
