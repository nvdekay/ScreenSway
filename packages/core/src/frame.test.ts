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
