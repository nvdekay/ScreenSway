import { describe, expect, it } from "vitest";
import { centredArea, changeArea } from "./captureArea";

const WIDE = 16 / 9;
const pixels = (area: { width: number; height: number }) => (area.width * 1920) / (area.height * 1080);
const inside = (area: { x: number; y: number; width: number; height: number }) =>
  area.x >= 0 && area.y >= 0 && area.x + area.width <= 100 && area.y + area.height <= 100;

describe("capture area shapes", () => {
  it("centres the largest area of each shape on the display", () => {
    const tall = centredArea(9 / 16, WIDE);
    expect(tall.height).toBeCloseTo(100, 2);
    expect(pixels(tall)).toBeCloseTo(9 / 16, 2);
    expect(tall.x).toBeCloseTo((100 - tall.width) / 2, 2);
    const square = centredArea(1, WIDE);
    expect(pixels(square)).toBeCloseTo(1, 2);
    const wide = centredArea(21 / 9, WIDE);
    expect(wide.width).toBe(100);
    expect(pixels(wide)).toBeCloseTo(21 / 9, 2);
    for (const area of [tall, square, wide, centredArea(WIDE, WIDE)]) expect(inside(area)).toBe(true);
  });

  it("keeps a fixed shape when a side is typed and when it is moved", () => {
    const start = centredArea(9 / 16, WIDE);
    const smaller = changeArea(start, "width", 20, 9 / 16, WIDE);
    expect(smaller.width).toBe(20);
    expect(pixels(smaller)).toBeCloseTo(9 / 16, 2);
    const byHeight = changeArea(start, "height", 50, 9 / 16, WIDE);
    expect(byHeight.height).toBeCloseTo(50, 1);
    const moved = changeArea(smaller, "x", 95, 9 / 16, WIDE);
    expect(moved.width).toBe(smaller.width);
    expect(inside(moved)).toBe(true);
    // Never larger than fits where it is.
    expect(inside(changeArea({ ...smaller, y: 40 }, "width", 90, 9 / 16, WIDE))).toBe(true);
  });

  it("sets each field freely without a shape", () => {
    // Moving past the edge narrows the area, as before shapes existed.
    expect(changeArea({ x: 10, y: 10, width: 80, height: 80 }, "x", 50, null, WIDE)).toEqual({ x: 50, y: 10, width: 50, height: 80 });
    expect(changeArea({ x: 10, y: 10, width: 80, height: 80 }, "height", 2, null, WIDE).height).toBe(5);
  });
});
