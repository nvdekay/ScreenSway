import { describe, expect, it } from "vitest";
import {
  BUILT_IN_STYLES,
  buildRenderFrames,
  computeLayout,
  DEFAULT_FRAME_SETTINGS,
  MESH_PRESETS,
  WAVE_PRESETS,
  type BackgroundSpec,
  type FrameSettings,
  type FrameStyle,
  type PointerEvent,
} from "./index";

const source = { width: 3024, height: 1964 };
const settings = (overrides: Partial<FrameSettings> = {}): FrameSettings => ({ ...DEFAULT_FRAME_SETTINGS, ...overrides });

describe("computeLayout", () => {
  it("uses the recording's aspect ratio and the quality's short side", () => {
    const layout = computeLayout(settings({ aspect: "auto", quality: "1080p" }), source);
    expect(layout.height).toBe(1080);
    expect(layout.width).toBe(1662);
  });

  it("produces even output sizes within H.264 limits for 4K presets", () => {
    for (const aspect of ["auto", "16:9", "4:3", "1:1", "9:16"] as const) {
      const layout = computeLayout(settings({ aspect, quality: "4k" }), source);
      expect(layout.width % 2).toBe(0);
      expect(layout.height % 2).toBe(0);
      expect(Math.max(layout.width, layout.height)).toBeLessThanOrEqual(4096);
    }
  });

  it("keeps the video at the recording's aspect ratio, centered, inside the padding", () => {
    for (const aspect of ["16:9", "1:1", "9:16"] as const) {
      const layout = computeLayout(settings({ aspect, padding: 0.1 }), source);
      expect(layout.video.width / layout.video.height).toBeCloseTo(source.width / source.height, 5);
      const inset = Math.min(layout.width, layout.height) * 0.1;
      expect(layout.window.x).toBeGreaterThanOrEqual(inset - 0.01);
      expect(layout.window.y).toBeGreaterThanOrEqual(inset - 0.01);
      expect(layout.window.x * 2 + layout.window.width).toBeCloseTo(layout.width, 5);
      expect(layout.window.y * 2 + layout.window.height).toBeCloseTo(layout.height, 5);
    }
  });

  it("adds a title bar only for window and browser frames", () => {
    expect(computeLayout(settings({ frame: "macos-dark" }), source).titleBar).toBeGreaterThan(0);
    const browser = computeLayout(settings({ frame: "browser-light" }), source);
    expect(browser.titleBar).toBeGreaterThan(computeLayout(settings({ frame: "macos-light" }), source).titleBar);
    expect(browser.roundVideoTop).toBe(false);
    expect(computeLayout(settings({ frame: "none" }), source).titleBar).toBe(0);
    expect(computeLayout(settings({ frame: "none" }), source).roundVideoTop).toBe(true);
  });

  const styles: FrameStyle[] = ["none", "macos-light", "macos-dark", "browser-light", "browser-dark", "macbook", "glass", "outline"];

  it("keeps every frame, video and laptop base inside the padded canvas", () => {
    for (const frame of styles) {
      for (const aspect of ["auto", "16:9", "1:1", "9:16"] as const) {
        const layout = computeLayout(settings({ frame, aspect, padding: 0.08 }), source);
        const inset = Math.min(layout.width, layout.height) * 0.08 - 0.01;
        const parts = [layout.window, layout.video, ...(layout.base ? [layout.base] : [])];
        for (const part of parts) {
          expect(part.x).toBeGreaterThanOrEqual(inset);
          expect(part.y).toBeGreaterThanOrEqual(inset);
          expect(part.x + part.width).toBeLessThanOrEqual(layout.width - inset);
          expect(part.y + part.height).toBeLessThanOrEqual(layout.height - inset);
        }
        // The video always keeps the recording's shape and sits inside its window.
        expect(layout.video.width / layout.video.height).toBeCloseTo(source.width / source.height, 5);
        expect(layout.video.x).toBeGreaterThanOrEqual(layout.window.x);
        expect(layout.video.y + layout.video.height).toBeLessThanOrEqual(layout.window.y + layout.window.height + 0.01);
      }
    }
  });

  it("draws a laptop as a bezel around the video with a wider base underneath", () => {
    const layout = computeLayout(settings({ frame: "macbook", padding: 0.05 }), source);
    expect(layout.bezel).toBeGreaterThan(0);
    expect(layout.video.x - layout.window.x).toBeCloseTo(layout.bezel, 5);
    expect(layout.window.x + layout.window.width - (layout.video.x + layout.video.width)).toBeCloseTo(layout.bezel, 5);
    expect(layout.base).not.toBeNull();
    expect(layout.base!.y).toBeCloseTo(layout.window.y + layout.window.height, 5);
    expect(layout.base!.width).toBeGreaterThan(layout.window.width);
    expect(layout.base!.x + layout.base!.width / 2).toBeCloseTo(layout.width / 2, 5);
    // The whole device is centered vertically.
    expect(layout.window.y).toBeCloseTo(layout.height - (layout.base!.y + layout.base!.height), 5);
    expect(layout.videoRadius).toBeLessThan(layout.radius);
    expect(layout.roundVideoTop).toBe(true);
  });
});

