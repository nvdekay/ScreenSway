// The desktop studio talks to the Rust shell through commands; in the browser they are
// answered here. No recording content leaves this browser: edits and images stay in the tab's memory,
// recordings and downloaded exports in its private file storage (OPFS). Only anonymous
// usage counts (analytics.ts) and feedback the user writes and sends are sent.
import { feedbackProblem, type FeedbackRequest } from "../../desktop/src/feedback";
import { ANALYTICS_ENDPOINT, analyticsOn, browserName, STUDIO_EVENTS, track, version, visitorOs, type StudioEvent } from "./analytics";
import { journeyId } from "./identity";
import { emit } from "./tauri/event";
import type { ExportJob } from "./exporter";

interface WebRecording {
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
let exportCancel = () => exporting?.abort();
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

/**
 * Sends the feedback form (see the desktop shell's feedback.rs for the same contract). Rejects
 * with a message key the form translates. A 409 means the same text already arrived (a retry
 * after a lost answer), so it counts as sent.
 */
export async function sendFeedback(request: FeedbackRequest, endpoint = ANALYTICS_ENDPOINT): Promise<void> {
  if (!endpoint) throw "feedback.errorUnavailable";
  if (feedbackProblem(request)) throw "feedback.errorInvalid";
  const sessionId = request.includeMetadata ? journeyId() : null;
  const body = {
    source: "studio",
    category: request.category,
    rating: request.rating,
    message: request.message.trim(),
    email: request.email?.trim() || null,
    includeMetadata: request.includeMetadata,
    ...(request.includeMetadata
      ? { metadata: { version, os: visitorOs(), browser: browserName(), ...(request.locale ? { locale: request.locale } : {}), ...(sessionId ? { sessionId } : {}) } }
      : {}),
    website: request.website,
  };
  let response: Response;
  try {
    // A plain-text body keeps this a simple cross-origin request (no preflight); the API reads JSON.
    response = await fetch(`${endpoint}/v1/feedback`, { method: "POST", body: JSON.stringify(body) });
  } catch {
    throw "feedback.errorNetwork";
  }
  if (response.ok || response.status === 409) return;
  if (response.status === 429) throw "feedback.errorRateLimited";
  if (response.status === 400 || response.status === 413) throw "feedback.errorInvalid";
  throw "feedback.errorUnavailable";
}

type Command = (args: Record<string, unknown>) => unknown;

export const commands: Record<string, Command> = {
  load_edits: ({ projectPath }) => edits.get(String(projectPath)) ?? null,
  save_edits: ({ projectPath, edits: value }) => void edits.set(String(projectPath), value),
  load_captions: () => null,
  save_captions: () => undefined,
  // The studio's own events (exports, styles) join the page's anonymous statistics.
  track_event: ({ name, props }) => {
    if ((STUDIO_EVENTS as readonly string[]).includes(String(name))) track(name as StudioEvent, (props ?? {}) as Record<string, string | number | boolean>);
  },
  // Lets the studio ask questions whose answers are statistics only when they are sent.
  telemetry_status: () => ({ available: analyticsOn(), enabled: analyticsOn() }),
  send_feedback: ({ feedback }) => sendFeedback(feedback as FeedbackRequest),
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
      // Exports are only ever streamed to a file, never built in memory.
      // Errors are message keys the studio translates (see isMessageKey).
      if (!target) throw new Error("web.exportNoStorage");
      // The file may refuse to open (permission withdrawn, storage full).
      writable = await target.createWritable().catch(() => {
        throw new Error("web.exportWriteFailed");
      });
      const { renderExport } = await import("./exporter");
      let committing = false;
      // From the commit on, Cancel is no longer offered (progress 100 hides it) and is ignored.
      const commit = () => {
        committing = true;
        emit("export-progress", 100);
      };
      exportCancel = () => {
        if (!committing) controller.abort();
      };
      await renderExport(recording.blob, job, baseLayer, (percent) => emit("export-progress", percent), controller.signal, writable, commit);
      forgetLastExport();
      if (!chosen) {
        lastExport = { url: URL.createObjectURL(await target.getFile()), fileName: name, file: target };
        download(lastExport.url, name);
      }
      emit(EXPORT_SAVED, projectPath);
      return { outputPath: !chosen && lastExport ? lastExport.url : "", durationMs: (job.frames.length / job.fps) * 1_000, width: job.width, height: job.height, fps: job.fps };
    } catch (error) {
      // A file the user chose keeps its old content (the exporter discards unfinished
      // writes); only our own temporary file is deleted.
      await writable?.abort().catch(() => {});
      if (target && !chosen) await removeFile(target);
      if (error === CANCELLED_MESSAGE || controller.signal.aborted) throw CANCELLED_MESSAGE;
      throw error instanceof Error ? error.message : String(error);
    } finally {
      if (exporting === controller) {
        exporting = null;
        exportCancel = () => exporting?.abort();
      }
    }
  },
  cancel_export: () => exportCancel(),
  open_export: ({ path }) => {
    if (lastExport && lastExport.url === path) download(lastExport.url, lastExport.fileName);
  },
};
