# ScreenSway

Local-first screen recorder with automatic cursor-aware zooms. macOS and Windows x64 are publicly available; Windows implements capture, audio, export and offline captions with an unsigned NSIS installer (see docs/windows-validation.md). Read `docs/architecture.md` (how it works), `docs/product.md` (what ships, roadmap), `docs/landing-page.md` (marketing demo constraints) and `docs/releasing.md` (release flow) before larger changes.

## Layout

- `packages/core` — shared TypeScript logic (zoom segments, spring camera, frame model/painter, per-frame render plan). Desktop preview/export and the landing demo use the same frame painter; do not replace landing frames with approximate CSS.
- `apps/desktop` — Tauri 2 shell (`src-tauri/src/lib.rs`) and React UI (`src/`, studio in `src/frame/`). UI strings live in `src/i18n.tsx` (English and Vietnamese, keep both in sync).
- `native/macos-capture` — Swift sidecar: capture (`ScreenSwayCapture.swift`) and `--export` renderer (`Exporter.swift`). Built into `apps/desktop/src-tauri/binaries/` by `scripts/build-native.mjs`.
- `native/windows-capture` — Rust sidecar for Windows with the same CLI contract (capture, WASAPI audio, Media Foundation export and Whisper captions). Shell code shared by both platforms is gated with `cfg(capture)`.
- `apps/web` — landing page (GitHub Pages), bilingual, dark only, CSS tokens in `src/styles.css` (black stage with the system-blue accent shared with the browser app, the same flat blue `LogoMark`, and a looping globe video shifted to blue behind the page; see `docs/landing-page.md`).
- `apps/studio-web` — browser version (beta) at `/app/`: reuses the desktop studio through `@tauri-apps/api` aliases (`src/tauri/`, `src/backend.ts`) and `isWeb`, records with `getDisplayMedia`, finds the pointer in the video (`src/pointer/`) and exports with mediabunny/WebCodecs. See `docs/web-studio.md`.
- `apps/analytics` — Cloudflare Worker + D1: public event ingestion, the stats API and the private dashboard page (one admin account in Worker secrets, signed session cookie; bearer token for scripts). Events, API and deployment: `docs/analytics.md`.
- `apps/downloads` — Cloudflare Worker + R2 that serves the installers and updater bundles (`/latest/<file>`, `/<tag>/<file>`); the landing deploy uploads releases with `scripts/publish-downloads.mjs`. See `docs/releasing.md`.

## Current state

