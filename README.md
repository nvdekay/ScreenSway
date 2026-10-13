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
- Windows: Microsoft C++ Build Tools with Windows SDK, WebView2, CMake and LLVM/libclang

## Development

```bash
pnpm install
pnpm dev:web
pnpm dev:desktop
```

On macOS, ScreenSway records a display or application window (optionally with system audio and the microphone), pauses and resumes without keeping the paused interval, previews automatic cursor-aware zooms in a studio with a customizable frame, and exports MP4 up to 4K at 60 fps. Recordings are local `.screensway` projects under `~/Movies/ScreenSway`; exports go to `~/Movies/ScreenSway/Exports`. See [docs/architecture.md](docs/architecture.md).

Installed builds check ScreenSway's public static update feed after launch. Updates are downloaded and installed only after Tauri verifies their embedded signature; recording, editing and export remain entirely local.

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

`test:capture:macos` performs real display and window recordings (with system audio and the default microphone; set `SCREENSWAY_TEST_MICROPHONE=0` to skip it), a trimmed export with a caption, and with `SCREENSWAY_TEST_CAPTIONS=1` on-device captions in Vietnamese and English (needs Speech Recognition permission), exercises pause/resume and stop, and validates the MP4, audio track, manifest, pointer metadata and timeline alignment. It requires Screen Recording permission, an unlocked screen, and `ffprobe` from FFmpeg. `build:macos` builds the universal app and the compressed DMG.

### Windows

The Windows helper (`native/windows-capture`, Rust) implements display/window capture, system audio and microphone processing, pause/resume, Studio MP4 export through 4K/60 fps, and editable offline English/Vietnamese captions with SRT. See [Windows validation and build requirements](docs/windows-validation.md). Captions use a bundled 574 MB Whisper model and require AVX2; CPU transcription can be slow.

```bash
pnpm setup:windows-speech  # download and verify the bundled offline model
pnpm test:capture:windows   # real capture/audio checks; FFmpeg on PATH
pnpm test:export:windows
pnpm dev:desktop
pnpm build:windows          # NSIS installer in apps/desktop/src-tauri/target/release/bundle/nsis
```

The **Windows build** workflow runs the same build on `windows-latest` for every relevant push to `main` and uploads the installer as an artifact. It is unsigned, so SmartScreen asks for **More info → Run anyway**.

## Releases

Pushing a tag such as `v0.2.0` (matching the app version) triggers the macOS release workflow. It builds and verifies `ScreenSway-macos-universal.dmg`, publishes the release, and redeploys the landing page, which serves the DMG at `download/ScreenSway-macos-universal.dmg`.

The build is ad-hoc signed and not notarized yet. See [docs/releasing.md](docs/releasing.md).

