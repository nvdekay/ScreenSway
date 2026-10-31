import {
  applyZoomStrength,
  DEFAULT_ZOOM_SCALE,
  DEFAULT_ZOOM_STRENGTH,
  MAX_ZOOM_SCALE,
  MAX_ZOOM_STRENGTH,
  MIN_ZOOM_STRENGTH,
  MIN_TRIM_MS,
  MIN_ZOOM_MS,
  MIN_ZOOM_SCALE,
  normalizeZooms,
  normalizeCuts,
  normalizeSpeeds,
  DEFAULT_SPEED_RATE,
  SPEED_RATES,
  samplePointer,
  type Canvas,
  type PointerEvent,
  type RecordingEdits,
  type CutSegment,
  type SpeedSegment,
  type FramingSegment,
  type ZoomSegment,
} from "@screensway/core";
import { Crosshair, Gauge, Plus, Redo2, RotateCcw, Scissors, Trash2, Undo2, Wand2 } from "lucide-react";
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
  /** How deep every zoom plays, 1 = each zoom's own depth; changed for the whole video. */
  zoomStrength?: number;
  onZoomStrengthChange?: (strength: number) => void;
  /** Receives an update of the latest edits, so quick successive changes never undo each other. */
  onChange: (update: (edits: RecordingEdits) => RecordingEdits) => void;
  onSeek: (timeMs: number) => void;
  currentTimeMs: () => number;
  /** Moved by the player on every frame, so the timeline does not re-render while playing. */
  playheadRef: RefObject<HTMLDivElement | null>;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  /** A filled frame narrower than the recording, where the view's position can be held. */
  framingEnabled?: boolean;
}

