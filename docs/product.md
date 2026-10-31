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

- First-run permission preflight, a ten-second test recording, and a setup flow that can be reopened from Settings.
- Record a display, an application window or a cropped display region, with optional system audio and microphone (pick the device; the voice is leveled and background noise is lowered between phrases). Pause and resume without keeping the paused interval.
- Start quickly from a configurable global shortcut or the persistent menu bar/tray entry, using a compact source picker that remembers the last choices.
- Low-disk preflight and interrupted-project recovery after an app or helper crash.
- 3-second countdown and floating controls that stay out of the video; macOS also provides a menu bar timer.
- Studio preview with automatic, spring-based zoom and pan that follows clicks, a smooth re-rendered cursor and click ripples.
- Styles: built-in looks (Studio, Clean, MacBook, Website, Social) and your own saved styles, applied in one click.
- Frame customization: a library of mesh, linear and wave backgrounds, solid colors and a custom two-color gradient, your own images (kept in Movies › ScreenSway › Backgrounds for reuse) with blur, a Magic background built from the recording's colors, film grain; macOS light/dark, browser light/dark (with address bar), MacBook, glass and outline frames; aspect presets (auto, 16:9, 4:3, 1:1, 9:16), padding, corners and shadow.
- Timeline: trim the start and end, remove middle ranges, undo/redo, move, resize, add or remove zooms and set each zoom's depth, or make every zoom calmer or deeper at once ("All zooms", 25–150 %, remembered for new recordings); play parts faster or slower (0.5×, 1.5×, 2×, 4×, 8×; their sound is left out of the export, so picture and sound stay in step); edits are saved with the recording and can be reset to the automatic zooms.
- Captions: on-device speech recognition (Vietnamese and English), balanced caption lines you can edit, remove spoken ranges with the matching video, review locally detected silence, three sizes and three looks, burned into the export plus an .srt file next to the video.
- Privacy and teaching overlays: editable blur/solid regions that remain attached through zooms, plus opt-in shortcut-chord capture (off by default; Input Monitoring on macOS) stored as metadata with position, size and light/dark controls. Ordinary typing is not stored.
- Webcam as a separate track: pick a camera before recording; afterwards show or hide it, drag it in the preview, choose circle or rounded, size and mirror. Optional speaker-echo removal for recording without headphones (macOS voice processing; Windows communications mode where the device supports it).
- Filled 9:16 and 1:1 frames whose view follows the pointer, with held-framing segments on the timeline and safe zones that keep captions and shortcut keys clear of social apps' buttons.
- Brand kit: a logo in a corner and intro/outro title cards on the style's background, saved on the computer and added to every export.
- After exporting: small or sharp GIFs with a size estimate, copying the video or GIF to the clipboard, and export presets (docs, social, square, plus saved ones). Exports can go to any folder, such as one synced by iCloud Drive, Dropbox or OneDrive.
- Import an existing MP4/MOV into the Studio (zooms by hand, since it has no pointer data); search the library by what was said, opening at that moment; suggested name and chapters from the captions, editable, copied as YouTube chapters.
- Automation links: `screensway://record`, `open` and `export` for scripts and launchers; a link always asks before recording.
- Export to MP4 at 1080p, 1440p or 4K, 60 fps, with zoom, cursor, frame and audio.
- A searchable local library with inline rename, confirmed deletion and hover scrubbing; Vietnamese and English UI; Retina/standard display hints.
- A browser version (beta) at `/app/` for Chrome and Edge on a computer: record a screen, window or tab with tab audio and microphone, automatic zooms where the pointer settles (browsers do not expose clicks), the same Studio styles, frames, timeline and trim, and MP4 export up to 4K (a 60 fps file from a 30 fps capture). No captions, library or pause yet; see [web-studio.md](web-studio.md).
- Public macOS universal and Windows x64 downloads. Windows provides the same capture, audio, Studio editing, MP4/SRT export and offline editable captions workflow; platform-specific implementation details and requirements are documented in [windows-validation.md](windows-validation.md).

## Roadmap

Ordered by expected impact on activation, successful exports, sharing and repeat use. Each phase should ship as a small complete workflow before work starts on the next one.

