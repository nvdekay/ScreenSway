mod telemetry;

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(capture)]
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

#[cfg(capture)]
struct ActiveRecording {
    child: std::process::Child,
    stdout_reader: std::thread::JoinHandle<Vec<u8>>,
    stderr_log: Arc<Mutex<String>>,
    control_path: std::path::PathBuf,
    project_path: std::path::PathBuf,
    started_at: Instant,
    paused_total: Duration,
    paused_at: Option<Instant>,
}

#[cfg(capture)]
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
    #[cfg(capture)]
    active: Arc<Mutex<Option<ActiveRecording>>>,
    #[cfg(capture)]
    cancel_countdown: Arc<AtomicBool>,
}

const RECORDING_STATE_EVENT: &str = "recording-state";
const RECORDING_FINISHED_EVENT: &str = "recording-finished";
const RECORDING_FAILED_EVENT: &str = "recording-failed";
#[cfg(capture)]
const HUD_LABEL: &str = "hud";
#[cfg(capture)]
const TRAY_ID: &str = "recording";
#[cfg(capture)]
const COUNTDOWN_SECONDS: u8 = 3;
#[cfg(capture)]
const HELPER_READY_LINE: &str = "SCREENSWAY_READY";

fn publish_state(app: &tauri::AppHandle, state: RecordingState) {
    if let Ok(mut current) = app.state::<CaptureManager>().state.lock() {
        *current = state.clone();
    }
    let _ = app.emit(RECORDING_STATE_EVENT, state);
}

#[tauri::command]
fn get_recording_state(state: tauri::State<'_, CaptureManager>) -> RecordingState {
    #[cfg(capture)]
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
    #[cfg(capture)]
    {
        tauri::async_runtime::spawn_blocking(list_capture_sources_blocking)
            .await
            .map_err(|error| format!("Source discovery task failed: {error}"))?
    }

    #[cfg(not(capture))]
    {
        Err("Capture source discovery is not supported on this platform.".into())
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

    #[cfg(capture)]
    {
        reserve_recording(&app)?;
        tauri::async_runtime::spawn_blocking(move || {
            let result =
                start_recording_blocking(&app, &source_kind, &source_id, system_audio, microphone.as_deref());
            if result.is_err() {
                hide_hud(&app);
                publish_state(&app, RecordingState { status: "idle", ..Default::default() });
                restore_main_window(&app);
            }
            result
        })
        .await
        .map_err(|error| format!("Capture start task failed: {error}"))?
    }

    #[cfg(not(capture))]
    {
        let _ = (app, source_id, system_audio, microphone);
        Err("The first ScreenSway capture prototype is not supported on this platform.".into())
    }
}

#[tauri::command]
async fn list_microphones() -> Result<Vec<Microphone>, String> {
    #[cfg(capture)]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let output = helper_command()?
                .arg("--list-microphones")
                .output()
                .map_err(|error| format!("Could not list microphones: {error}"))?;
            parse_helper_output(output, "Microphone discovery")
        })
        .await
        .map_err(|error| format!("Microphone discovery task failed: {error}"))?
    }

    #[cfg(not(capture))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
fn cancel_countdown(state: tauri::State<'_, CaptureManager>) {
    #[cfg(capture)]
    state.cancel_countdown.store(true, Ordering::SeqCst);
    #[cfg(not(capture))]
    let _ = state;
}

#[tauri::command]
async fn stop_recording(app: tauri::AppHandle) -> Result<CaptureSummary, String> {
    #[cfg(capture)]
    {
        tauri::async_runtime::spawn_blocking(move || stop_recording_blocking(&app))
            .await
            .map_err(|error| format!("Capture stop task failed: {error}"))?
    }

    #[cfg(not(capture))]
    {
        let _ = app;
        Err("The first ScreenSway capture prototype is not supported on this platform.".into())
    }
}

#[tauri::command]
async fn set_recording_paused(app: tauri::AppHandle, paused: bool) -> Result<(), String> {
    #[cfg(capture)]
    {
        tauri::async_runtime::spawn_blocking(move || set_recording_paused_blocking(&app, paused))
            .await
            .map_err(|error| format!("Capture control task failed: {error}"))?
    }

    #[cfg(not(capture))]
    {
        let _ = (app, paused);
        Err("Pause and resume are not supported on this platform.".into())
    }
}

/// ScreenCaptureKit can hang when two processes query shareable content at once,
/// so helper launches that do so are serialized. Windows keeps the same order.
#[cfg(capture)]
static HELPER_QUERY_LOCK: Mutex<()> = Mutex::new(());

#[cfg(capture)]
fn capture_binary() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "macos")]
    const HELPER: &str = "screensway-capture";
    #[cfg(target_os = "windows")]
    const HELPER: &str = "screensway-capture.exe";
    #[cfg(target_os = "macos")]
    const DEVELOPMENT_BINARY: &str = "../../../native/macos-capture/.build/debug/screensway-capture";
    #[cfg(target_os = "windows")]
    const DEVELOPMENT_BINARY: &str = "../../../native/windows-capture/target/release/screensway-capture.exe";

    let bundled_binary = std::env::current_exe()
        .map_err(|error| format!("Could not locate the ScreenSway executable: {error}"))?
        .with_file_name(HELPER);
    if bundled_binary.is_file() {
        return Ok(bundled_binary);
    }

    let development_binary = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(DEVELOPMENT_BINARY);
    if development_binary.is_file() {
        return Ok(development_binary);
    }

    Err("The capture helper is missing. Rebuild it with `node scripts/build-native.mjs`.".into())
}

