// The desktop studio talks to the Rust shell through commands; in the browser they are
// answered here. Nothing leaves the tab: recordings, edits and images live in memory.
import { emit } from "./tauri/event";
import type { ExportJob } from "./exporter";

export interface WebRecording {
  /** Also the projectPath the studio passes back. */
  id: string;
  blob: Blob;
  url: string;
  thumbnail: string | null;
  /** Frees the recording's stored file. */
  discard: () => void;
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
/**
 * The last export when the browser had no save dialog: written to its private storage and
 * downloaded from there, so it never sits in memory. Kept for "Download again".
 */
let lastExport: { url: string; fileName: string; file: FileSystemFileHandle | null } | null = null;
let exporting: AbortController | null = null;
/** What the studio shows as a cancelled export (RecordingStudio compares the message). */
const CANCELLED_MESSAGE = "Export cancelled.";
let nextImage = 0;

export function addRecording(recording: WebRecording) {
  recordings.set(recording.id, recording);
}

export function removeRecording(id: string) {
  const recording = recordings.get(id);
  if (recording) {
    URL.revokeObjectURL(recording.url);
    recording.discard();
  }
  recordings.delete(id);
  edits.delete(id);
  forgetLastExport();
}

function forgetLastExport() {
  if (lastExport) {
    URL.revokeObjectURL(lastExport.url);
    if (lastExport.file) void removeFile(lastExport.file);
  }
  lastExport = null;
}

/** Deletes one of our own temporary files (never one the user chose), or empties it. */
async function removeFile(handle: FileSystemFileHandle) {
  const removable = handle as FileSystemFileHandle & { remove?: () => Promise<void> };
  try {
    if (removable.remove) {
      await removable.remove();
      return;
    }
  } catch {
    // Not allowed here; empty it instead.
  }
  try {
    const writable = await handle.createWritable();
    await writable.truncate(0);
    await writable.close();
  } catch {
    // Already gone.
  }
}

/** A file in the browser's private storage for an export that will be downloaded. */
async function temporaryFile(): Promise<FileSystemFileHandle | null> {
  try {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports", { create: true });
    for await (const [name] of (folder as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      await folder.removeEntry(name).catch(() => {});
    }
    return await folder.getFileHandle(`export-${Date.now()}.mp4`, { create: true });
  } catch {
    return null;
  }
}

/** Fired when an export is saved, so the page knows the work is safe. */
export const EXPORT_SAVED = "web-export-saved";

interface SavePicker {
  showSaveFilePicker(options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }): Promise<FileSystemFileHandle>;
}

/** Asks where to save, so a long export goes to disk instead of memory. Null: download instead. */
async function chooseFile(name: string): Promise<FileSystemFileHandle | null> {
  const picker = window as unknown as Partial<SavePicker>;
  if (!picker.showSaveFilePicker) return null;
  try {
    return await picker.showSaveFilePicker({ suggestedName: name, types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }] });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return null;
  }
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
    const name = `${fileName}.mp4`;
    let target: FileSystemFileHandle | null = null;
    let chosen: FileSystemFileHandle | null = null;
    let writable: FileSystemWritableFileStream | null = null;
    try {
      // First, while the click still counts as the user's: the save dialog needs it.
      chosen = await chooseFile(name).catch(() => {
        throw CANCELLED_MESSAGE;
      });
      target = chosen ?? (await temporaryFile());
      writable = target ? await target.createWritable() : null;
      const { renderExport } = await import("./exporter");
      const blob = await renderExport(recording.blob, job, baseLayer, (percent) => emit("export-progress", percent), controller.signal, writable);
      forgetLastExport();
      if (!chosen) {
        const file = target ? await target.getFile() : blob;
        if (!file) throw new Error("The export is empty.");
        lastExport = { url: URL.createObjectURL(file), fileName: name, file: target };
        download(lastExport.url, name);
      }
      emit(EXPORT_SAVED, projectPath);
      return { outputPath: lastExport && !chosen ? lastExport.url : "", durationMs: (job.frames.length / job.fps) * 1_000, width: job.width, height: job.height, fps: job.fps };
    } catch (error) {
      // A file the user chose keeps its old content (the exporter discards unfinished
      // writes); only our own temporary file is deleted.
      await writable?.abort().catch(() => {});
      if (target && !chosen) await removeFile(target);
      if (error === CANCELLED_MESSAGE || controller.signal.aborted) throw CANCELLED_MESSAGE;
      throw error instanceof Error ? error.message : String(error);
    } finally {
      if (exporting === controller) exporting = null;
    }
  },
  cancel_export: () => exporting?.abort(),
  open_export: ({ path }) => {
    if (lastExport && lastExport.url === path) download(lastExport.url, lastExport.fileName);
  },
};
