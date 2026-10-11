//! A recording session: frames from Windows.Graphics.Capture, the pointer from polling, and
//! the control file written by the desktop shell. Mirrors `ScreenSwayCapture.run()` on macOS.

use super::capture::{texture_size, Converter, Gpu, CAPTURE_FORMAT};
use super::encoder::Encoder;
use super::sources::{self, size};
use super::{now, thumbnail, ParentWatch, Step};
use crate::argument;
use crate::model::{encoded_size, iso8601, Canvas, CaptureStats, CaptureSummary, Media, ProjectManifest};
use crate::timeline::{PointerLog, VideoTimeline, TICKS_PER_SECOND};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows::core::{Interface, Ref};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Direct3D11::{ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE};
use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetSystemMetrics, SM_SWAPBUTTON};

/// Where in the recording the library thumbnail is taken, like on macOS.
const THUMBNAIL_TIME: i64 = TICKS_PER_SECOND / 2;
const DEFAULT_DURATION_SECONDS: f64 = 14_400.0;
/// Three buffers let Windows deliver the next frame while one is being encoded.
const POOL_BUFFERS: i32 = 3;

type Error = Box<dyn std::error::Error>;

/// Everything the frame callback touches, behind one lock.
struct Frames {
    gpu: Arc<Gpu>,
    timeline: VideoTimeline,
    converter: Converter,
    encoder: Option<Encoder>,
    /// A copy of the newest frame, kept to start the video, refresh it on resume and hold
    /// it until the stop: frames only arrive when the screen changes.
    latest: Option<(ID3D11Texture2D, (u32, u32))>,
    thumbnail: Option<(ID3D11Texture2D, (u32, u32))>,
    pool_size: SizeInt32,
    failure: Option<String>,
    stats: CaptureStats,
    frame_time_total_ms: f64,
}

impl Frames {
    fn receive(&mut self, pool: &Direct3D11CaptureFramePool, frame: Direct3D11CaptureFrame) -> windows::core::Result<()> {
        let started = Instant::now();
        let result = self.receive_frame(pool, frame);
        let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
        self.stats.frames_received += 1;
        self.frame_time_total_ms += elapsed_ms;
        self.stats.slowest_frame_ms = self.stats.slowest_frame_ms.max(elapsed_ms);
        if elapsed_ms > 1_000.0 / 60.0 {
            self.stats.slow_frames += 1;
        }
        result
    }

    fn receive_frame(&mut self, pool: &Direct3D11CaptureFramePool, frame: Direct3D11CaptureFrame) -> windows::core::Result<()> {
        let time = frame.SystemRelativeTime()?.Duration;
        let content = frame.ContentSize()?;
        let surface: ID3D11Texture2D = unsafe { frame.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>()?.GetInterface()? };
        let buffer_size = texture_size(&surface);
        let copy = match self.latest.take() {
            Some((texture, _)) if texture_size(&texture) == buffer_size => texture,
            _ => self.gpu.texture(
                buffer_size.0,
                buffer_size.1,
                CAPTURE_FORMAT,
                D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE,
            )?,
        };
        unsafe { self.gpu.context.CopyResource(&copy, &surface) };
        let visible = (
            (content.Width.max(1) as u32).min(buffer_size.0),
            (content.Height.max(1) as u32).min(buffer_size.1),
        );
        self.latest = Some((copy, visible));
        frame.Close()?;

        // A resized window keeps sending frames of the old size until the pool follows it.
        if content.Width != self.pool_size.Width || content.Height != self.pool_size.Height {
            pool.Recreate(&self.gpu.capture_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, POOL_BUFFERS, content)?;
            self.pool_size = content;
        }

        if let Some(media_time) = self.timeline.frame(time) {
            self.encode_latest(media_time);
        }
        Ok(())
    }

