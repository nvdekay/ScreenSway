# Architecture

## Layers

```text
Platform capture -> project bundle -> camera engine -> studio preview -> native export
```

- `apps/desktop` is the Tauri 2 shell (Rust, `src-tauri/src/lib.rs`) and the React studio UI (`src/`).
- `packages/core` holds the portable logic shared by preview and export: pointer/zoom types, zoom segment generation, the spring camera track, the frame model, and the per-frame render plan.
- `native/macos-capture` is a Swift command-line sidecar: ScreenCaptureKit capture (`ScreenSwayCapture.swift`) and the GPU exporter (`Exporter.swift`).
- `apps/web` is the independent marketing site (GitHub Pages). It imports `@screensway/core` for its live demo.
- Windows capture will use Windows.Graphics.Capture; it is not implemented.

## Project bundle

```text
~/Movies/ScreenSway/
  Recording-<unix time>.screensway/
    project.json                  manifest: title, createdAt, durationMs, canvas (video pixels)
    media/screen.mp4              H.264 High video, plus an AAC track when system audio was on
    media/thumbnail.jpg           written by the helper for the library
    metadata/pointer-events.json  pointer moves and clicks in video pixels, ms on the video timeline
  Exports/
    ScreenSway <date time>.mp4    rendered videos
```

The pointer is stored as metadata instead of being burned into the video, so the cursor can be smoothed, scaled and given click effects at preview and export time.

## Capture (macOS)

- The helper is driven by the shell through a project-local control file containing `recording`, `pause` or `stop`. It prints `SCREENSWAY_READY` on stderr once frames are flowing, and a JSON summary on stdout when done.
- `SCStream` delivers 420v frames at native pixel density (Retina = 2x points; the long side is capped at 3840 px for H.264). `VideoWriter` encodes them with `AVAssetWriter`: H.264 High, BT.709, about 0.15 bits per pixel per frame.
- Timestamps are rebased so the video and the pointer log share one clock. Paused time is cut from video, audio and pointer data alike. The last frame is repeated at the stop time (ScreenCaptureKit only sends frames on change), and the newest frame is shown on resume. Video and pointer timelines agree within about 10 ms.
- `--system-audio` adds a 48 kHz stereo AAC track (ScreenSway's own audio excluded) on the same clock.
- If ScreenCaptureKit ends the stream (a captured window closes, a display disconnects) or ScreenSway itself quits, the helper finishes and saves the file instead of recording on unattended. An encoder failure (for example a full disk) stops the recording with an error.
- `--list-sources` returns displays and windows with their point size and `pixelScale` (2 on Retina). The UI warns when a non-Retina source is selected, since zoomed-in moments look softer.
- ScreenCaptureKit can drop a shareable-content query when two processes ask at once, so queries time out and retry, and the shell serializes helper launches. A missing Screen Recording permission is reported as `SCREENSWAY_SCREEN_RECORDING_DENIED`; the UI then shows how to grant it.
- Starting a recording runs a 3-second countdown, hides the main window, and shows floating Liquid Glass controls plus a menu bar timer. ScreenSway's windows are excluded from the capture and from audio. Clicks on Pause/Stop are dropped from the pointer log. The controls window is hidden, never closed, when a recording ends: its own Stop request is still waiting for a reply, and answering a request from a destroyed webview raises an exception in WebKit. Release builds keep `panic = "unwind"` so wry can catch such exceptions instead of aborting.

## Camera, preview and export

- `generateZoomSegments` turns clicks into zoom segments; `buildCameraTrack` simulates a 60 fps critically damped spring camera with a pan dead zone.
- `FrameSettings` (background, frame style, aspect, padding, radius, shadow, quality) → `computeLayout` gives the output size and the window/video rectangles.
- `buildRenderFrames` produces the per-frame plan: source crop, cursor position and size, click ripple. The preview and the export both follow this plan, so they match.
- The background, shadow and title bar are painted by one canvas function (`apps/desktop/src/frame/paint.ts`): at screen size for the preview and at output size for export.
- Export: the UI sends the plan plus the painted background and cursor PNGs to `export_recording`. The shell writes them next to the project and runs `screensway-capture --export job.json`. The exporter decodes the recording, composes each frame with Core Image on Metal (edge-extended Lanczos scaling, rounded video mask, cursor, ripple), encodes 60 fps H.264 High, then adds the original audio track without re-encoding. Progress is streamed as `export-progress` events.

## Desktop shell commands

Recording: `list_capture_sources`, `start_recording` (with `systemAudio`), `set_recording_paused`, `stop_recording`, `cancel_countdown`, `get_recording_state`. Library: `list_recordings`, `load_recording`, `reveal_recording`, `read_thumbnail`. Export: `export_recording`, `cancel_export`, `open_export`. Other: `set_native_labels` (menu bar language), `open_screen_recording_settings`. File access is limited to `~/Movies/ScreenSway`.

## Privacy boundary

The desktop application makes no network requests during recording, editing or export. Fonts are bundled. Update checks may be added later as an explicit, documented exception. The marketing site is independent and contains no recording data.

## Distribution

The helper is bundled beside the Tauri executable as a universal sidecar. Release builds use LTO, size optimization and stripped symbols; the DMG is recompressed with LZMA (`pnpm build:macos`). Builds are ad-hoc signed but not notarized, so first launch needs "Open Anyway"; the landing page, DMG background and release notes explain it. See [releasing.md](releasing.md).
