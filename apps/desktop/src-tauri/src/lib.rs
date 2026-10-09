use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Deserialize, Serialize)]
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

#[derive(Clone, Debug, Deserialize, Serialize)]
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

/// Broadcast to every window so the main window, the floating controls and the
/// menu bar always agree on what the recorder is doing.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingState {
    /// One of `idle`, `countdown`, `recording`, `paused`, `finishing`.
    status: &'static str,
    countdown: Option<u8>,
    elapsed_ms: u64,
}

#[cfg(target_os = "macos")]
struct ActiveRecording {
    child: std::process::Child,
    stderr_log: Arc<Mutex<String>>,
    control_path: std::path::PathBuf,
    project_path: std::path::PathBuf,
    started_at: Instant,
    paused_total: Duration,
    paused_at: Option<Instant>,
}

#[cfg(target_os = "macos")]
impl ActiveRecording {
    fn elapsed(&self) -> Duration {
        let current_pause = self.paused_at.map(|at| at.elapsed()).unwrap_or_default();
        self.started_at
            .elapsed()
            .saturating_sub(self.paused_total + current_pause)
    }

    fn state(&self) -> RecordingState {
        RecordingState {
            status: if self.paused_at.is_some() { "paused" } else { "recording" },
            countdown: None,
            elapsed_ms: self.elapsed().as_millis() as u64,
        }
    }
}

#[derive(Default)]
struct CaptureManager {
    state: Arc<Mutex<RecordingState>>,
    #[cfg(target_os = "macos")]
    active: Arc<Mutex<Option<ActiveRecording>>>,
    #[cfg(target_os = "macos")]
    cancel_countdown: Arc<AtomicBool>,
}

const RECORDING_STATE_EVENT: &str = "recording-state";
const RECORDING_FINISHED_EVENT: &str = "recording-finished";
const RECORDING_FAILED_EVENT: &str = "recording-failed";
#[cfg(target_os = "macos")]
const HUD_LABEL: &str = "hud";
#[cfg(target_os = "macos")]
const TRAY_ID: &str = "recording";
#[cfg(target_os = "macos")]
const COUNTDOWN_SECONDS: u8 = 3;
#[cfg(target_os = "macos")]
const HELPER_READY_LINE: &str = "SCREENSWAY_READY";

fn publish_state(app: &tauri::AppHandle, state: RecordingState) {
    if let Ok(mut current) = app.state::<CaptureManager>().state.lock() {
        *current = state.clone();
    }
    let _ = app.emit(RECORDING_STATE_EVENT, state);
}

#[tauri::command]
fn get_recording_state(state: tauri::State<'_, CaptureManager>) -> RecordingState {
    #[cfg(target_os = "macos")]
    if let Ok(active) = state.active.lock() {
        if let Some(recording) = active.as_ref() {
            return recording.state();
        }
    }
    state
        .state
        .lock()
        .map(|current| current.clone())
        .unwrap_or_default()
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
    app: tauri::AppHandle,
    source_kind: String,
    source_id: String,
) -> Result<RecordingStarted, String> {
    if source_kind != "display" && source_kind != "window" {
        return Err("Capture source must be a display or window.".into());
    }

    #[cfg(target_os = "macos")]
    {
        reserve_recording(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            let result = start_recording_macos(&app, &source_kind, &source_id);
            if result.is_err() {
                publish_state(&app, RecordingState { status: "idle", ..Default::default() });
                restore_main_window(&app);
            }
            result
        })
        .await
        .map_err(|error| format!("Capture start task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, source_id);
        Err("The first ScreenSway capture prototype currently supports macOS only.".into())
    }
}

#[tauri::command]
fn cancel_countdown(state: tauri::State<'_, CaptureManager>) {
    #[cfg(target_os = "macos")]
    state.cancel_countdown.store(true, Ordering::SeqCst);
    #[cfg(not(target_os = "macos"))]
    let _ = state;
}

#[tauri::command]
async fn stop_recording(app: tauri::AppHandle) -> Result<CaptureSummary, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || stop_recording_macos(&app))
            .await
            .map_err(|error| format!("Capture stop task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("The first ScreenSway capture prototype currently supports macOS only.".into())
    }
}

