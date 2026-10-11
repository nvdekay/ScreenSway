# Windows release acceptance plan

This is a release gate, not a promise of zero defects. A passing test on one
Windows 11 PC does not certify every Windows version, GPU, audio device or driver.
Keep unexecuted cases marked NOT RUN, never PASS. Do not publish while a P0/P1
defect is open or a required release case remains unverified.

## Evidence and execution

Record installer SHA-256, source revision plus dirty diff, OS build, CPU/GPU and
driver, RAM, display/DPI layout, audio endpoints and app language. Keep results,
logs, project manifests and exported videos. Use synthetic speech and a moving
clock fixture, not private content. Decode the entire MP4 with FFmpeg; inspect
first/middle/last frames and listen to the exported audio. Stream presence alone
does not prove audible microphone input, correct pixels or lip sync.

P0 = data loss, unusable installation or crash on the main flow. P1 = recording,
audio, editing or export fails; wrong source or misleading success. P2 = UX,
accessibility or performance defect with a usable workaround.

## Main user journey (required on the installed app)

1. Install the final NSIS artifact as a standard user. Launch from its shortcut
   offline; verify bundled helper/model and readable source names.
2. Select a screen, system sound and a microphone. Record a moving clock while
   speaking and clicking in several locations. Cancel one countdown first.
3. Record 15 seconds, pause 5 seconds, resume 15 seconds, stop. HUD and timer must
   match state. Paused time must be absent from media, pointer events and audio.
4. Play/seek the result. Check source identity, cursor placement, audible channels,
   sync and automatic zoom. Trim, add/remove a zoom, choose a frame/aspect ratio.
5. Generate captions, cancel and retry, edit text with Vietnamese accents. Close
   immediately after editing, reopen and verify persistence.
6. Start 4K export, cancel, retry 1080p/60. Verify progress, successful playback,
   full decode, trim boundaries, frame/cursor/caption appearance and matching SRT.
7. Exit/relaunch. Reopen the same project and export a second time. Original
   recording and earlier MP4/SRT must remain intact.
8. Upgrade/reinstall, then uninstall in an isolated installation. Verify shortcuts,
   absence of orphan helpers and preservation of the user's recording library.

## Test cases

Each row is an independently reportable case. Repeat relevant cases in English
and Vietnamese and on the supported hardware matrix. Expected behavior describes
acceptance, not an assertion that the implementation already provides it.

