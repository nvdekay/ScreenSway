# Architecture

## Layers

```text
Platform capture -> project bundle -> zoom engine -> editor preview -> renderer
```

- `apps/desktop` owns the desktop shell and editor UI.
- `packages/core` defines portable project/event types and automatic zoom generation.
- `native/macos-capture` uses ScreenCaptureKit and emits a local MP4 plus pointer metadata.
- Windows capture will use Windows.Graphics.Capture.
- Raw media and metadata remain inside a local `.screensway` project directory.

## Project bundle

```text
My Recording.screensway/
  project.json
  media/screen.mp4
  media/microphone.m4a
  metadata/pointer-events.json
```

The pointer is stored as metadata instead of being permanently burned into the screen recording. This permits cursor smoothing, resizing, replacement, and click effects during editing.

## Privacy boundary

The desktop application must not make network requests during recording, editing, or export. Update checks may be added later as an explicit, documented exception. The marketing website is an independent application and contains no recording data.

## Current prototype boundary

The macOS helper uses `SCRecordingOutput`, records the main display without burning the pointer into the video, and samples cursor position and mouse-button transitions independently. The Tauri UI receives those events, regenerates zoom segments through `@screensway/core`, draws the cursor, and previews camera transforms without modifying the original video.

The helper is currently a development-time binary. Production sidecar bundling, signing, notarization, source selection, audio capture, and graceful early-stop controls are later milestones.

