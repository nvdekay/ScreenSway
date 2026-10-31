//! A small local log of how recordings and exports ended, so a user who reports a problem
//! can open the folder and attach it. It holds the app's and the capture helper's own
//! messages (steps, errors, encoder names); it may name file paths, but never recording
//! content. Nothing reads or sends it: the user decides whether to share it.

use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

pub const LOG_FILE: &str = "screensway.log";
const OLD_LOG_FILE: &str = "screensway.old.log";
/// The log starts over (keeping one older file) once it reaches this size.
const MAX_LOG_BYTES: u64 = 1024 * 1024;
/// A helper message longer than this is cut, for example a pointer log in a failed result.
const MAX_ENTRY_CHARS: usize = 8_000;

pub fn log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_log_dir().map_err(|error| format!("Could not find the log folder: {error}"))
}

/// Appends one entry; a log that cannot be written never fails what is being logged.
pub fn log(app: &tauri::AppHandle, context: &str, message: &str) {
    if let Ok(directory) = log_dir(app) {
        let _ = append(&directory, &entry(&crate::iso8601_utc(now_seconds()), context, message));
    }
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs() as i64)
}

fn entry(time: &str, context: &str, message: &str) -> String {
    let message = message.trim();
    let message = match message.char_indices().nth(MAX_ENTRY_CHARS) {
        Some((cut, _)) => format!("{}…", &message[..cut]),
        None => message.to_string(),
    };
    format!("{time} {context} {}\n", version_and_system() + &indent(&message))
}

fn version_and_system() -> String {
    format!("[{} {}-{}]", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH)
}

/// Continuation lines are indented, so each entry starts with its time.
fn indent(message: &str) -> String {
    if message.is_empty() {
        return String::new();
    }
    format!(" {}", message.replace('\n', "\n    "))
}

fn append(directory: &Path, entry: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    let path = directory.join(LOG_FILE);
    if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() >= MAX_LOG_BYTES) {
        std::fs::rename(&path, directory.join(OLD_LOG_FILE))?;
    }
    std::fs::OpenOptions::new().create(true).append(true).open(path)?.write_all(entry.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_start_with_the_time_and_indent_further_lines() {
        let text = entry("2026-10-31T08:00:00Z", "recording failed", "first\nsecond\n");
        assert!(text.starts_with("2026-10-31T08:00:00Z recording failed ["));
        assert!(text.ends_with("] first\n    second\n"));
    }

    #[test]
    fn long_messages_are_cut() {
        let text = entry("t", "export failed", &"x".repeat(MAX_ENTRY_CHARS + 50));
        assert!(text.contains(&format!("{}…", "x".repeat(MAX_ENTRY_CHARS))));
        assert!(!text.contains(&"x".repeat(MAX_ENTRY_CHARS + 1)));
    }

    #[test]
    fn a_full_log_starts_over_and_keeps_one_older_file() {
        let directory = std::env::temp_dir().join(format!("screensway-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(LOG_FILE), vec![b'a'; MAX_LOG_BYTES as usize]).unwrap();
        append(&directory, "new entry\n").unwrap();
        assert_eq!(std::fs::read_to_string(directory.join(LOG_FILE)).unwrap(), "new entry\n");
        assert_eq!(std::fs::metadata(directory.join(OLD_LOG_FILE)).unwrap().len(), MAX_LOG_BYTES);
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
