# Architecture

## Layers

```text
Platform capture -> project bundle -> camera engine -> studio preview -> native export
```

- `apps/desktop` is the Tauri 2 shell (Rust, `src-tauri/src/lib.rs`) and the React studio UI (`src/`).
- `packages/core` holds the portable logic shared by preview and export: pointer/zoom types, zoom segment generation, the spring camera track, the frame model, and the per-frame render plan.
- `native/macos-capture` is a Swift command-line sidecar: ScreenCaptureKit capture (`ScreenSwayCapture.swift`) and the GPU exporter (`Exporter.swift`).
- `native/windows-capture` is the Windows sidecar in Rust with the same command line (see "Capture (Windows)").
- `apps/web` is the independent marketing site (GitHub Pages). It imports `@screensway/core` for its live demo.

## Project bundle

```text
~/Movies/ScreenSway/
  Recording-<unix time>.screensway/
    project.json                  manifest: title, createdAt, durationMs, canvas (video pixels)
    media/screen.mp4              H.264 High video, plus one AAC track when system audio and/or the microphone was on
    media/thumbnail.jpg           written by the helper for the library
    metadata/pointer-events.json  pointer moves and clicks in video pixels, ms on the video timeline
    edits.json                    trim and zoom edits from the studio (absent until something is edited)
    transcript.json               timed words from speech recognition
    captions.json                 caption lines as edited in the studio, their language and whether they are shown
  Exports/
    ScreenSway <date time>.mp4    rendered videos
  Backgrounds/
    <content hash>.<ext>          background images chosen in the studio, plus <hash>.thumb.jpg
```

The pointer is stored as metadata instead of being burned into the video, so the cursor can be smoothed, scaled and given click effects at preview and export time.

## Capture (macOS)

