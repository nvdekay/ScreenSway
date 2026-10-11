import {
  DEFAULT_ZOOM_SCALE,
  MAX_ZOOM_SCALE,
  MIN_TRIM_MS,
  MIN_ZOOM_MS,
  MIN_ZOOM_SCALE,
  normalizeZooms,
  samplePointer,
  type Canvas,
  type PointerEvent,
  type RecordingEdits,
  type ZoomSegment,
} from "@screensway/core";
import { Plus, RotateCcw, Scissors, Trash2, Wand2 } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { formatPrecise } from "../format";
import { useI18n } from "../i18n";

/** A new zoom lasts this long, or less when the next one starts sooner. */
const NEW_ZOOM_MS = 2_000;
const KEY_STEP_MS = 100;

type Drag =
  | { kind: "trim-start" }
  | { kind: "trim-end" }
  | { kind: "zoom-move"; id: string; grabOffsetMs: number }
  | { kind: "zoom-start"; id: string }
  | { kind: "zoom-end"; id: string };

interface TimelineProps {
  durationMs: number;
  canvas: Canvas;
  events: PointerEvent[];
  edits: RecordingEdits;
  range: { startMs: number; endMs: number };
  /** The zooms in effect (edited or automatic). */
  zooms: ZoomSegment[];
  zoomEnabled: boolean;
  /** Receives an update of the latest edits, so quick successive changes never undo each other. */
  onChange: (update: (edits: RecordingEdits) => RecordingEdits) => void;
  onSeek: (timeMs: number) => void;
  currentTimeMs: () => number;
  /** Moved by the player on every frame, so the timeline does not re-render while playing. */
  playheadRef: RefObject<HTMLDivElement | null>;
}

