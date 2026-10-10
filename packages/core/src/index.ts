export type PointerEventType = "move" | "leftClick" | "rightClick";

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

const DEFAULT_ZOOM_SCALE = 1.8;
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

    if (segment && timeMs >= segment.startMs) {
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
