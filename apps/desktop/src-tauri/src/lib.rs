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
    pixel_scale: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Microphone {
    id: String,
    name: String,
    is_default: bool,
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
    system_audio: Option<bool>,
    microphone: Option<String>,
) -> Result<RecordingStarted, String> {
    let system_audio = system_audio.unwrap_or(false);
    // A device ID from `list_microphones`, or "default" for the system input.
    let microphone = microphone.filter(|id| !id.trim().is_empty());
    if source_kind != "display" && source_kind != "window" {
        return Err("Capture source must be a display or window.".into());
    }

    #[cfg(target_os = "macos")]
    {
        reserve_recording(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            let result =
                start_recording_macos(&app, &source_kind, &source_id, system_audio, microphone.as_deref());
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
        let _ = (app, source_id, system_audio, microphone);
        Err("The first ScreenSway capture prototype currently supports macOS only.".into())
    }
}

#[tauri::command]
async fn list_microphones() -> Result<Vec<Microphone>, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let output = std::process::Command::new(capture_binary()?)
                .arg("--list-microphones")
                .output()
                .map_err(|error| format!("Could not list microphones: {error}"))?;
            parse_helper_output(output, "Microphone discovery")
        })
        .await
        .map_err(|error| format!("Microphone discovery task failed: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(Vec::new())
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

/// ScreenCaptureKit can hang when two processes query shareable content at once,
/// so helper launches that do so are serialized.
#[cfg(target_os = "macos")]
static HELPER_QUERY_LOCK: Mutex<()> = Mutex::new(());

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
    let _query = HELPER_QUERY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
    system_audio: bool,
    microphone: Option<&str>,
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
                hide_hud(app);
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

    let _query = HELPER_QUERY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut command = Command::new(capture_binary()?);
    if system_audio {
        command.arg("--system-audio");
    }
    if let Some(microphone) = microphone {
        command.arg("--microphone").arg(microphone);
    }
    let mut child = command
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
        hide_hud(app);
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
    hide_hud(app);
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

    let (width, height, radius) = match layout {
        HudLayout::Countdown => (220.0, 220.0, 44.0),
        HudLayout::Controls => (292.0, 60.0, 30.0),
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
            .effects(liquid_glass(radius))
            .build()
            .map_err(|error| format!("Could not show the recording controls: {error}"))?,
    };

    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| hud.primary_monitor().ok().flatten());
    let _ = hud.set_size(LogicalSize::new(width, height));
    let _ = hud.set_effects(liquid_glass(radius));
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

/// Native Liquid Glass (`NSGlassEffectView`) on macOS 26+, falling back to the HUD
/// vibrancy material on macOS 15. A dark tint keeps white text legible over any wallpaper.
#[cfg(target_os = "macos")]
fn liquid_glass(radius: f64) -> tauri::utils::config::WindowEffectsConfig {
    use tauri::window::{Color, Effect, EffectState, EffectsBuilder};

    EffectsBuilder::new()
        .effects([Effect::LiquidGlassRegular, Effect::HudWindow])
        .state(EffectState::Active)
        .radius(radius)
        .color(Color(18, 16, 26, 150))
        .build()
}

/// Hides the recording controls instead of closing them. The HUD's own Stop and Cancel
/// requests are still waiting for their replies at this point, and answering a request
/// from a destroyed webview raises an exception inside WebKit that aborts the app.
/// The hidden HUD is reused by the next recording.
#[cfg(target_os = "macos")]
fn hide_hud(app: &tauri::AppHandle) {
    if let Some(hud) = app.get_webview_window(HUD_LABEL) {
        let _ = hud.hide();
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
    app.manage(TrayMenu { pause, stop, show, labels: Mutex::default() });
    Ok(())
}

#[cfg(target_os = "macos")]
struct TrayMenu {
    pause: tauri::menu::MenuItem<tauri::Wry>,
    stop: tauri::menu::MenuItem<tauri::Wry>,
    show: tauri::menu::MenuItem<tauri::Wry>,
    /// Localized menu labels supplied by the UI, keyed by `stop`, `pause`, `resume`, `show`, `tooltip`.
    labels: Mutex<std::collections::HashMap<String, String>>,
}

#[cfg(target_os = "macos")]
impl TrayMenu {
    fn label(&self, key: &str, fallback: &str) -> String {
        self.labels
            .lock()
            .ok()
            .and_then(|labels| labels.get(key).cloned())
            .unwrap_or_else(|| fallback.to_owned())
    }
}

/// Native menu bar items cannot read the web UI's language, so the UI pushes its labels here.
#[tauri::command]
fn set_native_labels(app: tauri::AppHandle, labels: std::collections::HashMap<String, String>) {
    #[cfg(target_os = "macos")]
    {
        let Some(menu) = app.try_state::<TrayMenu>() else { return };
        if let Ok(mut current) = menu.labels.lock() {
            *current = labels;
        }
        let _ = menu.stop.set_text(menu.label("stop", "Stop Recording"));
        let _ = menu.show.set_text(menu.label("show", "Show ScreenSway"));
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let _ = tray.set_tooltip(Some(menu.label("tooltip", "ScreenSway is recording")));
        }
        update_tray(&app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, labels);
}

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
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let label = if state.status == "paused" {
            menu.label("resume", "Resume")
        } else {
            menu.label("pause", "Pause")
        };
        let _ = menu.pause.set_text(label);
    }
}

