import type { PointerEvent } from "@screensway/core";

export interface PointerSample {
  timeMs: number;
  x: number;
  y: number;
}

/** How far the pointer must travel, as a share of the video width, before a stop counts. */
const MIN_TRAVEL = 0.12;
/** The pointer counts as still while it stays this close, as a share of the video width. */
const STILL_RADIUS = 0.012;
/** How long it must stay still. */
const SETTLE_MS = 800;

/**
 * Turns tracked pointer positions into the events the studio uses. A browser never sees
 * clicks, so the zooms follow where the pointer settles after moving somewhere: that is
 * where people click, type or point at something while presenting.
 */
export function pointerEvents(samples: PointerSample[], width: number): PointerEvent[] {
  const events: PointerEvent[] = [];
  const minTravel = width * MIN_TRAVEL;
  const stillRadius = width * STILL_RADIUS;
  let travel = 0;
  let last: PointerSample | null = null;
  let anchor: PointerSample | null = null;
  let focused = false;

  for (const sample of samples) {
    if (!last || Math.hypot(sample.x - last.x, sample.y - last.y) >= 0.5) {
      events.push({ timeMs: Math.round(sample.timeMs), type: "move", x: sample.x, y: sample.y });
    }
    if (last) travel += Math.hypot(sample.x - last.x, sample.y - last.y);
    last = sample;

    if (!anchor || Math.hypot(sample.x - anchor.x, sample.y - anchor.y) > stillRadius) {
      anchor = sample;
      focused = false;
      continue;
    }
    if (!focused && travel >= minTravel && sample.timeMs - anchor.timeMs >= SETTLE_MS) {
      // From when it slowed down, at where it came to rest.
      events.push({ timeMs: Math.round(anchor.timeMs), type: "focus", x: sample.x, y: sample.y });
      focused = true;
      travel = 0;
    }
  }
  return events.sort((a, b) => a.timeMs - b.timeMs);
}