    fn encode_latest(&mut self, media_time: i64) {
        let (Some((texture, content)), Some(encoder)) = (&self.latest, self.encoder.as_mut()) else { return };
        let result = self
            .converter
            .convert(&self.gpu, texture, *content)
            .step("Converting a frame to NV12")
            .and_then(|converted| encoder.write(&converted, media_time).step("Encoding a frame"));
        if let Err(message) = result {
            // For example a full disk; the main loop stops the recording.
            self.failure.get_or_insert(message);
            return;
        }
        self.stats.frames_written += 1;
        if self.thumbnail.is_none() && media_time >= THUMBNAIL_TIME {
            self.thumbnail = self.snapshot();
        }
    }

    fn snapshot(&self) -> Option<(ID3D11Texture2D, (u32, u32))> {
        let (texture, content) = self.latest.as_ref()?;
        let (width, height) = texture_size(texture);
        let copy = self.gpu.texture(width, height, CAPTURE_FORMAT, D3D11_BIND_SHADER_RESOURCE).ok()?;
        unsafe { self.gpu.context.CopyResource(&copy, texture) };
        Some((copy, *content))
    }
}

/// What is being recorded and where it sits on the screen.
struct Target {
    item: GraphicsCaptureItem,
    /// Top-left in physical screen pixels, for the pointer log.
    origin: (f64, f64),
    size: (u32, u32),
}

fn target(arguments: &[String]) -> Result<Target, Error> {
    let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
        .step("Opening Windows.Graphics.Capture")?;
    let source_id = argument(arguments, "--source-id");
    if argument(arguments, "--source-kind") == Some("window") {
        let handle = source_id.and_then(|id| id.parse::<usize>().ok()).ok_or("The window to record is invalid.")?;
        let window = sources::window(HWND(handle as *mut _)).ok_or("The window to record is no longer open.")?;
        let item = unsafe { interop.CreateForWindow(window.hwnd) }.step("Starting capture of the window")?;
        return Ok(Target {
            item,
            origin: (f64::from(window.bounds.left), f64::from(window.bounds.top)),
            size: size(&window.bounds),
        });
    }
    let display = sources::find_display(source_id)?.ok_or("ScreenSway could not find the main display.")?;
    let item = unsafe { interop.CreateForMonitor(display.monitor) }.step("Starting capture of the display")?;
    Ok(Target {
        item,
        origin: (f64::from(display.bounds.left), f64::from(display.bounds.top)),
        size: size(&display.bounds),
    })
}

