# Patchwork

An agentic development environment in the spirit of [t3code](https://github.com/pingdotgg/t3code), built with Rust + Tauri 2 and a React/TypeScript UI styled after JetBrains IDEs (light and dark themes).

Patchwork drives the **Claude Code** and **Codex** CLIs already installed and signed in on your machine. Each task is a conversation with one agent; edits land directly in your project, and you review them in the canvas (Plan / Code / Diff) where **Apply** stages a file (`git add`) and **Reject** restores it.

You can also start a **chat without a project** (the Chats entry in the project switcher or sidebar). Those run in a private scratch folder under the app's data directory, which is deleted with the chat.

## Develop

```sh
pnpm install
pnpm tauri dev        # run the app
pnpm tauri build      # release bundle
```

Requires Rust, pnpm, and the Tauri Linux prerequisites (webkit2gtk-4.1).

## Tests

```sh
cd src-tauri
cargo test                    # unit tests (parsers, git helpers)
cargo test -- --ignored       # live turns against the real claude / codex CLIs
```

## Layout

- `src-tauri/src/runner.rs` — spawns agent CLIs, turns their JSONL into `agent-event`s
- `src-tauri/src/workspace.rs` — agent detection, git, file access
- `src-tauri/src/store.rs` — settings and threads persisted as JSON in the app config dir
- `src/api.ts` — typed bridge mirroring `src-tauri/src/types.rs`
- `src/theme.css` — JetBrains Int UI tokens for both themes
- `src/onboarding/`, `src/workspace/`, `src/workspace/canvas/` — UI

## Permissions

With the **Terminal** integration off, Claude runs with `acceptEdits` (file edits allowed, shell commands need approval and are denied in headless mode); with it on, `bypassPermissions`. Codex always runs in its `workspace-write` sandbox.