#[cfg(target_os = "macos")]
fn create_project_path() -> Result<std::path::PathBuf, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let recordings_directory = recordings_directory()?;
    std::fs::create_dir_all(&recordings_directory)
        .map_err(|error| format!("Could not create the ScreenSway recordings directory: {error}"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock error: {error}"))?
        .as_secs();
    Ok(recordings_directory.join(format!("Recording-{timestamp}.screensway")))
}

fn recordings_directory() -> Result<std::path::PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("Could not locate the user home directory.")?;
    Ok(std::path::PathBuf::from(home).join("Movies").join("ScreenSway"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectManifest {
    title: String,
    created_at: String,
    duration_ms: u64,
    canvas: ProjectCanvas,
    media: ProjectMedia,
    pointer_events: String,
}

#[derive(Deserialize)]
struct ProjectCanvas {
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
struct ProjectMedia {
    screen: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingEntry {
    project_path: String,
    video_path: String,
    thumbnail_path: Option<String>,
    title: String,
    created_at: String,
    duration_ms: u64,
    width: u32,
    height: u32,
}

/// Resolves a project path and refuses anything outside the recordings directory.
fn resolve_project(project_path: &str) -> Result<std::path::PathBuf, String> {
    let root = recordings_directory()?
        .canonicalize()
        .map_err(|_| "The recordings folder does not exist yet.".to_string())?;
    let project = std::path::Path::new(project_path)
        .canonicalize()
        .map_err(|_| "This recording no longer exists.".to_string())?;
    if project.parent() != Some(root.as_path()) {
        return Err("This recording is outside the ScreenSway library.".into());
    }
    Ok(project)
}

fn read_manifest(project: &std::path::Path) -> Result<ProjectManifest, String> {
    let data = std::fs::read(project.join("project.json"))
        .map_err(|error| format!("Could not read the project file: {error}"))?;
    serde_json::from_slice(&data).map_err(|error| format!("The project file is damaged: {error}"))
}

#[tauri::command]
async fn list_recordings() -> Result<Vec<RecordingEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = recordings_directory()?;
        let Ok(entries) = std::fs::read_dir(&root) else { return Ok(Vec::new()) };
        let mut recordings: Vec<RecordingEntry> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "screensway"))
            .filter_map(|project| {
                let manifest = read_manifest(&project).ok()?;
                let video = project.join(&manifest.media.screen);
                let thumbnail = project.join("media").join("thumbnail.jpg");
                video.is_file().then(|| RecordingEntry {
                    project_path: project.to_string_lossy().into_owned(),
                    video_path: video.to_string_lossy().into_owned(),
                    thumbnail_path: thumbnail
                        .is_file()
                        .then(|| thumbnail.to_string_lossy().into_owned()),
                    title: manifest.title,
                    created_at: manifest.created_at,
                    duration_ms: manifest.duration_ms,
                    width: manifest.canvas.width,
                    height: manifest.canvas.height,
                })
            })
            .collect();
        recordings.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(recordings)
    })
    .await
    .map_err(|error| format!("Library task failed: {error}"))?
}

#[tauri::command]
async fn load_recording(project_path: String) -> Result<CaptureSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = resolve_project(&project_path)?;
        let manifest = read_manifest(&project)?;
        let pointer_events_path = project.join(&manifest.pointer_events);
        let pointer_events = std::fs::read(&pointer_events_path)
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        Ok(CaptureSummary {
            project_path: project.to_string_lossy().into_owned(),
            video_path: project.join(&manifest.media.screen).to_string_lossy().into_owned(),
            pointer_events_path: pointer_events_path.to_string_lossy().into_owned(),
            duration_ms: manifest.duration_ms,
            width: manifest.canvas.width,
            height: manifest.canvas.height,
            pointer_events,
        })
    })
    .await
    .map_err(|error| format!("Library task failed: {error}"))?
}

/// The running export, so it can be cancelled.
#[derive(Default)]
struct ExportManager {
    child: Arc<Mutex<Option<std::process::Child>>>,
    output: Arc<Mutex<Option<std::path::PathBuf>>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    output_path: String,
    duration_ms: u64,
    width: u32,
    height: u32,
}

