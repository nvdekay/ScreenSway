// Reads what the browser recorded and turns it into the studio's recording.
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import type { RecordingResult } from "../../desktop/src/ZoomPreview";
import { addRecording } from "./backend";
import { MOTION_HEIGHT, MOTION_WIDTH, motionBetween, timelineOffset, type MotionSample } from "./pointer/align";
import { pointerEvents } from "./pointer/focus";
import type { CapturedRecording } from "./recorder";

/** Seconds of the recording compared to line up the pointer's clock. */
const ALIGN_SECONDS = 20;

/** Size, length and a still of the recording, read from the file the browser wrote. */
export async function prepare(id: string, captured: CapturedRecording): Promise<RecordingResult> {
  const input = new Input({ source: new BlobSource(captured.blob), formats: ALL_FORMATS });
  try {
    return await read(id, input, captured);
  } finally {
    input.dispose();
  }
}

async function read(id: string, input: Input, captured: CapturedRecording): Promise<RecordingResult> {
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error("The recording has no video.");
  const width = video.displayWidth;
  const height = video.displayHeight;
  const durationMs = (await video.computeDuration()) * 1_000;

  let thumbnail: string | null = null;
  try {
    const still = await new CanvasSink(video, { width: 640, height: Math.round((640 * height) / width) }).getCanvas(Math.min(0.5, durationMs / 2_000));
    if (still) {
      const canvas = still.canvas;
      const blob = canvas instanceof OffscreenCanvas ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 }) : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
      if (blob) thumbnail = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    }
  } catch {
    // The magic background falls back to the default without a still.
  }

  // Line the pointer up with the recording, using the first seconds of screen motion.
  let offsetMs = 0;
  try {
    const recorded: MotionSample[] = [];
    let previous: Uint8ClampedArray | null = null;
    const sink = new CanvasSink(video, { width: MOTION_WIDTH, height: MOTION_HEIGHT, fit: "fill" });
    for await (const { canvas, timestamp } of sink.canvases(0, ALIGN_SECONDS)) {
      const context = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!context) break;
      const pixels = context.getImageData(0, 0, MOTION_WIDTH, MOTION_HEIGHT).data;
      if (previous) recorded.push({ timeMs: timestamp * 1_000, motion: motionBetween(previous, pixels) });
      previous = pixels;
    }
    offsetMs = timelineOffset(recorded, captured.motion.filter((sample) => sample.timeMs <= ALIGN_SECONDS * 1_000 + 2_000));
  } catch {
    // Without alignment the pointer is at most a fraction of a second off.
  }
  // Positions arrive as fractions of the frame; the studio works in the recording's pixels.
  const samples = captured.samples.map((sample) => ({ timeMs: sample.timeMs + offsetMs, x: sample.x * width, y: sample.y * height }));

  const url = URL.createObjectURL(captured.blob);
  addRecording({ id, blob: captured.blob, url, thumbnail, discard: captured.discard });
  return {
    projectPath: id,
    videoPath: url,
    pointerEventsPath: "",
    durationMs,
    width,
    height,
    pointerEvents: pointerEvents(samples, width),
  };
}