#[tauri::command]
async fn set_recording_paused(app: tauri::AppHandle, paused: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || set_recording_paused_macos(&app, paused))
            .await
            .map_err(|error| format!("Capture control task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, paused);
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
fn reserve_recording(app: &tauri::AppHandle) -> Result<(), String> {
    let manager = app.state::<CaptureManager>();
    let mut current = manager
        .state
        .lock()
        .map_err(|_| "The capture state lock is unavailable.".to_string())?;
    if current.status != "idle" {
        return Err("A recording is already in progress.".into());
    }
    current.status = "countdown";
    Ok(())
}

#[cfg(target_os = "macos")]
fn start_recording_macos(
    app: &tauri::AppHandle,
    source_kind: &str,
    source_id: &str,
) -> Result<RecordingStarted, String> {
    use std::io::BufRead;
    use std::process::{Command, Stdio};

    let manager = app.state::<CaptureManager>();
    manager.cancel_countdown.store(false, Ordering::SeqCst);

    // Get the app out of the way and give the user a moment before frames are captured.
    show_hud(app, HudLayout::Countdown)?;
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    for remaining in (1..=COUNTDOWN_SECONDS).rev() {
        publish_state(
            app,
            RecordingState { status: "countdown", countdown: Some(remaining), elapsed_ms: 0 },
        );
        for _ in 0..10 {
            std::thread::sleep(Duration::from_millis(100));
            if manager.cancel_countdown.load(Ordering::SeqCst) {
                close_hud(app);
                return Err("Recording cancelled.".into());
            }
        }
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
        .arg("--exclude-pid")
        .arg(std::process::id().to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start the native capture helper: {error}"))?;

    // Wait until ScreenCaptureKit is actually delivering frames before the timer starts.
    let stderr = child.stderr.take().ok_or("Could not read the capture helper output.")?;
    let stderr_log = Arc::new(Mutex::new(String::new()));
    let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
    {
        let stderr_log = stderr_log.clone();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                if line.trim() == HELPER_READY_LINE {
                    let _ = ready_sender.send(());
                } else if let Ok(mut log) = stderr_log.lock() {
                    log.push_str(&line);
                    log.push('\n');
                }
            }
        });
    }
    if ready_receiver.recv_timeout(Duration::from_secs(30)).is_err() {
        let _ = child.kill();
        let message = finish_helper(child, &stderr_log)
            .err()
            .unwrap_or_else(|| "Screen recording did not start in time.".into());
        let _ = std::fs::remove_dir_all(&project_path);
        close_hud(app);
        return Err(message);
    }

    let recording = ActiveRecording {
        child,
        stderr_log,
        control_path,
        project_path: project_path.clone(),
        started_at: Instant::now(),
        paused_total: Duration::ZERO,
        paused_at: None,
    };
    let state = recording.state();
    *manager
        .active
        .lock()
        .map_err(|_| "The capture state lock is unavailable.".to_string())? = Some(recording);

    show_hud(app, HudLayout::Controls)?;
    publish_state(app, state);
    start_recording_monitor(app.clone());

    Ok(RecordingStarted {
        project_path: project_path.to_string_lossy().into_owned(),
    })
}

#[cfg(target_os = "macos")]
fn set_recording_paused_macos(app: &tauri::AppHandle, paused: bool) -> Result<(), String> {
    let manager = app.state::<CaptureManager>();
    let state = {
        let mut guard = manager
            .active
            .lock()
            .map_err(|_| "The capture state lock is unavailable.".to_string())?;
        let recording = guard
            .as_mut()
            .ok_or("There is no active recording to pause or resume.")?;
        if recording.paused_at.is_some() == paused {
            return Ok(());
        }

        std::fs::write(
            &recording.control_path,
            if paused { "pause" } else { "recording" },
        )
        .map_err(|error| format!("Could not update the recording state: {error}"))?;
        if paused {
            recording.paused_at = Some(Instant::now());
        } else if let Some(paused_at) = recording.paused_at.take() {
            recording.paused_total += paused_at.elapsed();
        }
        recording.state()
    };
    publish_state(app, state);
    update_tray(app);
    Ok(())
}

#[cfg(target_os = "macos")]
fn stop_recording_macos(app: &tauri::AppHandle) -> Result<CaptureSummary, String> {
    let manager = app.state::<CaptureManager>();
    let recording = manager
        .active
        .lock()
        .map_err(|_| "The capture state lock is unavailable.".to_string())?
        .take()
        .ok_or("There is no active recording to stop.")?;

    let elapsed_ms = recording.elapsed().as_millis() as u64;
    publish_state(app, RecordingState { status: "finishing", countdown: None, elapsed_ms });
    update_tray(app);

    let result = std::fs::write(&recording.control_path, "stop")
        .map_err(|error| format!("Could not send the stop command: {error}"))
        .and_then(|_| finish_helper(recording.child, &recording.stderr_log));
    let _ = std::fs::remove_file(&recording.control_path);
    if let Ok(summary) = &result {
        debug_assert_eq!(summary.project_path, recording.project_path.to_string_lossy());
    }
    finish_session(app, &result);
    result
}

/// Detects a helper that dies mid-recording and keeps the menu bar timer ticking.
#[cfg(target_os = "macos")]
fn start_recording_monitor(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        let manager = app.state::<CaptureManager>();
        let crashed = {
            let Ok(mut guard) = manager.active.lock() else { return };
            let Some(recording) = guard.as_mut() else { return };
            match recording.child.try_wait() {
                Ok(None) => None,
                _ => guard.take(),
            }
        };
        match crashed {
            Some(recording) => {
                let _ = std::fs::remove_file(&recording.control_path);
                let result = finish_helper(recording.child, &recording.stderr_log).and_then(|_| {
                    Err::<CaptureSummary, String>("The capture helper stopped unexpectedly.".into())
                });
                finish_session(&app, &result);
                return;
            }
            None => update_tray(&app),
        }
    });
}