- The helper is driven by the shell through a project-local control file containing `recording`, `pause` or `stop`. It prints `SCREENSWAY_READY` on stderr once frames are flowing, and a JSON summary on stdout when done.
- `SCStream` delivers 420v frames at native pixel density (Retina = 2x points; the long side is capped at 3840 px for H.264). `VideoWriter` encodes them with `AVAssetWriter`: H.264 High, BT.709, about 0.15 bits per pixel per frame.
- Timestamps are rebased so the video and the pointer log share one clock. Paused time is cut from video, audio and pointer data alike. The last frame is repeated at the stop time (ScreenCaptureKit only sends frames on change), and the newest frame is shown on resume. Video and pointer timelines agree within about 10 ms.
- `--system-audio` captures system audio (ScreenSway's own audio excluded); `--microphone <id|default>` captures a microphone through ScreenCaptureKit (`--list-microphones` lists devices). `AudioMixer` places both on the video's clock and mixes them into one 48 kHz stereo AAC track, so every player plays it and export can copy it unchanged. The microphone first goes through `VoiceProcessor`: a 90 Hz high-pass, slow leveling toward -20 dBFS (at most +12 dB), a gentle gate that lowers noise between phrases (noise floor = 10th percentile of the last 3 s), and an instant peak limit. A missing permission is reported as `SCREENSWAY_MICROPHONE_DENIED`; the bundle declares `NSMicrophoneUsageDescription` and the `audio-input` entitlement the hardened runtime requires.
- If ScreenCaptureKit ends the stream (a captured window closes, a display disconnects) or ScreenSway itself quits, the helper finishes and saves the file instead of recording on unattended. An encoder failure (for example a full disk) stops the recording with an error.
- `--list-sources` returns displays and windows with their point size and `pixelScale` (2 on Retina). The UI warns when a non-Retina source is selected, since zoomed-in moments look softer.
- ScreenCaptureKit can drop a shareable-content query when two processes ask at once, so queries time out and retry, and the shell serializes helper launches. A missing Screen Recording permission is reported as `SCREENSWAY_SCREEN_RECORDING_DENIED`; the UI then shows how to grant it.
- Starting a recording runs a 3-second countdown, hides the main window, and shows floating Liquid Glass controls plus a menu bar timer. ScreenSway's windows are excluded from the capture and from audio. Clicks on Pause/Stop are dropped from the pointer log. The controls window is hidden, never closed, when a recording ends: its own Stop request is still waiting for a reply, and answering a request from a destroyed webview raises an exception in WebKit. Release builds keep `panic = "unwind"` so wry can catch such exceptions instead of aborting.

## Capture (Windows)

- `native/windows-capture` builds the same `screensway-capture` helper for Windows (`screensway-capture-x86_64-pc-windows-msvc.exe`), driven exactly like the macOS one: control file, `SCREENSWAY_READY`, JSON summary, the same project bundle. The shell code is shared under `cfg(capture)`; only Liquid Glass, System Settings links and the menu bar title stay macOS-only. Recordings live in `Videos\ScreenSway` (`dirs::video_dir()`, `$VIDEO` in the asset scope, which is `~/Movies` on macOS).
- Sources: displays from `EnumDisplayMonitors` (id = device name such as `\\.\DISPLAY1`, primary first) and top-level app windows from `EnumWindows` (visible, not cloaked, not tool windows, not ScreenSway's own; id = window handle). Sizes are logical pixels and `pixelScale` is the Windows scale factor (1.5 at 150 %). The process is per-monitor DPI aware, so cursor, monitor and window coordinates are all physical pixels.
- Frames come from Windows.Graphics.Capture (cursor and the yellow border off). Each frame is copied into a texture the recorder keeps; the D3D11 video processor scales it and converts BGRA to NV12 (BT.709, studio range), and Media Foundation's sink writer encodes H.264 High into MP4 with the GPU encoder when there is one, at the same bitrate as macOS and a keyframe every 2 s. Frames carry their real duration (a frame is written when the next arrives), and the same `VideoTimeline` rules as macOS start the video at zero, cut pauses, refresh the frame on resume and hold the last frame until the stop.
- The pointer is polled every 4 ms (`GetCursorPos`, `GetAsyncKeyState`, honoring swapped buttons) on the same performance-counter clock as the frames; `PointerLog` drops the Pause/Stop click like macOS. The recording ends and is saved when the window or display goes away or ScreenSway quits. The thumbnail is a frame at 0.5 s saved through WIC.
- The recording controls are excluded from capture by `WDA_EXCLUDEFROMCAPTURE` (Tauri's content protection) and paint their own dark background instead of Liquid Glass. The main window keeps the standard Windows title bar.
- Not ported yet: audio (`--list-microphones` returns an empty list and the UI hides the audio switches), `--export` and `--transcribe` (both exit with an error).

## Camera, preview and export

- `generateZoomSegments` turns clicks into zoom segments; `buildCameraTrack` simulates a 60 fps critically damped spring camera with a pan dead zone.
- `FrameSettings` (background, frame style, aspect, padding, radius, shadow, quality) → `computeLayout` gives the output size and the window/video rectangles. Each frame style declares its chrome in video widths (title bar, device bezel, laptop base and its overhang), so window, browser and MacBook frames share one fitting rule; the layout also says how the video's own corners are rounded, which the preview and the exporter both use.
- Backgrounds are data (`solid`, `linear`, `mesh`, `waves`, `image`) painted in code, so presets stay sharp at 4K and add nothing to the download. `BUILT_IN_STYLES` are ready-made looks; saved styles live in the UI's local storage. Image backgrounds reference a copy in `Backgrounds/`, read back as a data URL so the export canvas is never tainted.
- `RecordingEdits` holds the trim and the zooms; `zooms: null` means "follow the clicks" (`generateZoomSegments`), an edited list replaces them. `normalizeZooms` keeps zooms sorted, non-overlapping, at least 400 ms and between 1.2× and 3×; `trimRange` keeps at least 500 ms. The camera is always simulated over the whole recording, so a trimmed export shows exactly what the preview shows at that moment.
- Captions: `screensway-capture --transcribe video --locale vi-VN --output transcript.json` reads the audio as 16 kHz mono, cuts it into 20–40 s chunks at the quietest moments, skips silent chunks and runs `SFSpeechRecognizer` with `requiresOnDeviceRecognition` on each (macOS 26's `SpeechTranscriber` has no Vietnamese). `buildCaptionLines` groups words into phrases at pauses and sentence ends and splits long phrases into balanced lines, preferring commas. `paintCaption` draws a line with the bundled font for both the preview overlay and the export; the exporter composites the active caption image per frame, and an `.srt` (`toSrt`, shifted by `trimCaptions`) is written next to the video. A missing permission is reported as `SCREENSWAY_SPEECH_DENIED`.
- `buildRenderFrames` produces the per-frame plan: source crop, cursor position and size, click ripple. The preview and the export both follow this plan, so they match.
- The background, shadow and title bar are painted by one shared canvas implementation (`packages/core/src/paint.ts`): at screen size for the desktop and landing previews, and at output size for export. The desktop compatibility module in `apps/desktop/src/frame/paint.ts` re-exports it.
- Export: the UI sends the plan plus the painted background and cursor PNGs to `export_recording`. The shell writes them next to the project and runs `screensway-capture --export job.json`. The exporter decodes the recording, composes each frame with Core Image on Metal (edge-extended Lanczos scaling, rounded video mask, cursor, ripple), encodes 60 fps H.264 High, then adds the original audio track without re-encoding. With a trimmed start the job carries `startMs`: the exporter reads from shortly before it and copies the audio from the same moment. Progress is streamed as `export-progress` events.

## Desktop shell commands

Recording: `list_capture_sources`, `list_microphones`, `start_recording` (with `systemAudio` and `microphone`), `set_recording_paused`, `stop_recording`, `cancel_countdown`, `get_recording_state`. Library: `list_recordings`, `load_recording`, `reveal_recording`, `read_thumbnail`, `load_edits`, `save_edits`. Captions: `transcribe_recording` (streams `transcribe-progress`), `cancel_transcription`, `load_captions`, `save_captions`, `open_speech_settings`. Backgrounds: `save_background_image`, `list_background_images`, `read_background_image`, `delete_background_image`. Export: `export_recording`, `cancel_export`, `open_export`. Other: `set_native_labels` (menu bar language), `open_screen_recording_settings`, `open_microphone_settings`. File access is limited to `~/Movies/ScreenSway`.

## Privacy boundary

The desktop application makes no network requests during recording, editing or export. Fonts are bundled. Update checks may be added later as an explicit, documented exception. The marketing site is independent and contains no recording data.

## Distribution

The helper is bundled beside the Tauri executable as a universal sidecar. Release builds use LTO, size optimization and stripped symbols; the DMG is recompressed with LZMA (`pnpm build:macos`). Builds are ad-hoc signed but not notarized, so first launch needs "Open Anyway"; the landing page, DMG background and release notes explain it. See [releasing.md](releasing.md).
