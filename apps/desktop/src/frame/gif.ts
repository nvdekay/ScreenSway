/// <reference path="../gifenc.d.ts" />
import { applyPalette, GIFEncoder, quantize } from "gifenc";

export interface GifOptions {
  /** Width of the GIF; the height keeps the video's proportions. */
  width: number;
  fps: number;
}

export const GIF_PRESETS: { id: "small" | "sharp"; options: GifOptions }[] = [
  { id: "small", options: { width: 480, fps: 10 } },
  { id: "sharp", options: { width: 800, fps: 15 } },
];

/** A rough size, so the user can pick before waiting: GIFs of screen recordings take about a third of a byte per pixel. */
export function estimateGifBytes(options: GifOptions, video: { width: number; height: number; durationMs: number }): number {
  const height = Math.round((options.width * video.height) / video.width);
  return Math.round(options.width * height * Math.ceil((video.durationMs / 1_000) * options.fps) * 0.33);
}

/** Turns the exported video into an animated GIF, frame by frame, on this computer. */
export async function makeGif(url: string, options: GifOptions, onProgress: (percent: number) => void, signal: AbortSignal): Promise<Uint8Array> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error("The exported video could not be read."));
  });
  const width = Math.max(2, Math.round(options.width / 2) * 2);
  const height = Math.max(2, Math.round((width * video.videoHeight) / video.videoWidth / 2) * 2);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.imageSmoothingQuality = "high";
  const encoder = GIFEncoder();
  const count = Math.max(1, Math.floor(video.duration * options.fps));
  const delay = Math.round(1_000 / options.fps);
  for (let index = 0; index < count; index++) {
    if (signal.aborted) throw new Error("Export cancelled.");
    video.currentTime = Math.min(video.duration - 0.001, (index + 0.5) / options.fps);
    await new Promise<void>((resolve) => video.addEventListener("seeked", () => resolve(), { once: true }));
    context.drawImage(video, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    const palette = quantize(data, 256, { format: "rgb444" });
    encoder.writeFrame(applyPalette(data, palette, "rgb444"), width, height, { palette, delay });
    onProgress(Math.min(99, Math.floor(((index + 1) / count) * 100)));
  }
  encoder.finish();
  video.removeAttribute("src");
  video.load();
  return encoder.bytes();
}
