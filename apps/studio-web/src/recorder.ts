import type { MotionSample } from "./pointer/align";
import type { PointerSample } from "./pointer/focus";
import type { WorkerRequest, WorkerResponse } from "./pointer/worker";

export interface RecordingOptions {
  systemAudio: boolean;
  microphone: boolean;
}

export interface CapturedRecording {
  blob: Blob;
  samples: PointerSample[];
  /** Screen motion on the samples' clock, to line them up with the recording. */
  motion: MotionSample[];
}

/** Containers in order of preference: MP4 is seekable and plays everywhere once exported. */
const MIME_TYPES = [
  ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1.640028"],
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

/** One recording of a shared screen, window or tab, with the pointer followed alongside. */
export class ScreenRecording {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private streams: MediaStream[] = [];
  private audioContext: AudioContext | null = null;
  private worker: Worker | null = null;
  private followed: MediaStreamTrack | null = null;
  private stopped: Promise<void> | null = null;

  /** Resolves once recording; `onEnded` fires when sharing stops from the browser's own controls. */
  async start(options: RecordingOptions, onEnded: () => void): Promise<void> {
    // Ask for the microphone first: its prompt would otherwise appear over the shared screen.
    let microphone: MediaStream | null = null;
    if (options.microphone) {
      try {
        microphone = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        this.streams.push(microphone);
      } catch {
        throw new MicrophoneBlockedError();
      }
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
      this.release();
      throw error instanceof DOMException && error.name === "NotAllowedError" ? new ShareCancelledError() : error;
    }
    this.streams.push(display);
    const [video] = display.getVideoTracks();
    video.contentHint = "detail";
    video.addEventListener("ended", onEnded, { once: true });

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

    // Screen text needs far more than a camera's bitrate, as in the desktop helper.
    const { width = 1920, height = 1080 } = video.getSettings();
    const videoBitsPerSecond = Math.round(Math.min(60_000_000, Math.max(10_000_000, width * height * 30 * 0.2)));
    this.recorder = new MediaRecorder(new MediaStream(tracks), { mimeType, videoBitsPerSecond, audioBitsPerSecond: 160_000 });
    this.chunks = [];
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.stopped = new Promise((resolve) => {
      this.recorder!.onstop = () => resolve();
    });

    this.worker = new Worker(new URL("./pointer/worker.ts", import.meta.url), { type: "module" });
    this.followed = video.clone();
    const frames = new MediaStreamTrackProcessor({ track: this.followed as MediaStreamVideoTrack }).readable;
    this.recorder.start(1_000);
    this.worker.postMessage({ type: "start", frames } satisfies WorkerRequest, [frames]);
  }

  async stop(): Promise<CapturedRecording> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("Not recording.");
    const samples = this.collectSamples();
    if (recorder.state !== "inactive") recorder.stop();
    await this.stopped;
    const result = { blob: new Blob(this.chunks, { type: recorder.mimeType.split(";")[0] }), ...(await samples) };
    this.release();
    return result;
  }

  /** Stops everything without keeping the recording. */
  cancel() {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
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
