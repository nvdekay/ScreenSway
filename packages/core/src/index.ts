/**
 * "focus" marks where the pointer settled after moving. The browser version cannot see
 * clicks, so it zooms on these instead; like clicks, they start a zoom.
 */
export type PointerEventType = "move" | "leftClick" | "rightClick" | "focus";

export interface PointerEvent {
  timeMs: number;
  type: PointerEventType;
  x: number;
  y: number;
}

export interface ZoomSegment {
  id: string;
  startMs: number;
  endMs: number;
  centerX: number;
  centerY: number;
  scale: number;
}

export interface CutSegment {
  id: string;
  startMs: number;
  endMs: number;
}

/** A part of the recording played faster or slower; its sound is left out of the export. */
export interface SpeedSegment {
  id: string;
  startMs: number;
  endMs: number;
  /** 2 plays twice as fast; below 1 is slow motion. */
  rate: number;
}

/** The speeds the timeline offers. */
export const SPEED_RATES = [0.5, 1.5, 2, 4, 8] as const;
export const DEFAULT_SPEED_RATE = 2;
const MIN_SPEED_RATE = 0.25;
const MAX_SPEED_RATE = 16;

export interface Redaction {
  id: string;
  /** Normalized coordinates in the source recording. */
  x: number;
  y: number;
  width: number;
  height: number;
  mode: "blur" | "solid";
}

export interface KeystrokeEvent { timeMs: number; keys: string[] }
export interface KeystrokeOverlay {
  enabled: boolean;
  position: "top" | "bottom";
  size: "small" | "medium" | "large";
  theme: "dark" | "light";
}

/** Where the webcam recording sits on the finished frame. It is a separate file, so all of this can change after recording. */
export interface CameraOverlay {
  visible: boolean;
  /** Centre of the camera, as fractions of the output frame. */
  x: number;
  y: number;
  /** Width as a fraction of the output frame's shorter side. */
  size: number;
  shape: "circle" | "rounded";
  mirror: boolean;
}

export const DEFAULT_CAMERA_OVERLAY: CameraOverlay = { visible: true, x: 0.86, y: 0.8, size: 0.26, shape: "circle", mirror: true };

/** The camera's box on an output frame of `width` × `height` pixels, kept fully inside it. */
export function cameraRect(overlay: CameraOverlay, width: number, height: number): { x: number; y: number; width: number; height: number; radius: number } {
  const boxWidth = Math.round(Math.min(width, height) * Math.min(0.6, Math.max(0.08, overlay.size)));
  const boxHeight = overlay.shape === "circle" ? boxWidth : Math.round(boxWidth * 0.75);
  const x = Math.round(Math.min(width - boxWidth, Math.max(0, overlay.x * width - boxWidth / 2)));
  const y = Math.round(Math.min(height - boxHeight, Math.max(0, overlay.y * height - boxHeight / 2)));
  return { x, y, width: boxWidth, height: boxHeight, radius: overlay.shape === "circle" ? boxWidth / 2 : Math.round(boxWidth * 0.08) };
}

export interface ScreenSwayProject {
  schemaVersion: 1;
  title: string;
  createdAt: string;
  canvas: { width: number; height: number };
  pointerEvents: PointerEvent[];
  zoomSegments: ZoomSegment[];
}

export interface Canvas {
  width: number;
  height: number;
}

/** Camera center in normalized canvas coordinates (0..1) plus zoom factor. */
export interface CameraState {
  x: number;
  y: number;
  scale: number;
}

export interface CameraTrack {
  fps: number;
  frames: CameraState[];
}

export const DEFAULT_ZOOM_SCALE = 1.8;
export const MIN_ZOOM_SCALE = 1.2;
export const MAX_ZOOM_SCALE = 3;
/** How deep every zoom goes, relative to its own depth: 0.5 halves how far each one zooms in. */
export const DEFAULT_ZOOM_STRENGTH = 1;
export const MIN_ZOOM_STRENGTH = 0.25;
export const MAX_ZOOM_STRENGTH = 1.5;
/** Shortest zoom the timeline allows, so a segment can always be grabbed and seen. */
export const MIN_ZOOM_MS = 400;
/** Shortest part of a recording that can be kept. */
export const MIN_TRIM_MS = 500;

/**
 * What the user changed in the studio. `zooms` is null while the zooms still follow
 * the clicks automatically; once edited it holds the full list (empty = no zooms).
 */
