# ScreenSway

ScreenSway is a local-first screen recorder that automatically follows the action with smooth cursor-aware zooms and pans.

Landing page: https://nvdekay.github.io/ScreenSway/

The application is free to use, has no watermark, and keeps recordings on the user's device. ScreenSway is proprietary software and is not open source.

## Repository

```text
apps/desktop       Tauri 2 + React desktop application
apps/web           Public marketing and download website
packages/core      Shared project model and zoom engine
native/macos-capture  ScreenCaptureKit recording helper
docs               Product and architecture documentation
```

## Requirements

- Node.js 22 or newer
- pnpm 11 or newer
- Rust stable
- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ Build Tools and WebView2

## Development

```bash
pnpm install
pnpm dev:web
pnpm dev:desktop
```

On macOS, ScreenSway records a display or application window (optionally with system audio), pauses and resumes without keeping the paused interval, previews automatic cursor-aware zooms in a studio with a customizable frame, and exports MP4 up to 4K at 60 fps. Recordings are local `.screensway` projects under `~/Movies/ScreenSway`; exports go to `~/Movies/ScreenSway/Exports`. See [docs/architecture.md](docs/architecture.md).

The capture helper currently requires macOS 15 or newer. On first use, macOS asks for Screen Recording permission. Build the helper before starting the desktop application:

```bash
pnpm build:capture:macos
pnpm dev:desktop
```

Run all checks:

```bash
pnpm typecheck
pnpm build:web
pnpm test
pnpm test:capture:macos
(cd apps/desktop/src-tauri && cargo test --lib)
pnpm build:macos
```

`test:capture:macos` performs real display and window recordings (with system audio), exercises pause/resume and stop, and validates the MP4, audio track, manifest, pointer metadata and timeline alignment. It requires Screen Recording permission, an unlocked screen, and `ffprobe` from FFmpeg. `build:macos` builds the universal app and the compressed DMG.

Windows capture is part of the product plan but is not implemented yet.

## Releases

Pushing a tag such as `v0.2.0` (matching the app version) triggers the macOS release workflow. It builds and verifies `ScreenSway-macos-universal.dmg`, publishes the release, and redeploys the landing page, which serves the DMG at `download/ScreenSway-macos-universal.dmg`.

The build is ad-hoc signed and not notarized yet. See [docs/releasing.md](docs/releasing.md).

