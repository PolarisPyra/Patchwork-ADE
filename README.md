# Patchwork

An agentic development environment built with Rust + Tauri 2 and a React/TypeScript UI styled after JetBrains IDEs (light and dark themes).

Patchwork drives the **Claude Code**, **Codex**, and **Antigravity** CLIs already installed and signed in on your machine. Each task is a conversation with one agent; edits land directly in your project, and you review them in the canvas (Plan / Code / Diff) where **Stage** stages a file (`git add`) and **Reject** restores it.

The sidebar is a tree: **chats** without a project are top-level threads, and each project lists its own tasks (use its **+** to start one). Chats run in a private scratch folder under the app's data directory, which is deleted with the chat.

Conversations you had with an agent outside Patchwork, either in the agent's own CLI or in [T3 Code](https://github.com/pingdotgg/t3code), can be imported (during onboarding, or later in **Settings → Imports**). T3 Code's database is only read, never modified. Each one becomes a task in the project for its folder, with its messages copied in, and follow-ups resume the original CLI session. The **Usage** button at the bottom of the sidebar shows each provider's subscription limits (Claude, Codex, and Antigravity).

State lives in SQLite at `~/.config/patchwork/patchwork.db`, and future config files go in the same folder. On first launch Patchwork moves its data there from the old `~/.config/dev.patchwork.ade` folder, and converts any older `settings.json` / `threads.json` into the database, keeping them as `*.json.bak`.

## Develop

```sh
pnpm install
pnpm tauri dev        # run the app
pnpm tauri build      # release bundle
```

Requires Rust, pnpm, and the Tauri Linux prerequisites (webkit2gtk-4.1).

## Tests

```sh
cargo test --workspace                    # unit tests (parsers, importers, persistence, git)
cargo test -p patchwork-server -- --ignored  # live turns against the real agent CLIs
```

## Layout

The repo is split into `apps/web`, `apps/server`, and `apps/desktop`:

- `apps/server` — the backend, a Rust crate with no Tauri dependency
  - `src/lib.rs` — `Server`, the operations the UI calls
  - `src/provider/` — one module per agent CLI: detection, models, turn arguments, JSONL parsing
  - `src/runner.rs` — spawns agent CLIs, turns their output into agent events
  - `src/persistence/` — SQLite store and schema migrations
  - `src/import/` — reads each CLI's saved sessions for importing
  - `src/usage/` — subscription usage limits per provider
  - `src/workspace.rs` — git and file access
  - `src/types.rs` — data contract shared with the UI
- `apps/desktop/src-tauri` — the Tauri shell: exposes `Server` as commands and forwards events
- `apps/web` — the React UI (`~/` imports resolve to `apps/web/src`)
  - `src/app/` — app root; `src/api.ts` — typed bridge mirroring `apps/server/src/types.rs`
  - `src/components/{chat,sidebar,usage,settings,onboarding,canvas,workspace}/` — UI
  - `src/hooks/`, `src/lib/` — state and helpers; `src/theme.css` — JetBrains Int UI tokens

## Data model

Everything the sidebar shows comes from one SQLite database, `patchwork.db`, in the config folder. The store loads it into memory at startup and writes each change through before it is visible (`apps/server/src/persistence/mod.rs`).

| Table | What it holds |
| --- | --- |
| `settings` | App settings as JSON: theme, connected agents, integrations. |
| `projects` | One row per project folder: `name`, `path` (unique), and `position` for sidebar order. |
| `folders` | Sub-folders inside a project: `project_id`, `name`, `position`. Organisation only; no directory is created on disk. |
| `threads` | Tasks and chats. `project_id` NULL makes it a chat. `folder_id` NULL puts it at the top level of its project. `session_id` lets the agent resume. |
| `messages` | The messages of each thread, with text, tool calls, plan, file changes, approvals, and attachments. |
| `app_state` | Small key/value state that is not settings, such as the thread that was open last. |

Where a thread runs:

- **Task:** directly in its project's `path`. There is no copy and no git worktree, so tasks in the same project share one working tree.
- **Chat:** in `chats/<thread id>` under the app's local data directory (`app_local_data_dir`). The folder is deleted with the chat.

Sidebar order is the `position` column. A new thread gets `-created_at`, so the newest is first until it is dragged. Dropping rows calls `reorder_threads`, which numbers that list `0..n`.

Schema changes go in as a new entry appended to `MIGRATIONS` in `apps/server/src/persistence/migrations.rs`. Never edit one that has shipped.

## Permissions

With the **Terminal** integration off, Claude runs with `acceptEdits` (file edits allowed, shell commands need approval and are denied in headless mode); with it on, `bypassPermissions`. Codex always runs in its `workspace-write` sandbox. Antigravity runs with `--approval-mode auto_edit`, or `yolo` with Terminal on.
