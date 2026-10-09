use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
use std::sync::{Arc, Mutex};

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingStarted {
    project_path: String,
}

#[cfg(target_os = "macos")]
struct ActiveRecording {
    child: std::process::Child,
    control_path: std::path::PathBuf,
    project_path: std::path::PathBuf,
    paused: bool,
}

#[derive(Default)]
struct CaptureManager {
    #[cfg(target_os = "macos")]
    active: Arc<Mutex<Option<ActiveRecording>>>,
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
async fn start_recording(
    state: tauri::State<'_, CaptureManager>,
    source_kind: String,
    source_id: String,
) -> Result<RecordingStarted, String> {
    if source_kind != "display" && source_kind != "window" {
        return Err("Capture source must be a display or window.".into());
    }

    #[cfg(target_os = "macos")]
    {
        let active = state.active.clone();
        tauri::async_runtime::spawn_blocking(move || {
            start_recording_macos(active, &source_kind, &source_id)
        })
        .await
        .map_err(|error| format!("Capture start task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        Err("The first ScreenSway capture prototype currently supports macOS only.".into())
    }
}

#[tauri::command]
async fn stop_recording(
    state: tauri::State<'_, CaptureManager>,
) -> Result<CaptureSummary, String> {
    #[cfg(target_os = "macos")]
    {
        let active = state.active.clone();
        tauri::async_runtime::spawn_blocking(move || stop_recording_macos(active))
            .await
            .map_err(|error| format!("Capture stop task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        Err("The first ScreenSway capture prototype currently supports macOS only.".into())
    }
}

#[tauri::command]
async fn set_recording_paused(
    state: tauri::State<'_, CaptureManager>,
    paused: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let active = state.active.clone();
        tauri::async_runtime::spawn_blocking(move || set_recording_paused_macos(active, paused))
            .await
            .map_err(|error| format!("Capture control task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, paused);
        Err("Pause and resume currently support macOS only.".into())
    }
}

#[cfg(target_os = "macos")]
fn capture_binary() -> Result<std::path::PathBuf, String> {
    let bundled_binary = std::env::current_exe()
        .map_err(|error| format!("Could not locate the ScreenSway executable: {error}"))?
        .with_file_name("screensway-capture");
    if bundled_binary.is_file() {
        return Ok(bundled_binary);
    }

    let development_binary = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../native/macos-capture/.build/debug/screensway-capture");
    if development_binary.is_file() {
        return Ok(development_binary);
    }

    Err("The macOS capture sidecar is missing. Rebuild ScreenSway with `pnpm build:capture:macos`.".into())
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
fn start_recording_macos(
    active: Arc<Mutex<Option<ActiveRecording>>>,
    source_kind: &str,
    source_id: &str,
) -> Result<RecordingStarted, String> {
    use std::process::{Command, Stdio};

    let mut guard = active
        .lock()
        .map_err(|_| "The capture state lock is unavailable.".to_string())?;
    if guard.is_some() {
        return Err("A recording is already in progress.".into());
    }

    let project_path = create_project_path()?;
    std::fs::create_dir_all(&project_path)
        .map_err(|error| format!("Could not create the ScreenSway project directory: {error}"))?;
    let control_path = project_path.join(".capture-control");
    std::fs::write(&control_path, "recording")
        .map_err(|error| format!("Could not initialize recording controls: {error}"))?;

    let mut child = Command::new(capture_binary()?)
        .arg("--output")
        .arg(&project_path)
        .arg("--control")
        .arg(&control_path)
        .arg("--source-kind")
        .arg(source_kind)
        .arg("--source-id")
        .arg(source_id)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start the native capture helper: {error}"))?;

    std::thread::sleep(std::time::Duration::from_millis(350));
    if child
        .try_wait()
        .map_err(|error| format!("Could not inspect the capture helper: {error}"))?
        .is_some()
    {
        let output = child
            .wait_with_output()
            .map_err(|error| format!("Could not read the capture helper result: {error}"))?;
        return parse_helper_output::<CaptureSummary>(output, "Screen recording").map(|summary| {
            RecordingStarted {
                project_path: summary.project_path,
            }
        });
    }

    let response = RecordingStarted {
        project_path: project_path.to_string_lossy().into_owned(),
    };
    *guard = Some(ActiveRecording {
        child,
        control_path,
        project_path,
        paused: false,
    });
    Ok(response)
}

#[cfg(target_os = "macos")]
fn set_recording_paused_macos(
    active: Arc<Mutex<Option<ActiveRecording>>>,
    paused: bool,
) -> Result<(), String> {
    let mut guard = active
        .lock()
        .map_err(|_| "The capture state lock is unavailable.".to_string())?;
    let recording = guard
        .as_mut()
        .ok_or("There is no active recording to pause or resume.")?;
    if recording.paused == paused {
        return Ok(());
    }

    std::fs::write(
        &recording.control_path,
        if paused { "pause" } else { "recording" },
    )
    .map_err(|error| format!("Could not update the recording state: {error}"))?;
    recording.paused = paused;
    Ok(())
}

#[cfg(target_os = "macos")]
fn stop_recording_macos(
    active: Arc<Mutex<Option<ActiveRecording>>>,
) -> Result<CaptureSummary, String> {
    let recording = active
        .lock()
        .map_err(|_| "The capture state lock is unavailable.".to_string())?
        .take()
        .ok_or("There is no active recording to stop.")?;

    std::fs::write(&recording.control_path, "stop")
        .map_err(|error| format!("Could not send the stop command: {error}"))?;
    let output = recording
        .child
        .wait_with_output()
        .map_err(|error| format!("Could not finalize the recording: {error}"))?;

    let _ = std::fs::remove_file(recording.control_path);
    let summary: CaptureSummary = parse_helper_output(output, "Screen recording")?;
    debug_assert_eq!(summary.project_path, recording.project_path.to_string_lossy());
    Ok(summary)
}

#[cfg(target_os = "macos")]
fn create_project_path() -> Result<std::path::PathBuf, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let home = std::env::var_os("HOME").ok_or("Could not locate the user home directory.")?;
    let recordings_directory = std::path::PathBuf::from(home)
        .join("Movies")
        .join("ScreenSway");
    std::fs::create_dir_all(&recordings_directory)
        .map_err(|error| format!("Could not create the ScreenSway recordings directory: {error}"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock error: {error}"))?
        .as_secs();
    Ok(recordings_directory.join(format!("Recording-{timestamp}.screensway")))
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
        .manage(CaptureManager::default())
        .invoke_handler(tauri::generate_handler![
            list_capture_sources,
            start_recording,
            set_recording_paused,
            stop_recording
        ])
        .run(tauri::generate_context!())
        .expect("error while running ScreenSway");
}
