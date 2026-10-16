// Follows the pointer in the live capture, off the main thread so it keeps running while
// the page is in the background (which is the usual case: the user records another app).
import { PointerTracker } from "./tracker";
import type { PointerSample } from "./focus";
import { MOTION_HEIGHT, MOTION_WIDTH, motionBetween, type MotionSample } from "./align";

/** Frames are analysed at most this wide; the pointer stays ~10 px tall or more. */
const ANALYSIS_WIDTH = 1600;

export type WorkerRequest = { type: "start"; frames: ReadableStream<VideoFrame> } | { type: "finish" };
/** Pointer positions are fractions of the frame (0…1), so a window resized mid-recording keeps them right. */
export type WorkerResponse = { type: "samples"; samples: PointerSample[]; motion: MotionSample[] };

let samples: PointerSample[] = [];
/** Reused for every frame: reading pixels with getImageData allocates ~6 MB a frame. */
let rgba = new Uint8ClampedArray(0);
let copyWorks = true;

/** The analysis canvas's pixels, copied into the reused buffer where the browser allows it. */
async function pixels(context: OffscreenCanvasRenderingContext2D, width: number, height: number): Promise<Uint8ClampedArray> {
  if (copyWorks) {
    if (rgba.length !== width * height * 4) rgba = new Uint8ClampedArray(width * height * 4);
    const frame = new VideoFrame(context.canvas, { timestamp: 0 });
    try {
      await frame.copyTo(rgba, { format: "RGBA", colorSpace: "srgb" } as VideoFrameCopyToOptions);
      return rgba;
    } catch {
      copyWorks = false;
    } finally {
      frame.close();
    }
  }
  return context.getImageData(0, 0, width, height).data;
}
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
        const nextScale = Math.min(1, ANALYSIS_WIDTH / width);
        // At the same scale the pointer looks the same, so what was learned still applies.
        if (tracker && Math.abs(nextScale - scale) < 0.02) tracker.resize(Math.round(width * scale), Math.round(height * scale));
        else {
          scale = nextScale;
          tracker = new PointerTracker(Math.round(width * scale), Math.round(height * scale));
        }
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
      const position = tracker.push(await pixels(context, tracker.width, tracker.height));
      if (!position) continue;
      const sample = { timeMs, x: position.x / tracker.width, y: position.y / tracker.height };
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
