import { describe, expect, it } from "vitest";
import {
  buildRenderFrames,
  computeLayout,
  DEFAULT_FRAME_SETTINGS,
  type FrameSettings,
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

  it("adds a title bar only for macOS frames", () => {
    expect(computeLayout(settings({ frame: "macos-dark" }), source).titleBar).toBeGreaterThan(0);
    expect(computeLayout(settings({ frame: "none" }), source).titleBar).toBe(0);
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
