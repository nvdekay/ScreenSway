import { convertFileSrc } from "@tauri-apps/api/core";
import {
  buildCameraTrack,
  computeLayout,
  sampleCameraTrack,
  samplePointer,
  type FrameSettings,
  type PointerEvent,
  type RecordingEdits,
  type ZoomSegment,
} from "@screensway/core";
import { Pause, Play, RotateCcw, Volume2, VolumeX, ZoomIn } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDuration } from "./format";
import { CURSOR_PATH, paintFrameBase } from "./frame/paint";
import { Timeline } from "./frame/Timeline";
import { useI18n } from "./i18n";

export interface RecordingResult {
  projectPath: string;
  videoPath: string;
  pointerEventsPath: string;
  durationMs: number;
  width: number;
  height: number;
  pointerEvents: PointerEvent[];
}

const CLICK_RIPPLE_MS = 550;
const FULL_FRAME = { x: 0.5, y: 0.5, scale: 1 };

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
  range: { startMs: number; endMs: number };
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
  range,
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
  // Read by the frame loop, so moving a trim handle never restarts playback.
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const scrubbingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [durationMs, setDurationMs] = useState(recording.durationMs);

  const { pointerEvents: events, width, height } = recording;
  const clicks = useMemo(() => events.filter((event) => event.type !== "move"), [events]);
  const track = useMemo(
    () => buildCameraTrack(events, zooms, { width, height }, durationMs + 1_000),
    [events, zooms, width, height, durationMs],
  );
  // Proportions only; the canvas is painted at the stage's real pixel size below.
  const layout = useMemo(() => computeLayout(settings, { width, height }), [settings, width, height]);

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

  const percent = (value: number, total: number) => `${(value / total) * 100}%`;
  const cornerRadius = (layout.videoRadius / layout.width) * stageSize.width;

  // Camera, cursor and progress are written straight to the DOM on every display frame,
  // so motion stays at the screen's refresh rate instead of React's render cadence.
  useEffect(() => {
    let frame = 0;
    const render = () => {
      frame = requestAnimationFrame(render);
      const video = videoRef.current;
      const content = contentRef.current;
      if (!video || !content) return;

      const { startMs, endMs } = rangeRef.current;
      // Play only the kept part: stop at its end and never show what was trimmed away.
      if (!video.paused && video.currentTime * 1_000 >= endMs) {
        video.pause();
        video.currentTime = endMs / 1_000;
      } else if (!video.seeking && video.currentTime * 1_000 < startMs - 40) {
        video.currentTime = startMs / 1_000;
      }
      const timeMs = Math.min(endMs, Math.max(startMs, video.currentTime * 1_000));
      const camera = autoZoom ? sampleCameraTrack(track, timeMs) : FULL_FRAME;
      const offsetX = (0.5 - camera.x * camera.scale) * 100;
      const offsetY = (0.5 - camera.y * camera.scale) * 100;
      content.style.transform = `translate3d(${offsetX}%, ${offsetY}%, 0) scale(${camera.scale})`;

      const stageWidth = content.clientWidth;
      const stageHeight = content.clientHeight;
      const pointer = samplePointer(events, timeMs);
      const cursor = cursorRef.current;
      if (cursor) {
        cursor.style.opacity = pointer ? "1" : "0";
        if (pointer) {
          cursor.style.transform = `translate3d(${(pointer.x / width) * stageWidth}px, ${(pointer.y / height) * stageHeight}px, 0)`;
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
        ripple.style.transform = `translate3d(${(click.x / width) * stageWidth}px, ${(click.y / height) * stageHeight}px, 0) translate(-50%, -50%) scale(${0.4 + progress * 0.9})`;
      } else if (ripple) {
        ripple.style.opacity = "0";
      }

      const kept = Math.max(1, endMs - startMs);
      if (progressRef.current) progressRef.current.style.width = `${Math.min(100, ((timeMs - startMs) / kept) * 100)}%`;
      if (scrubberRef.current && !scrubbingRef.current) scrubberRef.current.value = String(timeMs);
      if (timeRef.current) {
        timeRef.current.textContent = `${formatDuration(timeMs - startMs)} / ${formatDuration(kept)}`;
      }
      if (playheadRef.current) playheadRef.current.style.left = `${(timeMs / Math.max(1, recording.durationMs)) * 100}%`;
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [autoZoom, clicks, durationMs, events, height, recording.durationMs, track, width]);

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      const { startMs, endMs } = rangeRef.current;
      if (video.ended || video.currentTime * 1_000 >= endMs - 30) video.currentTime = startMs / 1_000;
      void video.play();
    } else {
      video.pause();
    }
  }

  function seek(value: string) {
    if (videoRef.current) videoRef.current.currentTime = Number(value) / 1_000;
  }

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
                video.currentTime = rangeRef.current.startMs / 1_000;
                setHasAudio(hasAudioTrack(video));
                // Autoplay with sound can be refused; fall back to muted playback rather than none.
                void video.play().catch(() => {
                  video.muted = true;
                  setMuted(true);
                  void video.play().catch(() => {});
                });
              }}
            />
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
          </div>
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
        <span className="player-time" ref={timeRef}>0:00 / {formatDuration(range.endMs - range.startMs)}</span>
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
        onChange={onEditsChange}
        onSeek={(timeMs) => seek(String(timeMs))}
        currentTimeMs={() => (videoRef.current?.currentTime ?? 0) * 1_000}
        playheadRef={playheadRef}
      />
    </div>
  );
}
