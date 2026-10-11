# ScreenSway

Local-first macOS screen recorder with automatic cursor-aware zooms. Read `docs/architecture.md` (how it works), `docs/product.md` (what ships, roadmap) and `docs/releasing.md` (release flow) before larger changes.

## Layout

- `packages/core` — shared TypeScript logic (zoom segments, spring camera, frame model, per-frame render plan). Preview and export must both go through it.
- `apps/desktop` — Tauri 2 shell (`src-tauri/src/lib.rs`) and React UI (`src/`, studio in `src/frame/`). UI strings live in `src/i18n.tsx` (English and Vietnamese, keep both in sync).
- `native/macos-capture` — Swift sidecar: capture (`ScreenSwayCapture.swift`) and `--export` renderer (`Exporter.swift`). Built into `apps/desktop/src-tauri/binaries/` by `scripts/build-native.mjs`.
- `native/windows-capture` — Rust sidecar for Windows with the same CLI contract (capture done; audio, export, captions to come). Shell code shared by both platforms is gated with `cfg(capture)`.
- `apps/web` — landing page (GitHub Pages), bilingual, light/dark themes via CSS tokens in `src/styles.css`.

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

## Verification notes

- `test:capture:macos` and any real capture fail with "could not find the main display" while the Mac's screen is locked; check `CGSessionCopyCurrentDictionary()["CGSSessionScreenIsLocked"]` before assuming a bug.
- `screensway-capture --export job.json` can be tested without the UI using a synthetic source (`ffmpeg -f lavfi -i testsrc2=...`) and a job built from `buildRenderFrames`.
- UI changes can be checked in a browser: Vite plus `@tauri-apps/api/mocks` (`mockIPC`) render the React components without the Tauri runtime. Remove any temporary harness files afterwards.
- WebKit pauses CSS animations and `requestAnimationFrame` in offscreen or locked sessions; elements with entrance animations can look invisible in such screenshots.
- The Windows code can only be type-checked on a Mac. Checking the Tauri shell for `x86_64-pc-windows-msvc` also needs an `llvm-rc` (a stub that writes an empty `.res` is enough, passed as `RC=`) and a placeholder `binaries/screensway-capture-x86_64-pc-windows-msvc.exe`; delete the placeholder afterwards. Real behavior is verified on the user's Windows PC and in the Windows workflow.
- Release builds must be opened with `open` (LaunchServices); launching the raw binary can show an empty window.
- Speech recognition run from a terminal is killed by TCC: macOS asks the *responsible* app (the terminal) for `NSSpeechRecognitionUsageDescription`. `SCREENSWAY_TEST_CAPTIONS=1 pnpm test:capture:macos` wraps the helper in a temporary app opened with `open -W`; the first run needs "Allow" on the prompt.
