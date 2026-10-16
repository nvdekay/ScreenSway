// Follows the pointer in the live capture, off the main thread so it keeps running while
// the page is in the background (which is the usual case: the user records another app).
import { PointerTracker } from "./tracker";
import type { PointerSample } from "./focus";
import { MOTION_HEIGHT, MOTION_WIDTH, motionBetween, type MotionSample } from "./align";

/** Frames are analysed at most this wide; the pointer stays ~10 px tall or more. */
const ANALYSIS_WIDTH = 1600;

export type WorkerRequest = { type: "start"; frames: ReadableStream<VideoFrame> } | { type: "finish" };
export type WorkerResponse = { type: "samples"; samples: PointerSample[]; motion: MotionSample[] };

let samples: PointerSample[] = [];
let motion: MotionSample[] = [];
let finished = false;

async function follow(frames: ReadableStream<VideoFrame>) {
  const reader = frames.getReader();
  let tracker: PointerTracker | null = null;
  let context: OffscreenCanvasRenderingContext2D | null = null;
  let scale = 1;
  let firstTimestamp: number | null = null;
  let last: PointerSample | null = null;
  const tiny = new OffscreenCanvas(MOTION_WIDTH, MOTION_HEIGHT).getContext("2d", { willReadFrequently: true })!;
  let previousTiny: Uint8ClampedArray | null = null;
  while (!finished) {
    const { value: frame, done } = await reader.read();
    if (done || !frame) break;
    try {
      const width = frame.displayWidth;
      const height = frame.displayHeight;
      // A captured window can change size; start over at the new size.
      if (!tracker || Math.round(width * scale) !== tracker.width || Math.round(height * scale) !== tracker.height) {
        scale = Math.min(1, ANALYSIS_WIDTH / width);
        tracker = new PointerTracker(Math.round(width * scale), Math.round(height * scale));
        context = new OffscreenCanvas(tracker.width, tracker.height).getContext("2d", { willReadFrequently: true });
      }
      if (!context) continue;
      firstTimestamp ??= frame.timestamp;
      const timeMs = (frame.timestamp - firstTimestamp) / 1_000;
      // How much the screen changed, to line this clock up with the recording afterwards.
      tiny.drawImage(frame, 0, 0, MOTION_WIDTH, MOTION_HEIGHT);
      const small = tiny.getImageData(0, 0, MOTION_WIDTH, MOTION_HEIGHT).data;
      if (previousTiny) motion.push({ timeMs, motion: motionBetween(previousTiny, small) });
      previousTiny = small;
      context.drawImage(frame, 0, 0, tracker.width, tracker.height);
      const position = tracker.push(context.getImageData(0, 0, tracker.width, tracker.height).data);
      if (!position) continue;
      const sample = { timeMs, x: position.x / scale, y: position.y / scale };
      // Every move, and a still pointer now and then, so pauses can be measured.
      if (!last || sample.x !== last.x || sample.y !== last.y || sample.timeMs - last.timeMs >= 100) {
        samples.push(sample);
        last = sample;
      }
    } finally {
      frame.close();
    }
  }
  reader.releaseLock();
  void frames.cancel().catch(() => {});
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "start") {
    samples = [];
    motion = [];
    finished = false;
    void follow(event.data.frames);
  } else {
    finished = true;
    self.postMessage({ type: "samples", samples, motion } satisfies WorkerResponse);
  }
};
