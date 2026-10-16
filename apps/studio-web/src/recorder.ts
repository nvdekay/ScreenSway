import type { MotionSample } from "./pointer/align";
import type { PointerSample } from "./pointer/focus";
import type { WorkerRequest, WorkerResponse } from "./pointer/worker";

export interface RecordingOptions {
  systemAudio: boolean;
  microphone: boolean;
}

export interface CapturedRecording {
  /** Backed by a file in the browser's private storage when available, so it does not fill memory. */
  blob: Blob;
  /** Removes that file; call once the recording is closed. */
  discard: () => void;
  samples: PointerSample[];
  /** Screen motion on the samples' clock, to line them up with the recording. */
  motion: MotionSample[];
}

/**
 * Containers in order of preference: MP4 is seekable and plays everywhere once exported.
 * High profile level 5.1 covers screens up to 4K; the plain "avc1" lets the browser pick.
 */
const MIME_TYPES = [
  ["video/mp4;codecs=avc1.640033,mp4a.40.2", "video/mp4;codecs=avc1.640033"],
  ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4;codecs=avc1"],
  ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp9"],
  ["video/webm", "video/webm"],
] as const;

/** Why this browser cannot record, or null when it can. */
export function unsupportedReason(): string | null {
  if (typeof window === "undefined" || !window.isSecureContext) return "insecure";
  if (!navigator.mediaDevices?.getDisplayMedia) return "display";
  if (typeof MediaRecorder === "undefined") return "recorder";
  // Pointer following and export need these Chromium APIs.
  if (!("MediaStreamTrackProcessor" in window) || typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") return "codecs";
  if (/Android|iPhone|iPad/i.test(navigator.userAgent)) return "mobile";
  return null;
}

export class MicrophoneBlockedError extends Error {}
export class ShareCancelledError extends Error {}

const STORAGE_FOLDER = "recordings";
/** Files left behind by closed tabs or crashes are removed after this long. */
const STALE_MS = 12 * 60 * 60 * 1_000;

/**
 * Where MediaRecorder's chunks go while recording. The browser's private file storage keeps
 * a long Retina recording (several GB) on disk instead of in memory; without it, memory.
 */
class ChunkStore {
  private writable: FileSystemWritableFileStream | null = null;
  private handle: FileSystemFileHandle | null = null;
  private folder: FileSystemDirectoryHandle | null = null;
  private memory: Blob[] = [];
  private writing: Promise<void> = Promise.resolve();
  failed = false;

  constructor(private readonly name: string) {}

  async open() {
    try {
      this.folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(STORAGE_FOLDER, { create: true });
      await removeStaleFiles(this.folder);
      this.handle = await this.folder.getFileHandle(this.name, { create: true });
      this.writable = await this.handle.createWritable();
    } catch {
      this.writable = null;
    }
  }

  add(chunk: Blob, onFailure: () => void) {
    const writable = this.writable;
    if (!writable) {
      this.memory.push(chunk);
      return;
    }
    this.writing = this.writing.then(() => writable.write(chunk)).catch(() => {
      // Out of space: stop instead of losing what was recorded.
      if (!this.failed) onFailure();
      this.failed = true;
    });
  }

  async finish(type: string): Promise<Blob> {
    await this.writing;
    if (this.writable && this.handle) {
      try {
        await this.writable.close();
        const file = await this.handle.getFile();
        return this.memory.length ? new Blob([file, ...this.memory], { type }) : file.slice(0, file.size, type);
      } catch {
        // Fall through to what is still in memory.
      }
    }
    return new Blob(this.memory, { type });
  }

  discard() {
    void this.writable?.abort().catch(() => {});
    if (this.folder) void this.folder.removeEntry(this.name).catch(() => {});
    this.memory = [];
  }
}

async function removeStaleFiles(folder: FileSystemDirectoryHandle) {
  const now = Date.now();
  for await (const [name, entry] of (folder as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    const created = Number(name.match(/^recording-(\d+)/)?.[1]);
    if (entry.kind === "file" && Number.isFinite(created) && now - created > STALE_MS) await folder.removeEntry(name).catch(() => {});
  }
}

/**
 * The shared video at the size it started with. MediaRecorder keeps writing frames of a
 * resized window into an MP4 that declares the first size, which no decoder can read, so
 * frames of another size are fitted in with black bars. Same-size frames pass untouched.
 */
function fixedSize(track: MediaStreamTrack): MediaStreamTrack {
  const { width = 1920, height = 1080 } = track.getSettings();
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false })!;
  const generator = new MediaStreamTrackGenerator({ kind: "video" });
  const frames = new MediaStreamTrackProcessor({ track: track as MediaStreamVideoTrack }).readable;
  void frames
    .pipeThrough(
      new TransformStream<VideoFrame, VideoFrame>({
        transform(frame, controller) {
          if (frame.displayWidth === width && frame.displayHeight === height) {
            controller.enqueue(frame);
            return;
          }
          const scale = Math.min(width / frame.displayWidth, height / frame.displayHeight);
          const w = frame.displayWidth * scale;
          const h = frame.displayHeight * scale;
          context.fillStyle = "#000";
          context.fillRect(0, 0, width, height);
          context.drawImage(frame, (width - w) / 2, (height - h) / 2, w, h);
          const fitted = new VideoFrame(canvas, { timestamp: frame.timestamp });
          frame.close();
          controller.enqueue(fitted);
        },
      }),
    )
    .pipeTo(generator.writable)
    .catch(() => {});
  return generator;
}