const EXPORT_PROGRESS_EVENT: &str = "export-progress";
const EXPORT_PROGRESS_PREFIX: &str = "SCREENSWAY_PROGRESS ";

fn exports_directory() -> Result<std::path::PathBuf, String> {
    Ok(recordings_directory()?.join("Exports"))
}

/// Accepts only files inside the ScreenSway folder, so the UI cannot open arbitrary paths.
fn resolve_library_file(path: &str) -> Result<std::path::PathBuf, String> {
    let root = recordings_directory()?
        .canonicalize()
        .map_err(|_| "The ScreenSway folder does not exist yet.".to_string())?;
    let file = std::path::Path::new(path)
        .canonicalize()
        .map_err(|_| "This file no longer exists.".to_string())?;
    if !file.starts_with(&root) {
        return Err("This file is outside the ScreenSway folder.".into());
    }
    Ok(file)
}

fn decode_png(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let encoded = data.split_once(',').map_or(data, |(_, rest)| rest);
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("The export image is invalid: {error}"))
}

/// Picks "<name>.mp4", or "<name> 2.mp4" and so on when the name is taken.
fn unique_export_path(directory: &std::path::Path, name: &str) -> std::path::PathBuf {
    let cleaned: String = name
        .chars()
        .map(|character| if matches!(character, '/' | ':' | '\\' | '\0') { '-' } else { character })
        .collect();
    let base = if cleaned.trim().is_empty() { "ScreenSway".to_string() } else { cleaned.trim().to_string() };
    let mut candidate = directory.join(format!("{base}.mp4"));
    let mut counter = 2;
    while candidate.exists() {
        candidate = directory.join(format!("{base} {counter}.mp4"));
        counter += 1;
    }
    candidate
}

/// Renders a recording with its zoom, cursor and frame into Movies/ScreenSway/Exports.
/// `job` is the per-frame plan from @screensway/core; the PNGs are data URLs drawn by the UI.
#[tauri::command]
async fn export_recording(
    app: tauri::AppHandle,
    project_path: String,
    file_name: String,
    job: serde_json::Value,
    base_layer: String,
    cursor: String,
) -> Result<ExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        export_recording_blocking(&app, &project_path, &file_name, job, &base_layer, &cursor)
    })
    .await
    .map_err(|error| format!("Export task failed: {error}"))?
}

fn export_recording_blocking(
    app: &tauri::AppHandle,
    project_path: &str,
    file_name: &str,
    mut job: serde_json::Value,
    base_layer: &str,
    cursor: &str,
) -> Result<ExportResult, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, project_path, file_name, &mut job, base_layer, cursor);
        return Err("Export currently supports macOS only.".into());
    }

    #[cfg(target_os = "macos")]
    {
        use std::io::{BufRead, Read};
        use std::process::{Command, Stdio};

        let manager = app.state::<ExportManager>();
        if manager.child.lock().map(|child| child.is_some()).unwrap_or(true) {
            return Err("An export is already running.".into());
        }

        let project = resolve_project(project_path)?;
        let manifest = read_manifest(&project)?;
        let exports = exports_directory()?;
        std::fs::create_dir_all(&exports)
            .map_err(|error| format!("Could not create the Exports folder: {error}"))?;
        let output = unique_export_path(&exports, file_name);

        let work = project.join(".export");
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).map_err(|error| format!("Could not prepare the export: {error}"))?;
        let base_path = work.join("base.png");
        let cursor_path = work.join("cursor.png");
        std::fs::write(&base_path, decode_png(base_layer)?)
            .map_err(|error| format!("Could not prepare the export: {error}"))?;
        std::fs::write(&cursor_path, decode_png(cursor)?)
            .map_err(|error| format!("Could not prepare the export: {error}"))?;

        let fields = job.as_object_mut().ok_or("The export plan is invalid.")?;
        let path = |path: &std::path::Path| serde_json::Value::String(path.to_string_lossy().into_owned());
        fields.insert("source".into(), path(&project.join(&manifest.media.screen)));
        fields.insert("output".into(), path(&output));
        fields.insert("baseLayer".into(), path(&base_path));
        fields.insert("cursor".into(), path(&cursor_path));
        let job_path = work.join("job.json");
        std::fs::write(&job_path, serde_json::to_vec(&job).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Could not prepare the export: {error}"))?;

        let mut child = Command::new(capture_binary()?)
            .arg("--export")
            .arg(&job_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not start the exporter: {error}"))?;
        let stderr = child.stderr.take().ok_or("Could not read the exporter output.")?;
        let mut stdout = child.stdout.take().ok_or("Could not read the exporter output.")?;
        if let Ok(mut current) = manager.output.lock() {
            *current = Some(output.clone());
        }
        if let Ok(mut current) = manager.child.lock() {
            *current = Some(child);
        }

        let progress_app = app.clone();
        let errors = std::thread::spawn(move || {
            let mut message = String::new();
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                match line.strip_prefix(EXPORT_PROGRESS_PREFIX).and_then(|value| value.trim().parse::<u32>().ok()) {
                    Some(percent) => {
                        let _ = progress_app.emit(EXPORT_PROGRESS_EVENT, percent);
                    }
                    None => {
                        message.push_str(&line);
                        message.push('\n');
                    }
                }
            }
            message
        });

        let mut result_json = Vec::new();
        let _ = stdout.read_to_end(&mut result_json);
        let child = manager.child.lock().ok().and_then(|mut child| child.take());
        let cancelled = child.is_none();
        let status = child.map(|mut child| child.wait());
        let message = errors.join().unwrap_or_default();
        let _ = std::fs::remove_dir_all(&work);
        if let Ok(mut current) = manager.output.lock() {
            *current = None;
        }

        match status {
            Some(Ok(status)) if status.success() => serde_json::from_slice(&result_json)
                .map_err(|error| format!("Could not read the export result: {error}")),
            _ => {
                let _ = std::fs::remove_file(&output);
                let _ = std::fs::remove_file(output.with_extension("video.mp4"));
                Err(if cancelled {
                    "Export cancelled.".into()
                } else if message.trim().is_empty() {
                    "The export stopped unexpectedly.".into()
                } else {
                    message.trim().to_string()
                })
            }
        }
    }
}