- Version `0.3.3`; landing page is live at `https://screensway.site/` (GitHub Pages custom domain; DNS on Cloudflare; the old `nvdekay.github.io/ScreenSway/` redirects there), the downloads Worker at `download.screensway.site` and analytics at `stats.screensway.site`; the latest macOS and Windows installers are served by the downloads Worker (R2), and Pages keeps only the site and `update/latest.json`.
- The browser version (Chrome/Edge on a computer) has its own wide product page on a dark contour-image background, a blue accent (`#0a84ff`, not the desktop violet), flat single-colour surfaces (no gradients) with small corner radii (no pills), with a live zoom sample, reached in the same tab with a page cross-fade; it records a screen, window or tab, zooms where the pointer settles, offers the desktop styles/timeline/trim and downloads an MP4. No captions, library or pause. It sends anonymous cookieless usage counts as analytics source `studio` (dashboard view "Bản web"; see `docs/analytics.md`). Desktop studio changes ship to it too, but its visual overrides stay under `html.web`.
- The landing page groups its message into hero/demo, four benefit cards, a dedicated browser-recorder section, five essential FAQs and a compact download CTA; install details stay in the popup. Its hero presents the browser app as a distinct beta trial beside, not instead of, the two equal desktop downloads.
- The landing Studio demo uses all five real `BUILT_IN_STYLES`, all eight frame types, six timed EN/VI sample captions and stable reveal keys across language changes. `apps/web/src/RecordingFrame.tsx` calls the shared `computeLayout` and `paintFrameBase` APIs.
- macOS capture, audio/microphone processing, editable zoom/trim, local EN/VI captions and MP4/SRT export up to 4K/60 fps are implemented.
- The local recording library supports search, inline rename, confirmed permanent deletion and on-demand hover scrubbing.
- The signed Tauri updater checks the public Pages feed after launch and can download, verify, install and relaunch from Settings; it waits while a recording, export or caption job runs. Ad-hoc signing means macOS may need permissions re-granted after an update (see `docs/releasing.md`). Release CI requires `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; never commit or rotate the private key casually.
- Windows display/window capture, pointer metadata, pause/resume, thumbnails, shared desktop shell and NSIS CI build are implemented. Windows audio, export and offline captions are implemented and tested locally. The landing page serves both macOS and Windows installers from the latest release, with platform-specific install guides.
- Windows speech uses optimized MSVC C/C++ kernels and fused attention, with a bundled Whisper model. Keep `.cargo/windows-speech.cmake` and the CI cache key aligned; see `docs/windows-validation.md` for timings, accuracy samples and CPU requirements.
- GitHub workflows: `audit.yml` audits the JS and Rust lockfiles weekly; `web.yml` deploys Pages (landing plus the browser version at `/app/`) and copies the latest complete release to R2, `release.yml` publishes macOS tags and dispatches the matching Windows release from the same tag, and `windows.yml` tests/builds the unsigned Windows installer on relevant pushes and publishes it when requested.

## Commands

```bash
pnpm typecheck && pnpm test                       # TS types + core and desktop UI tests
(cd apps/desktop/src-tauri && cargo test --lib)   # Rust unit tests
pnpm build:capture:macos                          # rebuild the Swift sidecar (needed after Swift changes)
pnpm test:capture:macos                           # real screen/window/audio capture test
pnpm dev:desktop                                  # run the app
pnpm build:macos                                  # universal app + LZMA DMG
pnpm build:web                                    # landing page
pnpm dev:site                                     # landing + browser version on one address (app at /app/, as deployed)
pnpm dev:studio-web / pnpm build:studio-web        # browser version alone (web.yml puts it in the site's app/ folder)
pnpm --filter @screensway/studio-web test:e2e       # browser version end to end in Edge (BROWSER=chrome)
pnpm --filter @screensway/analytics test:e2e        # analytics API end to end on a local D1
pnpm --filter @screensway/downloads test:e2e        # downloads Worker + publish script on a local R2
(cd native/windows-capture && cargo test)          # Windows helper logic (runs on macOS too)
(cd native/windows-capture && cargo check --target x86_64-pc-windows-msvc)  # type-check the Windows code from a Mac
pnpm test:capture:windows / pnpm build:windows    # on a Windows PC; CI runs the build (windows.yml)
```

## Conventions

- Commits: focused, imperative subject, explanatory body. Never add Claude/Co-Authored-By attribution. Split unrelated changes into separate commits.
- The app's only network use is opt-in anonymous usage statistics (`src-tauri/src/telemetry.rs`): nothing is sent before the user agrees, and never recording content, file names or paths. Fonts are bundled. New events must be added to the allow-lists on both sides (see `docs/analytics.md`). File access from the UI is restricted to `~/Movies/ScreenSway`.
- Versions live in four places: root and desktop `package.json`, `tauri.conf.json`, `Cargo.toml`. Release = push a matching `vX.Y.Z` tag; the workflow builds, verifies, publishes and redeploys the landing page with the new DMG.
- The landing page and the browser app get a build-time CSP `<meta>` from `scripts/vite-csp.mjs` (inline blocks hashed automatically). A new external request (another API, CDN, font) must be added to `connect-src`/the matching directive in that app's `vite.config.ts`, or the browser blocks it.
- The repository is private: the landing page links to the downloads Worker (`…/latest/ScreenSway-macos-universal.dmg`) and must not link to GitHub.
- Before ending a coding session, keep `CLAUDE.md` and the relevant file in `docs/` aligned with shipped behavior, run proportionate checks, split unrelated work into focused commits, and push `main` when the user asks for a full handoff.

## Verification notes

- Windows release acceptance matrix: `docs/windows-release-test-plan.md` (61 cases).
  Latest installer hash and scoped results: `docs/windows-qa-latest.md`.
  `scripts/test-windows-installer.ps1` verifies same-version install, installed UI
  E2E, uninstall/reinstall and byte-for-byte preservation of the recording library.
  `scripts/test-windows-ui.ps1` exercises real WebView2 UI and full MP4 decoding;
  preserve the capture timebase with `-fps_mode passthrough -enc_time_base demux`.
  Windows closes the reused hidden recording HUD when main is destroyed, so an
  idle app exits normally; closing main during an active capture is prevented.

- `test:capture:macos` and any real capture fail with "could not find the main display" while the Mac's screen is locked; check `CGSessionCopyCurrentDictionary()["CGSSessionScreenIsLocked"]` before assuming a bug.
- `screensway-capture --export job.json` can be tested without the UI using a synthetic source (`ffmpeg -f lavfi -i testsrc2=...`) and a job built from `buildRenderFrames`.
- UI changes can be checked in a browser: Vite plus `@tauri-apps/api/mocks` (`mockIPC`) render the React components without the Tauri runtime. Remove any temporary harness files afterwards.
- WebKit pauses CSS animations and `requestAnimationFrame` in offscreen or locked sessions; elements with entrance animations can look invisible in such screenshots.
- The Windows code can only be type-checked on a Mac. Checking the Tauri shell for `x86_64-pc-windows-msvc` also needs an `llvm-rc` passed as `RC=` (a stub is enough: print `Resource Converter` for `-V /?`, otherwise write an empty file to the `/fo` path) and empty placeholders for `binaries/screensway-capture-x86_64-pc-windows-msvc.exe` and `resources/models/ggml-large-v3-turbo-q5_0.bin`; delete the placeholders afterwards. Real behavior is verified on the user's Windows PC and in the Windows workflow.
- Release builds must be opened with `open` (LaunchServices); launching the raw binary can show an empty window.
- Speech recognition run from a terminal is killed by TCC: macOS asks the *responsible* app (the terminal) for `NSSpeechRecognitionUsageDescription`. `SCREENSWAY_TEST_CAPTIONS=1 pnpm test:capture:macos` wraps the helper in a temporary app opened with `open -W`; the first run needs "Allow" on the prompt.
