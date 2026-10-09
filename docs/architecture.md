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
  metadata/pointer-events.json
```

Future audio capture may add `media/microphone.m4a`; it is not produced by the current prototype.

The pointer is stored as metadata instead of being permanently burned into the screen recording. This permits cursor smoothing, resizing, replacement, and click effects during editing.

## Privacy boundary

The desktop application must not make network requests during recording, editing, or export. Update checks may be added later as an explicit, documented exception. The marketing website is an independent application and contains no recording data.

## Current prototype boundary

The macOS helper uses `SCRecordingOutput`, records a selected display or application window without burning the pointer into the video, and samples cursor position and mouse-button transitions independently. The Tauri shell controls the helper through a project-local control file, while the UI receives the finished events, regenerates zoom segments through `@screensway/core`, draws the cursor, and previews camera transforms without modifying the original video.

Pause closes the active MP4 segment and resume starts a new one. On stop, AVFoundation assembles the segments into `media/screen.mp4`; segment files are then deleted. Paused time is subtracted from pointer timestamps and project duration.

The helper is currently a development-time binary. Production sidecar bundling, signing, notarization, Windows capture, and audio capture are later milestones.