export interface RecordingEdits {
  trimStartMs: number;
  /** Null keeps the recording to its end. */
  trimEndMs: number | null;
  zooms: ZoomSegment[] | null;
  /** Source-time ranges removed from the finished timeline. */
  cuts?: CutSegment[];
  redactions?: Redaction[];
  keystrokeOverlay?: KeystrokeOverlay;
  camera?: CameraOverlay;
  /** Where a frame narrower than the recording (for example 9:16) is held instead of following the pointer. */
  framing?: FramingSegment[];
  /** Chapters in recording time; the first one starts the video. */
  chapters?: { startMs: number; title: string }[];
  /** Scales how deep every zoom goes (see `applyZoomStrength`); missing means 1. */
  zoomStrength?: number;
  /** Parts played faster or slower, in recording time. */
  speeds?: SpeedSegment[];
}

export interface FramingSegment {
  id: string;
  startMs: number;
  endMs: number;
  /** Centre of the view, as a fraction of the recording's width. */
  x: number;
}

export const DEFAULT_KEYSTROKE_OVERLAY: KeystrokeOverlay = { enabled: true, position: "bottom", size: "medium", theme: "dark" };
export const NO_EDITS: RecordingEdits = { trimStartMs: 0, trimEndMs: null, zooms: null, cuts: [], redactions: [], keystrokeOverlay: DEFAULT_KEYSTROKE_OVERLAY };

/** A kept part of the recording; `rate` above 1 plays it faster (missing means 1). */
export interface SourceRange { startMs: number; endMs: number; rate?: number }

const rateOf = (range: SourceRange) => range.rate ?? 1;
/** How long a kept part lasts in the finished video. */
const outputLength = (range: SourceRange) => (range.endMs - range.startMs) / rateOf(range);

/** Sorted, non-overlapping speed changes inside the trimmed recording, with a usable rate. */
export function normalizeSpeeds(speeds: SpeedSegment[], range: SourceRange): SpeedSegment[] {
  const result: SpeedSegment[] = [];
  for (const speed of [...speeds].sort((a, b) => a.startMs - b.startMs)) {
    if (!Number.isFinite(speed.rate) || speed.rate === 1) continue;
    const startMs = Math.max(range.startMs, result.at(-1)?.endMs ?? range.startMs, Math.round(speed.startMs));
    const endMs = Math.min(range.endMs, Math.round(speed.endMs));
    if (endMs - startMs < 100) continue;
    result.push({ ...speed, startMs, endMs, rate: Math.min(MAX_SPEED_RATE, Math.max(MIN_SPEED_RATE, speed.rate)) });
  }
  return result;
}

/** Sorted, non-overlapping cuts inside the trimmed recording. */
export function normalizeCuts(cuts: CutSegment[], range: SourceRange): CutSegment[] {
  const result: CutSegment[] = [];
  for (const cut of [...cuts].sort((a, b) => a.startMs - b.startMs)) {
    const startMs = Math.max(range.startMs, result.at(-1)?.endMs ?? range.startMs, Math.round(cut.startMs));
    const endMs = Math.min(range.endMs, Math.round(cut.endMs));
    if (endMs - startMs < 100) continue;
    result.push({ ...cut, startMs, endMs });
  }
  // A project must retain enough material to remain playable.
  while (result.reduce((sum, cut) => sum + cut.endMs - cut.startMs, 0) > range.endMs - range.startMs - MIN_TRIM_MS) result.pop();
  return result;
}

/** Source ranges that remain after trim and middle cuts. */
export function keptRanges(edits: RecordingEdits, durationMs: number): SourceRange[] {
  const range = trimRange(edits, durationMs);
  const cuts = normalizeCuts(edits.cuts ?? [], range);
  const kept: SourceRange[] = [];
  let cursor = range.startMs;
  for (const cut of cuts) {
    if (cut.startMs > cursor) kept.push({ startMs: cursor, endMs: cut.startMs });
    cursor = cut.endMs;
  }
  if (cursor < range.endMs) kept.push({ startMs: cursor, endMs: range.endMs });
  const speeds = normalizeSpeeds(edits.speeds ?? [], range);
  if (speeds.length === 0) return kept;
  // Each kept part is split where its speed changes.
  return kept.flatMap((part) => {
    const pieces: SourceRange[] = [];
    let start = part.startMs;
    for (const speed of speeds) {
      if (speed.endMs <= start || speed.startMs >= part.endMs) continue;
      if (speed.startMs > start) pieces.push({ startMs: start, endMs: speed.startMs });
      const end = Math.min(part.endMs, speed.endMs);
      pieces.push({ startMs: Math.max(start, speed.startMs), endMs: end, rate: speed.rate });
      start = end;
    }
    if (start < part.endMs) pieces.push({ startMs: start, endMs: part.endMs });
    return pieces;
  });
}

