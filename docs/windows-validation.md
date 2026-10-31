# Windows implementation and validation

Release acceptance scenarios, priorities and hardware coverage are tracked in
[Windows release test plan](windows-release-test-plan.md). Passing the local
checks below does not certify the unexecuted cases in that plan.
See [latest local QA evidence](windows-qa-latest.md) for the final installer hash,
installed-app E2E results and remaining gaps.

Windows now implements display/window recording, pointer metadata, pause/resume,
system audio, microphone selection and voice processing, Studio editing, framed
MP4 export through 4K/60 fps, editable captions and SRT export.

## Build

Use Node 22+, pnpm 11, Rust stable, Microsoft C++ Build Tools with the Windows
SDK, WebView2, CMake and LLVM/libclang. Set `CMAKE` and `LIBCLANG_PATH` if these
tools are outside the default search paths. Run:

```powershell
pnpm install
pnpm setup:windows-speech
pnpm build:windows
```

The setup command downloads and verifies the 574 MB MIT-licensed Whisper
large-v3-turbo Q5 model. The installer includes this model: captions need no
runtime download or cloud service. Windows captions require an AVX2-class CPU
with FMA, F16C and BMI2 (checked before loading the recognizer).
Capture and export do not require AVX2. FFmpeg is only a development test tool.

## Verified on October 11, 2026

Test machine: Windows 11, Intel Core i5-1235U, integrated graphics.

| Area | Verification |
| --- | --- |
| Capture | Real display/window recordings, pointer log, pause/resume and stop |
| Audio | System playback and mixed microphone capture; one 48 kHz stereo AAC track, audible signal and video alignment |
| Export | Trim, animated crop, cursor, rounded mask and timed captions; H.264 High/AAC, silent input, invalid input rejection, 1080p/1440p/4K |
| Desktop | Actual WebView2 application: microphone selection, recording HUD, pause/resume, save, Studio caption editing and trimmed 1080p/60 MP4 + SRT export |
| Captions | Offline English and Vietnamese fixtures; timed UTF-8 words and persisted transcript |

After optimization, the original Vietnamese Google FLEURS sample had 3 word
errors out of 34 (8.8% WER), down from 4/34 (11.8%). Across the first three
`vi_vn` validation rows (IDs 1594, 1573, 1628), total errors decreased from
7/105 to 6/105 (6.7% to 5.7%). This small sample is not a general accuracy
guarantee; captions remain editable.

The same model now runs in approximately 26–28 seconds per tested 11–15-second
clip on this CPU, versus approximately 217–228 seconds in the earlier build.
An isolated sequential before/after run on the same English fixture measured
220.4 versus 27.1 seconds (8.1x faster), with the same recognized words;
punctuation differed. No smaller model or GPU was used for this comparison.
The main fix restores MSVC `/O2` optimization in Whisper's native C/C++ kernels:
cmake-rs otherwise overwrites CMake's Release defaults without optimization.
The target-specific `.cargo/windows-speech.cmake` applies the fix to both local
and CI builds. The Rust helper also favors speed over executable size. Fused
attention uses less intermediate memory and improved the first sample's
recognition, at a small CPU time cost versus optimized unfused attention
(approximately 24 versus 28 seconds). Word timestamps remain enabled.
The logged encoder compute buffer decreased from 212.31 MB to 55.35 MB;
these figures describe that buffer, not total application memory. The native
build script checks the actual Cargo dependency's CMake cache for `/O2`, and
the CI cache key includes `.cargo` configuration to avoid stale native builds.

Recognition still uses the CPU; GPU acceleration is not bundled. Performance
depends on hardware and recording length. macOS uses Apple's recognizer;
Windows uses Whisper, so recognition results and processing speed differ.

Windows renders the shared Studio frame plan using a CPU Lanczos compositor and
Media Foundation H.264 encoding. It re-encodes trimmed audio to AAC; macOS can
copy its original AAC track. Pixel-identical output across platforms is not
claimed. macOS native code was not changed or retested on this Windows machine.

## Reproduce

```powershell
pnpm typecheck
pnpm test
cargo test --manifest-path native/windows-capture/Cargo.toml
cargo test --lib --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm test:capture:windows
pnpm test:export:windows
# Set these to local English and Vietnamese speech WAV fixtures:
$env:SCREENSWAY_TEST_EN_AUDIO = 'C:\fixtures\english.wav'
$env:SCREENSWAY_TEST_VI_AUDIO = 'C:\fixtures\vietnamese.wav'
pnpm test:speech:windows
# Optional per-clip regression budget for this test machine:
$env:SCREENSWAY_TEST_MAX_SPEECH_SECONDS = '60'
pnpm test:speech:windows
```

Use an unlocked interactive desktop for capture tests and put FFmpeg/ffprobe on
PATH. The speech script's Vietnamese WER reference is the first `vi_vn`
validation row of `google/fleurs`; use that fixture for its accuracy assertion.
Speech tests save timings, WER and recognizer logs beside their temporary
transcripts. Clear `SCREENSWAY_TEST_MAX_SPEECH_SECONDS` on slower hardware.
After changing the CMake toolchain, clear stale native objects with
`cargo clean -p whisper-rs-sys --release --manifest-path native/windows-capture/Cargo.toml`.
No test recordings or speech fixtures are committed. The public Windows x64 download
is served by the landing page; its NSIS installer remains unsigned.

Final automated checks: 33 shared tests, 19 Windows native tests and 4 desktop
shell tests passed, along with workspace TypeScript checks. A regression test
also covers canonical Windows paths (`\\?\`), Unicode and UNC shares; the
native export test uses canonical source and destination paths, matching the
actual shell's recording paths.

Export decodes the recording to RGB32 through Media Foundation and reads each frame with
the buffer's own row pitch (`IMF2DBuffer::Lock2D`), cropped to the display aperture. H.264
pads sizes such as 1366 × 766 to 1376 × 768; reading those rows as tightly packed sheared
the picture into diagonal stripes in 0.4.1–0.4.2. `test:export:windows` exports a
1366 × 766 source and checks both halves of the picture at the top, middle and bottom.

GitHub's hosted Windows runner exposes D3D11 but returned `E_NOINTERFACE`
(`0x80004002`) for `ID3D11VideoDevice`. CI explicitly permits skipping native
export checks for this exact capability failure. Every other export failure
still fails CI; local export tests remain strict by default. Capture on hosted
runners is also best-effort. Real capture/export validation requires a Windows
PC with a usable interactive desktop and D3D11 video-processing support.