pub fn run(arguments: &[String]) -> Result<CaptureSummary, Error> {
    if !GraphicsCaptureSession::IsSupported().step("Checking for Windows.Graphics.Capture")? {
        return Err("Screen capture needs Windows 10 version 1903 or newer.".into());
    }
    let project = PathBuf::from(argument(arguments, "--output").ok_or("Missing --output directory.")?);
    let control = argument(arguments, "--control").map(PathBuf::from);
    let duration = argument(arguments, "--duration")
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(DEFAULT_DURATION_SECONDS);
    let media = project.join("media");
    let metadata = project.join("metadata");
    let video_path = media.join("screen.mp4");
    let pointer_events_path = metadata.join("pointer-events.json");
    std::fs::create_dir_all(&media)?;
    std::fs::create_dir_all(&metadata)?;

    let target = target(arguments)?;
    // Physical pixels already are the native density; only very large captures are scaled.
    let item_size = target.item.Size().step("Reading the capture size")?;
    let source_size = if item_size.Width > 0 && item_size.Height > 0 {
        (item_size.Width as u32, item_size.Height as u32)
    } else {
        target.size
    };
    let (width, height, encoder_scale) = encoded_size(source_size.0, source_size.1);

    let gpu = Arc::new(Gpu::new()?);
    let encoder = Encoder::new(&video_path, &gpu, width, height)?;
    let encoder_name = encoder.name.clone();
    let frames = Arc::new(Mutex::new(Frames {
        gpu: gpu.clone(),
        timeline: VideoTimeline::default(),
        converter: Converter::new(&gpu, source_size, (width, height))?,
        encoder: Some(encoder),
        latest: None,
        thumbnail: None,
        pool_size: item_size,
        failure: None,
        stats: CaptureStats {
            encoder: encoder_name,
            source_width: source_size.0,
            source_height: source_size.1,
            width,
            height,
            ..Default::default()
        },
        frame_time_total_ms: 0.0,
    }));

    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &gpu.capture_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        POOL_BUFFERS,
        item_size,
    )
    .step("Creating the capture frame pool")?;
    let session = pool.CreateCaptureSession(&target.item).step("Creating the capture session")?;
    // The pointer is drawn later from the log, so it can be smoothed and scaled.
    let _ = session.SetIsCursorCaptureEnabled(false);
    // Windows 11 draws a yellow border around captured content unless told otherwise.
    let _ = session.SetIsBorderRequired(false);

    let frame_handler = {
        let frames = frames.clone();
        TypedEventHandler::new(move |pool: Ref<Direct3D11CaptureFramePool>, _| {
            let Some(pool) = pool.as_ref() else { return Ok(()) };
            let Ok(frame) = pool.TryGetNextFrame() else { return Ok(()) };
            let Ok(mut frames) = frames.lock() else { return Ok(()) };
            if let Err(error) = frames.receive(pool, frame) {
                let message = format!("Receiving a frame failed: {} (0x{:08X})", error.message(), error.code().0 as u32);
                frames.failure.get_or_insert(message);
            }
            Ok(())
        })
    };
    pool.FrameArrived(&frame_handler).step("Listening for frames")?;
    // A recorded window was closed, or a display was disconnected.
    let closed = Arc::new(AtomicBool::new(false));
    {
        let closed = closed.clone();
        target.item.Closed(&TypedEventHandler::new(move |_, _| {
            closed.store(true, Ordering::SeqCst);
            Ok(())
        }))
        .step("Listening for the capture to end")?;
    }

    let created_at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs());
    let started = Instant::now();
    session.StartCapture().step("Starting the capture")?;
    // The first frame usually arrives within a few milliseconds; give the capture a moment so
    // the video does not start black.
    let wait_until = Instant::now() + Duration::from_millis(500);
    while Instant::now() < wait_until && frames.lock().map_or(true, |frames| frames.latest.is_none()) {
        std::thread::sleep(Duration::from_millis(5));
    }

    let recording_start = now();
    {
        let mut frames = frames.lock().map_err(|_| "The capture state is unavailable.")?;
        let has_frame = frames.latest.is_some();
        if let Some(time) = frames.timeline.start(recording_start, has_frame) {
            frames.encode_latest(time);
        }
    }
    let pointer = Arc::new(Mutex::new(PointerLog::new(recording_start, target.origin, encoder_scale)));
    let pointer_running = Arc::new(AtomicBool::new(true));
    let pointer_thread = {
        let pointer = pointer.clone();
        let running = pointer_running.clone();
        std::thread::spawn(move || poll_pointer(&pointer, &running))
    };
    // Tells the desktop shell that frames are being recorded, so its timer starts in sync.
    eprintln!("SCREENSWAY_READY");

    let parent = ParentWatch::new();
    let mut paused = false;
    let mut failure = None;
    while started.elapsed().as_secs_f64() < duration {
        if closed.load(Ordering::SeqCst) {
            eprintln!("Capture stopped by Windows: the recorded window or display went away.");
            break;
        }
        if let Some(message) = frames.lock().ok().and_then(|frames| frames.failure.clone()) {
            failure = Some(message);
            break;
        }
        // If ScreenSway itself quits, finish the file instead of recording on unattended.
        if parent.has_exited() {
            break;
        }
        if let Some(command) = control.as_deref().and_then(read_command) {
            match command.as_str() {
                "stop" => break,
                "pause" if !paused => {
                    set_paused(&frames, &pointer, true);
                    paused = true;
                }
                "recording" if paused => {
                    set_paused(&frames, &pointer, false);
                    paused = false;
                }
                _ => {}
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let recording_end = now();
    if let Ok(mut pointer) = pointer.lock() {
        pointer.stop(recording_end);
    }
    pointer_running.store(false, Ordering::SeqCst);
    let _ = session.Close();
    let _ = pool.Close();
    let _ = pointer_thread.join();

    let (encoder, has_frames, thumbnail, mut stats) = {
        let mut frames = frames.lock().map_err(|_| "The capture state is unavailable.")?;
        let (end, closing) = frames.timeline.finish(recording_end);
        if let Some(time) = closing {
            frames.encode_latest(time);
        }
        let thumbnail = frames.thumbnail.take().or_else(|| frames.latest.take());
        let mut stats = std::mem::take(&mut frames.stats);
        if stats.frames_received > 0 {
            stats.average_frame_ms = frames.frame_time_total_ms / stats.frames_received as f64;
        }
        (frames.encoder.take().map(|encoder| (encoder, end)), frames.timeline.has_frames(), thumbnail, stats)
    };
    if let Some((encoder, end)) = encoder {
        encoder.finish(end).step("Finishing the video file")?;
    }
    if let Some(message) = failure {
        return Err(message.into());
    }
    if !has_frames || !video_path.is_file() {
        return Err("Screen recording finished without creating a video file.".into());
    }
    // The library shows this instead of decoding the full video for every card.
    if let Some((texture, content)) = thumbnail {
        let _ = thumbnail::write(&gpu, &texture, content, &media.join("thumbnail.jpg"));
    }

    let (duration_ms, pointer_events) = {
        let pointer = pointer.lock().map_err(|_| "The pointer log is unavailable.")?;
        (pointer.duration_ms(recording_end), pointer.samples().to_vec())
    };
    std::fs::write(&pointer_events_path, serde_json::to_vec_pretty(&pointer_events)?)?;
    stats.duration_ms = duration_ms;
    let _ = std::fs::write(metadata.join("capture-stats.json"), serde_json::to_vec_pretty(&stats)?);
    let manifest = ProjectManifest {
        schema_version: 1,
        title: project.file_stem().map_or_else(String::new, |stem| stem.to_string_lossy().into_owned()),
        created_at: iso8601(created_at),
        duration_ms,
        canvas: Canvas { width, height },
        media: Media { screen: "media/screen.mp4".into() },
        pointer_events: "metadata/pointer-events.json".into(),
    };
    write_atomically(&project.join("project.json"), &serde_json::to_vec_pretty(&manifest)?)?;

    Ok(CaptureSummary {
        project_path: path_string(&project),
        video_path: path_string(&video_path),
        pointer_events_path: path_string(&pointer_events_path),
        duration_ms,
        width,
        height,
        pointer_events,
    })
}

fn set_paused(frames: &Mutex<Frames>, pointer: &Mutex<PointerLog>, paused: bool) {
    let time = now();
    if let Ok(mut pointer) = pointer.lock() {
        pointer.set_paused(paused, time);
    }
    if let Ok(mut frames) = frames.lock() {
        if let Some(media_time) = frames.timeline.set_paused(paused, time) {
            frames.encode_latest(media_time);
        }
    }
}

/// Polls the pointer every few milliseconds; clicks last far longer than that.
fn poll_pointer(pointer: &Mutex<PointerLog>, running: &AtomicBool) {
    unsafe { timeBeginPeriod(1) };
    while running.load(Ordering::SeqCst) {
        let mut point = POINT::default();
        if unsafe { GetCursorPos(&mut point) }.is_ok() {
            let pressed = |key: u16| unsafe { GetAsyncKeyState(i32::from(key)) } as u16 & 0x8000 != 0;
            // GetAsyncKeyState reports physical buttons; follow the "swap buttons" setting.
            let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
            let (primary, secondary) = if swapped { (VK_RBUTTON, VK_LBUTTON) } else { (VK_LBUTTON, VK_RBUTTON) };
            let left = pressed(primary.0);
            let right = pressed(secondary.0);
            if let Ok(mut pointer) = pointer.lock() {
                pointer.observe(now(), (f64::from(point.x), f64::from(point.y)), left, right);
            }
        }
        std::thread::sleep(Duration::from_millis(4));
    }
    unsafe { timeEndPeriod(1) };
}

fn read_command(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|text| text.trim().to_owned())
}

fn write_atomically(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, data)?;
    std::fs::rename(&temporary, path)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
