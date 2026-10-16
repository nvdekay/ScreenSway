// The pointer is followed on frames read live from the capture, but their timestamps
// start at zero on their own clock, not at the first frame MediaRecorder wrote. Both see
// the same screen, so how much each frame changed lines the two timelines up.

/** How much each frame differs from the one before, at a time in milliseconds. */
export interface MotionSample {
  timeMs: number;
  motion: number;
}

/** Tiny frames are enough to tell how much the screen changed, and cheap to compare. */
export const MOTION_WIDTH = 64;
export const MOTION_HEIGHT = 40;

/** Mean gray-level change between two RGBA images of the same size. */
export function motionBetween(previous: Uint8ClampedArray, current: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < current.length; i += 4) {
    const a = previous[i] * 77 + previous[i + 1] * 150 + previous[i + 2] * 29;
    const b = current[i] * 77 + current[i + 1] * 150 + current[i + 2] * 29;
    sum += Math.abs(a - b) >> 8;
  }
  return sum / (current.length / 4);
}

const SEARCH_MS = 2_000;
const STEP_MS = 10;

/**
 * Milliseconds to add to live timestamps to place them on the recording's timeline, or 0
 * when the recording has too little motion to tell (a still screen needs no alignment).
 */
export function timelineOffset(recorded: MotionSample[], live: MotionSample[]): number {
  const match = timelineMatch(recorded, live);
  return match && match.score >= 0.5 && match.margin >= 0.1 ? match.offset : 0;
}

/**
 * The best offset, how well the two timelines agree there (correlation, -1…1) and by how
 * much it beats the best offset more than 200 ms away. Repeating motion (a spinner, a
 * looping video) agrees at many offsets; then the margin is small and nothing is moved.
 */
export function timelineMatch(recorded: MotionSample[], live: MotionSample[]): { offset: number; score: number; margin: number } | null {
  if (recorded.length < 10 || live.length < 10) return null;
  // Motion at a time: what changed since the previous frame, so take the next frame at or after it.
  const at = (series: MotionSample[], timeMs: number) => {
    let low = 0, high = series.length - 1;
    if (timeMs > series[high].timeMs) return 0;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (series[mid].timeMs < timeMs) low = mid + 1;
      else high = mid;
    }
    return series[low].timeMs - timeMs < 50 ? series[low].motion : 0;
  };
  const times: number[] = [];
  const end = recorded[recorded.length - 1].timeMs;
  for (let t = 0; t <= end; t += STEP_MS) times.push(t);
  const a = times.map((t) => at(recorded, t));
  const meanA = a.reduce((sum, v) => sum + v, 0) / a.length;
  const spreadA = Math.sqrt(a.reduce((sum, v) => sum + (v - meanA) ** 2, 0));
  if (spreadA === 0) return null;

  const scores: { offset: number; score: number }[] = [];
  for (let offset = -SEARCH_MS; offset <= SEARCH_MS; offset += STEP_MS) {
    const b = times.map((t) => at(live, t - offset));
    const meanB = b.reduce((sum, v) => sum + v, 0) / b.length;
    let product = 0, spreadB = 0;
    for (let i = 0; i < a.length; i++) {
      product += (a[i] - meanA) * (b[i] - meanB);
      spreadB += (b[i] - meanB) ** 2;
    }
    scores.push({ offset, score: spreadB > 0 ? product / (spreadA * Math.sqrt(spreadB)) : -1 });
  }
  // Among near ties, the smallest correction.
  const top = Math.max(...scores.map((s) => s.score));
  const best = scores.filter((s) => s.score >= top - 0.005).sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0];
  const rival = Math.max(-1, ...scores.filter((s) => Math.abs(s.offset - best.offset) > 200).map((s) => s.score));
  return { offset: best.offset, score: best.score, margin: best.score - rival };
}