export function keptDuration(ranges: SourceRange[]): number {
  return ranges.reduce((sum, range) => sum + outputLength(range), 0);
}

export function sourceToOutputTime(ranges: SourceRange[], sourceMs: number): number {
  let output = 0;
  for (const range of ranges) {
    if (sourceMs < range.startMs) return output;
    if (sourceMs <= range.endMs) return output + (sourceMs - range.startMs) / rateOf(range);
    output += outputLength(range);
  }
  return output;
}

export function outputToSourceTime(ranges: SourceRange[], outputMs: number): number {
  let remaining = Math.max(0, outputMs);
  for (const range of ranges) {
    const length = outputLength(range);
    if (remaining < length) return range.startMs + remaining * rateOf(range);
    remaining -= length;
  }
  return ranges.at(-1)?.endMs ?? 0;
}

export function buildSourceTimes(ranges: SourceRange[], fps: number): number[] {
  const count = Math.max(1, Math.ceil((keptDuration(ranges) / 1_000) * fps));
  return Array.from({ length: count }, (_, index) => outputToSourceTime(ranges, (index * 1_000) / fps));
}

/** The kept part of the recording, always at least MIN_TRIM_MS long and inside it. */
export function trimRange(edits: RecordingEdits, durationMs: number): { startMs: number; endMs: number } {
  const minimum = Math.min(MIN_TRIM_MS, durationMs);
  const endMs = Math.min(durationMs, Math.max(minimum, edits.trimEndMs ?? durationMs));
  const startMs = Math.max(0, Math.min(edits.trimStartMs, endMs - minimum));
  return { startMs, endMs };
}

/** The zooms in effect: edited ones if any, otherwise the ones generated from clicks. */
export function resolveZooms(edits: RecordingEdits, events: PointerEvent[], durationMs: number): ZoomSegment[] {
  return normalizeZooms(edits.zooms ?? generateZoomSegments(events), durationMs);
}

/**
 * The zooms as the camera plays them: each one goes `strength` times as far in as its own
 * depth (1.8× at 0.5 becomes 1.4×), so a whole video can be made calmer or punchier without
 * editing every zoom. Applied when the view is planned, never stored in the zooms.
 */
export function applyZoomStrength(zooms: ZoomSegment[], strength = DEFAULT_ZOOM_STRENGTH): ZoomSegment[] {
  const factor = Number.isFinite(strength) ? Math.min(MAX_ZOOM_STRENGTH, Math.max(MIN_ZOOM_STRENGTH, strength)) : DEFAULT_ZOOM_STRENGTH;
  if (factor === 1) return zooms;
  return zooms.map((zoom) => ({ ...zoom, scale: Math.min(MAX_ZOOM_SCALE, 1 + (zoom.scale - 1) * factor) }));
}

/**
 * Sorted, inside the recording, at least MIN_ZOOM_MS long, never overlapping (a later
 * zoom starts where the earlier one ends) and with a scale in the allowed range.
 */
export function normalizeZooms(zooms: ZoomSegment[], durationMs: number): ZoomSegment[] {
  const sorted = [...zooms].sort((a, b) => a.startMs - b.startMs);
  const result: ZoomSegment[] = [];
  for (const zoom of sorted) {
    const earliest = result.at(-1)?.endMs ?? 0;
    const startMs = Math.max(earliest, Math.min(zoom.startMs, durationMs - MIN_ZOOM_MS));
    const endMs = Math.min(durationMs, Math.max(zoom.endMs, startMs + MIN_ZOOM_MS));
    if (endMs - startMs < MIN_ZOOM_MS) continue;
    result.push({
      ...zoom,
      startMs,
      endMs,
      scale: Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, zoom.scale)),
    });
  }
  return result;
}
/** How long the camera stays zoomed after the last click of a cluster. */
const ZOOM_HOLD_MS = 2_400;
/** Clicks closer than this to an active zoom extend it instead of zooming out and back in. */
const ZOOM_MERGE_GAP_MS = 1_200;
/** Start zooming slightly before the click so the camera has arrived when it happens. */
const ZOOM_LEAD_MS = 350;

const CAMERA_FPS = 60;
const SCALE_SPRING = 7;
const PAN_SPRING = 4.5;
/** Fraction of the visible area around the center where pointer motion does not pan. */
const PAN_DEAD_ZONE = 0.28;

