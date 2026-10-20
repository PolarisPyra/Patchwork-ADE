# CLAUDE.md

## Running the app

- Do not launch the app (no `pnpm tauri dev`, `pnpm dev`, `target/debug/patchwork`, or screenshots of it) unless the user explicitly asks.
- The user keeps their own `pnpm tauri dev` session open alongside and views changes there; Vite hot-reloads UI edits, and Rust changes rebuild on save.
- Verify changes with `pnpm typecheck` (web) and `cargo test --workspace` / `cargo clippy --workspace --all-targets` (Rust) instead.

## Tests

- Never write tests. Do not add unit, integration, or frontend tests, test files, test runners, test dependencies, or test scripts, even when a change would benefit from one.
- Verify with `pnpm typecheck`, `cargo clippy --workspace --all-targets`, and the existing `cargo test --workspace`.

## Committing

- Do not commit or push until the user has reviewed the change and says to. Leave finished work uncommitted in the working tree.
- Do not push at all unless the user explicitly asks.
