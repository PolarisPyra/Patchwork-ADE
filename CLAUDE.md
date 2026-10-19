# CLAUDE.md

## Running the app

- Do not launch the app (no `pnpm tauri dev`, `pnpm dev`, `target/debug/patchwork`, or screenshots of it) unless the user explicitly asks.
- The user keeps their own `pnpm tauri dev` session open alongside and views changes there; Vite hot-reloads UI edits, and Rust changes rebuild on save.
- Verify changes with `pnpm typecheck` (web) and `cargo test --workspace` / `cargo clippy --workspace --all-targets` (Rust) instead.