#[cfg(target_os = "macos")]
fn finish_session(app: &tauri::AppHandle, result: &Result<CaptureSummary, String>) {
    close_hud(app);
    update_tray(app);
    publish_state(app, RecordingState { status: "idle", ..Default::default() });
    match result {
        Ok(summary) => {
            let _ = app.emit(RECORDING_FINISHED_EVENT, summary.clone());
        }
        Err(message) => {
            let _ = app.emit(RECORDING_FAILED_EVENT, message.clone());
        }
    }
    restore_main_window(app);
}

#[cfg(target_os = "macos")]
fn finish_helper(
    mut child: std::process::Child,
    stderr_log: &Arc<Mutex<String>>,
) -> Result<CaptureSummary, String> {
    use std::io::Read;

    // Drain stdout before waiting so a large pointer log cannot fill the pipe and block the helper.
    let mut stdout = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_end(&mut stdout);
    }
    let status = child
        .wait()
        .map_err(|error| format!("Could not finalize the recording: {error}"))?;
    // Give the stderr reader a moment to collect the helper's final message.
    std::thread::sleep(Duration::from_millis(50));
    let stderr = stderr_log.lock().map(|log| log.clone()).unwrap_or_default();
    parse_helper_output(
        std::process::Output { status, stdout, stderr: stderr.into_bytes() },
        "Screen recording",
    )
}

#[cfg(target_os = "macos")]
enum HudLayout {
    Countdown,
    Controls,
}

