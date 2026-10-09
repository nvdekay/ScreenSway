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

The current macOS prototype records the main display for ten seconds, saves a local `.screensway` project under `~/Movies/ScreenSway`, and opens an automatic zoom preview. It requires macOS 15 or newer. On first use, macOS asks for Screen Recording permission.

Run all checks:

```bash
pnpm typecheck
pnpm build:web
pnpm test
```

## Releases

Pushing a tag such as `v0.1.0` triggers the desktop release workflow. The workflow builds macOS and Windows installers and publishes fixed download filenames used by the landing page:

- `ScreenSway-macos-universal.dmg`
- `ScreenSway-windows-x64.exe`

Code signing and notarization secrets must be configured before public distribution. See [docs/releasing.md](docs/releasing.md).

