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

#[tauri::command]
async fn record_main_display(duration_seconds: u64) -> Result<CaptureSummary, String> {
    if !(1..=300).contains(&duration_seconds) {
        return Err("Recording duration must be between 1 and 300 seconds.".into());
    }

    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || record_main_display_macos(duration_seconds))
            .await
            .map_err(|error| format!("Capture task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("The first ScreenSway capture prototype currently supports macOS only.".into())
    }
}

#[cfg(target_os = "macos")]
fn record_main_display_macos(duration_seconds: u64) -> Result<CaptureSummary, String> {
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

    let capture_binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../native/macos-capture/.build/debug/screensway-capture");
    if !capture_binary.exists() {
        return Err("The native capture helper is missing. Run `pnpm build:capture:macos` first.".into());
    }

    let output = Command::new(&capture_binary)
        .arg("--output")
        .arg(&project_path)
        .arg("--duration")
        .arg(duration_seconds.to_string())
        .output()
        .map_err(|error| format!("Could not start the native capture helper: {error}"))?;

    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if message.is_empty() {
            "The native capture helper exited unexpectedly.".into()
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
        .invoke_handler(tauri::generate_handler![record_main_display])
        .run(tauri::generate_context!())
        .expect("error while running ScreenSway");
}