export function generateZoomSegments(events: PointerEvent[]): ZoomSegment[] {
  const clicks = events.filter((event) => event.type !== "move");
  const segments: ZoomSegment[] = [];

  for (const click of clicks) {
    const previous = segments.at(-1);
    if (previous && click.timeMs <= previous.endMs + ZOOM_MERGE_GAP_MS) {
      previous.endMs = click.timeMs + ZOOM_HOLD_MS;
      continue;
    }

    segments.push({
      id: `zoom-${segments.length + 1}`,
      startMs: click.timeMs,
      endMs: click.timeMs + ZOOM_HOLD_MS,
      centerX: click.x,
      centerY: click.y,
      scale: DEFAULT_ZOOM_SCALE,
    });
  }

  return segments;
}

/** Pointer position at `timeMs`, linearly interpolated between samples. */
export function samplePointer(events: PointerEvent[], timeMs: number): { x: number; y: number } | null {
  if (events.length === 0 || timeMs < events[0].timeMs) return null;

  let low = 0;
  let high = events.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (events[mid].timeMs <= timeMs) low = mid;
    else high = mid - 1;
  }

  const current = events[low];
  const next = events[low + 1];
  if (!next || next.timeMs === current.timeMs) return { x: current.x, y: current.y };

  const progress = (timeMs - current.timeMs) / (next.timeMs - current.timeMs);
  return {
    x: current.x + (next.x - current.x) * progress,
    y: current.y + (next.y - current.y) * progress,
  };
}

/**
 * Simulates the camera at a fixed frame rate so preview and export produce identical motion.
 * Zoom and pan follow critically damped springs, which ease in and out without overshoot.
 */
export function buildCameraTrack(
  events: PointerEvent[],
  segments: ZoomSegment[],
  canvas: Canvas,
  durationMs: number,
): CameraTrack {
  const frameMs = 1_000 / CAMERA_FPS;
  const dt = frameMs / 1_000;
  const frameCount = Math.max(1, Math.ceil(durationMs / frameMs) + 1);
  const frames: CameraState[] = [];

  let scale = 1;
  let scaleVelocity = 0;
  let x = 0.5;
  let y = 0.5;
  let xVelocity = 0;
  let yVelocity = 0;
  let panTargetX = 0.5;
  let panTargetY = 0.5;
  let segmentIndex = 0;
  let activeSegment: ZoomSegment | undefined;
  // Where the pointer settled (browser recordings): while zoomed, the camera moves to each.
  const focuses = events.filter((event) => event.type === "focus");
  let focusIndex = 0;
  let focusArrivesMs = -Infinity;

  for (let frame = 0; frame < frameCount; frame++) {
    const timeMs = frame * frameMs;
    while (segmentIndex < segments.length && segments[segmentIndex].endMs < timeMs) segmentIndex++;
    const candidate = segments[segmentIndex];
    const segment = candidate && timeMs >= candidate.startMs - ZOOM_LEAD_MS ? candidate : undefined;

    const targetScale = segment?.scale ?? 1;
    if (segment && segment !== activeSegment) {
      panTargetX = segment.centerX / canvas.width;
      panTargetY = segment.centerY / canvas.height;
    }
    activeSegment = segment;

    // Like a zoom, a move to a new focus starts slightly early so it arrives in time.
    while (focusIndex < focuses.length && focuses[focusIndex].timeMs <= timeMs + ZOOM_LEAD_MS) {
      const focus = focuses[focusIndex++];
      // Small adjustments are left to the following below, so the camera stays calm.
      const far = Math.max(Math.abs(focus.x / canvas.width - panTargetX), Math.abs(focus.y / canvas.height - panTargetY)) > PAN_DEAD_ZONE / (2 * (segment?.scale ?? 1));
      if (segment && focus.timeMs > segment.startMs && far) {
        panTargetX = focus.x / canvas.width;
        panTargetY = focus.y / canvas.height;
        focusArrivesMs = focus.timeMs;
      }
    }

    // Until the pointer gets there, following it would pull the camera back.
    if (segment && timeMs >= segment.startMs && timeMs >= focusArrivesMs) {
      const pointer = samplePointer(events, timeMs);
      if (pointer) {
        const pointerX = pointer.x / canvas.width;
        const pointerY = pointer.y / canvas.height;
        const deadZone = PAN_DEAD_ZONE / targetScale;
        if (Math.abs(pointerX - panTargetX) > deadZone) {
          panTargetX = pointerX - Math.sign(pointerX - panTargetX) * deadZone;
        }
        if (Math.abs(pointerY - panTargetY) > deadZone) {
          panTargetY = pointerY - Math.sign(pointerY - panTargetY) * deadZone;
        }
      }
    }

    [scale, scaleVelocity] = stepSpring(scale, scaleVelocity, targetScale, SCALE_SPRING, dt);
    const targetX = segment ? panTargetX : 0.5;
    const targetY = segment ? panTargetY : 0.5;
    [x, xVelocity] = stepSpring(x, xVelocity, targetX, PAN_SPRING, dt);
    [y, yVelocity] = stepSpring(y, yVelocity, targetY, PAN_SPRING, dt);

    frames.push(clampCamera({ x, y, scale }));
  }

  return { fps: CAMERA_FPS, frames };
}