/** Trim handles and an editable lane of zooms under the preview. */
export function Timeline({ durationMs, canvas, events, edits, range, zooms, zoomEnabled, zoomStrength = DEFAULT_ZOOM_STRENGTH, onZoomStrengthChange, onChange, onSeek, currentTimeMs, playheadRef, canUndo, canRedo, onUndo, onRedo, framingEnabled }: TimelineProps) {
  const { t } = useI18n();
  /** How deep a zoom plays with the strength for all zooms applied. */
  const played = (scale: number) => applyZoomStrength([{ id: "", startMs: 0, endMs: 0, centerX: 0, centerY: 0, scale }], zoomStrength)[0].scale;
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCutId, setSelectedCutId] = useState<string | null>(null);
  const selected = zooms.find((zoom) => zoom.id === selectedId) ?? null;
  const cuts = normalizeCuts(edits.cuts ?? [], range);
  const selectedCut = cuts.find((cut) => cut.id === selectedCutId) ?? null;
  const [selectedSpeedId, setSelectedSpeedId] = useState<string | null>(null);
  const speeds = normalizeSpeeds(edits.speeds ?? [], range);
  const selectedSpeed = speeds.find((speed) => speed.id === selectedSpeedId) ?? null;
  const [selectedFramingId, setSelectedFramingId] = useState<string | null>(null);
  const framing = framingEnabled ? edits.framing ?? [] : [];
  const selectedFraming = framing.find((item) => item.id === selectedFramingId) ?? null;
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

  const setCuts = (next: CutSegment[]) => onChange((current) => ({ ...current, cuts: normalizeCuts(next, range) }));
  const addCut = () => {
    const center = Math.min(range.endMs - 100, Math.max(range.startMs + 100, currentTimeMs()));
    const cut = { id: `cut-${Date.now().toString(36)}`, startMs: Math.max(range.startMs, center - 500), endMs: Math.min(range.endMs, center + 500) };
    const next = normalizeCuts([...cuts, cut], range);
    if (!next.some((candidate) => candidate.id === cut.id)) return;
    setCuts(next);
    setSelectedCutId(cut.id); setSelectedSpeedId(null);
    setSelectedId(null);
  };
  const updateCut = (id: string, patch: Partial<CutSegment>) => setCuts(cuts.map((cut) => cut.id === id ? { ...cut, ...patch } : cut));
  const removeCut = (id: string) => {
    setCuts(cuts.filter((cut) => cut.id !== id));
    setSelectedCutId(null); setSelectedSpeedId(null);
  };

  const setSpeeds = (next: SpeedSegment[]) => onChange((current) => ({ ...current, speeds: normalizeSpeeds(next, range) }));
  const addSpeed = () => {
    const now = Math.min(range.endMs - 100, Math.max(range.startMs, currentTimeMs()));
    const speed = { id: `speed-${Date.now().toString(36)}`, startMs: Math.round(now), endMs: Math.round(Math.min(range.endMs, now + 3_000)), rate: DEFAULT_SPEED_RATE };
    // A new speed replaces the part of others it overlaps.
    const others = speeds.filter((item) => item.endMs <= speed.startMs || item.startMs >= speed.endMs);
    const next = normalizeSpeeds([...others, speed], range);
    if (!next.some((candidate) => candidate.id === speed.id)) return;
    setSpeeds(next);
    setSelectedSpeedId(speed.id);
    setSelectedCutId(null);
    setSelectedFramingId(null);
    setSelectedId(null);
  };
  const updateSpeed = (id: string, patch: Partial<SpeedSegment>) => setSpeeds(speeds.map((speed) => (speed.id === id ? { ...speed, ...patch } : speed)));
  const removeSpeed = (id: string) => {
    setSpeeds(speeds.filter((speed) => speed.id !== id));
    setSelectedSpeedId(null);
  };

  const setFraming = (next: FramingSegment[]) => onChange((current) => ({ ...current, framing: [...next].sort((a, b) => a.startMs - b.startMs) }));
  const addFraming = () => {
    const now = Math.min(range.endMs - 500, Math.max(range.startMs, currentTimeMs()));
    const pointer = samplePointer(events, now);
    const segment = {
      id: `framing-${Date.now().toString(36)}`,
      startMs: Math.round(now),
      endMs: Math.round(Math.min(range.endMs, now + 3_000)),
      x: pointer ? Math.min(1, Math.max(0, pointer.x / canvas.width)) : 0.5,
    };
    // A new hold replaces the part of others it overlaps.
    const others = framing.filter((item) => item.endMs <= segment.startMs || item.startMs >= segment.endMs);
    setFraming([...others, segment]);
    setSelectedFramingId(segment.id);
    setSelectedCutId(null); setSelectedSpeedId(null);
    setSelectedId(null);
  };
  const updateFraming = (id: string, patch: Partial<FramingSegment>) => setFraming(framing.map((item) => (item.id === id ? { ...item, ...patch } : item)));

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
          <button className="editor-button compact icon-only" onClick={onUndo} disabled={!canUndo} aria-label={t("timeline.undo")} title={t("timeline.undo")}><Undo2 size={13} /></button>
          <button className="editor-button compact icon-only" onClick={onRedo} disabled={!canRedo} aria-label={t("timeline.redo")} title={t("timeline.redo")}><Redo2 size={13} /></button>
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
          {zoomEnabled && onZoomStrengthChange && (
            <label className="zoom-strength" title={t("timeline.zoomStrengthHint")}>
              <span>{t("timeline.zoomStrength")}</span>
              <input
                type="range"
                min={MIN_ZOOM_STRENGTH}
                max={MAX_ZOOM_STRENGTH}
                step={0.05}
                value={zoomStrength}
                aria-valuetext={`${Math.round(zoomStrength * 100)}%`}
                onChange={(event) => onZoomStrengthChange(Number(event.target.value))}
              />
              <output>{Math.round(zoomStrength * 100)}%</output>
            </label>
          )}
          <button className="editor-button compact accent" onClick={addZoom} disabled={!zoomEnabled}>
            <Plus size={13} aria-hidden="true" /> {t("timeline.addZoom")}
          </button>
          <button className="editor-button compact" onClick={addCut}><Scissors size={13} aria-hidden="true" /> {t("timeline.addCut")}</button>
          <button className="editor-button compact" onClick={addSpeed} title={t("timeline.addSpeedHint")}><Gauge size={13} aria-hidden="true" /> {t("timeline.addSpeed")}</button>
          {framingEnabled && (
            <button className="editor-button compact" onClick={addFraming}><Crosshair size={13} aria-hidden="true" /> {t("timeline.holdFraming")}</button>
          )}
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
              aria-label={t("timeline.zoomLabel", { index: index + 1, scale: played(zoom.scale).toFixed(1) })}
              onPointerDown={(event) => {
                beginDrag({ kind: "zoom-move", id: zoom.id, grabOffsetMs: timeAt(event.clientX) - zoom.startMs })(event);
              }}
              onKeyDown={(event) => {
                if (event.key === "Delete" || event.key === "Backspace") removeZoom(zoom.id);
                if (event.key === "Enter") setSelectedId(zoom.id);
              }}
            >
              <span className="zoom-edge start" onPointerDown={beginDrag({ kind: "zoom-start", id: zoom.id })} />
              <span className="zoom-text">{played(zoom.scale).toFixed(1)}×</span>
              <span className="zoom-edge end" onPointerDown={beginDrag({ kind: "zoom-end", id: zoom.id })} />
            </div>
          ))}
        </div>
        <div className="cut-lane" aria-label={t("timeline.cuts")}>
          {cuts.map((cut) => (
            <button
              key={cut.id}
              className={`cut-block${cut.id === selectedCutId ? " selected" : ""}`}
              style={{ left: percent(cut.startMs), width: percent(cut.endMs - cut.startMs) }}
              aria-label={t("timeline.cutLabel", { start: formatPrecise(cut.startMs), end: formatPrecise(cut.endMs) })}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => { setSelectedCutId(cut.id); setSelectedSpeedId(null); setSelectedId(null); onSeek(cut.startMs); }}
            />
          ))}
        </div>
        {speeds.length > 0 && (
          <div className="speed-lane" aria-label={t("timeline.speeds")}>
            {speeds.map((speed) => (
              <button
                key={speed.id}
                className={`speed-block${speed.id === selectedSpeedId ? " selected" : ""}`}
                style={{ left: percent(speed.startMs), width: percent(speed.endMs - speed.startMs) }}
                aria-label={t("timeline.speedLabel", { rate: speed.rate, start: formatPrecise(speed.startMs), end: formatPrecise(speed.endMs) })}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => { setSelectedSpeedId(speed.id); setSelectedCutId(null); setSelectedFramingId(null); setSelectedId(null); onSeek(speed.startMs); }}
              >
                {speed.rate}×
              </button>
            ))}
          </div>
        )}
        {framing.length > 0 && (
          <div className="framing-lane" aria-label={t("timeline.framing")}>
            {framing.map((item) => (
              <button
                key={item.id}
                className={`framing-block${item.id === selectedFramingId ? " selected" : ""}`}
                style={{ left: percent(item.startMs), width: percent(item.endMs - item.startMs) }}
                aria-label={t("timeline.framingLabel", { start: formatPrecise(item.startMs), end: formatPrecise(item.endMs) })}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => { setSelectedFramingId(item.id); setSelectedCutId(null); setSelectedSpeedId(null); setSelectedId(null); onSeek(item.startMs); }}
              />
            ))}
          </div>
        )}
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
            <span><span>{t("timeline.depth")}</span><output>{selected.scale.toFixed(1)}×{zoomStrength !== DEFAULT_ZOOM_STRENGTH && ` → ${played(selected.scale).toFixed(1)}×`}</output></span>
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
      {selectedSpeed && (
        <div className="speed-inspector">
          <div className="chip-row" role="radiogroup" aria-label={t("timeline.speed")}>
            {SPEED_RATES.map((rate) => (
              <button
                key={rate}
                type="button"
                role="radio"
                aria-checked={selectedSpeed.rate === rate}
                className={`chip${selectedSpeed.rate === rate ? " selected" : ""}`}
                onClick={() => updateSpeed(selectedSpeed.id, { rate })}
              >
                {rate}×
              </button>
            ))}
          </div>
          <div className="cut-inspector">
            <label><span>{t("timeline.cutStart")}</span><input type="number" min={range.startMs / 1_000} max={(selectedSpeed.endMs - 100) / 1_000} step={0.1} value={(selectedSpeed.startMs / 1_000).toFixed(1)} onChange={(event) => updateSpeed(selectedSpeed.id, { startMs: Math.min(selectedSpeed.endMs - 100, Number(event.target.value) * 1_000) })} /></label>
            <label><span>{t("timeline.cutEnd")}</span><input type="number" min={(selectedSpeed.startMs + 100) / 1_000} max={range.endMs / 1_000} step={0.1} value={(selectedSpeed.endMs / 1_000).toFixed(1)} onChange={(event) => updateSpeed(selectedSpeed.id, { endMs: Math.max(selectedSpeed.startMs + 100, Number(event.target.value) * 1_000) })} /></label>
            <button className="editor-button compact" onClick={() => removeSpeed(selectedSpeed.id)}><Trash2 size={13} /> {t("timeline.removeSpeed")}</button>
          </div>
          <p className="editor-note">{t("timeline.speedNote")}</p>
        </div>
      )}
      {selectedCut && (
        <div className="cut-inspector">
          <label><span>{t("timeline.cutStart")}</span><input type="number" min={range.startMs / 1_000} max={(selectedCut.endMs - 100) / 1_000} step={0.1} value={(selectedCut.startMs / 1_000).toFixed(1)} onChange={(event) => updateCut(selectedCut.id, { startMs: Number(event.target.value) * 1_000 })} /></label>
          <label><span>{t("timeline.cutEnd")}</span><input type="number" min={(selectedCut.startMs + 100) / 1_000} max={range.endMs / 1_000} step={0.1} value={(selectedCut.endMs / 1_000).toFixed(1)} onChange={(event) => updateCut(selectedCut.id, { endMs: Number(event.target.value) * 1_000 })} /></label>
          <button className="editor-button compact" onClick={() => removeCut(selectedCut.id)}><Trash2 size={13} /> {t("timeline.removeCut")}</button>
        </div>
      )}
      {selectedFraming && (
        <div className="cut-inspector">
          <label><span>{t("timeline.cutStart")}</span><input type="number" min={0} max={(selectedFraming.endMs - 100) / 1_000} step={0.1} value={(selectedFraming.startMs / 1_000).toFixed(1)} onChange={(event) => updateFraming(selectedFraming.id, { startMs: Math.min(selectedFraming.endMs - 100, Number(event.target.value) * 1_000) })} /></label>
          <label><span>{t("timeline.cutEnd")}</span><input type="number" min={(selectedFraming.startMs + 100) / 1_000} max={durationMs / 1_000} step={0.1} value={(selectedFraming.endMs / 1_000).toFixed(1)} onChange={(event) => updateFraming(selectedFraming.id, { endMs: Math.max(selectedFraming.startMs + 100, Number(event.target.value) * 1_000) })} /></label>
          <button className="editor-button compact" onClick={() => { setFraming(framing.filter((item) => item.id !== selectedFraming.id)); setSelectedFramingId(null); }}><Trash2 size={13} /> {t("timeline.removeFraming")}</button>
          <label className="framing-position"><span>{t("timeline.framingPosition")}</span><input type="range" min={0} max={1} step={0.01} value={selectedFraming.x} onChange={(event) => updateFraming(selectedFraming.id, { x: Number(event.target.value) })} /></label>
        </div>
      )}
      {!zoomEnabled && <p className="editor-note">{t("timeline.zoomOff")}</p>}
    </div>
  );
}
