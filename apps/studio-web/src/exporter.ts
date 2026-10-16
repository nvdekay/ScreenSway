import type { RenderFrame } from "@screensway/core";
import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSampleSink,
  canEncodeAudio,
} from "mediabunny";

/** The job the studio builds for the desktop helper (see Exporter.swift); captions are not offered on the web. */
export interface ExportJob {
  width: number;
  height: number;
  fps: number;
  video: { x: number; y: number; width: number; height: number };
  radius: number;
  roundTopCorners: boolean;
  startMs: number;
  frames: RenderFrame[];
}

export class ExportCancelled extends Error {
  constructor() {
    super("Export cancelled.");
  }
}

/**
 * Renders the framed, zoomed video exactly like the desktop helper: the painted base layer,
 * then the cropped recording inside the rounded video area, encoded to H.264 MP4 with the
 * recording's sound. Runs faster than real time and keeps working in a background tab.
 */
export async function renderExport(
  recording: Blob,
  job: ExportJob,
  baseLayer: string,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const input = new Input({ source: new BlobSource(recording), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error("The recording has no video.");
  const audioTrack = await input.getPrimaryAudioTrack();

  const canvas = new OffscreenCanvas(job.width, job.height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas is not available.");
  context.imageSmoothingQuality = "high";
  const base = await createImageBitmap(await (await fetch(baseLayer)).blob());

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  // The desktop exporter's bitrate (Exporter.swift): sharp text when zoomed.
  const bitrate = Math.round(Math.min(100_000_000, Math.max(8_000_000, job.width * job.height * job.fps * 0.12)));
  const videoSource = new CanvasSource(canvas, { codec: "avc", bitrate });
  output.addVideoTrack(videoSource, { frameRate: job.fps });
  const audioCodec = (await canEncodeAudio("aac")) ? "aac" : "opus";
  const audioSource = audioTrack ? new AudioBufferSource({ codec: audioCodec, bitrate: 160_000 }) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();

  const abort = () => {
    throw new ExportCancelled();
  };
  try {
    const { video, radius, roundTopCorners, frames, fps, startMs } = job;
    const corners = roundTopCorners ? [radius, radius, radius, radius] : [0, 0, radius, radius];
    const first = await videoTrack.getFirstTimestamp();
    const times = frames.map((_, index) => Math.max(first, (startMs + (index * 1_000) / fps) / 1_000));
    const sink = new VideoSampleSink(videoTrack);
    let index = 0;
    let shown = -1;
    for await (const sample of sink.samplesAtTimestamps(times)) {
      if (signal.aborted) {
        sample?.close();
        abort();
      }
      const [cropX, cropY, cropWidth, cropHeight] = frames[index];
      context.drawImage(base, 0, 0);
      if (sample) {
        context.save();
        context.beginPath();
        context.roundRect(video.x, video.y, video.width, video.height, corners);
        context.clip();
        sample.draw(context, cropX, cropY, cropWidth, cropHeight, video.x, video.y, video.width, video.height);
        context.restore();
        sample.close();
      }
      await videoSource.add(index / fps, 1 / fps);
      index++;
      const percent = Math.min(99, Math.floor((index / frames.length) * (audioSource ? 95 : 99)));
      if (percent !== shown) onProgress((shown = percent));
    }
    videoSource.close();

    if (audioTrack && audioSource) {
      const start = startMs / 1_000;
      const end = start + frames.length / fps;
      for await (const { buffer, timestamp } of new AudioBufferSink(audioTrack).buffers(start, end)) {
        if (signal.aborted) abort();
        const kept = keep(buffer, timestamp, start, end);
        if (kept) await audioSource.add(kept);
      }
      audioSource.close();
    }
    await output.finalize();
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  } finally {
    base.close();
  }
  onProgress(100);
  return new Blob([target.buffer!], { type: "video/mp4" });
}

/** The part of an audio buffer that falls inside [start, end) seconds. */
function keep(buffer: AudioBuffer, timestamp: number, start: number, end: number): AudioBuffer | null {
  const from = Math.max(0, Math.round((start - timestamp) * buffer.sampleRate));
  const to = Math.min(buffer.length, Math.round((end - timestamp) * buffer.sampleRate));
  if (to <= from) return null;
  if (from === 0 && to === buffer.length) return buffer;
  const part = new AudioBuffer({ length: to - from, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    part.copyToChannel(buffer.getChannelData(channel).subarray(from, to), channel);
  }
  return part;
}
