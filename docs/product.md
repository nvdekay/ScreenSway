# ScreenSway product brief

## Promise

Beautiful screen recordings that guide the viewer automatically, without watermarks or cloud uploads.

## Product principles

1. Local-only by default. Recording, editing, and rendering stay on the device.
2. Free full feature set at launch. No export limits and no watermark.
3. Calm automation. Automatic zooms should feel intentional and remain editable.
4. Native capture quality. Platform-specific capture backends feed one shared project model.
5. No account required.

## What ships today

Unless noted otherwise, these workflows ship on both macOS and Windows. The floating controls use Liquid Glass and the timer also appears in the menu bar on macOS; Windows uses native dark controls and a standard title bar.

- Record a display or an application window, with optional system audio and microphone (pick the device; the voice is leveled and background noise is lowered between phrases). Pause and resume without keeping the paused interval.
- 3-second countdown and floating controls that stay out of the video; macOS also provides a menu bar timer.
- Studio preview with automatic, spring-based zoom and pan that follows clicks, a smooth re-rendered cursor and click ripples.
- Styles: built-in looks (Studio, Clean, MacBook, Website, Social) and your own saved styles, applied in one click.
- Frame customization: a library of mesh, linear and wave backgrounds, solid colors and a custom two-color gradient, your own images (kept in Movies › ScreenSway › Backgrounds for reuse) with blur, a Magic background built from the recording's colors, film grain; macOS light/dark, browser light/dark (with address bar), MacBook, glass and outline frames; aspect presets (auto, 16:9, 4:3, 1:1, 9:16), padding, corners and shadow.
- Timeline: trim the start and end, move, resize, add or remove zooms and set each zoom's depth; edits are saved with the recording and can be reset to the automatic zooms.
- Captions: on-device speech recognition (Vietnamese and English), balanced caption lines you can edit, three sizes and three looks, burned into the export plus an .srt file next to the video.
- Export to MP4 at 1080p, 1440p or 4K, 60 fps, with zoom, cursor, frame and audio.
- A searchable local library with inline rename, confirmed deletion and hover scrubbing; Vietnamese and English UI; Retina/standard display hints.
- Public macOS universal and Windows x64 downloads. Windows provides the same capture, audio, Studio editing, MP4/SRT export and offline editable captions workflow; platform-specific implementation details and requirements are documented in [windows-validation.md](windows-validation.md).

## Roadmap

Ordered by expected impact on activation, sharing and retention.

1. Notarization (Apple Developer Program) to remove the first-launch block.
2. Global shortcut and quick record from the menu bar; first-run onboarding.
3. Webcam overlay; optional echo cancellation for recording the microphone over speakers.
4. More editing: speed up idle stretches, cut out the middle of a recording, keystroke overlay.
5. Vertical 9:16 exports where the camera follows the action; GIF and clipboard export.

Measure growth without breaking the privacy promise: cookie-free analytics on the landing page only, download counts, and anonymous requests to the static update manifest as a proxy for active users.
