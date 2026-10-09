use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureSummary {
    project_path: String,
    video_path: String,
    pointer_events_path: String,
    duration_ms: u64,
    width: u32,
    height: u32,
    pointer_events: Vec<PointerSample>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PointerSample {
    time_ms: u64,
    r#type: String,
    x: f64,
    y: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureSource {
    id: String,
    kind: String,
    name: String,
    width: u32,
    height: u32,
}

#[tauri::command]
async fn list_capture_sources() -> Result<Vec<CaptureSource>, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(list_capture_sources_macos)
            .await
            .map_err(|error| format!("Source discovery task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Capture source discovery currently supports macOS only.".into())
    }
}

#[tauri::command]
async fn record_capture_source(
    duration_seconds: u64,
    source_kind: String,
    source_id: String,
) -> Result<CaptureSummary, String> {
    if !(1..=300).contains(&duration_seconds) {
        return Err("Recording duration must be between 1 and 300 seconds.".into());
    }
    if source_kind != "display" && source_kind != "window" {
        return Err("Capture source must be a display or window.".into());
    }

    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            record_capture_source_macos(duration_seconds, &source_kind, &source_id)
        })
        .await
        .map_err(|error| format!("Capture task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("The first ScreenSway capture prototype currently supports macOS only.".into())
    }
}

#[cfg(target_os = "macos")]
fn capture_binary() -> Result<std::path::PathBuf, String> {
    use std::path::PathBuf;

    let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../native/macos-capture/.build/debug/screensway-capture");
    if !binary.exists() {
        return Err("The native capture helper is missing. Run `pnpm build:capture:macos` first.".into());
    }
    Ok(binary)
}

#[cfg(target_os = "macos")]
fn list_capture_sources_macos() -> Result<Vec<CaptureSource>, String> {
    let output = std::process::Command::new(capture_binary()?)
        .arg("--list-sources")
        .output()
        .map_err(|error| format!("Could not discover capture sources: {error}"))?;
    parse_helper_output(output, "Capture source discovery")
}

#[cfg(target_os = "macos")]
fn record_capture_source_macos(
    duration_seconds: u64,
    source_kind: &str,
    source_id: &str,
) -> Result<CaptureSummary, String> {
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    let home = std::env::var_os("HOME").ok_or("Could not locate the user home directory.")?;
    let recordings_directory = PathBuf::from(home).join("Movies").join("ScreenSway");
    std::fs::create_dir_all(&recordings_directory)
        .map_err(|error| format!("Could not create the ScreenSway recordings directory: {error}"))?;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock error: {error}"))?
        .as_secs();
    let project_path = recordings_directory.join(format!("Recording-{timestamp}.screensway"));

    let output = Command::new(capture_binary()?)
        .arg("--output")
        .arg(&project_path)
        .arg("--duration")
        .arg(duration_seconds.to_string())
        .arg("--source-kind")
        .arg(source_kind)
        .arg("--source-id")
        .arg(source_id)
        .output()
        .map_err(|error| format!("Could not start the native capture helper: {error}"))?;

    parse_helper_output(output, "Screen recording")
}

#[cfg(target_os = "macos")]
fn parse_helper_output<T: serde::de::DeserializeOwned>(
    output: std::process::Output,
    operation: &str,
) -> Result<T, String> {
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if message.is_empty() {
            format!("{operation} helper exited unexpectedly.")
        } else {
            message
        });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Could not read the capture result: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_capture_sources,
            record_capture_source
        ])
        .run(tauri::generate_context!())
        .expect("error while running ScreenSway");
}

