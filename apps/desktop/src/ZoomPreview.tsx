import { convertFileSrc } from "@tauri-apps/api/core";
import {
  applyZoomStrength,
  buildViewPlan,
  DEFAULT_ZOOM_STRENGTH,
  cameraRect,
  captionAt,
  computeLayout,
  safeArea,
  keptDuration,
  keptRanges,
  type CameraOverlay,
  type CaptionLine,
  viewAt,
  samplePointer,
  sourceToOutputTime,
  type FrameLayout,
  type FrameSettings,
  type PointerEvent,
  type RecordingEdits,
  type Redaction,
  type KeystrokeEvent,
  type KeystrokeOverlay,
  type ZoomSegment,
} from "@screensway/core";
import { Pause, Play, RotateCcw, Volume2, VolumeX, ZoomIn } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDuration } from "./format";
import { CURSOR_PATH, paintFrameBase } from "./frame/paint";
import { Timeline } from "./frame/Timeline";
import { keystrokeAt, loadCaptionFont, paintCaption, paintKeystroke, type CaptionStyle } from "./frame/captionPaint";
import { useI18n } from "./i18n";
import { isWeb } from "./platform";

export interface RecordingResult {
  projectPath: string;
  videoPath: string;
  cameraPath?: string | null;
  /** How much later than the screen the camera started. */
  cameraOffsetMs?: number;
  pointerEventsPath: string;
  keystrokesPath: string;
  durationMs: number;
  width: number;
  height: number;
  pointerEvents: PointerEvent[];
  keystrokes: KeystrokeEvent[];
}

const CLICK_RIPPLE_MS = 550;
/** Cursor and ripple widths in percent of the video at 1×, as in styles.css. */
const CURSOR_WIDTH_PERCENT = 1.9;
const RIPPLE_WIDTH_PERCENT = 4.5;

function hasAudioTrack(video: HTMLVideoElement): boolean {
  const tracks = (video as HTMLVideoElement & { audioTracks?: { length: number } }).audioTracks;
  return tracks ? tracks.length > 0 : true;
}

interface ZoomPreviewProps {
  recording: RecordingResult;
  settings: FrameSettings;
  backgroundImage: HTMLImageElement | null;
  autoZoom: boolean;
  onAutoZoomChange: (autoZoom: boolean) => void;
  edits: RecordingEdits;
  onEditsChange: (update: (edits: RecordingEdits) => RecordingEdits) => void;
  /** The zooms in effect and the kept range, resolved from the edits by the studio. */
  zooms: ZoomSegment[];
  /** How deep every zoom plays (`applyZoomStrength`), and where the timeline changes it. */
  zoomStrength?: number;
  onZoomStrengthChange?: (strength: number) => void;
  range: { startMs: number; endMs: number };
  /** Captions to show, or null when they are off. */
  captions: { lines: CaptionLine[]; style: CaptionStyle } | null;
  /** Lets the studio move the playhead, e.g. from the caption list. */
  seekRef?: { current: ((timeMs: number) => void) | null };
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  redactions?: Redaction[];
  keystrokeOverlay?: KeystrokeOverlay;
  /** The webcam's placement; dragging it in the preview moves it. */
  cameraOverlay?: CameraOverlay;
  onCameraChange?: (overlay: CameraOverlay) => void;
  /** The brand logo over the frame; `rect` places it on a layout in output pixels. */
  /** Where playback starts instead of the start of the kept part. */
  startAtMs?: number;
  logo?: { src: string; rect: (layout: FrameLayout) => { x: number; y: number; width: number; height: number } } | null;
}