export function sampleCameraTrack(track: CameraTrack, timeMs: number): CameraState {
  const position = Math.max(0, (timeMs / 1_000) * track.fps);
  const index = Math.min(Math.floor(position), track.frames.length - 1);
  const current = track.frames[index];
  const next = track.frames[index + 1];
  if (!next) return current;

  const progress = position - index;
  return {
    x: current.x + (next.x - current.x) * progress,
    y: current.y + (next.y - current.y) * progress,
    scale: current.scale + (next.scale - current.scale) * progress,
  };
}

/**
 * The horizontal centre of a view narrower than the recording, as a fraction of its width,
 * one value per camera frame. It follows the pointer with a dead zone (and the same spring as
 * the zoom), so a vertical video keeps the action in view; framing segments hold it where the
 * user put it. `viewWidth` is the view's width at 1× as a fraction of the recording's width.
 */
export function buildFollowTrack(
  events: PointerEvent[],
  camera: CameraTrack,
  canvas: Canvas,
  viewWidth: number,
  framing: FramingSegment[] = [],
): number[] {
  const dt = 1 / camera.fps;
  const result: number[] = [];
  let x = 0.5;
  let velocity = 0;
  let target = 0.5;
  const first = events.find((event) => event.type !== "focus");
  if (first) target = x = first.x / canvas.width;
  for (let frame = 0; frame < camera.frames.length; frame++) {
    const timeMs = (frame * 1_000) / camera.fps;
    const half = viewWidth / (2 * camera.frames[frame].scale);
    const held = framing.find((segment) => timeMs >= segment.startMs && timeMs < segment.endMs);
    if (held) {
      target = held.x;
    } else {
      const pointer = samplePointer(events, timeMs);
      if (pointer) {
        // The pointer may move freely in the middle of the view before the view follows.
        const pointerX = pointer.x / canvas.width;
        const deadZone = half * 0.5;
        if (Math.abs(pointerX - target) > deadZone) target = pointerX - Math.sign(pointerX - target) * deadZone;
      }
    }
    target = Math.min(1 - half, Math.max(half, target));
    [x, velocity] = stepSpring(x, velocity, target, PAN_SPRING, dt);
    result.push(Math.min(1 - half, Math.max(half, x)));
  }
  return result;
}

export function sampleFollowTrack(track: number[], fps: number, timeMs: number): number {
  const position = Math.max(0, (timeMs / 1_000) * fps);
  const index = Math.min(Math.floor(position), track.length - 1);
  const next = track[index + 1];
  return next === undefined ? track[index] : track[index] + (next - track[index]) * (position - index);
}

/** Keeps the zoomed viewport inside the canvas so no empty edges are ever shown. */
export function clampCamera(camera: CameraState): CameraState {
  const scale = Math.max(1, camera.scale);
  const half = 0.5 / scale;
  return {
    scale,
    x: Math.min(1 - half, Math.max(half, camera.x)),
    y: Math.min(1 - half, Math.max(half, camera.y)),
  };
}

function stepSpring(
  value: number,
  velocity: number,
  target: number,
  angularFrequency: number,
  dt: number,
): [number, number] {
  // Exact solution of a critically damped spring, stable for any time step.
  const omega = angularFrequency;
  const offset = value - target;
  const decay = Math.exp(-omega * dt);
  const nextOffset = (offset + (velocity + omega * offset) * dt) * decay;
  const nextVelocity = (velocity - omega * (velocity + omega * offset) * dt) * decay;
  return [target + nextOffset, nextVelocity];
}

export * from "./frame";
export * from "./captions";
export * from "./paint";
