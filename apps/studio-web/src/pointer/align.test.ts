import { describe, expect, it } from "vitest";
import { timelineOffset, type MotionSample } from "./align";

/** Bursts of motion at irregular times, sampled at 30 fps with dropped frames. */
function series(shiftMs: number, durationMs = 8_000): MotionSample[] {
  const bursts = [700, 1_900, 2_300, 4_100, 6_600];
  const samples: MotionSample[] = [];
  for (let t = 0; t < durationMs; t += 33) {
    if ((t / 33) % 7 === 3) continue;
    const real = t + shiftMs;
    const motion = bursts.reduce((sum, start) => sum + (real >= start && real < start + 200 ? 10 + (start % 7) : 0), 0);
    samples.push({ timeMs: t, motion });
  }
  return samples;
}

describe("timelineOffset", () => {
  it("finds how far live frames are behind or ahead of the recording", () => {
    expect(Math.abs(timelineOffset(series(0), series(420)) - 420)).toBeLessThanOrEqual(40);
    expect(Math.abs(timelineOffset(series(0), series(-180)) + 180)).toBeLessThanOrEqual(40);
  });

  it("does not guess when the motion repeats, like a spinner", () => {
    const spinner = (shiftMs: number): MotionSample[] => {
      const samples: MotionSample[] = [];
      for (let t = 0; t < 8_000; t += 33) samples.push({ timeMs: t, motion: (t + shiftMs) % 500 < 100 ? 12 : 0 });
      return samples;
    };
    expect(timelineOffset(spinner(0), spinner(330))).toBe(0);
  });

  it("leaves still recordings alone", () => {
    const still = series(0).map((sample) => ({ ...sample, motion: 0 }));
    expect(timelineOffset(still, series(300))).toBe(0);
  });
});