export function ZoomPreview({
  recording,
  settings,
  backgroundImage,
  autoZoom,
  onAutoZoomChange,
  edits,
  onEditsChange,
  zooms,
  zoomStrength = DEFAULT_ZOOM_STRENGTH,
  onZoomStrengthChange,
  range,
  captions,
  seekRef,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  redactions = [],
  keystrokeOverlay,
  cameraOverlay,
  onCameraChange,
  logo,
  startAtMs,
}: ZoomPreviewProps) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLSpanElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const scrubberRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const captionCanvasRef = useRef<HTMLCanvasElement>(null);
  const keystrokeRef = useRef<HTMLCanvasElement>(null);
  const shownKey = useRef<KeystrokeEvent | null | undefined>(undefined);
  const cameraRef = useRef<HTMLVideoElement>(null);
  const cameraDrag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const showCamera = Boolean(recording.cameraPath && cameraOverlay?.visible);
  // Read by the frame loop, so moving a trim handle never restarts playback.
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const ranges = useMemo(() => keptRanges(edits, recording.durationMs), [edits, recording.durationMs]);
  const rangesRef = useRef(ranges);
  rangesRef.current = ranges;
  const scrubbingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [durationMs, setDurationMs] = useState(recording.durationMs);

  const { pointerEvents: events, width, height } = recording;
  // In the browser version the real pointer is part of the video and clicks are unknown.
  const clicks = useMemo(() => (isWeb ? [] : events.filter((event) => event.type !== "move")), [events]);
  // Proportions only; the canvas is painted at the stage's real pixel size below.
  const layout = useMemo(() => computeLayout(settings, { width, height }), [settings, width, height]);
  // The export's own view plan, so zooms and the follow of a filled frame match it exactly.
  const plan = useMemo(
    () => buildViewPlan(events, applyZoomStrength(zooms, zoomStrength), { width, height }, layout, durationMs + 1_000, edits.framing),
    [events, zooms, zoomStrength, width, height, layout, durationMs, edits.framing],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // The same painter draws the exported frame, so the preview shows exactly what you get.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || stageSize.width === 0) return;
    const shortSide = Math.min(stageSize.width, stageSize.height) * window.devicePixelRatio;
    const previewLayout = computeLayout(settings, { width, height }, shortSide);
    canvas.width = previewLayout.width;
    canvas.height = previewLayout.height;
    const context = canvas.getContext("2d");
    if (context) paintFrameBase(context, previewLayout, settings, backgroundImage);
  }, [backgroundImage, height, settings, stageSize, width]);

  // Captions are painted by the export's own function onto a canvas over the stage,
  // so the preview shows exactly the exported text, size and position.
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => void loadCaptionFont().then(() => setFontReady(true)), []);
  const shownCaption = useRef("");
  const drawCaption = useMemo(() => {
    return (line: CaptionLine | null) => {
      const canvas = captionCanvasRef.current;
      if (!canvas || stageSize.width === 0) return;
      // Style, layout and size changes create a new painter, which marks the overlay stale.
      const key = line && captions ? `${line.id}|${line.text}` : "";
      if (key === shownCaption.current) return;
      shownCaption.current = key;
      const scale = window.devicePixelRatio;
      canvas.width = Math.round(stageSize.width * scale);
      canvas.height = Math.round(stageSize.height * scale);
      const context = canvas.getContext("2d")!;
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (!line || !captions) return;
      const previewLayout = computeLayout(settings, { width, height }, Math.min(canvas.width, canvas.height));
      const painted = paintCaption(line.text, previewLayout, captions.style);
      if (painted) context.drawImage(painted.canvas, painted.x * (canvas.width / previewLayout.width), painted.y * (canvas.height / previewLayout.height), painted.canvas.width * (canvas.width / previewLayout.width), painted.canvas.height * (canvas.height / previewLayout.height));
    };
    // fontReady redraws once the bundled font is available.
  }, [captions, fontReady, height, settings, stageSize, width]);
  // Redraw at once when the captions or their style change, even while paused.
  useEffect(() => {
    shownCaption.current = "stale";
    const timeMs = (videoRef.current?.currentTime ?? 0) * 1_000;
    drawCaption(captions ? captionAt(captions.lines, timeMs) : null);
  }, [captions, drawCaption]);

  // Shortcut keys use the export's painter too, on their own canvas.
  const drawKeystroke = useMemo(() => {
    shownKey.current = undefined;
    return (key: KeystrokeEvent | null) => {
      const canvas = keystrokeRef.current;
      if (!canvas || stageSize.width === 0 || key === shownKey.current) return;
      shownKey.current = key;
      const scale = window.devicePixelRatio;
      canvas.width = Math.round(stageSize.width * scale);
      canvas.height = Math.round(stageSize.height * scale);
      const context = canvas.getContext("2d")!;
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (!key || !keystrokeOverlay) return;
      const previewLayout = computeLayout(settings, { width, height }, Math.min(canvas.width, canvas.height));
      const painted = paintKeystroke(key.keys, previewLayout, keystrokeOverlay);
      const ratio = canvas.width / previewLayout.width;
      context.drawImage(painted.canvas, painted.x * ratio, painted.y * ratio, painted.canvas.width * ratio, painted.canvas.height * ratio);
    };
    // fontReady redraws once the bundled font is available.
  }, [fontReady, height, keystrokeOverlay, settings, stageSize, width]);

  const percent = (value: number, total: number) => `${(value / total) * 100}%`;
  // Where social apps put their buttons on a vertical video; shown while paused.
  const safe = safeArea(layout);
  const cornerRadius = (layout.videoRadius / layout.width) * stageSize.width;

  // Camera, cursor and progress are written straight to the DOM on every display frame,
  // so motion stays at the screen's refresh rate instead of React's render cadence.
  // While paused nothing moves, so the loop does no work and scrolling stays smooth.
  useEffect(() => {
    let frame = 0;
    let shown = "";
    let shownTime = "";
    const videoWidth = (layout.video.width / layout.width) * stageSize.width;
    const videoHeight = (layout.video.height / layout.height) * stageSize.height;
    const render = () => {
      frame = requestAnimationFrame(render);
      const video = videoRef.current;
      const content = contentRef.current;
      if (!video || !content) return;

      const { startMs, endMs } = rangeRef.current;
      const kept = rangesRef.current;
      const rawTime = video.currentTime * 1_000;
      const activeRange = kept.find((item) => rawTime >= item.startMs && rawTime < item.endMs);
      if (!video.seeking && !activeRange && rawTime >= startMs && rawTime < endMs) {
        const next = kept.find((item) => item.startMs > rawTime);
        if (next) {
          video.currentTime = next.startMs / 1_000;
          return;
        }
        // Cut to the end: the video ends where the last kept part does.
        const last = kept.at(-1);
        if (last) {
          video.pause();
          // Just inside the last kept part, so its final frame shows and Play starts over.
          video.currentTime = Math.max(last.startMs, last.endMs - 20) / 1_000;
          return;
        }
      }
      // Play only the kept part: stop at its end and never show what was trimmed away.
      if (!video.paused && video.currentTime * 1_000 >= endMs) {
        video.pause();
        video.currentTime = endMs / 1_000;
      } else if (!video.seeking && video.currentTime * 1_000 < startMs - 40) {
        video.currentTime = startMs / 1_000;
      }
      const timeMs = Math.min(endMs, Math.max(startMs, video.currentTime * 1_000));
      // A faster or slower part plays at its speed, without its sound, as in the export.
      const rate = activeRange?.rate ?? 1;
      if (video.playbackRate !== rate) video.playbackRate = rate;
      const volume = rate === 1 ? 1 : 0;
      if (video.volume !== volume) video.volume = volume;
      // The camera file follows the screen; it only needs a nudge when it drifts.
      const webcam = cameraRef.current;
      if (webcam && webcam.playbackRate !== rate) webcam.playbackRate = rate;
      if (webcam && webcam.readyState > 0) {
        const target = Math.max(0, video.currentTime - (recording.cameraOffsetMs ?? 0) / 1_000);
        if (!webcam.seeking && Math.abs(webcam.currentTime - target) > (video.paused ? 0.03 : 0.15)) webcam.currentTime = target;
        if (video.paused !== webcam.paused) void (video.paused ? webcam.pause() : webcam.play().catch(() => {}));
      }
      const state = `${timeMs}|${startMs}|${endMs}`;
      if (state === shown) return;
      shown = state;
      const view = viewAt(plan, timeMs, { width, height }, autoZoom);
      // The content is the whole recording stretched over the video area; scaling it shows the view.
      const scaleX = width / view.width;
      const scaleY = height / view.height;
      const offsetX = -(view.x / width) * scaleX * 100;
      const offsetY = -(view.y / height) * scaleY * 100;
      content.style.transform = `translate3d(${offsetX}%, ${offsetY}%, 0) scale(${scaleX}, ${scaleY})`;
      // Recording pixels are this much larger than at 1× in a frame of the recording's shape.
      const magnification = scaleX;

      // The cursor and ripple sit above the zoomed content instead of inside it and are
      // sized by the zoom, so they are drawn sharp at every zoom level. Scaling them with the
      // content's transform shows a stretched low-resolution copy in Chromium (WebView2).
      const toStageX = (x: number) => ((x - view.x) / view.width) * videoWidth;
      const toStageY = (y: number) => ((y - view.y) / view.height) * videoHeight;
      const pointer = isWeb ? null : samplePointer(events, timeMs);
      const cursor = cursorRef.current;
      if (cursor) {
        cursor.style.opacity = pointer ? "1" : "0";
        if (pointer) {
          cursor.style.width = `${CURSOR_WIDTH_PERCENT * magnification}%`;
          cursor.style.transform = `translate3d(${toStageX(pointer.x)}px, ${toStageY(pointer.y)}px, 0)`;
        }
      }

      const ripple = rippleRef.current;
      let click: PointerEvent | undefined;
      for (const event of clicks) {
        if (event.timeMs > timeMs) break;
        click = event;
      }
      const clickAge = click ? timeMs - click.timeMs : Infinity;
      if (ripple && click && clickAge < CLICK_RIPPLE_MS) {
        const progress = clickAge / CLICK_RIPPLE_MS;
        ripple.style.opacity = String(1 - progress);
        ripple.style.width = `${RIPPLE_WIDTH_PERCENT * magnification}%`;
        ripple.style.transform = `translate3d(${toStageX(click.x)}px, ${toStageY(click.y)}px, 0) translate(-50%, -50%) scale(${0.4 + progress * 0.9})`;
      } else if (ripple) {
        ripple.style.opacity = "0";
      }

      const outputDuration = Math.max(1, keptDuration(kept));
      const outputTime = sourceToOutputTime(kept, timeMs);
      if (progressRef.current) progressRef.current.style.width = `${Math.min(100, (outputTime / outputDuration) * 100)}%`;
      if (scrubberRef.current && !scrubbingRef.current) scrubberRef.current.value = String(timeMs);
      const time = `${formatDuration(outputTime)} / ${formatDuration(outputDuration)}`;
      if (timeRef.current && time !== shownTime) {
        timeRef.current.textContent = time;
        shownTime = time;
      }
      drawCaption(captions ? captionAt(captions.lines, timeMs) : null);
      drawKeystroke(keystrokeOverlay?.enabled ? keystrokeAt(recording.keystrokes ?? [], timeMs) : null);
      if (playheadRef.current) playheadRef.current.style.left = `${(timeMs / Math.max(1, recording.durationMs)) * 100}%`;
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [autoZoom, captions, clicks, drawCaption, drawKeystroke, durationMs, events, height, keystrokeOverlay, layout, plan, recording.cameraOffsetMs, recording.durationMs, recording.keystrokes, stageSize, width]);

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      const { startMs, endMs } = rangeRef.current;
      const keptEnd = rangesRef.current.at(-1)?.endMs ?? endMs;
      if (video.ended || video.currentTime * 1_000 >= Math.min(endMs, keptEnd) - 30) video.currentTime = startMs / 1_000;
      void video.play();
    } else {
      video.pause();
    }
  }

  function seek(value: string) {
    if (videoRef.current) videoRef.current.currentTime = Number(value) / 1_000;
  }
  if (seekRef) seekRef.current = (timeMs) => seek(String(timeMs));

  return (
    <div className="player">
      <div
        className="player-backdrop"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.code === "Space") {
            event.preventDefault();
            togglePlayback();
          }
        }}
      >
        <div
          className="player-stage"
          ref={stageRef}
          style={{
            aspectRatio: `${layout.width} / ${layout.height}`,
            width: `min(100%, calc(56vh * ${layout.width / layout.height}))`,
          }}
          onClick={togglePlayback}
        >
          <canvas className="frame-canvas" ref={canvasRef} aria-hidden="true" />
          <div
            className="frame-video"
            style={{
              left: percent(layout.video.x, layout.width),
              top: percent(layout.video.y, layout.height),
              width: percent(layout.video.width, layout.width),
              height: percent(layout.video.height, layout.height),
              borderRadius: layout.roundVideoTop ? `${cornerRadius}px` : `0 0 ${cornerRadius}px ${cornerRadius}px`,
            }}
          >
          <div className="player-content" ref={contentRef}>
            <video
              ref={videoRef}
              src={convertFileSrc(recording.videoPath)}
              playsInline
              preload="auto"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                if (Number.isFinite(video.duration)) setDurationMs(video.duration * 1_000);
                const { startMs, endMs } = rangeRef.current;
                video.currentTime = (startAtMs !== undefined && startAtMs >= startMs && startAtMs < endMs ? startAtMs : startMs) / 1_000;
                setHasAudio(hasAudioTrack(video));
                // Autoplay with sound can be refused; fall back to muted playback rather than none.
                void video.play().catch(() => {
                  video.muted = true;
                  setMuted(true);
                  void video.play().catch(() => {});
                });
              }}
            />
            {redactions.map((item) => (
              <span key={item.id} className={`preview-redaction ${item.mode}`} style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%`, width: `${item.width * 100}%`, height: `${item.height * 100}%` }} />
            ))}
          </div>
          <span className="click-ripple" ref={rippleRef} />
          <div className="player-cursor" ref={cursorRef}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d={CURSOR_PATH}
                fill="#111"
                stroke="#fff"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          </div>
          <canvas className="frame-canvas caption-canvas" ref={captionCanvasRef} aria-hidden="true" />
          {logo && (() => {
            const box = logo.rect(layout);
            return <img className="preview-logo" src={logo.src} alt="" style={{ left: percent(box.x, layout.width), top: percent(box.y, layout.height), width: percent(box.width, layout.width), height: percent(box.height, layout.height) }} />;
          })()}
          {showCamera && cameraOverlay && (() => {
            const box = cameraRect(cameraOverlay, layout.width, layout.height);
            return (
              <video
                ref={cameraRef}
                className="preview-camera"
                src={convertFileSrc(recording.cameraPath!)}
                muted
                playsInline
                preload="auto"
                style={{
                  left: percent(box.x, layout.width),
                  top: percent(box.y, layout.height),
                  width: percent(box.width, layout.width),
                  height: percent(box.height, layout.height),
                  borderRadius: `${(box.radius / box.width) * 100}% / ${(box.radius / box.height) * 100}%`,
                  transform: cameraOverlay.mirror ? "scaleX(-1)" : undefined,
                }}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  cameraDrag.current = { x: event.clientX, y: event.clientY, moved: false };
                }}
                onPointerMove={(event) => {
                  const drag = cameraDrag.current;
                  const stage = stageRef.current;
                  if (!drag || !stage || !onCameraChange) return;
                  const bounds = stage.getBoundingClientRect();
                  const dx = (event.clientX - drag.x) / bounds.width;
                  const dy = (event.clientY - drag.y) / bounds.height;
                  if (!drag.moved && Math.hypot(dx * bounds.width, dy * bounds.height) < 3) return;
                  cameraDrag.current = { x: event.clientX, y: event.clientY, moved: true };
                  const half = { x: box.width / layout.width / 2, y: box.height / layout.height / 2 };
                  onCameraChange({
                    ...cameraOverlay,
                    x: Math.min(1 - half.x, Math.max(half.x, (box.x + box.width / 2) / layout.width + dx)),
                    y: Math.min(1 - half.y, Math.max(half.y, (box.y + box.height / 2) / layout.height + dy)),
                  });
                }}
                onPointerUp={() => { cameraDrag.current = null; }}
                aria-label={t("camera.drag")}
              />
            );
          })()}
          <canvas className="frame-canvas caption-canvas" ref={keystrokeRef} aria-hidden="true" />
          {safe.bottom > 0 && !playing && (
            <>
              <span className="safe-zone top" style={{ height: percent(safe.top, layout.height) }} aria-hidden="true" />
              <span className="safe-zone bottom" style={{ height: percent(safe.bottom, layout.height) }} title={t("preview.safeZone")} aria-hidden="true" />
            </>
          )}
          {!playing && (
            <span className="play-overlay" aria-hidden="true">
              <Play size={22} fill="currentColor" />
            </span>
          )}
        </div>
      </div>

      <div className="player-controls">
        <button className="player-button" onClick={togglePlayback} aria-label={playing ? t("player.pause") : t("player.play")}>
          {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
        </button>
        <button
          className="player-button"
          onClick={() => {
            seek(String(range.startMs));
            void videoRef.current?.play();
          }}
          aria-label={t("player.replay")}
        >
          <RotateCcw size={14} />
        </button>
        {hasAudio && (
          <button
            className="player-button"
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              video.muted = !video.muted;
              setMuted(video.muted);
            }}
            aria-label={muted ? t("player.unmute") : t("player.mute")}
            aria-pressed={muted}
          >
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
        )}
        <div className="scrubber">
          <div className="scrubber-track">
            {autoZoom && zooms.map((segment) => {
              const kept = Math.max(1, range.endMs - range.startMs);
              const start = Math.max(segment.startMs, range.startMs);
              const end = Math.min(segment.endMs, range.endMs);
              if (end <= start) return null;
              return (
                <span
                  key={segment.id}
                  className="scrubber-zoom"
                  style={{ left: `${((start - range.startMs) / kept) * 100}%`, width: `${((end - start) / kept) * 100}%` }}
                />
              );
            })}
            <div className="scrubber-progress" ref={progressRef} />
          </div>
          <input
            ref={scrubberRef}
            type="range"
            min={range.startMs}
            max={range.endMs}
            step={1}
            defaultValue={0}
            aria-label={t("player.seek")}
            onPointerDown={() => (scrubbingRef.current = true)}
            onPointerUp={() => (scrubbingRef.current = false)}
            onInput={(event) => seek(event.currentTarget.value)}
          />
        </div>
        <span className="player-time" ref={timeRef}>0:00 / {formatDuration(keptDuration(ranges))}</span>
        <button
          className={`zoom-toggle${autoZoom ? " active" : ""}`}
          onClick={() => onAutoZoomChange(!autoZoom)}
          aria-pressed={autoZoom}
        >
          <ZoomIn size={14} /> {t("player.autoZoom")}
        </button>
      </div>

      <Timeline
        durationMs={recording.durationMs}
        canvas={{ width, height }}
        events={events}
        edits={edits}
        range={range}
        zooms={zooms}
        zoomEnabled={autoZoom}
        zoomStrength={zoomStrength}
        onZoomStrengthChange={onZoomStrengthChange}
        onChange={onEditsChange}
        onSeek={(timeMs) => seek(String(timeMs))}
        currentTimeMs={() => (videoRef.current?.currentTime ?? 0) * 1_000}
        playheadRef={playheadRef}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={onUndo}
          onRedo={onRedo}
        framingEnabled={plan.follow !== null}
      />
    </div>
  );
}
