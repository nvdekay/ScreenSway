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
  StreamTarget,
  VideoSampleSink,
  canEncodeAudio,
  canEncodeVideo,
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

export const CANCELLED = "Export cancelled.";

export class ExportCancelled extends Error {
  constructor() {
    super(CANCELLED);
  }
}

/**
 * Renders the framed, zoomed video with the desktop helper's layout and camera plan: the
 * painted base layer, then the cropped recording inside the rounded video area, encoded to
 * H.264 MP4 with the recording's sound. Runs faster than real time and keeps working in a
 * background tab. With `file`, the MP4 is written straight to disk as it is made; otherwise
 * it is returned in memory.
 */
export async function renderExport(
  recording: Blob,
  job: ExportJob,
  baseLayer: string,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
  file: FileSystemWritableFileStream | null,
): Promise<Blob | null> {
  const checkpoint = () => {
    if (signal.aborted) throw new ExportCancelled();
  };
  // The desktop exporter's bitrate (Exporter.swift): sharp text when zoomed.
  const bitrate = Math.round(Math.min(100_000_000, Math.max(8_000_000, job.width * job.height * job.fps * 0.12)));
  if (!(await canEncodeVideo("avc", { width: job.width, height: job.height, bitrate }))) {
    throw new Error(`This browser cannot encode ${job.width} × ${job.height} video. Choose a lower export quality.`);
  }

  const input = new Input({ source: new BlobSource(recording), formats: ALL_FORMATS });
  let output: Output | null = null;
  let base: ImageBitmap | null = null;
  // Cancelling also stops a long finalize, not only the frame loop.
  const cancel = () => void output?.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error("The recording has no video.");
    const audioTrack = await input.getPrimaryAudioTrack();
    checkpoint();

    const canvas = new OffscreenCanvas(job.width, job.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas is not available.");
    context.imageSmoothingQuality = "high";
    base = await createImageBitmap(await (await fetch(baseLayer)).blob());
    checkpoint();

    const target = file ? new StreamTarget(file as unknown as WritableStream, { chunked: true }) : new BufferTarget();
    output = new Output({ format: new Mp4OutputFormat({ fastStart: file ? false : "in-memory" }), target });
    const videoSource = new CanvasSource(canvas, { codec: "avc", bitrate });
    output.addVideoTrack(videoSource, { frameRate: job.fps });
    const audioCodec = (await canEncodeAudio("aac")) ? "aac" : "opus";
    const audioSource = audioTrack ? new AudioBufferSource({ codec: audioCodec, bitrate: 160_000 }) : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();
    checkpoint();

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
        throw new ExportCancelled();
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
      // Sound is laid end to end, so gaps in the recording are filled with silence to stay in sync.
      let written = start;
      for await (const { buffer, timestamp } of new AudioBufferSink(audioTrack).buffers(start, end)) {
        checkpoint();
        const gap = timestamp - written;
        if (gap > 0.01) await audioSource.add(silence(Math.min(gap, end - written), buffer.sampleRate, buffer.numberOfChannels));
        const kept = keep(buffer, Math.max(timestamp, written), timestamp, end);
        if (kept) {
          await audioSource.add(kept);
          written = Math.max(timestamp, written) + kept.duration;
        }
      }
      // Sound that ends before the picture is padded too, so both tracks end together.
      if (end - written > 0.01) await audioSource.add(silence(end - written, audioTrack.sampleRate, audioTrack.numberOfChannels));
      audioSource.close();
    }
    checkpoint();
    await output.finalize();
    checkpoint();
    onProgress(100);
    return target instanceof BufferTarget ? new Blob([target.buffer!], { type: "video/mp4" }) : null;
  } catch (error) {
    // Also waits for a cancel already started by the abort handler to finish closing the file.
    if (output && output.state !== "finalized") await output.cancel().catch(() => {});
    throw signal.aborted ? new ExportCancelled() : error;
  } finally {
    signal.removeEventListener("abort", cancel);
    base?.close();
    input.dispose();
  }
}

/** The part of an audio buffer that starts at `from` (seconds) and ends before `end`. */
function keep(buffer: AudioBuffer, from: number, timestamp: number, end: number): AudioBuffer | null {
  const first = Math.max(0, Math.round((from - timestamp) * buffer.sampleRate));
  const last = Math.min(buffer.length, Math.round((end - timestamp) * buffer.sampleRate));
  if (last <= first) return null;
  if (first === 0 && last === buffer.length) return buffer;
  const part = new AudioBuffer({ length: last - first, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    part.copyToChannel(buffer.getChannelData(channel).subarray(first, last), channel);
  }
  return part;
}

function silence(seconds: number, sampleRate: number, numberOfChannels: number): AudioBuffer {
  return new AudioBuffer({ length: Math.max(1, Math.round(seconds * sampleRate)), numberOfChannels, sampleRate });
}