/// A helper process. On Windows it is a console program, so keep it from flashing a console window.
#[cfg(capture)]
fn helper_command() -> Result<std::process::Command, String> {
    #[allow(unused_mut)]
    let mut command = std::process::Command::new(capture_binary()?);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(command)
}

#[cfg(capture)]
fn list_capture_sources_blocking() -> Result<Vec<CaptureSource>, String> {
    let _query = HELPER_QUERY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let output = helper_command()?
        .arg("--list-sources")
        .output()
        .map_err(|error| format!("Could not discover capture sources: {error}"))?;
    parse_helper_output(output, "Capture source discovery")
}

#[cfg(capture)]
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

#[cfg(capture)]
fn start_recording_blocking(
    app: &tauri::AppHandle,
    source_kind: &str,
    source_id: &str,
    system_audio: bool,
    microphone: Option<&str>,
) -> Result<RecordingStarted, String> {
    use std::io::{BufRead, Read};
    use std::process::Stdio;

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
    let mut command = helper_command()?;
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

    // Auto-finished recordings can contain a pointer log larger than a pipe buffer.
    // Drain it immediately, otherwise the helper cannot exit and the monitor cannot save it.
    let mut stdout = child.stdout.take().ok_or("Could not read the capture helper output.")?;
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });

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
        let message = finish_helper(child, &stderr_log, stdout_reader)
            .err()
            .unwrap_or_else(|| "Screen recording did not start in time.".into());
        let _ = std::fs::remove_dir_all(&project_path);
        hide_hud(app);
        return Err(message);
    }

    let recording = ActiveRecording {
        child,
        stdout_reader,
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

#[cfg(capture)]
fn set_recording_paused_blocking(app: &tauri::AppHandle, paused: bool) -> Result<(), String> {
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

#[cfg(capture)]
fn stop_recording_blocking(app: &tauri::AppHandle) -> Result<CaptureSummary, String> {
    let manager = app.state::<CaptureManager>();
    let mut recording = manager
        .active
        .lock()
        .map_err(|_| "The capture state lock is unavailable.".to_string())?
        .take()
        .ok_or("There is no active recording to stop.")?;

    let elapsed_ms = recording.elapsed().as_millis() as u64;
    publish_state(app, RecordingState { status: "finishing", countdown: None, elapsed_ms });
    update_tray(app);

    let stop_error = std::fs::write(&recording.control_path, "stop").err();
    if stop_error.is_some() { let _ = recording.child.kill(); }
    let finished = finish_helper(recording.child, &recording.stderr_log, recording.stdout_reader);
    let result = match stop_error {
        Some(error) => Err(format!("Could not send the stop command: {error}")),
        None => finished,
    };
    let _ = std::fs::remove_file(&recording.control_path);
    if let Ok(summary) = &result {
        debug_assert_eq!(summary.project_path, recording.project_path.to_string_lossy());
    }
    finish_session(app, &result);
    result
}

/// Detects a helper that dies mid-recording and keeps the menu bar timer ticking.
#[cfg(capture)]
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
                // Closing the captured window is a normal, successfully saved recording.
                let result = finish_helper(recording.child, &recording.stderr_log, recording.stdout_reader);
                finish_session(&app, &result);
                return;
            }
            None => update_tray(&app),
        }
    });
}

#[cfg(capture)]
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

#[cfg(capture)]
fn finish_helper(
    mut child: std::process::Child,
    stderr_log: &Arc<Mutex<String>>,
    stdout_reader: std::thread::JoinHandle<Vec<u8>>,
) -> Result<CaptureSummary, String> {
    let stdout = stdout_reader.join().unwrap_or_default();
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

#[cfg(capture)]
enum HudLayout {
    Countdown,
    Controls,
}

#[cfg(capture)]
fn show_hud(app: &tauri::AppHandle, layout: HudLayout) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize, WebviewUrl, WebviewWindowBuilder};

    let (width, height, radius) = match layout {
        HudLayout::Countdown => (220.0, 220.0, 44.0),
        HudLayout::Controls => (292.0, 60.0, 30.0),
    };

    let hud = match app.get_webview_window(HUD_LABEL) {
        Some(window) => window,
        None => {
            let builder = WebviewWindowBuilder::new(app, HUD_LABEL, WebviewUrl::App("index.html#hud".into()))
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
                .content_protected(true);
            #[cfg(target_os = "macos")]
            let builder = builder.effects(liquid_glass(radius));
            builder
                .build()
                .map_err(|error| format!("Could not show the recording controls: {error}"))?
        }
    };

    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| hud.primary_monitor().ok().flatten());
    let _ = hud.set_size(LogicalSize::new(width, height));
    #[cfg(target_os = "macos")]
    let _ = hud.set_effects(liquid_glass(radius));
    #[cfg(not(target_os = "macos"))]
    let _ = radius;
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
#[cfg(capture)]
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

