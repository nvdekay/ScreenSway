import { describe, expect, it } from "vitest";
import { pointerEvents, type PointerSample } from "./focus";

const WIDTH = 1920;

/** A pointer moving in a straight line, then resting, sampled every 33 ms. */
function path(from: [number, number], to: [number, number], moveMs: number, restMs: number, startMs = 0): PointerSample[] {
  const samples: PointerSample[] = [];
  for (let t = 0; t <= moveMs + restMs; t += 33) {
    const k = Math.min(1, t / moveMs);
    samples.push({ timeMs: startMs + t, x: from[0] + (to[0] - from[0]) * k, y: from[1] + (to[1] - from[1]) * k });
  }
  return samples;
}

describe("pointerEvents", () => {
  it("marks where the pointer settles after moving", () => {
    const events = pointerEvents(path([100, 100], [900, 600], 400, 800), WIDTH);
    const focus = events.filter((event) => event.type === "focus");
    expect(focus).toHaveLength(1);
    expect(focus[0]).toMatchObject({ x: 900, y: 600 });
    expect(focus[0].timeMs).toBeGreaterThanOrEqual(396);
    expect(focus[0].timeMs).toBeLessThanOrEqual(430);
    expect(events.every((event, index) => index === 0 || event.timeMs >= events[index - 1].timeMs)).toBe(true);
  });

  it("ignores short pauses, small moves and a pointer that never moved", () => {
    expect(pointerEvents(path([100, 100], [900, 600], 400, 300), WIDTH).some((event) => event.type === "focus")).toBe(false);
    expect(pointerEvents(path([100, 100], [140, 120], 400, 900), WIDTH).some((event) => event.type === "focus")).toBe(false);
    expect(pointerEvents(path([500, 500], [500, 500], 400, 2_000), WIDTH).some((event) => event.type === "focus")).toBe(false);
  });

  it("marks each stop once, even when the pointer jitters while resting", () => {
    const first = path([100, 100], [900, 600], 400, 1_500).map((sample, index) => ({ ...sample, x: sample.x + (index % 2) * 3 }));
    const second = path([900, 600], [200, 900], 400, 900, 1_934);
    const focus = pointerEvents([...first, ...second], WIDTH).filter((event) => event.type === "focus");
    expect(focus.map(({ x, y }) => [Math.round(x), Math.round(y)])).toEqual([[900, 600], [200, 900]]);
  });
});
