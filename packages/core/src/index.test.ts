import { describe, expect, it } from "vitest";
import { generateZoomSegments, type PointerEvent } from "./index";

describe("generateZoomSegments", () => {
  it("turns clicks into zoom segments and clusters nearby clicks", () => {
    const events: PointerEvent[] = [
      { timeMs: 100, type: "move", x: 10, y: 20 },
      { timeMs: 500, type: "leftClick", x: 100, y: 200 },
      { timeMs: 1_000, type: "leftClick", x: 150, y: 250 },
      { timeMs: 3_000, type: "rightClick", x: 800, y: 450 },
    ];

    expect(generateZoomSegments(events)).toEqual([
      {
        id: "zoom-1",
        startMs: 500,
        endMs: 3_000,
        centerX: 150,
        centerY: 250,
        scale: 1.6,
      },
      {
        id: "zoom-2",
        startMs: 3_000,
        endMs: 5_000,
        centerX: 800,
        centerY: 450,
        scale: 1.6,
      },
    ]);
  });
});
