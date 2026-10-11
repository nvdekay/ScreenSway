import { describe, expect, it } from "vitest";
import {
  buildCameraTrack,
  clampCamera,
  generateZoomSegments,
  sampleCameraTrack,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_MS,
  MIN_ZOOM_SCALE,
  NO_EDITS,
  normalizeZooms,
  resolveZooms,
  samplePointer,
  trimRange,
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

describe("edits", () => {
  const zoom = (id: string, startMs: number, endMs: number, scale = 1.8) =>
    ({ id, startMs, endMs, centerX: 100, centerY: 100, scale });

  it("keeps the trim inside the recording and at least half a second long", () => {
    expect(trimRange(NO_EDITS, 10_000)).toEqual({ startMs: 0, endMs: 10_000 });
    expect(trimRange({ ...NO_EDITS, trimStartMs: 2_000, trimEndMs: 8_000 }, 10_000)).toEqual({ startMs: 2_000, endMs: 8_000 });
    expect(trimRange({ ...NO_EDITS, trimStartMs: 9_900, trimEndMs: 9_950 }, 10_000)).toEqual({ startMs: 9_450, endMs: 9_950 });
    expect(trimRange({ ...NO_EDITS, trimStartMs: -50, trimEndMs: 99_000 }, 10_000)).toEqual({ startMs: 0, endMs: 10_000 });
    expect(trimRange({ ...NO_EDITS, trimEndMs: 100 }, 10_000)).toEqual({ startMs: 0, endMs: 500 });
  });

  it("follows the clicks until zooms are edited, then uses the edited list", () => {
    const events: PointerEvent[] = [{ timeMs: 1_000, type: "leftClick", x: 10, y: 10 }];
    expect(resolveZooms(NO_EDITS, events, 10_000)).toHaveLength(1);
    expect(resolveZooms({ ...NO_EDITS, zooms: [] }, events, 10_000)).toEqual([]);
    expect(resolveZooms({ ...NO_EDITS, zooms: [zoom("a", 5_000, 6_000, 2.5)] }, events, 10_000)[0].scale).toBe(2.5);
  });

  it("sorts zooms, removes overlaps and clamps length, position and depth", () => {
    const normalized = normalizeZooms([
      zoom("late", 6_000, 7_000, 9),
      zoom("early", 1_000, 3_000, 0.5),
      zoom("overlap", 2_500, 4_000),
      zoom("tiny", 8_000, 8_050),
      zoom("past-end", 9_900, 12_000),
    ], 10_000);
    expect(normalized.map((z) => z.id)).toEqual(["early", "overlap", "late", "tiny", "past-end"]);
    for (let index = 1; index < normalized.length; index++) {
      expect(normalized[index].startMs).toBeGreaterThanOrEqual(normalized[index - 1].endMs);
    }
    for (const z of normalized) {
      expect(z.endMs - z.startMs).toBeGreaterThanOrEqual(MIN_ZOOM_MS);
      expect(z.endMs).toBeLessThanOrEqual(10_000);
      expect(z.scale).toBeGreaterThanOrEqual(MIN_ZOOM_SCALE);
      expect(z.scale).toBeLessThanOrEqual(MAX_ZOOM_SCALE);
    }
    expect(normalized.find((z) => z.id === "overlap")!.startMs).toBe(3_000);
    // A zoom with no room left after its neighbor is dropped instead of overlapping.
    expect(normalizeZooms([zoom("a", 0, 9_800), zoom("b", 9_700, 10_000)], 10_000).map((z) => z.id)).toEqual(["a"]);
  });
});
