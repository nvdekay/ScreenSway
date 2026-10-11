//! ScreenSway's Windows helper. It speaks the same command line as the macOS helper in
//! `native/macos-capture`, so the desktop shell drives both the same way:
//!
//! - `--list-sources`, `--list-microphones`: JSON on stdout.
//! - `--output <project> --control <file> --source-kind display|window --source-id <id>`:
//!   records until the control file says `stop`, prints `SCREENSWAY_READY` on stderr once
//!   frames flow and a JSON summary on stdout when done.
//! - `--export <job.json>`, `--transcribe <video>`: not available on Windows yet.

// Only the platform-independent parts (and their tests) build elsewhere.
#![cfg_attr(not(windows), allow(dead_code))]

mod model;
mod timeline;
#[cfg(windows)]
mod platform;

use std::process::ExitCode;

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().collect();
    match run(&arguments) {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

pub fn argument<'a>(arguments: &'a [String], name: &str) -> Option<&'a str> {
    let index = arguments.iter().position(|argument| argument == name)?;
    arguments.get(index + 1).map(String::as_str)
}

#[cfg(windows)]
fn run(arguments: &[String]) -> Result<String, String> {
    if argument(arguments, "--export").is_some() {
        return Err("ScreenSway capture failed: Export is not available on Windows yet.".into());
    }
    if argument(arguments, "--transcribe").is_some() {
        return Err("ScreenSway capture failed: Captions are not available on Windows yet.".into());
    }
    platform::initialize().map_err(failure)?;
    if arguments.iter().any(|argument| argument == "--list-sources") {
        return Ok(json(&platform::sources::list().map_err(failure)?));
    }
    if arguments.iter().any(|argument| argument == "--list-microphones") {
        // Microphones arrive with audio capture; an empty list hides the picker.
        return Ok(json(&Vec::<model::Microphone>::new()));
    }
    let summary = platform::recorder::run(arguments).map_err(failure)?;
    Ok(json(&summary))
}

#[cfg(not(windows))]
fn run(_arguments: &[String]) -> Result<String, String> {
    Err("This helper records on Windows; macOS uses native/macos-capture.".into())
}

#[cfg(windows)]
fn failure(error: impl std::fmt::Display) -> String {
    format!("ScreenSway capture failed: {error}")
}

/// Pretty JSON, like the macOS helper prints.
#[cfg(windows)]
fn json(value: &impl serde::Serialize) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into())
}
