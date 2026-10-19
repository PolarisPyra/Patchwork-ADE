//! Filesystem, git, and agent-detection helpers. All functions are blocking.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde_json::Value;

use crate::types::*;

/// Upper bound for any single agent CLI probe (`--version`, `auth status`, ...).
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// Largest file `read_file` returns.
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

/// Directories searched when `which` cannot find the agent CLI on PATH.
fn fallback_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut dirs: Vec<PathBuf> = [".local/bin", ".cargo/bin", ".bun/bin"]
        .iter()
        .map(|d| home.join(d))
        .collect();
    dirs.extend(["/usr/local/bin", "/opt/homebrew/bin"].map(PathBuf::from));
    if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        let mut nvm: Vec<PathBuf> = entries.flatten().map(|e| e.path().join("bin")).collect();
        nvm.sort();
        dirs.extend(nvm);
    }
    dirs
}

fn find_binary(name: &str) -> Option<PathBuf> {
    which::which(name).ok().or_else(|| {
        fallback_dirs()
            .into_iter()
            .map(|d| d.join(name))
            .find(|p| p.is_file())
    })
}

/// Resolves the agent CLI (searching PATH plus common install dirs, since GUI
/// launches may not inherit the shell PATH) and returns a Command for it with
/// the binary's directory prepended to PATH (codex needs `node` beside it).
pub fn agent_command(kind: AgentKind) -> Result<Command, String> {
    let (name, missing) = match kind {
        AgentKind::Claude => ("claude", "Claude Code is not installed"),
        AgentKind::Codex => ("codex", "Codex is not installed"),
    };
    let bin = find_binary(name).ok_or(missing)?;
    let mut cmd = Command::new(&bin);
    if let Some(dir) = bin.parent() {
        let mut paths = vec![dir.to_path_buf()];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
    Ok(cmd)
}

/// Sends `signal` to the process group led by `pid`. Agent children are spawned
/// as group leaders, so this also reaches their own subprocesses.
#[cfg(unix)]
pub fn signal_process_group(pid: u32, signal: i32) {
    // SAFETY: kill(2) has no memory-safety preconditions; a group that already
    // exited just yields an ignored error.
    unsafe { libc::kill(-(pid as libc::pid_t), signal) };
}

#[cfg(not(unix))]
pub fn signal_process_group(_pid: u32, _signal: i32) {}

struct Probe {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Runs the agent CLI with `args`. Returns None if it cannot start or exceeds
/// `PROBE_TIMEOUT` (the process group is killed in that case).
fn probe(kind: AgentKind, args: &[&str]) -> Option<Probe> {
    let mut cmd = agent_command(kind).ok()?;
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + PROBE_TIMEOUT;
    let exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                signal_process_group(child.id(), libc::SIGKILL);
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    Some(Probe {
        success: exit.success(),
        stdout: String::from_utf8_lossy(&out_reader.join().unwrap_or_default()).into_owned(),
        stderr: String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).into_owned(),
    })
}

fn claude_auth(status: &mut AgentStatus) {
    let json = probe(AgentKind::Claude, &["auth", "status"])
        .and_then(|p| serde_json::from_str::<Value>(p.stdout.trim()).ok());
    let logged_in = json
        .as_ref()
        .and_then(|v| v["loggedIn"].as_bool())
        .unwrap_or(false);
    if logged_in {
        let method = json
            .as_ref()
            .and_then(|v| v["authMethod"].as_str())
            .unwrap_or("claude.ai");
        status.signed_in = true;
        status.detail = format!("Signed in with {method}");
    } else {
        status.detail = "Not signed in — run `claude` to log in".into();
    }
}

pub fn detect_agent(kind: AgentKind) -> AgentStatus {
    let mut status = AgentStatus {
        kind,
        installed: false,
        version: None,
        signed_in: false,
        detail: "Not installed".into(),
    };
    let Some(version) = probe(kind, &["--version"]).filter(|p| p.success) else {
        return status;
    };
    status.installed = true;
    // "2.1.303 (Claude Code)" and "codex-cli 0.163.0" both carry the version as a numeric word.
    status.version = version
        .stdout
        .split_whitespace()
        .find(|w| w.starts_with(|c: char| c.is_ascii_digit()))
        .map(String::from);
    match kind {
        AgentKind::Claude => claude_auth(&mut status),
        AgentKind::Codex => {
            let login = probe(kind, &["login", "status"])
                .filter(|p| p.success)
                .and_then(|p| {
                    p.stdout
                        .lines()
                        .chain(p.stderr.lines())
                        .find(|l| l.contains("Logged in"))
                        .map(|l| l.trim().to_string())
                });
            status.signed_in = login.is_some();
            status.detail = login.unwrap_or_else(|| "Not signed in — run `codex login`".into());
        }
    }
    status
}

pub fn make_project(path: &str) -> Result<Project, String> {
    let canonical = std::fs::canonicalize(path).map_err(|e| format!("Cannot open {path}: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let name = canonical
        .file_name()
        .unwrap_or(canonical.as_os_str())
        .to_string_lossy()
        .into_owned();
    Ok(Project {
        id: new_id(),
        name,
        path: canonical.to_string_lossy().into_owned(),
    })
}

pub fn create_project_dir(parent: &str, name: &str) -> Result<Project, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err("Project name must be a single folder name".into());
    }
    let parent = std::fs::canonicalize(parent).map_err(|e| format!("Cannot open {parent}: {e}"))?;
    if !parent.is_dir() {
        return Err(format!("{} is not a folder", parent.display()));
    }
    let dir = parent.join(name);
    if dir.exists() {
        let empty = dir.is_dir()
            && std::fs::read_dir(&dir)
                .map_err(|e| e.to_string())?
                .next()
                .is_none();
        if !empty {
            return Err(format!("{} already exists and is not empty", dir.display()));
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let root = dir.to_string_lossy().into_owned();
    git(&root, &["init", "-b", "main"])?;
    make_project(&root)
}

/// Joins `rel` onto the project root and rejects anything that resolves outside it.
fn resolve_inside(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let path = std::fs::canonicalize(root.join(rel)).map_err(|e| format!("{rel}: {e}"))?;
    if path.starts_with(&root) {
        Ok(path)
    } else {
        Err("Path is outside the project".into())
    }
}

pub fn read_file(root: &str, rel: &str) -> Result<String, String> {
    let path = resolve_inside(root, rel)?;
    if !path.is_file() {
        return Err(format!("{rel} is not a file"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .and_then(|f| f.take(MAX_READ_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err("File is larger than 2 MB".into());
    }
    if bytes.contains(&0) {
        return Err("Binary file".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Runs `git <args>` in `root` and returns its raw output.
fn git_raw(root: &str, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))
}

/// Runs `git <args>` in `root` and returns stdout; a non-zero exit becomes an error carrying stderr.
fn git(root: &str, args: &[&str]) -> Result<String, String> {
    let out = git_raw(root, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

fn git_succeeds(root: &str, args: &[&str]) -> bool {
    git_raw(root, args).is_ok_and(|o| o.status.success())
}

fn is_untracked(root: &str, rel: &str) -> bool {
    !git_succeeds(root, &["ls-files", "--error-unmatch", "--", rel])
}

fn has_head(root: &str) -> bool {
    git_succeeds(root, &["rev-parse", "--verify", "-q", "HEAD"])
}

pub fn git_branch(root: &str) -> Option<String> {
    git(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Parses `git diff --numstat -z` into (path, additions, deletions). Renames
/// carry an extra NUL-separated origin path before the new path.
fn parse_numstat(out: &str) -> Vec<(String, u32, u32)> {
    let mut entries = Vec::new();
    let mut tokens = out.split('\0');
    while let Some(token) = tokens.next() {
        let mut parts = token.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            tokens.next(); // origin path of a rename
            match tokens.next() {
                Some(new) => new.to_string(),
                None => break,
            }
        } else {
            path.to_string()
        };
        // Binary files report "-" for both counts.
        entries.push((
            path,
            added.parse().unwrap_or(0),
            deleted.parse().unwrap_or(0),
        ));
    }
    entries
}

/// Number of lines in an untracked file; 0 for binary or unreadable files.
fn line_count(path: &Path) -> u32 {
    match std::fs::read(path) {
        Ok(bytes) if !bytes.contains(&0) => {
            let newlines = bytes.iter().filter(|&&b| b == b'\n').count();
            let partial_last = bytes.last().is_some_and(|&b| b != b'\n');
            (newlines + usize::from(partial_last)) as u32
        }
        _ => 0,
    }
}

pub fn git_changes(root: &str) -> Result<Vec<FileChange>, String> {
    if !git_succeeds(root, &["rev-parse", "--is-inside-work-tree"]) {
        return Ok(vec![]);
    }
    let status = git(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;

    let mut counts: HashMap<String, (u32, u32)> = HashMap::new();
    let numstat_args: [&[&str]; 2] = [
        &["diff", "--numstat", "-z"],
        &["diff", "--cached", "--numstat", "-z"],
    ];
    for args in numstat_args {
        for (path, added, deleted) in parse_numstat(&git(root, args)?) {
            let entry = counts.entry(path).or_default();
            entry.0 += added;
            entry.1 += deleted;
        }
    }

    let mut changes = Vec::new();
    let mut entries = status.split('\0');
    while let Some(entry) = entries.next() {
        // Each entry is "XY <path>"; rename/copy entries are followed by the origin path.
        if entry.len() < 4 {
            continue;
        }
        let (x, y) = (entry.as_bytes()[0] as char, entry.as_bytes()[1] as char);
        let path = entry[3..].to_string();
        if x == 'R' || x == 'C' {
            entries.next();
        }
        let code = if x != ' ' { x } else { y };
        let status = match code {
            '?' => "untracked",
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            _ => "modified",
        };
        let (additions, deletions) = if x == '?' {
            (line_count(&Path::new(root).join(&path)), 0)
        } else {
            counts.get(&path).copied().unwrap_or((0, 0))
        };
        changes.push(FileChange {
            path,
            status: status.into(),
            additions,
            deletions,
            staged: x != ' ' && x != '?',
        });
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(changes)
}

pub fn git_file_diff(root: &str, rel: &str) -> Result<String, String> {
    if is_untracked(root, rel) {
        let out = git_raw(root, &["diff", "--no-index", "--", "/dev/null", rel])?;
        // `diff --no-index` exits 1 whenever the files differ, which is the normal case here.
        if !matches!(out.status.code(), Some(0 | 1)) {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    if has_head(root) {
        return git(root, &["diff", "HEAD", "--", rel]);
    }
    // No commits yet, so there is no HEAD to diff against: show staged and unstaged parts.
    Ok(git(root, &["diff", "--cached", "--", rel])? + &git(root, &["diff", "--", rel])?)
}

pub fn accept_file(root: &str, rel: &str) -> Result<(), String> {
    git(root, &["add", "--", rel]).map(|_| ())
}

pub fn revert_file(root: &str, rel: &str) -> Result<(), String> {
    if is_untracked(root, rel) {
        return std::fs::remove_file(resolve_inside(root, rel)?).map_err(|e| e.to_string());
    }
    if git_succeeds(root, &["cat-file", "-e", &format!("HEAD:{rel}")]) {
        git(
            root,
            &[
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
                "--",
                rel,
            ],
        )?;
    } else {
        // Newly added file: drop it from the index and delete it from disk.
        git(root, &["rm", "--cached", "-f", "-q", "--", rel])?;
        if let Ok(path) = resolve_inside(root, rel) {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn open_in_editor(root: &str, rel: &str) -> Result<(), String> {
    let path = Path::new(root).join(rel);
    let fallback = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let candidates = ["idea", "code", "zed", fallback];
    for program in candidates {
        let spawned = Command::new(program)
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut child) = spawned {
            // Reap the launcher in the background so it does not linger as a zombie.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }
    }
    Err(format!("No editor found (tried {})", candidates.join(", ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Creates a repo under the temp dir with one committed file, `a.txt`.
    fn temp_repo() -> String {
        let dir = std::env::temp_dir().join(new_id());
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().into_owned();
        git(&root, &["init", "-b", "main"]).unwrap();
        git(&root, &["config", "user.name", "Test"]).unwrap();
        git(&root, &["config", "user.email", "test@example.com"]).unwrap();
        git(&root, &["config", "commit.gpgsign", "false"]).unwrap();
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        git(&root, &["add", "--", "a.txt"]).unwrap();
        git(&root, &["commit", "-q", "-m", "init"]).unwrap();
        root
    }

    #[test]
    fn reports_modified_and_untracked_files() {
        let root = temp_repo();
        std::fs::write(Path::new(&root).join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(Path::new(&root).join("b.txt"), "x\ny\n").unwrap();

        let changes = git_changes(&root).unwrap();
        assert_eq!(changes.len(), 2);
        let a = &changes[0];
        assert_eq!(
            (
                a.path.as_str(),
                a.status.as_str(),
                a.additions,
                a.deletions,
                a.staged
            ),
            ("a.txt", "modified", 1, 0, false)
        );
        let b = &changes[1];
        assert_eq!(
            (b.status.as_str(), b.additions, b.staged),
            ("untracked", 2, false)
        );

        assert!(git_file_diff(&root, "a.txt").unwrap().contains("+three"));
        assert!(!git_file_diff(&root, "b.txt").unwrap().is_empty());

        accept_file(&root, "a.txt").unwrap();
        let changes = git_changes(&root).unwrap();
        assert!(changes.iter().any(|c| c.path == "a.txt" && c.staged));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn revert_restores_tracked_and_removes_new_files() {
        let root = temp_repo();
        let dir = Path::new(&root);
        std::fs::write(dir.join("a.txt"), "changed\n").unwrap();
        std::fs::write(dir.join("b.txt"), "new\n").unwrap();
        std::fs::write(dir.join("c.txt"), "staged\n").unwrap();
        git(&root, &["add", "--", "c.txt"]).unwrap();

        revert_file(&root, "a.txt").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "one\ntwo\n"
        );
        revert_file(&root, "b.txt").unwrap();
        assert!(!dir.join("b.txt").exists());
        revert_file(&root, "c.txt").unwrap();
        assert!(!dir.join("c.txt").exists());
        assert!(git_changes(&root).unwrap().is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn read_file_stays_inside_project() {
        let root = temp_repo();
        let outside = Path::new(&root)
            .parent()
            .unwrap()
            .join(format!("{}.txt", new_id()));
        std::fs::write(&outside, "secret").unwrap();
        let escape = format!("../{}", outside.file_name().unwrap().to_string_lossy());

        assert!(read_file(&root, &escape).unwrap_err().contains("outside"));
        assert_eq!(read_file(&root, "a.txt").unwrap(), "one\ntwo\n");
        std::fs::remove_file(&outside).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }
}
