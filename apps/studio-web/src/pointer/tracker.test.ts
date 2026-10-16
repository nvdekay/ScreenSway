import { describe, expect, it } from "vitest";
import { PointerTracker } from "./tracker";

const W = 480, H = 300;

// A macOS-like arrow: black fill with a white outline, hotspot at the tip (0, 0).
const ARROW = [
  "W.........",
  "WW........",
  "WBW.......",
  "WBBW......",
  "WBBBW.....",
  "WBBBBW....",
  "WBBBBBW...",
  "WBBBBBBW..",
  "WBBBBBBBW.",
  "WBBBBBWWWW",
  "WBBWBBW...",
  "WBW.WBBW..",
  "WW..WBBW..",
  "W....WBBW.",
  ".....WWW..",
];

/** A screen with soft gradients and static shapes, the pointer at (px, py) and a pulsing dot. */
function frame(px: number, py: number, index: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 4;
      const panel = x > 60 && x < 200 && y > 40 && y < 140;
      const value = panel ? 230 : 60 + ((x + y) >> 3);
      data[k] = value;
      data[k + 1] = value;
      data[k + 2] = panel ? 230 : value + 30;
      data[k + 3] = 255;
    }
  }
  // Something animated that stays in place, like a spinner or a video thumbnail.
  const pulse = index % 6 < 3 ? 250 : 20;
  for (let y = 250; y < 262; y++) for (let x = 400; x < 412; x++) data.fill(pulse, (y * W + x) * 4, (y * W + x) * 4 + 3);
  ARROW.forEach((row, dy) => {
    [...row].forEach((cell, dx) => {
      const x = px + dx, y = py + dy;
      if (cell === "." || x < 0 || y < 0 || x >= W || y >= H) return;
      const k = (y * W + x) * 4;
      data.fill(cell === "W" ? 255 : 0, k, k + 3);
    });
  });
  return data;
}

/** A pointer gliding between a few spots and resting at each. */
function position(index: number): [number, number] {
  const stops: [number, number][] = [[30, 30], [300, 80], [120, 220], [380, 200], [90, 90], [250, 160]];
  const leg = Math.floor(index / 30) % (stops.length - 1);
  const t = Math.min(1, (index % 30) / 12);
  const [ax, ay] = stops[leg];
  const [bx, by] = stops[leg + 1];
  return [Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t)];
}

describe("PointerTracker", () => {
  it("learns an unknown pointer from its motion and follows it, also while it rests", () => {
    const tracker = new PointerTracker(W, H);
    let firstLock = -1;
    const errors: number[] = [];
    for (let index = 0; index < 150; index++) {
      const [x, y] = position(index);
      const found = tracker.push(frame(x, y, index));
      if (found && firstLock < 0) firstLock = index;
      if (found) errors.push(Math.hypot(found.x - x, found.y - y));
    }
    expect(firstLock).toBeGreaterThan(0);
    expect(firstLock).toBeLessThan(15);
    expect(errors.filter((error) => error <= 2).length / errors.length).toBeGreaterThan(0.95);
  });

  it("does not mistake animated content that stays in place for the pointer", () => {
    const tracker = new PointerTracker(W, H);
    for (let index = 0; index < 60; index++) expect(tracker.push(frame(-50, -50, index))).toBeNull();
  });
});
