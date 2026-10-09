import { convertFileSrc } from "@tauri-apps/api/core";
import {
  buildCameraTrack,
  generateZoomSegments,
  sampleCameraTrack,
  samplePointer,
  type PointerEvent,
} from "@screensway/core";
import { Pause, Play, RotateCcw, ZoomIn } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDuration } from "./format";

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

export function ZoomPreview({ recording }: { recording: RecordingResult }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLSpanElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const scrubberRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const scrubbingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [autoZoom, setAutoZoom] = useState(true);
  const [durationMs, setDurationMs] = useState(recording.durationMs);

  const { pointerEvents: events, width, height } = recording;
  const segments = useMemo(() => generateZoomSegments(events), [events]);
  const clicks = useMemo(() => events.filter((event) => event.type !== "move"), [events]);
  const track = useMemo(
    () => buildCameraTrack(events, segments, { width, height }, durationMs + 1_000),
    [events, segments, width, height, durationMs],
  );

  // Camera, cursor and progress are written straight to the DOM on every display frame,
  // so motion stays at the screen's refresh rate instead of React's render cadence.
  useEffect(() => {
    let frame = 0;
    const render = () => {
      frame = requestAnimationFrame(render);
      const video = videoRef.current;
      const content = contentRef.current;
      if (!video || !content) return;

      const timeMs = video.currentTime * 1_000;
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

      const total = Math.max(1, video.duration * 1_000 || durationMs);
      if (progressRef.current) progressRef.current.style.width = `${Math.min(100, (timeMs / total) * 100)}%`;
      if (scrubberRef.current && !scrubbingRef.current) scrubberRef.current.value = String(timeMs);
      if (timeRef.current) {
        timeRef.current.textContent = `${formatDuration(timeMs)} / ${formatDuration(total)}`;
      }
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [autoZoom, clicks, durationMs, events, height, track, width]);

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (video.ended) video.currentTime = 0;
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
          style={{ aspectRatio: `${width} / ${height}`, width: `min(100%, calc(58vh * ${width / height}))` }}
          onClick={togglePlayback}
        >
          <div className="player-content" ref={contentRef}>
            <video
              ref={videoRef}
              src={convertFileSrc(recording.videoPath)}
              autoPlay
              playsInline
              preload="auto"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onLoadedMetadata={(event) => {
                const duration = event.currentTarget.duration;
                if (Number.isFinite(duration)) setDurationMs(duration * 1_000);
              }}
            />
            <span className="click-ripple" ref={rippleRef} />
            <div className="player-cursor" ref={cursorRef}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M4.5 2.8v16.6c0 .6.7.9 1.1.4l3.9-4.2 2.6 6.1c.2.4.6.6 1 .4l2.2-.9c.4-.2.6-.6.4-1l-2.6-6h5.7c.6 0 .9-.7.5-1.1L5.6 2.4c-.4-.4-1.1-.1-1.1.4z"
                  fill="#111"
                  stroke="#fff"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
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
        <button className="player-button" onClick={togglePlayback} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
        </button>
        <button
          className="player-button"
          onClick={() => {
            seek("0");
            void videoRef.current?.play();
          }}
          aria-label="Replay from start"
        >
          <RotateCcw size={14} />
        </button>
        <div className="scrubber">
          <div className="scrubber-track">
            {segments.map((segment) => (
              <span
                key={segment.id}
                className="scrubber-zoom"
                style={{
                  left: `${(segment.startMs / durationMs) * 100}%`,
                  width: `${(Math.min(segment.endMs, durationMs) - segment.startMs) / durationMs * 100}%`,
                }}
              />
            ))}
            <div className="scrubber-progress" ref={progressRef} />
          </div>
          <input
            ref={scrubberRef}
            type="range"
            min={0}
            max={durationMs}
            step={1}
            defaultValue={0}
            aria-label="Seek"
            onPointerDown={() => (scrubbingRef.current = true)}
            onPointerUp={() => (scrubbingRef.current = false)}
            onInput={(event) => seek(event.currentTarget.value)}
          />
        </div>
        <span className="player-time" ref={timeRef}>0:00 / {formatDuration(durationMs)}</span>
        <button
          className={`zoom-toggle${autoZoom ? " active" : ""}`}
          onClick={() => setAutoZoom((value) => !value)}
          aria-pressed={autoZoom}
        >
          <ZoomIn size={14} /> Auto zoom
        </button>
      </div>
    </div>
  );
}
