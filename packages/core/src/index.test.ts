import { describe, expect, it } from "vitest";
import {
  applyZoomStrength,
  normalizeSpeeds,
  buildSourceTimes,
  buildCameraTrack,
  clampCamera,
  generateZoomSegments,
  keptDuration,
  keptRanges,
  sampleCameraTrack,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_MS,
  MIN_ZOOM_SCALE,
  NO_EDITS,
  normalizeZooms,
  outputToSourceTime,
  resolveZooms,
  samplePointer,
  sourceToOutputTime,
  trimRange,
  type PointerEvent,
  cameraRect,
  DEFAULT_CAMERA_OVERLAY,
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

describe("buildCameraTrack with focus points", () => {
  const canvas = { width: 1_000, height: 1_000 };
  // The pointer settles top-left, then moves to the bottom right within the same zoom.
  const events: PointerEvent[] = [
    { timeMs: 0, type: "move", x: 250, y: 250 },
    { timeMs: 1_000, type: "focus", x: 250, y: 250 },
    { timeMs: 2_000, type: "move", x: 250, y: 250 },
    { timeMs: 2_300, type: "move", x: 700, y: 700 },
    { timeMs: 2_300, type: "focus", x: 700, y: 700 },
  ];
  const segments = generateZoomSegments(events);
  const track = buildCameraTrack(events, segments, canvas, 8_000);

  it("keeps one zoom and moves the camera to where the pointer settled next", () => {
    expect(segments).toHaveLength(1);
    expect(sampleCameraTrack(track, 1_900).x).toBeLessThan(0.33);
    expect(sampleCameraTrack(track, 3_500).x).toBeGreaterThan(0.6);
    expect(sampleCameraTrack(track, 3_500).scale).toBeGreaterThan(1.75);
  });

  it("does not move for clicks, which keep the desktop behaviour", () => {
    const clicks = events.map((event) => (event.type === "focus" ? { ...event, type: "leftClick" as const } : event));
    const clickTrack = buildCameraTrack(clicks, generateZoomSegments(clicks), canvas, 8_000);
    expect(sampleCameraTrack(clickTrack, 3_500).x).toBeLessThan(sampleCameraTrack(track, 3_500).x);
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

describe("applyZoomStrength", () => {
  const zoomAt = (scale: number) => ({ id: "z", startMs: 0, endMs: 1_000, centerX: 0, centerY: 0, scale });

  it("scales how far each zoom goes in, keeping its own depth relative to the others", () => {
    const zooms = [zoomAt(1.8), zoomAt(2.6)];
    expect(applyZoomStrength(zooms, 0.5).map((z) => z.scale)).toEqual([1.4, 1.8]);
    expect(applyZoomStrength(zooms, 1)).toBe(zooms);
    expect(applyZoomStrength(zooms)).toBe(zooms);
  });

  it("keeps the strength and the result in range", () => {
    expect(applyZoomStrength([zoomAt(3)], 9)[0].scale).toBe(MAX_ZOOM_SCALE);
    expect(applyZoomStrength([zoomAt(1.8)], 0)[0].scale).toBeCloseTo(1.2);
    expect(applyZoomStrength([zoomAt(1.8)], Number.NaN)[0].scale).toBe(1.8);
  });
});

describe("speed changes", () => {
  const edits = { ...NO_EDITS, trimStartMs: 1_000, trimEndMs: 9_000, cuts: [{ id: "c", startMs: 4_000, endMs: 5_000 }], speeds: [
    { id: "fast", startMs: 2_000, endMs: 6_000, rate: 4 },
  ] };

  it("splits the kept parts where the speed changes, around cuts", () => {
    expect(keptRanges(edits, 10_000)).toEqual([
      { startMs: 1_000, endMs: 2_000 },
      { startMs: 2_000, endMs: 4_000, rate: 4 },
      { startMs: 5_000, endMs: 6_000, rate: 4 },
      { startMs: 6_000, endMs: 9_000 },
    ]);
  });

  it("maps time both ways through faster parts", () => {
    const ranges = keptRanges(edits, 10_000);
    // 1 s + 2 s and 1 s at 4× + 3 s
    expect(keptDuration(ranges)).toBe(1_000 + 500 + 250 + 3_000);
    expect(sourceToOutputTime(ranges, 3_000)).toBe(1_000 + 250);
    expect(outputToSourceTime(ranges, 1_250)).toBe(3_000);
    expect(outputToSourceTime(ranges, 1_500)).toBe(5_000);
    expect(outputToSourceTime(ranges, 1_750)).toBe(6_000);
    expect(sourceToOutputTime(ranges, 7_000)).toBe(2_750);
    const times = buildSourceTimes(ranges, 60);
    expect(times.length).toBe(Math.ceil(4.75 * 60));
    // Inside the 4× part each frame moves four frames' worth of recording.
    const fast = times.findIndex((time) => time >= 2_000);
    expect(times[fast + 1] - times[fast]).toBeCloseTo(4_000 / 60);
  });

  it("drops speeds that change nothing and keeps the rest in range", () => {
    const range = { startMs: 0, endMs: 10_000 };
    expect(normalizeSpeeds([
      { id: "same", startMs: 0, endMs: 1_000, rate: 1 },
      { id: "tiny", startMs: 2_000, endMs: 2_050, rate: 2 },
      { id: "wild", startMs: 3_000, endMs: 4_000, rate: 100 },
      { id: "overlap", startMs: 3_500, endMs: 12_000, rate: 0.5 },
      { id: "broken", startMs: 5_000, endMs: 6_000, rate: Number.NaN },
    ], range)).toEqual([
      { id: "wild", startMs: 3_000, endMs: 4_000, rate: 16 },
      { id: "overlap", startMs: 4_000, endMs: 10_000, rate: 0.5 },
    ]);
  });
});

describe("middle cuts", () => {
  const edits = { ...NO_EDITS, trimStartMs: 1_000, trimEndMs: 9_000, cuts: [
    { id: "a", startMs: 2_000, endMs: 3_000 },
    { id: "b", startMs: 5_000, endMs: 7_000 },
  ] };

  it("turns trim and cuts into kept source ranges", () => {
    const ranges = keptRanges(edits, 10_000);
    expect(ranges).toEqual([
      { startMs: 1_000, endMs: 2_000 },
      { startMs: 3_000, endMs: 5_000 },
      { startMs: 7_000, endMs: 9_000 },
    ]);
    expect(keptDuration(ranges)).toBe(5_000);
  });

  it("maps source and output time across cuts", () => {
    const ranges = keptRanges(edits, 10_000);
    expect(sourceToOutputTime(ranges, 4_000)).toBe(2_000);
    expect(outputToSourceTime(ranges, 3_500)).toBe(7_500);
    expect(buildSourceTimes(ranges, 2)).toEqual([1_000, 1_500, 3_000, 3_500, 4_000, 4_500, 7_000, 7_500, 8_000, 8_500]);
  });
});

describe("cameraRect", () => {
  it("places the camera by its centre and keeps it inside the frame", () => {
    const box = cameraRect(DEFAULT_CAMERA_OVERLAY, 1920, 1080);
    expect(box.width).toBe(281);
    expect(box.height).toBe(281);
    expect(box.radius).toBe(140.5);
    expect(box.x + box.width).toBeLessThanOrEqual(1920);
    const corner = cameraRect({ ...DEFAULT_CAMERA_OVERLAY, x: 1, y: 1 }, 1920, 1080);
    expect(corner.x + corner.width).toBe(1920);
    expect(corner.y + corner.height).toBe(1080);
  });

  it("uses a landscape box with small corners for the rounded shape", () => {
    const box = cameraRect({ ...DEFAULT_CAMERA_OVERLAY, shape: "rounded", size: 0.4 }, 1080, 1920);
    expect(box).toMatchObject({ width: 432, height: 324, radius: 35 });
  });
});