| ID | Priority | Action / condition | Expected result |
|---|---|---|---|
| INS-01 | P0 | Clean install, standard user | Launchable app; helper/model present; no developer tools needed |
| INS-02 | P1 | Install path with spaces and Vietnamese characters | Capture, speech and export work |
| INS-03 | P1 | Offline first launch with WebView2 present | Core functions work without downloads |
| INS-04 | P1 | WebView2 missing, online then offline | Installer handles dependency or gives actionable error; no false success |
| INS-05 | P0 | Upgrade over previous version with saved projects | Library and edits remain readable |
| INS-06 | P1 | Reinstall same version / launch twice | No broken shortcuts or conflicting capture sessions |
| INS-07 | P0 | Uninstall on a disposable installation | User media preserved; only installed files removed |
| INS-08 | P1 | Cancel installer, low disk, access denied | Clean failure; installed version remains usable |
| SRC-01 | P1 | Refresh screen/window sources | Correct names and dimensions; selection stays valid |
| SRC-02 | P1 | Close selected window before start | Explicit recoverable error; no unintended screen capture |
| SRC-03 | P1 | Disconnect selected display before start | Reject stale source; never silently use another screen |
| SRC-04 | P1 | Dual monitor, secondary left/above primary | Correct screen and cursor coordinates, including negative origins |
| SRC-05 | P1 | DPI 100/125/150/200%, mixed DPI | Captured pixels and click zoom align |
| SRC-06 | P1 | Move/resize captured window across displays | Stable media and correct cursor mapping |
| SRC-07 | P1 | Minimize, cover, restore captured window | No crash; restored capture valid; unavailable content understandable |
| SRC-08 | P1 | Close captured window while recording | Recording finalizes and appears once in library |
| REC-01 | P1 | Cancel countdown | Return idle; no completed ghost project |
| REC-02 | P1 | Stop immediately after capture starts | Valid short file or clear recoverable error |
| REC-03 | P0 | Repeated pause/resume, stop while paused | Valid media; paused periods excluded from all timelines |
| REC-04 | P1 | Rapid/double start, stop, pause clicks | One operation; consistent HUD/main window state |
| REC-05 | P1 | Static desktop then motion | Duration correct; no missing final still interval |
| REC-06 | P1 | 30/60/120 Hz displays; busy CPU/GPU | Playable timing; no runaway buffers or permanent hang |
| REC-07 | P0 | Lock/unlock; sleep/wake while recording | Clear state; saved usable recording or actionable failure |
| REC-08 | P0 | Close app/Alt+F4/tray during recording | Controlled save/confirmation; no invisible indefinite capture |
| REC-09 | P0 | Disk fills or library becomes unwritable | No false saved state; existing projects intact |
| REC-10 | P0 | Helper crashes / user terminates it | UI recovers; no orphan process; partial result not advertised as complete |
| REC-11 | P1 | 30-minute then 2-hour recording | Bounded memory, stable A/V sync, finalization succeeds |
| REC-12 | P1 | Swapped mouse buttons, clicks near edges/HUD | Intended primary clicks zoom; HUD clicks excluded |
| AUD-01 | P1 | Neither audio source enabled | Valid silent video; captions report no audio |
| AUD-02 | P1 | System audio only with known played tone | Audible AAC; correct sample rate and duration |
| AUD-03 | P1 | Mic only with known spoken phrase | Actual voice audible; no reliance on mere track existence |
| AUD-04 | P1 | Mic + system sound | Both audible; no clipping or unexpected duplicate echo |
| AUD-05 | P1 | Deny microphone access; retry after enabling | Actionable error and recovery without restart if supported |
| AUD-06 | P1 | Unplug USB/Bluetooth mic during recording | No deadlock; explicit fallback/error and usable saved video |
| AUD-07 | P1 | Change default playback device mid-recording | Clear handling; no silently missing entire soundtrack |
| AUD-08 | P1 | Silence, loud voice, 44.1/48 kHz devices | No DC/noise burst/clipping; consistent A/V clock |
| AUD-09 | P1 | Repeated pause with speech around boundaries | Paused speech absent; resumed voice aligned within 100 ms |
| EDT-01 | P1 | Play/pause/seek/replay, first and last frame | Stable preview; no stale image or stuck playback |
| EDT-02 | P1 | Trim near zero/clip end; add/move/delete zoom | Valid ranges; export matches preview |
| EDT-03 | P0 | Edit then immediately close/reopen Studio | Latest trim/zoom/captions persist |
| EDT-04 | P1 | All 5 styles, 8 frames and 5 aspect ratios | No exception or clipped controls; representative exports match preview |
| EDT-05 | P1 | Custom background, invalid/large image, deleted image | Safe validation/fallback; original project preserved |
| EDT-06 | P1 | Missing media / malformed project or edits | Recoverable error/fallback; remaining library usable |
| CAP-01 | P1 | English and Vietnamese fixture offline | Nonempty ordered timed words; UTF-8 text persisted |
| CAP-02 | P1 | Silent/no-audio recording | Useful message; export and subsequent speech still work |
| CAP-03 | P1 | Cancel immediately/midway, retry | Child exits; no stale output or busy state |
| CAP-04 | P1 | Close Studio while generating captions | Task canceled; next project gets no stale result |
| CAP-05 | P1 | Unsupported CPU or damaged model | Clear error; capture/export still usable |
| CAP-06 | P1 | Edit accents, punctuation, multiline text | Preview/burned captions/SRT preserve text and timings |
| EXP-01 | P1 | 1080p/1440p/4K at 60 fps | H.264, expected dimensions, complete decode and correct duration |
| EXP-02 | P1 | Cancel during preparation and encoding, retry | No partial advertised output; retry succeeds |
| EXP-03 | P1 | Close Studio while exporting; reopen another project | No stale job/progress; app remains usable |
| EXP-04 | P0 | Same name, reserved Windows name, existing SRT | Safe filenames; never overwrite earlier media/subtitles |
| EXP-05 | P0 | Low disk/unwritable destination/encoder unavailable | Useful failure; source unchanged; controls recover |
| EXP-06 | P1 | Trim with captions and audio at boundaries | Output starts at trim; audio/captions and SRT share time origin |
| EXP-07 | P1 | Open output in Windows player and another player | First/middle/end play and seek; audio audible |
| UX-01 | P2 | Keyboard-only navigation, focus, Escape | Named controls, visible focus, predictable dismissal |
| UX-02 | P1 | Minimum window, 1366x768, 200% DPI | Primary recording/export controls reachable |
| UX-03 | P2 | EN/VI, light/dark, long titles | Complete readable text; no clipped actions |
| UX-04 | P1 | Reopen app and existing project after reboot | Library discoverable; saved changes intact |
| UX-05 | P2 | Progress/error/success messages | Honest progress, actionable errors, obvious recovery |

## Release matrix and gates

- Test Windows 11 on Intel and AMD integrated graphics plus NVIDIA/AMD discrete
  graphics. Test Windows 10 only if claimed supported; otherwise declare the
  supported OS explicitly before release. ARM64/emulation is not certified by an
  x64 build. Include a non-AVX2 CPU to verify graceful caption rejection.
- Cover one and two displays, mixed DPI, laptop battery, standard account,
  Vietnamese Windows user path, USB/Bluetooth/default mic and offline use.
- All P0/P1 cases relevant to advertised support must pass on a final installer.
  Sign-off must include installed-app E2E, upgrade/uninstall, long recording,
  resource failure and device/displays changes. Log exclusions explicitly.
- Review exported pixels and audio manually; automated decoding is insufficient
  for visual quality and subjective ease of use. Have a new user perform the
  main journey without coaching and record confusing steps.
- Installer signing/SmartScreen reputation and the bundled model's download size
  remain product release considerations. Do not claim signing or broad hardware
  coverage based on this local run.

## Automation already available

`pnpm typecheck`, `pnpm test`, both Rust test suites,
`scripts/test-windows-capture.mjs`, `scripts/test-windows-window-cases.mjs`,
`scripts/test-windows-export.mjs`, `scripts/test-windows-transcribe.mjs`, and
`scripts/test-windows-ui.ps1 -AppPath <installed screensway.exe> -SpeechWav <fixture>`.
The UI suite covers countdown cancel, pause/resume/paused stop, styles/frames,
immediate-close zoom persistence, no-audio captions, export cancel/retry/full
decode and optional speech/caption-edit/SRT, closing/restarting the app, minimum
window size and caption persistence after restart. It is not the whole matrix above.

`scripts/test-windows-installer.ps1 -InstallerPath <final setup.exe> -SpeechWav
<fixture>` installs into workspace `.tools/installed-qa`, runs that UI suite,
uninstalls and reinstalls. It hashes the existing library to assert byte-for-byte
preservation and compares installed executables to the release build (allowing
only Tauri's exact `UNK` to `NSS` bundle-marker patch in the main executable). This covers
same-version reinstall, not migration from every older version. Close the app
before running; the script does not terminate an existing user session.