#[cfg(capture)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop Recording", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show ScreenSway", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&stop, &pause, &separator, &show])?;

    let builder = TrayIconBuilder::with_id(TRAY_ID);
    // The macOS menu bar shows only the timer text; the Windows notification area needs an icon.
    #[cfg(target_os = "windows")]
    let builder = match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone()),
        None => builder,
    };
    let tray = builder
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("ScreenSway is recording")
        .on_menu_event(move |app, event| {
            let app = app.clone();
            match event.id().as_ref() {
                "stop" => {
                    std::thread::spawn(move || {
                        let _ = stop_recording_blocking(&app);
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
                        let _ = set_recording_paused_blocking(&app, !paused);
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

#[cfg(capture)]
struct TrayMenu {
    pause: tauri::menu::MenuItem<tauri::Wry>,
    stop: tauri::menu::MenuItem<tauri::Wry>,
    show: tauri::menu::MenuItem<tauri::Wry>,
    /// Localized menu labels supplied by the UI, keyed by `stop`, `pause`, `resume`, `show`, `tooltip`.
    labels: Mutex<std::collections::HashMap<String, String>>,
}

#[cfg(capture)]
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
    #[cfg(capture)]
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
    #[cfg(not(capture))]
    let _ = (app, labels);
}

/// Shows a live timer in the menu bar while recording, so the state is visible from any app.
#[cfg(capture)]
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
    #[cfg(target_os = "macos")]
    let _ = tray.set_title(Some(format!(" {marker} {}:{:02}", seconds / 60, seconds % 60)));
    #[cfg(target_os = "windows")]
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let tooltip = menu.label("tooltip", "ScreenSway is recording");
        let _ = tray.set_tooltip(Some(format!("{marker} {}:{:02} · {tooltip}", seconds / 60, seconds % 60)));
    }
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

#[cfg(capture)]
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

/// Movies/ScreenSway on macOS, Videos\ScreenSway on Windows (wherever the Videos folder was moved).
fn recordings_directory() -> Result<std::path::PathBuf, String> {
    let videos = dirs::video_dir().ok_or("Could not locate the Videos folder.")?;
    Ok(videos.join("ScreenSway"))
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

/// Resolves a file named by project.json. The name must be a plain relative path, and the
/// file it reaches (after symlinks) must be a regular file inside the project, so a
/// tampered manifest cannot point the helpers at files elsewhere on the disk.
fn project_member(project: &std::path::Path, relative: &str) -> Result<std::path::PathBuf, String> {
    let name = std::path::Path::new(relative);
    let plain = !relative.is_empty()
        && name.components().all(|component| matches!(component, std::path::Component::Normal(_)));
    if !plain {
        return Err("The project file refers to a file outside the recording.".into());
    }
    let root = project
        .canonicalize()
        .map_err(|_| "This recording no longer exists.".to_string())?;
    let file = project.join(name);
    let target = file
        .canonicalize()
        .map_err(|_| "A file of this recording is missing.".to_string())?;
    if !target.starts_with(&root) || !target.is_file() {
        return Err("The project file refers to a file outside the recording.".into());
    }
    // The path keeps the form the caller gave (no \\?\ prefix on Windows) for the UI.
    Ok(file)
}

fn read_manifest(project: &std::path::Path) -> Result<ProjectManifest, String> {
    let data = std::fs::read(project.join("project.json"))
        .map_err(|error| format!("Could not read the project file: {error}"))?;
    serde_json::from_slice(&data).map_err(|error| format!("The project file is damaged: {error}"))
}

fn replace_file(temporary: &std::path::Path, destination: &std::path::Path) -> std::io::Result<()> {
    #[cfg(not(target_os = "windows"))]
    return std::fs::rename(temporary, destination);

    #[cfg(target_os = "windows")]
    {
        // Windows does not replace an existing destination with rename. Keep the old
        // file beside it until the new one is in place, so a failed update is recoverable.
        if !destination.exists() {
            return std::fs::rename(temporary, destination);
        }
        let backup = destination.with_extension("json.bak");
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(destination, &backup)?;
        match std::fs::rename(temporary, destination) {
            Ok(()) => {
                let _ = std::fs::remove_file(backup);
                Ok(())
            }
            Err(error) => {
                let _ = std::fs::rename(backup, destination);
                Err(error)
            }
        }
    }
}

fn rename_recording_in(project: &std::path::Path, title: &str) -> Result<String, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("The recording name cannot be empty.".into());
    }
    if title.chars().count() > 120 || title.chars().any(char::is_control) {
        return Err("The recording name must be 120 characters or fewer.".into());
    }

    let manifest_path = project.join("project.json");
    let data = std::fs::read(&manifest_path)
        .map_err(|error| format!("Could not read the project file: {error}"))?;
    let mut manifest: serde_json::Value = serde_json::from_slice(&data)
        .map_err(|error| format!("The project file is damaged: {error}"))?;
    let fields = manifest.as_object_mut().ok_or("The project file is damaged.")?;
    fields.insert("title".into(), serde_json::Value::String(title.into()));
    let temporary = project.join("project.json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Could not rename the recording: {error}"))?;
    replace_file(&temporary, &manifest_path)
        .map_err(|error| format!("Could not rename the recording: {error}"))?;
    Ok(title.into())
}

#[tauri::command]
fn rename_recording(project_path: String, title: String) -> Result<String, String> {
    rename_recording_in(&resolve_project(&project_path)?, &title)
}

#[tauri::command]
async fn delete_recording(project_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = resolve_project(&project_path)?;
        std::fs::remove_dir_all(project).map_err(|error| format!("Could not delete the recording: {error}"))
    })
    .await
    .map_err(|error| format!("Library task failed: {error}"))?
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
                let video = project_member(&project, &manifest.media.screen).ok()?;
                let thumbnail = project.join("media").join("thumbnail.jpg");
                Some(RecordingEntry {
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
        let video_path = project_member(&project, &manifest.media.screen)?;
        // Pointer data is optional: a recording without it plays without auto zooms.
        let pointer_events_path = project_member(&project, &manifest.pointer_events);
        let pointer_events = pointer_events_path
            .as_ref()
            .ok()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        let pointer_events_path = pointer_events_path.unwrap_or_else(|_| project.join("metadata").join("pointer-events.json"));
        Ok(CaptureSummary {
            project_path: project.to_string_lossy().into_owned(),
            video_path: video_path.to_string_lossy().into_owned(),
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

const EDITS_FILE: &str = "edits.json";
const CAPTIONS_FILE: &str = "captions.json";
const TRANSCRIPT_FILE: &str = "transcript.json";

/// Trim and zoom edits made in the studio, or null when the recording is untouched.
#[tauri::command]
fn load_edits(project_path: String) -> Result<Option<serde_json::Value>, String> {
    let project = resolve_project(&project_path)?;
    Ok(read_edits(&project))
}

#[tauri::command]
fn save_edits(project_path: String, edits: serde_json::Value) -> Result<(), String> {
    let project = resolve_project(&project_path)?;
    write_edits(&project, &edits)
}

fn read_edits(project: &std::path::Path) -> Option<serde_json::Value> {
    read_project_json(project, EDITS_FILE)
}

fn write_edits(project: &std::path::Path, edits: &serde_json::Value) -> Result<(), String> {
    write_project_json(project, EDITS_FILE, edits)
}

/// A JSON object stored in the project, or None when it is missing or damaged.
fn read_project_json(project: &std::path::Path, name: &str) -> Option<serde_json::Value> {
    let data = std::fs::read(project.join(name)).ok()?;
    serde_json::from_slice::<serde_json::Value>(&data).ok().filter(serde_json::Value::is_object)
}

fn write_project_json(project: &std::path::Path, name: &str, value: &serde_json::Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("The data to save is invalid.".into());
    }
    let data = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    // Write next to the file and rename, so a crash never leaves half a file behind.
    let temporary = project.join(format!("{name}.tmp"));
    std::fs::write(&temporary, data).map_err(|error| format!("Could not save {name}: {error}"))?;
    replace_file(&temporary, &project.join(name)).map_err(|error| format!("Could not save {name}: {error}"))
}

/// Captions edited in the studio, or null before any were made.
#[tauri::command]
fn load_captions(project_path: String) -> Result<Option<serde_json::Value>, String> {
    Ok(read_project_json(&resolve_project(&project_path)?, CAPTIONS_FILE))
}

#[tauri::command]
fn save_captions(project_path: String, captions: serde_json::Value) -> Result<(), String> {
    write_project_json(&resolve_project(&project_path)?, CAPTIONS_FILE, &captions)
}

/// The running transcription, so it can be cancelled.
#[derive(Default)]
struct TranscriptionManager {
    child: Arc<Mutex<Option<std::process::Child>>>,
    busy: AtomicBool,
    cancelled: AtomicBool,
}

/// Hold the reservation through preparation, process exit and file cleanup.
/// A child slot alone leaves races before spawn and immediately after cancellation.
struct OperationReservation<'a>(&'a AtomicBool);

impl Drop for OperationReservation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn reserve_operation<'a>(busy: &'a AtomicBool, cancelled: &AtomicBool, message: &str) -> Result<OperationReservation<'a>, String> {
    busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).map_err(|_| message.to_string())?;
    cancelled.store(false, Ordering::SeqCst);
    Ok(OperationReservation(busy))
}