describe("presets", () => {
  const colors = (background: BackgroundSpec): string[] => {
    switch (background.kind) {
      case "solid": return [background.color];
      case "linear": return background.stops.map((stop) => stop.color);
      case "mesh": return [background.base, ...background.blobs.map((blob) => blob.color)];
      case "waves": return [...background.sky, ...background.layers];
      case "image": return [];
    }
  };

  it("have unique ids and valid colors", () => {
    const all = [...MESH_PRESETS, ...WAVE_PRESETS];
    expect(new Set(all.map((preset) => preset.id)).size).toBe(all.length);
    expect(all.length).toBeGreaterThanOrEqual(26);
    for (const preset of all) {
      for (const color of colors(preset.background)) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("built-in styles are complete and lay out", () => {
    expect(new Set(BUILT_IN_STYLES.map((style) => style.id)).size).toBe(BUILT_IN_STYLES.length);
    for (const style of BUILT_IN_STYLES) {
      expect(Object.keys(style.settings).sort()).toEqual(Object.keys(DEFAULT_FRAME_SETTINGS).filter((key) => key !== "quality").sort());
      const layout = computeLayout({ ...style.settings, quality: "1080p" }, source);
      expect(layout.video.width).toBeGreaterThan(0);
    }
  });
});

describe("buildRenderFrames", () => {
  const layout = computeLayout(settings({ frame: "none", padding: 0 }), source);
  const events: PointerEvent[] = [
    { timeMs: 0, type: "move", x: 1512, y: 982 },
    { timeMs: 1_000, type: "leftClick", x: 2800, y: 1800 },
  ];

  it("emits one frame per output frame", () => {
    expect(buildRenderFrames(events, source, layout, 2_000, 60, true)).toHaveLength(120);
  });

  it("shows the whole recording without auto zoom", () => {
    const [frame] = buildRenderFrames(events, source, layout, 100, 60, false);
    expect(frame.slice(0, 4)).toEqual([0, 0, 3024, 1964]);
  });

  it("keeps the zoomed crop inside the recording", () => {
    for (const [x, y, width, height] of buildRenderFrames(events, source, layout, 6_000, 60, true)) {
      expect(x).toBeGreaterThanOrEqual(-0.01);
      expect(y).toBeGreaterThanOrEqual(-0.01);
      expect(x + width).toBeLessThanOrEqual(source.width + 0.01);
      expect(y + height).toBeLessThanOrEqual(source.height + 0.01);
    }
  });

  it("renders only the trimmed part, with the camera of the full timeline", () => {
    const zooms = [{ id: "z", startMs: 1_000, endMs: 3_000, centerX: 2800, centerY: 1800, scale: 2 }];
    const full = buildRenderFrames(events, source, layout, 6_000, 60, true, { zooms });
    const trimmed = buildRenderFrames(events, source, layout, 6_000, 60, true, { zooms, startMs: 2_000, endMs: 4_000 });
    expect(trimmed).toHaveLength(120);
    expect(trimmed[0]).toEqual(full[120]);
    expect(trimmed[60]).toEqual(full[180]);
    // The edited zoom is followed instead of the automatic one.
    expect(trimmed[0][2]).toBeLessThan(source.width * 0.6);
    const none = buildRenderFrames(events, source, layout, 6_000, 60, true, { zooms: [] });
    expect(none.every((frame) => frame[2] === source.width)).toBe(true);
  });

  it("renders non-contiguous source times for middle cuts", () => {
    const full = buildRenderFrames(events, source, layout, 4_000, 2, true);
    const cut = buildRenderFrames(events, source, layout, 4_000, 2, true, { sourceTimesMs: [0, 500, 2_000, 2_500] });
    expect(cut).toEqual([full[0], full[1], full[4], full[5]]);
  });

  it("maps the cursor into the video rectangle and shows a ripple after a click", () => {
    const frames = buildRenderFrames(events, source, layout, 2_000, 60, false);
    const [, , , , cursorX, cursorY] = frames[0];
    expect(cursorX).toBeCloseTo(layout.video.x + layout.video.width / 2, 0);
    expect(cursorY).toBeCloseTo(layout.video.y + layout.video.height / 2, 0);
    const afterClick = frames[Math.round(1.1 * 60)];
    expect(afterClick[10]).toBeGreaterThan(0);
    expect(frames[30][10]).toBe(0);
  });
});

describe("filled frames", () => {
  const source = { width: 1920, height: 1080 };
  const settings = { ...DEFAULT_FRAME_SETTINGS, aspect: "9:16" as const, padding: 0, frame: "none" as const, fill: true };

  it("gives the video the frame's shape", () => {
    const layout = computeLayout(settings, source);
    expect(layout.video.width / layout.video.height).toBeCloseTo(9 / 16, 3);
    const letterboxed = computeLayout({ ...settings, fill: false }, source);
    expect(letterboxed.video.width / letterboxed.video.height).toBeCloseTo(16 / 9, 3);
  });

  it("crops a view of the same shape that follows the pointer", () => {
    const layout = computeLayout(settings, source);
    const events = [
      { timeMs: 0, type: "move" as const, x: 200, y: 500 },
      { timeMs: 3_000, type: "move" as const, x: 200, y: 500 },
      { timeMs: 3_100, type: "move" as const, x: 1700, y: 500 },
      { timeMs: 8_000, type: "move" as const, x: 1700, y: 500 },
    ];
    const frames = buildRenderFrames(events, source, layout, 8_000, 30, false, { zooms: [] });
    const [startX, , width, height] = frames[0];
    expect(width / height).toBeCloseTo(9 / 16, 2);
    expect(height).toBeCloseTo(1080, 0);
    // The pointer is on the left at first and on the right at the end, always inside the view.
    expect(startX).toBe(0);
    const last = frames.at(-1)!;
    expect(last[0]).toBeGreaterThan(1_100);
    expect(last[4]).toBeGreaterThan(layout.width * 0.2);
    expect(last[4]).toBeLessThan(layout.width * 0.8);
  });

  it("holds the view where a framing segment puts it", () => {
    const layout = computeLayout(settings, source);
    const events = [{ timeMs: 0, type: "move" as const, x: 1800, y: 500 }, { timeMs: 6_000, type: "move" as const, x: 1800, y: 500 }];
    const frames = buildRenderFrames(events, source, layout, 6_000, 30, false, { zooms: [], framing: [{ id: "f", startMs: 0, endMs: 6_000, x: 0.5 }] });
    const last = frames.at(-1)!;
    expect(last[0] + last[2] / 2).toBeCloseTo(960, 0);
  });

  it("magnifies the cursor with the view, as a zoom does", () => {
    const filled = computeLayout(settings, source);
    const events = [{ timeMs: 0, type: "move" as const, x: 960, y: 540 }];
    const [frame] = buildRenderFrames(events, source, filled, 100, 30, false, { zooms: [] });
    const plain = computeLayout({ ...settings, aspect: "16:9" }, source);
    const [reference] = buildRenderFrames(events, source, plain, 100, 30, false, { zooms: [] });
    // The 9:16 frame shows the recording's full height on a 1920 px tall frame instead of 1080.
    expect(frame[6]).toBeCloseTo((reference[6] * 1920) / 1080, 1);
  });
});