/** Trim handles and an editable lane of zooms under the preview. */
export function Timeline({ durationMs, canvas, events, edits, range, zooms, zoomEnabled, onChange, onSeek, currentTimeMs, playheadRef }: TimelineProps) {
  const { t } = useI18n();
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = zooms.find((zoom) => zoom.id === selectedId) ?? null;
  const clicks = events.filter((event) => event.type !== "move");
  const percent = (timeMs: number) => `${(timeMs / durationMs) * 100}%`;
  const trimmed = range.startMs > 0 || range.endMs < durationMs;

  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(durationMs, Math.max(0, ((clientX - rect.left) / rect.width) * durationMs));
  };

  const setTrim = (startMs: number, endMs: number) => {
    onChange((current) => ({ ...current, trimStartMs: Math.max(0, Math.round(startMs)), trimEndMs: endMs >= durationMs ? null : Math.round(endMs) }));
  };
  const setZooms = (next: ZoomSegment[]) => onChange((current) => ({ ...current, zooms: normalizeZooms(next, durationMs) }));

  /** Moves one edge or the whole zoom, never past its neighbors. */
  const moveZoom = (id: string, startMs: number, endMs: number) => {
    const index = zooms.findIndex((zoom) => zoom.id === id);
    if (index < 0) return;
    const earliest = zooms[index - 1]?.endMs ?? 0;
    const latest = zooms[index + 1]?.startMs ?? durationMs;
    const length = endMs - startMs;
    let start = startMs;
    let end = endMs;
    if (dragRef.current?.kind === "zoom-move") {
      start = Math.min(latest - length, Math.max(earliest, startMs));
      end = start + length;
    } else {
      start = Math.max(earliest, Math.min(startMs, endMs - MIN_ZOOM_MS));
      end = Math.min(latest, Math.max(endMs, start + MIN_ZOOM_MS));
    }
    setZooms(zooms.map((zoom) => (zoom.id === id ? { ...zoom, startMs: Math.round(start), endMs: Math.round(end) } : zoom)));
  };

  const beginDrag = (drag: Drag) => (event: ReactPointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    try {
      // Keeps the drag going when the pointer leaves the handle.
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // The timeline still receives the moves while the pointer is over it.
    }
    dragRef.current = drag;
    if ("id" in drag) setSelectedId(drag.id);
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const time = timeAt(event.clientX);
    if (drag.kind === "trim-start") {
      const start = Math.min(time, range.endMs - MIN_TRIM_MS);
      setTrim(start, range.endMs);
      onSeek(start);
    } else if (drag.kind === "trim-end") {
      const end = Math.max(time, range.startMs + MIN_TRIM_MS);
      setTrim(range.startMs, end);
      onSeek(end);
    } else {
      const zoom = zooms.find((candidate) => candidate.id === drag.id);
      if (!zoom) return;
      if (drag.kind === "zoom-move") {
        const start = time - drag.grabOffsetMs;
        moveZoom(zoom.id, start, start + (zoom.endMs - zoom.startMs));
      } else if (drag.kind === "zoom-start") {
        moveZoom(zoom.id, time, zoom.endMs);
      } else {
        moveZoom(zoom.id, zoom.startMs, time);
      }
    }
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const addZoom = () => {
    const now = Math.round(Math.min(Math.max(currentTimeMs(), range.startMs), durationMs - MIN_ZOOM_MS));
    const inside = zooms.find((zoom) => now >= zoom.startMs && now < zoom.endMs);
    if (inside) return setSelectedId(inside.id);
    const next = zooms.find((zoom) => zoom.startMs > now);
    const end = Math.min(now + NEW_ZOOM_MS, next?.startMs ?? durationMs);
    if (end - now < MIN_ZOOM_MS) return;
    const pointer = samplePointer(events, now) ?? { x: canvas.width / 2, y: canvas.height / 2 };
    const zoom: ZoomSegment = {
      id: `zoom-${Date.now().toString(36)}`,
      startMs: now,
      endMs: end,
      centerX: pointer.x,
      centerY: pointer.y,
      scale: DEFAULT_ZOOM_SCALE,
    };
    setZooms([...zooms, zoom]);
    setSelectedId(zoom.id);
  };

  const removeZoom = (id: string) => {
    setZooms(zooms.filter((zoom) => zoom.id !== id));
    setSelectedId(null);
  };

  const trimKeys = (edge: "start" | "end") => (event: KeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? -KEY_STEP_MS : event.key === "ArrowRight" ? KEY_STEP_MS : 0;
    if (!step) return;
    event.preventDefault();
    if (edge === "start") setTrim(Math.min(range.startMs + step, range.endMs - MIN_TRIM_MS), range.endMs);
    else setTrim(range.startMs, Math.max(range.endMs + step, range.startMs + MIN_TRIM_MS));
  };

  return (
    <div className="timeline" onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      <div className="timeline-head">
        <span className="timeline-title">
          <Scissors size={14} aria-hidden="true" />
          {t("timeline.kept", { start: formatPrecise(range.startMs), end: formatPrecise(range.endMs), length: formatPrecise(range.endMs - range.startMs) })}
        </span>
        <span className="timeline-actions">
          {trimmed && (
            <button className="editor-button compact" onClick={() => setTrim(0, durationMs)}>
              <RotateCcw size={13} aria-hidden="true" /> {t("timeline.resetTrim")}
            </button>
          )}
          {edits.zooms !== null && (
            <button className="editor-button compact" onClick={() => onChange((current) => ({ ...current, zooms: null }))} title={t("timeline.autoZoomsHint")}>
              <Wand2 size={13} aria-hidden="true" /> {t("timeline.autoZooms")}
            </button>
          )}
          <button className="editor-button compact accent" onClick={addZoom} disabled={!zoomEnabled}>
            <Plus size={13} aria-hidden="true" /> {t("timeline.addZoom")}
          </button>
        </span>
      </div>

      <div
        className="timeline-track"
        ref={trackRef}
        onPointerDown={(event) => {
          setSelectedId(null);
          onSeek(Math.min(range.endMs, Math.max(range.startMs, timeAt(event.clientX))));
        }}
      >
        <div className="timeline-clicks" aria-hidden="true">
          {clicks.map((click, index) => (
            <span key={index} style={{ left: percent(click.timeMs) }} />
          ))}
        </div>
        <div className="zoom-lane">
          {zooms.map((zoom, index) => (
            <div
              key={zoom.id}
              className={`zoom-block${zoom.id === selectedId ? " selected" : ""}${zoomEnabled ? "" : " disabled"}`}
              style={{ left: percent(zoom.startMs), width: percent(zoom.endMs - zoom.startMs) }}
              role="button"
              tabIndex={0}
              aria-label={t("timeline.zoomLabel", { index: index + 1, scale: zoom.scale.toFixed(1) })}
              onPointerDown={(event) => {
                beginDrag({ kind: "zoom-move", id: zoom.id, grabOffsetMs: timeAt(event.clientX) - zoom.startMs })(event);
              }}
              onKeyDown={(event) => {
                if (event.key === "Delete" || event.key === "Backspace") removeZoom(zoom.id);
                if (event.key === "Enter") setSelectedId(zoom.id);
              }}
            >
              <span className="zoom-edge start" onPointerDown={beginDrag({ kind: "zoom-start", id: zoom.id })} />
              <span className="zoom-text">{zoom.scale.toFixed(1)}×</span>
              <span className="zoom-edge end" onPointerDown={beginDrag({ kind: "zoom-end", id: zoom.id })} />
            </div>
          ))}
        </div>
        <div className="trim-shade" style={{ left: 0, width: percent(range.startMs) }} />
        <div className="trim-shade" style={{ left: percent(range.endMs), right: 0 }} />
        <div className="trim-window" style={{ left: percent(range.startMs), width: percent(range.endMs - range.startMs) }}>
          <span
            className="trim-handle start"
            role="slider"
            tabIndex={0}
            aria-label={t("timeline.trimStart")}
            aria-valuemin={0}
            aria-valuemax={durationMs}
            aria-valuenow={Math.round(range.startMs)}
            aria-valuetext={formatPrecise(range.startMs)}
            onPointerDown={beginDrag({ kind: "trim-start" })}
            onKeyDown={trimKeys("start")}
          />
          <span
            className="trim-handle end"
            role="slider"
            tabIndex={0}
            aria-label={t("timeline.trimEnd")}
            aria-valuemin={0}
            aria-valuemax={durationMs}
            aria-valuenow={Math.round(range.endMs)}
            aria-valuetext={formatPrecise(range.endMs)}
            onPointerDown={beginDrag({ kind: "trim-end" })}
            onKeyDown={trimKeys("end")}
          />
        </div>
        <div className="timeline-playhead" ref={playheadRef} aria-hidden="true" />
      </div>

      {selected && zoomEnabled && (
        <div className="zoom-inspector">
          <label className="editor-slider">
            <span><span>{t("timeline.depth")}</span><output>{selected.scale.toFixed(1)}×</output></span>
            <input
              type="range"
              min={MIN_ZOOM_SCALE}
              max={MAX_ZOOM_SCALE}
              step={0.1}
              value={selected.scale}
              onChange={(event) => setZooms(zooms.map((zoom) => (zoom.id === selected.id ? { ...zoom, scale: Number(event.target.value) } : zoom)))}
            />
          </label>
          <button className="editor-button compact" onClick={() => removeZoom(selected.id)}>
            <Trash2 size={13} aria-hidden="true" /> {t("timeline.removeZoom")}
          </button>
        </div>
      )}
      {!zoomEnabled && <p className="editor-note">{t("timeline.zoomOff")}</p>}
    </div>
  );
}