const TRANSCRIBE_PROGRESS_EVENT: &str = "transcribe-progress";

/// Recognizes the speech in a recording on this Mac and returns its timed words.
#[tauri::command]
async fn transcribe_recording(app: tauri::AppHandle, project_path: String, locale: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || transcribe_blocking(&app, &project_path, &locale))
        .await
        .map_err(|error| format!("Caption task failed: {error}"))?
}

fn transcribe_blocking(app: &tauri::AppHandle, project_path: &str, locale: &str) -> Result<serde_json::Value, String> {
    #[cfg(not(capture))]
    {
        let _ = (app, project_path, locale);
        return Err("Captions currently support macOS only.".into());
    }

    #[cfg(capture)]
    {
        use std::io::{BufRead, Read};
        use std::process::Stdio;

        if !locale.chars().all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_') {
            return Err("The caption language is invalid.".into());
        }
        let manager = app.state::<TranscriptionManager>();
        let _operation = {
            let _child = manager.child.lock().map_err(|_| "The recognizer state is unavailable.")?;
            reserve_operation(&manager.busy, &manager.cancelled, "Captions are already being created.")?
        };
        let project = resolve_project(project_path)?;
        let manifest = read_manifest(&project)?;
        let mut child = helper_command()?
            .arg("--transcribe")
            .arg(project_member(&project, &manifest.media.screen)?)
            .arg("--locale")
            .arg(locale)
            .arg("--output")
            .arg(project.join(TRANSCRIPT_FILE))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Could not start speech recognition: {error}"))?;
        let stderr = child.stderr.take().ok_or("Could not read the recognizer output.")?;
        let mut stdout = child.stdout.take().ok_or("Could not read the recognizer output.")?;
        if let Ok(mut current) = manager.child.lock() {
            if manager.cancelled.load(Ordering::SeqCst) { let _ = child.kill(); }
            *current = Some(child);
        }

        let progress_app = app.clone();
        let errors = std::thread::spawn(move || {
            let mut message = String::new();
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                match line.strip_prefix(EXPORT_PROGRESS_PREFIX).and_then(|value| value.trim().parse::<u32>().ok()) {
                    Some(percent) => {
                        let _ = progress_app.emit(TRANSCRIBE_PROGRESS_EVENT, percent);
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
        let cancelled = manager.cancelled.load(Ordering::SeqCst);
        let status = child.map(|mut child| child.wait());
        let message = errors.join().unwrap_or_default();

        match status {
            Some(Ok(status)) if status.success() && !cancelled => serde_json::from_slice(&result_json)
                .map_err(|error| format!("Could not read the captions: {error}")),
            _ => Err(if cancelled {
                "Captions cancelled.".into()
            } else if message.trim().is_empty() {
                "Speech recognition stopped unexpectedly.".into()
            } else {
                message.trim().to_string()
            }),
        }
    }
}

#[tauri::command]
fn cancel_transcription(state: tauri::State<'_, TranscriptionManager>) {
    if let Ok(mut current) = state.child.lock() {
        state.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = current.as_mut() { let _ = child.kill(); }
    }
}

#[tauri::command]
fn open_speech_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition")
        .spawn()
        .map_err(|error| format!("Could not open System Settings: {error}"))?;
    Ok(())
}

/// The running export, so it can be cancelled.
#[derive(Default)]
struct ExportManager {
    child: Arc<Mutex<Option<std::process::Child>>>,
    output: Arc<Mutex<Option<std::path::PathBuf>>>,
    busy: AtomicBool,
    cancelled: AtomicBool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    output_path: String,
    duration_ms: u64,
    width: u32,
    height: u32,
    /// The .srt written next to the video when it has captions.
    #[serde(default)]
    subtitles_path: Option<String>,
}

/// A caption rendered by the UI, timed on the exported video.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptionImage {
    start_ms: f64,
    end_ms: f64,
    image: String,
    x: f64,
    y: f64,
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
        .take(120)
        .map(|character| if character.is_control() || matches!(character, '/' | ':' | '\\' | '<' | '>' | '"' | '|' | '?' | '*') { '-' } else { character })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']);
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    let base = if cleaned.is_empty() { "ScreenSway".to_string() } else if reserved { format!("ScreenSway-{cleaned}") } else { cleaned.to_string() };
    let mut candidate = directory.join(format!("{base}.mp4"));
    let mut counter = 2;
    while candidate.exists() || candidate.with_extension("srt").exists() {
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
    captions: Option<Vec<CaptionImage>>,
    subtitles: Option<String>,
) -> Result<ExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let captions = captions.unwrap_or_default();
        export_recording_blocking(&app, &project_path, &file_name, job, &base_layer, &cursor, &captions, subtitles.as_deref())
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
    captions: &[CaptionImage],
    subtitles: Option<&str>,
) -> Result<ExportResult, String> {
    #[cfg(not(capture))]
    {
        let _ = (app, project_path, file_name, &mut job, base_layer, cursor, captions, subtitles);
        return Err("Export is not supported on this platform.".into());
    }

    #[cfg(capture)]
    {
        use std::io::{BufRead, Read};
        use std::process::Stdio;

        let manager = app.state::<ExportManager>();
        let _operation = {
            let _child = manager.child.lock().map_err(|_| "The exporter state is unavailable.")?;
            reserve_operation(&manager.busy, &manager.cancelled, "An export is already running.")?
        };

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
        fields.insert("source".into(), path(&project_member(&project, &manifest.media.screen)?));
        fields.insert("output".into(), path(&output));
        fields.insert("baseLayer".into(), path(&base_path));
        fields.insert("cursor".into(), path(&cursor_path));
        let mut caption_jobs = Vec::with_capacity(captions.len());
        for (index, caption) in captions.iter().enumerate() {
            let image_path = work.join(format!("caption-{index}.png"));
            std::fs::write(&image_path, decode_png(&caption.image)?)
                .map_err(|error| format!("Could not prepare the export: {error}"))?;
            caption_jobs.push(serde_json::json!({
                "startMs": caption.start_ms,
                "endMs": caption.end_ms,
                "image": image_path.to_string_lossy(),
                "x": caption.x,
                "y": caption.y,
            }));
        }
        fields.insert("captions".into(), serde_json::Value::Array(caption_jobs));
        let job_path = work.join("job.json");
        std::fs::write(&job_path, serde_json::to_vec(&job).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Could not prepare the export: {error}"))?;

        let mut child = helper_command()?
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
            if manager.cancelled.load(Ordering::SeqCst) { let _ = child.kill(); }
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
        let cancelled = manager.cancelled.load(Ordering::SeqCst);
        let status = child.map(|mut child| child.wait());
        let message = errors.join().unwrap_or_default();
        let _ = std::fs::remove_dir_all(&work);
        if let Ok(mut current) = manager.output.lock() {
            *current = None;
        }

        match status {
            Some(Ok(status)) if status.success() && !cancelled => {
                let mut result: ExportResult = serde_json::from_slice(&result_json)
                    .map_err(|error| format!("Could not read the export result: {error}"))?;
                if let Some(subtitles) = subtitles.filter(|text| !text.trim().is_empty()) {
                    let subtitles_path = output.with_extension("srt");
                    if std::fs::write(&subtitles_path, subtitles).is_ok() {
                        result.subtitles_path = Some(subtitles_path.to_string_lossy().into_owned());
                    }
                }
                Ok(result)
            }
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

fn backgrounds_directory() -> Result<std::path::PathBuf, String> {
    Ok(recordings_directory()?.join("Backgrounds"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundImage {
    path: String,
    thumbnail: String,
}

/// Splits a data URL into its file extension and bytes; only common image types are accepted.
fn decode_image_data_url(data: &str) -> Result<(&'static str, Vec<u8>), String> {
    let (header, _) = data.split_once(',').ok_or("The image is invalid.")?;
    let extension = match header.trim_start_matches("data:").split(';').next() {
        Some("image/png") => "png",
        Some("image/jpeg") => "jpg",
        Some("image/webp") => "webp",
        Some("image/heic") => "heic",
        Some("image/gif") => "gif",
        _ => return Err("Only PNG, JPEG, WebP, HEIC and GIF images can be used.".into()),
    };
    Ok((extension, decode_png(data)?))
}

/// A stable name from the content, so choosing the same image twice keeps one copy.
fn content_name(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn data_url(path: &std::path::Path) -> Result<String, String> {
    use base64::Engine;
    let mime = match path.extension().and_then(|extension| extension.to_str()) {
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("heic") => "image/heic",
        Some("gif") => "image/gif",
        _ => return Err("This is not a background image.".into()),
    };
    let bytes = std::fs::read(path).map_err(|error| format!("Could not read the image: {error}"))?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Accepts only files directly inside the Backgrounds folder.
fn resolve_background(path: &str) -> Result<std::path::PathBuf, String> {
    let root = backgrounds_directory()?
        .canonicalize()
        .map_err(|_| "No background images are saved yet.".to_string())?;
    let file = std::path::Path::new(path)
        .canonicalize()
        .map_err(|_| "This background image no longer exists.".to_string())?;
    if file.parent() != Some(root.as_path()) {
        return Err("This image is outside the ScreenSway backgrounds folder.".into());
    }
    Ok(file)
}

fn save_background_image_in(
    directory: &std::path::Path,
    image: &str,
    thumbnail: &str,
) -> Result<std::path::PathBuf, String> {
    let (extension, bytes) = decode_image_data_url(image)?;
    let (_, thumbnail_bytes) = decode_image_data_url(thumbnail)?;
    std::fs::create_dir_all(directory).map_err(|error| format!("Could not save the image: {error}"))?;
    let name = content_name(&bytes);
    let path = directory.join(format!("{name}.{extension}"));
    if path.is_file() {
        // Choosing it again moves it to the front of the recent list.
        if let Ok(file) = std::fs::File::options().append(true).open(&path) {
            let _ = file.set_modified(std::time::SystemTime::now());
        }
    } else {
        std::fs::write(&path, &bytes).map_err(|error| format!("Could not save the image: {error}"))?;
    }
    std::fs::write(directory.join(format!("{name}.thumb.jpg")), thumbnail_bytes)
        .map_err(|error| format!("Could not save the image: {error}"))?;
    Ok(path)
}

fn list_background_images_in(directory: &std::path::Path) -> Vec<BackgroundImage> {
    let Ok(entries) = std::fs::read_dir(directory) else { return Vec::new() };
    let mut images: Vec<(std::time::SystemTime, std::path::PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| !path.to_string_lossy().ends_with(".thumb.jpg"))
        .filter_map(|path| Some((path.metadata().ok()?.modified().ok()?, path)))
        .collect();
    images.sort_by(|a, b| b.0.cmp(&a.0));
    images
        .into_iter()
        .filter_map(|(_, path)| {
            let stem = path.file_stem()?.to_string_lossy().into_owned();
            let thumbnail = data_url(&directory.join(format!("{stem}.thumb.jpg"))).ok()?;
            Some(BackgroundImage { path: path.to_string_lossy().into_owned(), thumbnail })
        })
        .take(12)
        .collect()
}

/// Keeps a copy of an uploaded background (plus a small preview) in Movies/ScreenSway/Backgrounds,
/// so styles that use it still work after a restart.
#[tauri::command]
fn save_background_image(image: String, thumbnail: String) -> Result<String, String> {
    let path = save_background_image_in(&backgrounds_directory()?, &image, &thumbnail)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn list_background_images() -> Result<Vec<BackgroundImage>, String> {
    Ok(list_background_images_in(&backgrounds_directory()?))
}

/// A saved background as a data URL, so it can be painted into the export without tainting the canvas.
#[tauri::command]
fn read_background_image(path: String) -> Result<String, String> {
    data_url(&resolve_background(&path)?)
}

#[tauri::command]
fn delete_background_image(path: String) -> Result<(), String> {
    let file = resolve_background(&path)?;
    if let Some(stem) = file.file_stem() {
        let _ = std::fs::remove_file(file.with_file_name(format!("{}.thumb.jpg", stem.to_string_lossy())));
    }
    std::fs::remove_file(&file).map_err(|error| format!("Could not delete the image: {error}"))
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
    if let Ok(mut current) = state.child.lock() {
        state.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = current.as_mut() { let _ = child.kill(); }
    }
}

/// Opens an exported video in the default player, or reveals it in Finder / File Explorer.
#[tauri::command]
fn open_export(path: String, reveal: bool) -> Result<(), String> {
    let file = resolve_library_file(&path)?;
    // Only exported videos and their subtitles are opened, never anything else in the library.
    let exported = file
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4") || extension.eq_ignore_ascii_case("srt"));
    if !exported {
        return Err("Only exported videos can be opened.".into());
    }
    if reveal {
        reveal_in_file_manager(&file)
    } else {
        open_with_default_app(&file)
    }
    .map_err(|error| format!("Could not open the video: {error}"))
}

fn open_with_default_app(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(not(target_os = "windows"))]
    let program = "open";
    std::process::Command::new(program).arg(path).spawn().map(drop)
}

fn reveal_in_file_manager(path: &std::path::Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Explorer parses `/select,` itself and does not accept the whole argument quoted.
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
            .map(drop)
    }
    #[cfg(not(target_os = "windows"))]
    std::process::Command::new("open").arg("-R").arg(path).spawn().map(drop)
}

/// True while a recording, export or caption job runs. Installing an update quits the
/// app, so the updater waits until this work has finished or been cancelled.
#[tauri::command]
fn background_work_active(
    capture: tauri::State<'_, CaptureManager>,
    export: tauri::State<'_, ExportManager>,
    transcription: tauri::State<'_, TranscriptionManager>,
) -> bool {
    let recording = capture.state.lock().map(|state| state.status != "idle").unwrap_or(true);
    recording || export.busy.load(Ordering::SeqCst) || transcription.busy.load(Ordering::SeqCst)
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
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer.exe")
        .arg("ms-settings:privacy-microphone")
        .spawn()
        .map_err(|error| format!("Could not open microphone settings: {error}"))?;
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
    reveal_in_file_manager(&project).map_err(|error| format!("Could not show the recording: {error}"))
}

#[cfg(capture)]
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ExportManager::default())
        .manage(TranscriptionManager::default())
        .manage(telemetry::Telemetry::default())
        .manage(CaptureManager {
            state: Arc::new(Mutex::new(RecordingState { status: "idle", ..Default::default() })),
            ..Default::default()
        })
        .setup(|app| {
            #[cfg(capture)]
            setup_tray(app)?;
            if let Ok(directory) = app.path().app_config_dir() {
                app.state::<telemetry::Telemetry>().init(directory);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "windows")]
            if window.label() == "main" {
                let app = window.app_handle();
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let capture = app.state::<CaptureManager>();
                    let recording = capture.state.lock().map(|state| state.status != "idle").unwrap_or(true);
                    // Keep the recording controls available until the user stops
                    // or cancels. Destroying main here would lose the saved preview.
                    if recording {
                        api.prevent_close();
                        return;
                    }
                    for manager in [app.state::<ExportManager>().child.clone(), app.state::<TranscriptionManager>().child.clone()] {
                        if let Ok(mut current) = manager.lock() {
                            if let Some(child) = current.as_mut() { let _ = child.kill(); }
                        }
                    }
                }
                if let tauri::WindowEvent::Destroyed = event {
                    // A reused hidden HUD otherwise keeps Windows running forever
                    // after the last visible window has been closed.
                    if let Some(hud) = app.get_webview_window(HUD_LABEL) { let _ = hud.close(); }
                    app.exit(0);
                }
            }
            #[cfg(not(target_os = "windows"))]
            let _ = (window, event);
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
            rename_recording,
            delete_recording,
            reveal_recording,
            open_screen_recording_settings,
            background_work_active,
            open_microphone_settings,
            export_recording,
            cancel_export,
            open_export,
            read_thumbnail,
            load_edits,
            save_edits,
            load_captions,
            save_captions,
            transcribe_recording,
            cancel_transcription,
            open_speech_settings,
            save_background_image,
            list_background_images,
            read_background_image,
            delete_background_image,
            telemetry::telemetry_status,
            telemetry::set_telemetry,
            telemetry::track_event
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
    fn edits_round_trip_and_ignore_damaged_files() {
        let project = std::env::temp_dir().join(format!("screensway-edits-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(&project).unwrap();

        assert_eq!(read_edits(&project), None);
        let edits = serde_json::json!({ "trimStartMs": 1200, "trimEndMs": null, "zooms": [] });
        write_edits(&project, &edits).unwrap();
        assert_eq!(read_edits(&project), Some(edits));
        assert!(!project.join("edits.json.tmp").exists());
        assert!(write_edits(&project, &serde_json::json!([1, 2])).is_err());
        let captions = serde_json::json!({ "locale": "vi-VN", "enabled": true, "lines": [] });
        write_project_json(&project, CAPTIONS_FILE, &captions).unwrap();
        assert_eq!(read_project_json(&project, CAPTIONS_FILE), Some(captions));

        std::fs::write(project.join(EDITS_FILE), b"{ broken").unwrap();
        assert_eq!(read_edits(&project), None);
        std::fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn manifest_files_must_stay_inside_the_project() {
        let base = std::env::temp_dir().join(format!("screensway-member-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let project = base.join("Recording-1.screensway");
        std::fs::create_dir_all(project.join("media")).unwrap();
        std::fs::write(project.join("media/screen.mp4"), b"video").unwrap();
        std::fs::write(base.join("private.mp4"), b"secret").unwrap();

        assert_eq!(project_member(&project, "media/screen.mp4").unwrap(), project.join("media/screen.mp4"));
        for name in ["", "../private.mp4", "media/../../private.mp4", "media", "media/missing.mp4"] {
            assert!(project_member(&project, name).is_err(), "{name:?} was accepted");
        }
        let absolute = base.join("private.mp4");
        assert!(project_member(&project, absolute.to_str().unwrap()).is_err());
        #[cfg(windows)]
        for name in [r"C:\Windows\win.ini", r"C:private.mp4", r"\\server\share\file.mp4", r"\private.mp4"] {
            assert!(project_member(&project, name).is_err(), "{name:?} was accepted");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("private.mp4"), project.join("media/link.mp4")).unwrap();
            assert!(project_member(&project, "media/link.mp4").is_err());
            std::os::unix::fs::symlink(&base, project.join("media/outside")).unwrap();
            assert!(project_member(&project, "media/outside/private.mp4").is_err());
        }
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn recording_titles_are_validated_and_saved_without_losing_manifest_fields() {
        let project = std::env::temp_dir().join(format!("screensway-rename-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&project);
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("project.json"), br#"{
          "schemaVersion": 1,
          "title": "Old title",
          "createdAt": "2026-01-01T00:00:00Z",
          "durationMs": 1000,
          "canvas": { "width": 1920, "height": 1080 },
          "media": { "screen": "media/screen.mp4" },
          "pointerEvents": "metadata/pointer-events.json",
          "futureField": { "keep": true }
        }"#).unwrap();

        assert_eq!(rename_recording_in(&project, "  Product demo  ").unwrap(), "Product demo");
        let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(project.join("project.json")).unwrap()).unwrap();
        assert_eq!(saved["title"], "Product demo");
        assert_eq!(saved["futureField"]["keep"], true);
        assert!(rename_recording_in(&project, "   ").is_err());
        assert!(rename_recording_in(&project, &"x".repeat(121)).is_err());
        assert!(rename_recording_in(&project, "bad\nname").is_err());
        assert!(!project.join("project.json.tmp").exists());

        std::fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn background_images_are_saved_once_and_listed_newest_first() {
        let directory = std::env::temp_dir().join(format!("screensway-backgrounds-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let thumbnail = "data:image/jpeg;base64,/9j/";

        let first = save_background_image_in(&directory, "data:image/png;base64,aGk=", thumbnail).unwrap();
        assert_eq!(first.extension().unwrap(), "png");
        assert_eq!(std::fs::read(&first).unwrap(), b"hi");
        // The same image again reuses the existing copy.
        assert_eq!(save_background_image_in(&directory, "data:image/png;base64,aGk=", thumbnail).unwrap(), first);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let second = save_background_image_in(&directory, "data:image/jpeg;base64,b2s=", thumbnail).unwrap();
        assert_eq!(second.extension().unwrap(), "jpg");

        let listed = list_background_images_in(&directory);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].path, second.to_string_lossy());
        assert_eq!(listed[1].path, first.to_string_lossy());
        assert!(listed[0].thumbnail.starts_with("data:image/jpeg;base64,"));
        std::thread::sleep(std::time::Duration::from_millis(20));
        save_background_image_in(&directory, "data:image/png;base64,aGk=", thumbnail).unwrap();
        assert_eq!(list_background_images_in(&directory)[0].path, first.to_string_lossy());

        assert!(save_background_image_in(&directory, "data:text/html;base64,aGk=", thumbnail).is_err());
        assert!(save_background_image_in(&directory, "not a data url", thumbnail).is_err());
        std::fs::remove_dir_all(&directory).unwrap();
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
        assert_eq!(unique_export_path(&directory, "CON").file_name().unwrap(), "ScreenSway-CON.mp4");
        assert_eq!(unique_export_path(&directory, "nul.demo").file_name().unwrap(), "ScreenSway-nul.demo.mp4");
        assert_eq!(unique_export_path(&directory, "demo?. ").file_name().unwrap(), "demo-.mp4");
        assert_eq!(unique_export_path(&directory, "...").file_name().unwrap(), "ScreenSway.mp4");
        let subtitles = directory.join("Captions.srt");
        std::fs::write(subtitles, b"keep me").unwrap();
        assert_eq!(unique_export_path(&directory, "Captions").file_name().unwrap(), "Captions 2.mp4");

        std::fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn operation_stays_reserved_until_cleanup_and_recovers_after_failure() {
        let busy = AtomicBool::new(false);
        let cancelled = AtomicBool::new(false);
        let first = reserve_operation(&busy, &cancelled, "busy").unwrap();
        cancelled.store(true, Ordering::SeqCst);
        assert!(reserve_operation(&busy, &cancelled, "busy").is_err());
        assert!(cancelled.load(Ordering::SeqCst), "a rejected retry must not erase cancellation");
        drop(first);
        let second = reserve_operation(&busy, &cancelled, "busy").unwrap();
        assert!(!cancelled.load(Ordering::SeqCst));
        drop(second);
        assert!(!busy.load(Ordering::SeqCst));
    }
}
