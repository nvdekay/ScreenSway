# ScreenSway

Local-first screen recorder with automatic cursor-aware zooms. macOS is the complete released platform; the Windows port implements capture, audio, export and offline captions with an unsigned NSIS installer (see docs/windows-validation.md). Read `docs/architecture.md` (how it works), `docs/product.md` (what ships, roadmap), `docs/landing-page.md` (marketing demo constraints) and `docs/releasing.md` (release flow) before larger changes.

## Layout

- `packages/core` — shared TypeScript logic (zoom segments, spring camera, frame model/painter, per-frame render plan). Desktop preview/export and the landing demo use the same frame painter; do not replace landing frames with approximate CSS.
- `apps/desktop` — Tauri 2 shell (`src-tauri/src/lib.rs`) and React UI (`src/`, studio in `src/frame/`). UI strings live in `src/i18n.tsx` (English and Vietnamese, keep both in sync).
- `native/macos-capture` — Swift sidecar: capture (`ScreenSwayCapture.swift`) and `--export` renderer (`Exporter.swift`). Built into `apps/desktop/src-tauri/binaries/` by `scripts/build-native.mjs`.
- `native/windows-capture` — Rust sidecar for Windows with the same CLI contract (capture, WASAPI audio, Media Foundation export and Whisper captions). Shell code shared by both platforms is gated with `cfg(capture)`.
- `apps/web` — landing page (GitHub Pages), bilingual, light/dark themes via CSS tokens in `src/styles.css`.

## Current state

- Version `0.3.0`; landing page is live at `https://nvdekay.github.io/ScreenSway/` and serves the latest macOS DMG from its own `download/` path.
- The landing page groups its message into hero/demo, four benefit cards, five essential FAQs and a compact download CTA; install details stay in the popup.
- The landing Studio demo uses all five real `BUILT_IN_STYLES`, all eight frame types, six timed EN/VI sample captions and stable reveal keys across language changes. `apps/web/src/RecordingFrame.tsx` calls the shared `computeLayout` and `paintFrameBase` APIs.
- macOS capture, audio/microphone processing, editable zoom/trim, local EN/VI captions and MP4/SRT export up to 4K/60 fps are implemented.
- Windows display/window capture, pointer metadata, pause/resume, thumbnails, shared desktop shell and NSIS CI build are implemented. Windows audio, export and offline captions are implemented and tested locally. The landing page serves both macOS and Windows installers from the latest release, with platform-specific install guides.
- Windows speech uses optimized MSVC C/C++ kernels and fused attention, with a bundled Whisper model. Keep `.cargo/windows-speech.cmake` and the CI cache key aligned; see `docs/windows-validation.md` for timings, accuracy samples and CPU requirements.
- GitHub workflows: `web.yml` deploys Pages, `release.yml` publishes macOS tags, and `windows.yml` tests/builds the unsigned Windows installer artifact on relevant pushes.

## Commands

```bash
pnpm typecheck && pnpm test                       # TS types + core unit tests
(cd apps/desktop/src-tauri && cargo test --lib)   # Rust unit tests
pnpm build:capture:macos                          # rebuild the Swift sidecar (needed after Swift changes)
pnpm test:capture:macos                           # real screen/window/audio capture test
pnpm dev:desktop                                  # run the app
pnpm build:macos                                  # universal app + LZMA DMG
pnpm build:web                                    # landing page
(cd native/windows-capture && cargo test)          # Windows helper logic (runs on macOS too)
(cd native/windows-capture && cargo check --target x86_64-pc-windows-msvc)  # type-check the Windows code from a Mac
pnpm test:capture:windows / pnpm build:windows    # on a Windows PC; CI runs the build (windows.yml)
```

## Conventions

- Commits: focused, imperative subject, explanatory body. Never add Claude/Co-Authored-By attribution. Split unrelated changes into separate commits.
- The app must not make network requests (fonts are bundled). File access from the UI is restricted to `~/Movies/ScreenSway`.
- Versions live in four places: root and desktop `package.json`, `tauri.conf.json`, `Cargo.toml`. Release = push a matching `vX.Y.Z` tag; the workflow builds, verifies, publishes and redeploys the landing page with the new DMG.
- The repository is private: the landing page serves the DMG itself (`download/ScreenSway-macos-universal.dmg`) and must not link to GitHub.
- Before ending a coding session, keep `CLAUDE.md` and the relevant file in `docs/` aligned with shipped behavior, run proportionate checks, split unrelated work into focused commits, and push `main` when the user asks for a full handoff.

## Verification notes

- `test:capture:macos` and any real capture fail with "could not find the main display" while the Mac's screen is locked; check `CGSessionCopyCurrentDictionary()["CGSSessionScreenIsLocked"]` before assuming a bug.
- `screensway-capture --export job.json` can be tested without the UI using a synthetic source (`ffmpeg -f lavfi -i testsrc2=...`) and a job built from `buildRenderFrames`.
- UI changes can be checked in a browser: Vite plus `@tauri-apps/api/mocks` (`mockIPC`) render the React components without the Tauri runtime. Remove any temporary harness files afterwards.
- WebKit pauses CSS animations and `requestAnimationFrame` in offscreen or locked sessions; elements with entrance animations can look invisible in such screenshots.
- The Windows code can only be type-checked on a Mac. Checking the Tauri shell for `x86_64-pc-windows-msvc` also needs an `llvm-rc` (a stub that writes an empty `.res` is enough, passed as `RC=`) and a placeholder `binaries/screensway-capture-x86_64-pc-windows-msvc.exe`; delete the placeholder afterwards. Real behavior is verified on the user's Windows PC and in the Windows workflow.
- Release builds must be opened with `open` (LaunchServices); launching the raw binary can show an empty window.
- Speech recognition run from a terminal is killed by TCC: macOS asks the *responsible* app (the terminal) for `NSSpeechRecognitionUsageDescription`. `SCREENSWAY_TEST_CAPTIONS=1 pnpm test:capture:macos` wraps the helper in a temporary app opened with `open -W`; the first run needs "Allow" on the prompt.