Status: items 2–15 shipped in 0.4.0 (2026-10-21) on macOS and Windows (see "What ships today"); item 1 is deliberately postponed. Scope notes where the first version is narrower than the item: intro/outro pieces are title cards rather than video clips; user-owned sharing is a chosen export folder (synced or network) without provider links; automation is a URL scheme rather than a CLI; Windows echo removal depends on the device's voice processing. New Windows capture paths (camera, shortcut keys, regions, echo mode) still need the manual pass on a Windows PC described in `windows-release-test-plan.md`.

### Now — make the first successful recording effortless

1. **Trusted installation.** Notarize and Developer ID-sign the macOS build, and code-sign the Windows installer. Preserve signed in-app updates on both platforms. This removes the largest first-launch trust warning before adding acquisition features.
2. **First-run onboarding and capture preflight.** Explain the three local permissions, request them only when needed, show whether screen, microphone and speech access are ready, and offer a ten-second test recording. Let users retry a failed permission without restarting the app.
3. **Quick record.** Add a configurable global shortcut and menu bar/tray entry that opens a compact source picker, remembers the last source and audio choices, and starts the countdown without navigating through the library.
4. **Recording resilience.** Warn before recording when free disk space is low, recover an interrupted project after an app or helper crash, and make partial recordings visible in the library with a clear repair or discard action.

Success signals: install-to-first-recording conversion, permission recovery rate, successful recordings divided by recording starts, and median time from launch to recording.

### Next — remove mistakes without leaving ScreenSway

5. **Middle cuts with undo and redo.** Allow splitting the timeline and removing any range while keeping video, audio, pointer events, zooms and captions aligned. Add keyboard shortcuts and a non-destructive edit history before introducing automatic cuts.
6. **Transcript editing and silence cleanup.** Use the existing timed words to remove a spoken range by deleting text, detect long pauses locally, and let users review suggested cuts or speed idle stretches up. Never apply destructive automatic edits without a preview.
7. **Capture region and privacy tools.** Record a selected area as well as a display or window. Add editable blur/redaction regions that can follow a fixed screen area through zooms, with an option to hide desktop icons and notifications before recording.
8. **Keystroke overlay.** Record shortcuts as metadata, ignore ordinary typing by default, and let users choose command-only or all-key display, position, size and light/dark style. Clearly indicate when key capture is active and never store password-field input.

Success signals: share of recordings edited, exports completed without opening another editor, undo usage after cuts, and median time from recording stop to export.

### Then — add presence and make every format shareable

9. **Webcam as a separate editable track.** Record the camera independently so it can be moved, resized, cropped, rounded or hidden after recording. Add optional echo cancellation and keep screen-only recording just as lightweight.
10. **Smarter vertical output.** Turn the existing 9:16 canvas into an action-following layout with safe zones for captions and webcam. Let users correct the subject position at any point on the timeline.
11. **Fast sharing outputs.** Add GIF export with duration and size estimates, copy a compressed video or GIF to the clipboard, and provide reusable export presets for documentation, social posts and messaging apps.
12. **Reusable project pieces.** Let users save intro/outro clips, logos and brand styles locally, then insert them without re-recording. Support importing an existing screen recording into Studio when pointer-aware zoom is not required.

Success signals: webcam adoption, vertical and GIF export share, repeat exports from saved presets, and recordings created per active device.

### Later — deepen the local-first advantage

13. **Local search across speech.** Index transcripts on-device so the library can find a recording and jump to the matching spoken moment. Offer automatic local titles and chapters as editable suggestions.
14. **Optional user-owned sharing.** Export directly to a folder, network drive or user-configured storage provider and copy a link when that provider supports one. ScreenSway should not require an account or operate a mandatory video cloud.
15. **Automation surface.** Add URL schemes or a small local CLI for starting a configured recording, opening a project and exporting with a saved preset. Keep every automated action visible and cancellable in the app.

### Product guardrails

- Keep recording, transcription, editing and rendering local. Network features must be optional and explicit.
- Store camera, keystrokes, cuts, redactions and other new inputs as editable project data rather than burning them into the source recording.
- Maintain preview/export parity through the shared core render plan and support macOS and Windows before calling a workflow shipped.
- Prefer reviewable suggestions over irreversible automation. Every automatic cut, crop, zoom and title remains editable.
- Do not add accounts, watermarks or export limits to unlock core features.

Growth is measured without breaking the privacy promise: cookie-free visit and download counts on the landing page, opt-in anonymous feature statistics in the app, and anonymous requests to the static update manifest as a proxy for active users. The private dashboard and event definitions are documented in `analytics.md`; recording content is never part of them.