/** One recording of a shared screen, window or tab, with the pointer followed alongside. */
export class ScreenRecording {
  readonly id = `recording-${Date.now()}`;
  private recorder: MediaRecorder | null = null;
  private store: ChunkStore | null = null;
  private streams: MediaStream[] = [];
  private audioContext: AudioContext | null = null;
  private worker: Worker | null = null;
  private followed: MediaStreamTrack | null = null;
  private stopped: Promise<void> | null = null;

  /**
   * Resolves once recording. `onEnded` fires when recording stops on its own: from the
   * browser's Stop sharing button, an encoder error or a full disk.
   */
  async start(options: RecordingOptions, onEnded: () => void): Promise<void> {
    try {
      await this.begin(options, onEnded);
    } catch (error) {
      // Nothing may keep capturing the screen or microphone after a failed start.
      this.cancel();
      throw error;
    }
  }

  private async begin(options: RecordingOptions, onEnded: () => void) {
    // Ask for the microphone first: its prompt would otherwise appear over the shared screen.
    let microphone: MediaStream | null = null;
    if (options.microphone) {
      try {
        microphone = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch {
        throw new MicrophoneBlockedError();
      }
      this.streams.push(microphone);
    }

    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        // Full resolution up to 4K-class screens: zooms magnify the recording, so every pixel counts.
        video: { frameRate: { ideal: 30, max: 30 }, width: { max: 3840 }, height: { max: 2400 }, cursor: "always" },
        audio: options.systemAudio,
        // Chromium hints: offer the whole screen, never this tab, and no surface switching.
        selfBrowserSurface: "exclude",
        surfaceSwitching: "exclude",
        systemAudio: options.systemAudio ? "include" : "exclude",
        monitorTypeSurfaces: "include",
      } as DisplayMediaStreamOptions);
    } catch (error) {
      throw error instanceof DOMException && error.name === "NotAllowedError" ? new ShareCancelledError() : error;
    }
    this.streams.push(display);
    const [shared] = display.getVideoTracks();
    shared.contentHint = "detail";
    shared.addEventListener("ended", onEnded, { once: true });
    const video = fixedSize(shared);
    video.contentHint = "detail";
    this.streams.push(new MediaStream([video]));

    // One audio track: what the shared surface plays plus the microphone.
    const audioInputs = [...display.getAudioTracks(), ...(microphone?.getAudioTracks() ?? [])];
    const tracks: MediaStreamTrack[] = [video];
    if (audioInputs.length > 0) {
      this.audioContext = new AudioContext({ sampleRate: 48_000 });
      const destination = this.audioContext.createMediaStreamDestination();
      for (const track of audioInputs) this.audioContext.createMediaStreamSource(new MediaStream([track])).connect(destination);
      tracks.push(...destination.stream.getAudioTracks());
    }
    const hasAudio = tracks.length > 1;
    const mimeType = MIME_TYPES.map(([withAudio, withoutAudio]) => (hasAudio ? withAudio : withoutAudio)).find((type) => MediaRecorder.isTypeSupported(type));

    this.store = new ChunkStore(`${this.id}.${mimeType?.includes("mp4") ? "mp4" : "webm"}`);
    await this.store.open();

    // Screen text needs far more than a camera's bitrate, as in the desktop helper.
    const { width = 1920, height = 1080 } = video.getSettings();
    const videoBitsPerSecond = Math.round(Math.min(40_000_000, Math.max(8_000_000, width * height * 30 * 0.15)));
    const recorder = new MediaRecorder(new MediaStream(tracks), { mimeType, videoBitsPerSecond, audioBitsPerSecond: 160_000 });
    this.recorder = recorder;
    const store = this.store;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) store.add(event.data, onEnded);
    };
    recorder.onerror = () => onEnded();
    this.stopped = new Promise((resolve) => {
      recorder.onstop = () => resolve();
    });

    this.worker = new Worker(new URL("./pointer/worker.ts", import.meta.url), { type: "module" });
    this.followed = video.clone();
    const frames = new MediaStreamTrackProcessor({ track: this.followed as MediaStreamVideoTrack }).readable;
    recorder.start(1_000);
    this.worker.postMessage({ type: "start", frames } satisfies WorkerRequest, [frames]);
  }

  async stop(): Promise<CapturedRecording> {
    const recorder = this.recorder;
    const store = this.store;
    if (!recorder || !store) throw new Error("Not recording.");
    try {
      const samples = this.collectSamples();
      if (recorder.state !== "inactive") recorder.stop();
      await this.stopped;
      const blob = await store.finish(recorder.mimeType.split(";")[0]);
      if (blob.size === 0) throw new Error("Nothing was recorded.");
      return { blob, discard: () => store.discard(), ...(await samples) };
    } catch (error) {
      store.discard();
      throw error;
    } finally {
      this.release();
    }
  }

  /** Stops everything without keeping the recording. */
  cancel() {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.store?.discard();
    this.release();
  }

  private collectSamples(): Promise<{ samples: PointerSample[]; motion: MotionSample[] }> {
    const worker = this.worker;
    const none = { samples: [], motion: [] };
    if (!worker) return Promise.resolve(none);
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => resolve(none), 5_000);
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        window.clearTimeout(timeout);
        resolve({ samples: event.data.samples, motion: event.data.motion });
      };
      worker.postMessage({ type: "finish" } satisfies WorkerRequest);
    });
  }

  private release() {
    for (const stream of this.streams) for (const track of stream.getTracks()) track.stop();
    this.streams = [];
    this.followed?.stop();
    this.followed = null;
    void this.audioContext?.close().catch(() => {});
    this.audioContext = null;
    this.worker?.terminate();
    this.worker = null;
  }
}