/// The recording's thumbnail as a data URL, for sampling colors in the UI without
/// tainting a canvas with a cross-origin image.
#[tauri::command]
fn read_thumbnail(project_path: String) -> Result<Option<String>, String> {
    use base64::Engine;
    let project = resolve_project(&project_path)?;
    let thumbnail = project.join("media").join("thumbnail.jpg");
    if !thumbnail.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(thumbnail).map_err(|error| format!("Could not read the thumbnail: {error}"))?;
    Ok(Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )))
}

#[tauri::command]
fn cancel_export(state: tauri::State<'_, ExportManager>) {
    if let Some(mut child) = state.child.lock().ok().and_then(|mut child| child.take()) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Opens an exported video in the default player, or reveals it in Finder.
#[tauri::command]
fn open_export(path: String, reveal: bool) -> Result<(), String> {
    let file = resolve_library_file(&path)?;
    let mut command = std::process::Command::new("open");
    if reveal {
        command.arg("-R");
    }
    command
        .arg(file)
        .spawn()
        .map_err(|error| format!("Could not open the video: {error}"))?;
    Ok(())
}

#[tauri::command]
fn open_screen_recording_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn()
        .map_err(|error| format!("Could not open System Settings: {error}"))?;
    Ok(())
}

#[tauri::command]
fn open_microphone_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        .spawn()
        .map_err(|error| format!("Could not open System Settings: {error}"))?;
    Ok(())
}

#[tauri::command]
fn reveal_recording(project_path: String) -> Result<(), String> {
    let project = resolve_project(&project_path)?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("-R")
        .arg(project)
        .spawn()
        .map_err(|error| format!("Could not open Finder: {error}"))?;
    #[cfg(not(target_os = "macos"))]
    let _ = project;
    Ok(())
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
        .manage(ExportManager::default())
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
            list_microphones,
            start_recording,
            cancel_countdown,
            set_recording_paused,
            stop_recording,
            set_native_labels,
            list_recordings,
            load_recording,
            reveal_recording,
            open_screen_recording_settings,
            open_microphone_settings,
            export_recording,
            cancel_export,
            open_export,
            read_thumbnail
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_png_data_urls_and_plain_base64() {
        assert_eq!(decode_png("data:image/png;base64,aGk=").unwrap(), b"hi");
        assert_eq!(decode_png("aGk=").unwrap(), b"hi");
        assert!(decode_png("data:image/png;base64,***").is_err());
    }

    #[test]
    fn export_names_are_sanitized_and_never_overwrite() {
        let directory = std::env::temp_dir().join(format!("screensway-export-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();

        let first = unique_export_path(&directory, "Demo: take/1");
        assert_eq!(first.file_name().unwrap(), "Demo- take-1.mp4");
        std::fs::write(&first, b"").unwrap();
        assert_eq!(unique_export_path(&directory, "Demo: take/1").file_name().unwrap(), "Demo- take-1 2.mp4");
        assert_eq!(unique_export_path(&directory, "   ").file_name().unwrap(), "ScreenSway.mp4");

        std::fs::remove_dir_all(&directory).unwrap();
    }
}
