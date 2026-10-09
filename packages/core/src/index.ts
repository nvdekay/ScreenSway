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

const DEFAULT_ZOOM_DURATION_MS = 2_000;
const CLICK_CLUSTER_MS = 900;

export function generateZoomSegments(events: PointerEvent[]): ZoomSegment[] {
  const clicks = events.filter((event) => event.type !== "move");
  const segments: ZoomSegment[] = [];

  for (const click of clicks) {
    const previous = segments.at(-1);
    if (previous && click.timeMs - previous.startMs <= CLICK_CLUSTER_MS) {
      previous.endMs = click.timeMs + DEFAULT_ZOOM_DURATION_MS;
      previous.centerX = click.x;
      previous.centerY = click.y;
      continue;
    }

    segments.push({
      id: `zoom-${segments.length + 1}`,
      startMs: click.timeMs,
      endMs: click.timeMs + DEFAULT_ZOOM_DURATION_MS,
      centerX: click.x,
      centerY: click.y,
      scale: 1.6,
    });
  }

  return segments;
}