#[cfg(target_os = "macos")]
fn show_hud(app: &tauri::AppHandle, layout: HudLayout) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize, WebviewUrl, WebviewWindowBuilder};

    let (width, height) = match layout {
        HudLayout::Countdown => (220.0, 220.0),
        HudLayout::Controls => (292.0, 60.0),
    };

    let hud = match app.get_webview_window(HUD_LABEL) {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, HUD_LABEL, WebviewUrl::App("index.html#hud".into()))
            .title("ScreenSway Recording")
            .inner_size(width, height)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .focused(false)
            .accept_first_mouse(true)
            // Keeps the controls out of this and any other screen recording.
            .content_protected(true)
            .build()
            .map_err(|error| format!("Could not show the recording controls: {error}"))?,
    };

    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| hud.primary_monitor().ok().flatten());
    let _ = hud.set_size(LogicalSize::new(width, height));
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let origin = monitor.position().to_logical::<f64>(scale);
        let size = monitor.size().to_logical::<f64>(scale);
        let y = match layout {
            HudLayout::Countdown => origin.y + (size.height - height) / 2.0,
            HudLayout::Controls => origin.y + 44.0,
        };
        let _ = hud.set_position(LogicalPosition::new(origin.x + (size.width - width) / 2.0, y));
    }
    let _ = hud.show();
    Ok(())
}

#[cfg(target_os = "macos")]
fn close_hud(app: &tauri::AppHandle) {
    if let Some(hud) = app.get_webview_window(HUD_LABEL) {
        let _ = hud.close();
    }
}

fn restore_main_window(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop Recording", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show ScreenSway", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&stop, &pause, &separator, &show])?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("ScreenSway is recording")
        .on_menu_event(move |app, event| {
            let app = app.clone();
            match event.id().as_ref() {
                "stop" => {
                    std::thread::spawn(move || {
                        let _ = stop_recording_macos(&app);
                    });
                }
                "pause" => {
                    std::thread::spawn(move || {
                        let paused = app
                            .state::<CaptureManager>()
                            .state
                            .lock()
                            .map(|state| state.status == "paused")
                            .unwrap_or(false);
                        let _ = set_recording_paused_macos(&app, !paused);
                    });
                }
                "show" => restore_main_window(&app),
                _ => {}
            }
        })
        .build(app)?;
    tray.set_visible(false)?;
    app.manage(TrayPauseItem(pause));
    Ok(())
}

#[cfg(target_os = "macos")]
struct TrayPauseItem(tauri::menu::MenuItem<tauri::Wry>);

/// Shows a live timer in the menu bar while recording, so the state is visible from any app.
#[cfg(target_os = "macos")]
fn update_tray(app: &tauri::AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let state = app
        .state::<CaptureManager>()
        .active
        .lock()
        .ok()
        .and_then(|active| active.as_ref().map(ActiveRecording::state));
    let Some(state) = state else {
        let _ = tray.set_visible(false);
        return;
    };

    let seconds = state.elapsed_ms / 1_000;
    let marker = if state.status == "paused" { "❚❚" } else { "●" };
    let _ = tray.set_title(Some(format!(" {marker} {}:{:02}", seconds / 60, seconds % 60)));
    let _ = tray.set_visible(true);
    if let Some(item) = app.try_state::<TrayPauseItem>() {
        let _ = item.0.set_text(if state.status == "paused" { "Resume" } else { "Pause" });
    }
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
        .manage(CaptureManager {
            state: Arc::new(Mutex::new(RecordingState { status: "idle", ..Default::default() })),
            ..Default::default()
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            setup_tray(app)?;
            #[cfg(not(target_os = "macos"))]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_recording_state,
            list_capture_sources,
            start_recording,
            cancel_countdown,
            set_recording_paused,
            stop_recording
        ])
        .build(tauri::generate_context!())
        .expect("error while building ScreenSway")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                restore_main_window(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
