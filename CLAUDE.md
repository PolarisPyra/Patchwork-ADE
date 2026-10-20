# CLAUDE.md

## Development setup

- The user runs PatchworkADE as an installed AppImage and builds it from this repo at the same time. Two app instances can exist; they are not interchangeable.
- **AppImage (everyday app):** never kill, stop, restart, replace, or relaunch it, and do not run any AppImage or installed `patchwork` binary. Do not kill processes by broad name match (`pkill patchwork`, `killall`) because that can hit the AppImage. If the AppImage blocks dev work (port, lock, or window conflict), tell the user and leave it alone.
- **Dev instance:** the only app instance that is ever started or restarted. Run it only with `pnpm tauri dev`. Never run `pnpm dev` on its own, `target/debug/patchwork`, or other build outputs directly.
- The user keeps their own `pnpm tauri dev` session open and views changes there. Vite hot-reloads UI edits, and Rust changes rebuild on save, so a restart is rarely needed. If one is needed, restart only that `pnpm tauri dev` session and say so.
- Do not start the dev app or take screenshots of it unless the user asks.

## Editing alongside the dev session

- The user views changes live, so never run destructive git commands that discard or hide working-tree changes: `git reset --hard`, `git checkout -- <file>`, `git stash`, `git clean`, or similar.
- Keep each edit complete and compiling. Hot reload applies every save, so do not leave half-finished files or broken imports between steps.
- Say explicitly when a change needs a dev session restart, a new Cargo or pnpm dependency, or a config change (`tauri.conf.json`, capabilities, Vite config). Hot reload does not pick these up.
- Do not delete, move, or rename files without asking first. Those changes can break the dev session's watchers and the user's view.

## Project layout

- pnpm workspace (`pnpm-workspace.yaml`) with packages under `apps/*`. Root `package.json` scripts use these filters:
  - `patchwork-desktop` (Tauri app): `pnpm tauri dev`, `pnpm build`, `pnpm appimage`.
  - `patchwork-web` (frontend): `pnpm typecheck`, `pnpm dev:web`.
- Cargo workspace (`Cargo.toml`) with members `apps/server` and `apps/desktop/src-tauri`.
- Formatting: `pnpm format` and `pnpm format:check` cover `apps/**/*.tsx`. Run `pnpm format` on TSX changes.

## Verification

- Web: `pnpm typecheck`, plus `pnpm format:check` for TSX changes.
- Rust: `cargo clippy --workspace --all-targets` and `cargo test --workspace`.
- Run the checks that match what you changed, and report the output if any fail.

## Tests

- Never write tests. Do not add unit, integration, or frontend tests, test files, test runners, test dependencies, or test scripts, even when a change would benefit from one.

## Committing

- Do not commit or push until the user has reviewed the change and says to. Leave finished work uncommitted in the working tree.
- Do not push at all unless the user explicitly asks.
- Commit subjects are short, sentence-case, imperative-style summaries with no prefix, such as "Nudge the header project dropdown 2px left". Describe the user-visible change.

## Offering choices

- When asking the user to pick between options, put them in a fenced block with the language `choices`, containing a JSON array of short option labels, and nothing else in the block. Example:

  ````
  ```choices
  ["Commit and push", "Commit without pushing", "Leave uncommitted"]
  ```
  ````

- The app shows the options as numbered keys above the compose box and adds "Submit my own response" itself, so do not list that option in the array.
- Do not also write the options as a plain list.
