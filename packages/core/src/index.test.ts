import { describe, expect, it } from "vitest";
import {
  buildCameraTrack,
  clampCamera,
  generateZoomSegments,
  sampleCameraTrack,
  samplePointer,
  type PointerEvent,
} from "./index";

describe("generateZoomSegments", () => {
  it("merges clicks that happen while zoomed and separates distant clicks", () => {
    const events: PointerEvent[] = [
      { timeMs: 100, type: "move", x: 10, y: 20 },
      { timeMs: 500, type: "leftClick", x: 100, y: 200 },
      { timeMs: 2_000, type: "leftClick", x: 150, y: 250 },
      { timeMs: 9_000, type: "rightClick", x: 800, y: 450 },
    ];

    expect(generateZoomSegments(events)).toEqual([
      { id: "zoom-1", startMs: 500, endMs: 4_400, centerX: 100, centerY: 200, scale: 1.8 },
      { id: "zoom-2", startMs: 9_000, endMs: 11_400, centerX: 800, centerY: 450, scale: 1.8 },
    ]);
  });
});

describe("samplePointer", () => {
  const events: PointerEvent[] = [
    { timeMs: 0, type: "move", x: 0, y: 0 },
    { timeMs: 100, type: "move", x: 100, y: 50 },
  ];

  it("interpolates between samples", () => {
    expect(samplePointer(events, 50)).toEqual({ x: 50, y: 25 });
  });

  it("holds the last sample", () => {
    expect(samplePointer(events, 500)).toEqual({ x: 100, y: 50 });
  });
});

describe("buildCameraTrack", () => {
  const canvas = { width: 1_000, height: 1_000 };
  const events: PointerEvent[] = [{ timeMs: 1_000, type: "leftClick", x: 900, y: 900 }];
  const segments = generateZoomSegments(events);
  const track = buildCameraTrack(events, segments, canvas, 8_000);

  it("eases into the zoom without jumping", () => {
    let previous = sampleCameraTrack(track, 0).scale;
    for (let time = 16; time < 2_000; time += 16) {
      const scale = sampleCameraTrack(track, time).scale;
      expect(Math.abs(scale - previous)).toBeLessThan(0.06);
      previous = scale;
    }
    expect(sampleCameraTrack(track, 2_500).scale).toBeGreaterThan(1.75);
  });

  it("returns to the full frame after the zoom", () => {
    expect(sampleCameraTrack(track, 7_900).scale).toBeCloseTo(1, 2);
  });

  it("never shows outside the canvas", () => {
    for (const frame of track.frames) {
      expect(frame).toEqual(clampCamera(frame));
    }
  });
});
