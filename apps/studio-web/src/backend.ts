// The desktop studio talks to the Rust shell through commands; in the browser they are
// answered here. Nothing leaves the tab: recordings, edits and images live in memory.
import { emit } from "./tauri/event";
import { ExportCancelled, renderExport, type ExportJob } from "./exporter";

export interface WebRecording {
  /** Also the projectPath the studio passes back. */
  id: string;
  blob: Blob;
  url: string;
  thumbnail: string | null;
}

interface ExportArgs {
  projectPath: string;
  fileName: string;
  baseLayer: string;
  job: ExportJob;
}

const recordings = new Map<string, WebRecording>();
const edits = new Map<string, unknown>();
const images = new Map<string, { image: string; thumbnail: string }>();
const exports = new Map<string, { url: string; fileName: string }>();
let exporting: AbortController | null = null;
let nextImage = 0;

export function addRecording(recording: WebRecording) {
  recordings.set(recording.id, recording);
}

export function removeRecording(id: string) {
  const recording = recordings.get(id);
  if (recording) URL.revokeObjectURL(recording.url);
  recordings.delete(id);
  edits.delete(id);
}

function download(url: string, fileName: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
}

function recordingOf(id: unknown): WebRecording {
  const recording = recordings.get(String(id));
  if (!recording) throw new Error("This recording is no longer open.");
  return recording;
}

type Command = (args: Record<string, unknown>) => unknown;

export const commands: Record<string, Command> = {
  load_edits: ({ projectPath }) => edits.get(String(projectPath)) ?? null,
  save_edits: ({ projectPath, edits: value }) => void edits.set(String(projectPath), value),
  load_captions: () => null,
  save_captions: () => undefined,
  // The browser version sends no usage statistics.
  track_event: () => undefined,
  telemetry_status: () => ({ available: false, enabled: false }),
  read_thumbnail: ({ projectPath }) => recordingOf(projectPath).thumbnail,

  list_background_images: () => [...images].reverse().map(([path, { thumbnail }]) => ({ path, thumbnail })),
  save_background_image: ({ image, thumbnail }) => {
    const path = `image-${++nextImage}`;
    images.set(path, { image: String(image), thumbnail: String(thumbnail) });
    return path;
  },
  read_background_image: ({ path }) => {
    const stored = images.get(String(path));
    if (!stored) throw new Error("Image not found.");
    return stored.image;
  },
  delete_background_image: ({ path }) => void images.delete(String(path)),

  export_recording: async (args) => {
    const { projectPath, fileName, baseLayer, job } = args as unknown as ExportArgs;
    const recording = recordingOf(projectPath);
    exporting?.abort();
    const controller = new AbortController();
    exporting = controller;
    try {
      const blob = await renderExport(recording.blob, job, baseLayer, (percent) => emit("export-progress", percent), controller.signal);
      const url = URL.createObjectURL(blob);
      const name = `${fileName}.mp4`;
      exports.set(url, { url, fileName: name });
      download(url, name);
      return { outputPath: url, durationMs: (job.frames.length / job.fps) * 1_000, width: job.width, height: job.height, fps: job.fps };
    } catch (error) {
      throw error instanceof ExportCancelled ? error.message : error instanceof Error ? error.message : String(error);
    } finally {
      if (exporting === controller) exporting = null;
    }
  },
  cancel_export: () => exporting?.abort(),
  open_export: ({ path }) => {
    const exported = exports.get(String(path));
    if (exported) download(exported.url, exported.fileName);
  },
};
