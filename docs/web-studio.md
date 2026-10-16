# Browser version (beta)

`apps/studio-web` lets people record and edit without installing anything. It is served next to the landing page at `/app/` (`web.yml` builds it into `apps/web/dist/app`), and the hero links to it. It needs Chrome or Edge on a computer; other browsers and phones see a card that points to the desktop app.

## What it reuses

The studio is the desktop one. `src/main.tsx` renders the desktop `I18nProvider`, styles and `RecordingStudio` (preview, styles, backgrounds, frames, timeline, trim, zoom editing, export button). `vite.config.ts` aliases `@tauri-apps/api/core` and `@tauri-apps/api/event` to `src/tauri/`, so the studio's commands are answered in the browser by `src/backend.ts`, and it defines `__SCREENSWAY_WEB__`, which sets `isWeb` in `apps/desktop/src/platform.ts`. With `isWeb`:

- the preview does not draw a cursor or click ripples, because the real pointer is already in the video;
- the captions panel and "Show in Finder" are hidden, export results show the file's frame rate and "Download again";
- `enWeb`/`viWeb` in `i18n.tsx` replace wording about the Mac, clicks and folders. New `web.*` strings live there too; keep English and Vietnamese in sync.

Edits, background images and recordings stay in memory for the tab; closing it asks first (`beforeunload`).

## Recording

`src/recorder.ts` asks for the microphone first, then `getDisplayMedia` (screen, window or tab; at most 2560 × 1600, 30 fps, `cursor: "always"`). Audio from the shared surface and the microphone are mixed by Web Audio into one track. `MediaRecorder` writes MP4 (H.264/AAC) when the browser supports it, otherwise WebM. Chromium can share the sound of a tab, and of the whole computer on Windows; on macOS only tab audio is available.

## Following the pointer

Browsers never say where the pointer is or when it clicks. A clone of the video track is read with `MediaStreamTrackProcessor` in a worker (`src/pointer/worker.ts`), which keeps running while the tab is in the background. Frames are analysed at most 1600 px wide by `PointerTracker` (`src/pointer/tracker.ts`):

1. It compares each frame with the previous one and groups the changed pixels.
2. When two small changes look like "the pointer left here and arrived there" (the new place shows what the old place showed a frame earlier), the arrived shape is a candidate template. Shape, color and size are learned, so custom pointer colors, hands and I-beams all work.
3. A shape is trusted only after a chain of three such moves, each starting where the last one ended. Animated content (video, wallpapers, spinners) changes in small pairs too, but stays in place.
4. Trusted shapes are searched for where the frame changed, nearest to the last position first. When nothing changes around the pointer it is still there; when it is lost, one band of the frame is searched per frame.

`src/pointer/focus.ts` turns the positions into the studio's pointer events: `move` events, plus a `focus` event wherever the pointer settles for 0.5 s after travelling 8% of the width. Focus events start zooms like clicks do (`generateZoomSegments` treats every non-move event the same).

Measured on a real 35 s recording (Retina, animated Edge wallpaper) with the real pointer path drawn back in, after the first lock (under 1 s): 95–98% of frames within 2% of the width, median error 2 px, for arrow, hand and I-beam pointers; ~3 ms per frame in a worker. Clicks cannot be inferred reliably (about half found, many false), which is why zooms follow stops instead. Focus zooms covered all but 1 s of the zoomed time click zooms would have, plus about 13 s more; people remove extra zooms on the timeline.

## Export

`src/exporter.ts` decodes the recording with mediabunny (`1.60.0`, pinned), paints each frame like the desktop helper (the studio's base layer, then the zoomed crop inside the rounded video area), encodes H.264 with WebCodecs and muxes MP4 with the trimmed audio (AAC, or Opus where AAC is unavailable). It runs faster than real time and the file is downloaded. Captions are not offered on the web yet.

## Privacy

Nothing is uploaded and the page sends no statistics: `track_event` is a no-op and `telemetry_status` reports statistics as unavailable.

## Validation

`pnpm --filter @screensway/studio-web typecheck`, `pnpm --filter @screensway/studio-web test` (tracker on synthetic frames, focus detection) and `pnpm build:studio-web`. For a full run without a screen-sharing prompt, replace `navigator.mediaDevices.getDisplayMedia` in a test page with `captureStream()` of a video that contains a pointer, and drive Edge with Playwright (`--use-fake-device-for-media-stream` for the microphone); this exercises recording, the worker, the studio and export end to end. Pointer accuracy can be scored against a ScreenSway recording's `pointer-events.json` drawn back into its video with ffmpeg.
