//! Launch arguments for Claude Code turns.

use crate::types::Settings;

/// Shells on this machine that commands can run in, by name and path.
const SHELLS: [(&str, &str); 3] = [
    ("zsh", "/usr/bin/zsh"),
    ("fish", "/usr/bin/fish"),
    ("bash", "/usr/bin/bash"),
];

/// Arguments that append the shell instructions to Claude's system prompt.
pub fn launch_args(settings: &Settings) -> Vec<String> {
    let paths = SHELLS
        .iter()
        .map(|(name, path)| format!("{name} is {path}"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut prompt = format!("Shell paths on this machine: {paths}.");
    if let Some(shell) = &settings.shell {
        prompt.push_str(&format!(
            " The user chose {shell} for shell commands; run them in it and write them for it."
        ));
    }
    vec!["--append-system-prompt".to_string(), prompt]
}
