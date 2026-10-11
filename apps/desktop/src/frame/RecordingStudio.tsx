import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  buildRenderFrames,
  computeLayout,
  DEFAULT_FRAME_SETTINGS,
  NO_EDITS,
  resolveZooms,
  trimRange,
  type BackgroundSpec,
  type FrameSettings,
  type RecordingEdits,
} from "@screensway/core";
import { AlertCircle, CheckCircle2, Download, FolderOpen, Loader2, Play, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { ZoomPreview, type RecordingResult } from "../ZoomPreview";
import { FrameEditor, type RecentImage } from "./FrameEditor";
import { CURSOR_HOTSPOT, magicBackground, paintFrameBase, renderCursorPng } from "./paint";

const SETTINGS_KEY = "screensway.frame";
const EXPORT_FPS = 60;

interface ExportResult {
  outputPath: string;
  durationMs: number;
  width: number;
  height: number;
}

type ExportState =
  | { status: "idle" }
  | { status: "running"; progress: number }
  | { status: "done"; result: ExportResult }
  | { status: "failed"; message: string };

function loadSettings(): FrameSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<FrameSettings> | null;
    // Images chosen before they were saved to disk cannot be restored.
    if (stored?.background?.kind === "image" && !stored.background.path) delete stored.background;
    return { ...DEFAULT_FRAME_SETTINGS, ...stored };
  } catch {
    return DEFAULT_FRAME_SETTINGS;
  }
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image"));
    image.src = source;
  });
}

/** Accepts edits saved by this or an older version; anything unexpected means no edits. */
function parseEdits(value: unknown): RecordingEdits {
  if (!value || typeof value !== "object") return NO_EDITS;
  const edits = value as Partial<RecordingEdits>;
  const number = (candidate: unknown) => (typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null);
  const zooms = Array.isArray(edits.zooms)
    ? edits.zooms.filter((zoom) => zoom && [zoom.startMs, zoom.endMs, zoom.centerX, zoom.centerY, zoom.scale].every((field) => number(field) !== null))
    : null;
  return { trimStartMs: number(edits.trimStartMs) ?? 0, trimEndMs: number(edits.trimEndMs), zooms };
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("file"));
    reader.readAsDataURL(file);
  });
}

/** A small JPEG of the image, cropped like a swatch, for the recent images grid. */
function thumbnailOf(image: HTMLImageElement): string {
  const canvas = document.createElement("canvas");
  canvas.width = 192;
  canvas.height = 128;
  const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  canvas.getContext("2d")!.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  return canvas.toDataURL("image/jpeg", 0.8);
}

function exportFileName(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `ScreenSway ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
}

/** Preview, frame customization and export for one recording. */
export function RecordingStudio({ recording }: { recording: RecordingResult }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<FrameSettings>(loadSettings);
  const [autoZoom, setAutoZoom] = useState(true);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [recentImages, setRecentImages] = useState<RecentImage[]>([]);
  const [magic, setMagic] = useState<BackgroundSpec | null>(null);
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });
  const [edits, setEdits] = useState<RecordingEdits>(NO_EDITS);
  const saveTimer = useRef<number | undefined>(undefined);
  const range = useMemo(() => trimRange(edits, recording.durationMs), [edits, recording.durationMs]);
  const zooms = useMemo(
    () => resolveZooms(edits, recording.pointerEvents, recording.durationMs),
    [edits, recording.durationMs, recording.pointerEvents],
  );

  // Each recording keeps its own trim and zooms in edits.json.
  useEffect(() => {
    let cancelled = false;
    setEdits(NO_EDITS);
    invoke<unknown>("load_edits", { projectPath: recording.projectPath })
      .then((stored) => {
        if (!cancelled) setEdits(parseEdits(stored));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [recording.projectPath]);

  const editsRef = useRef(edits);
  editsRef.current = edits;
  const updateEdits = useCallback((update: (current: RecordingEdits) => RecordingEdits) => {
    const next = update(editsRef.current);
    editsRef.current = next;
    setEdits(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void invoke("save_edits", { projectPath: recording.projectPath, edits: next }).catch(() => {});
    }, 300);
  }, [recording.projectPath]);
  // An image background without a loaded image (e.g. after a restart) falls back to the default.
  const effectiveSettings = useMemo(
    () => (settings.background.kind === "image" && (!image || imagePath !== (settings.background.path ?? null))
      ? { ...settings, background: DEFAULT_FRAME_SETTINGS.background }
      : settings),
    [image, imagePath, settings],
  );

  const updateSettings = useCallback((patch: Partial<FrameSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // Settings still apply for this session.
      }
      return next;
    });
  }, []);

  const refreshRecentImages = useCallback(async () => {
    try {
      setRecentImages(await invoke<RecentImage[]>("list_background_images"));
    } catch {
      // Recent images are a convenience.
    }
  }, []);
  useEffect(() => void refreshRecentImages(), [refreshRecentImages]);

  // Loads the saved image a style or the last session refers to.
  const wantedImage = settings.background.kind === "image" ? settings.background.path ?? null : null;
  useEffect(() => {
    if (!wantedImage || wantedImage === imagePath) return;
    let cancelled = false;
    invoke<string>("read_background_image", { path: wantedImage })
      .then(loadImage)
      .then((loaded) => {
        if (cancelled) return;
        setImage(loaded);
        setImagePath(wantedImage);
      })
      .catch(() => {
        if (!cancelled) updateSettings({ background: DEFAULT_FRAME_SETTINGS.background });
      });
    return () => {
      cancelled = true;
    };
  }, [imagePath, updateSettings, wantedImage]);

  useEffect(() => {
    const unlisten = listen<number>("export-progress", (event) => {
      setExportState((current) => (current.status === "running" ? { status: "running", progress: event.payload } : current));
    });
    return () => void unlisten.then((dispose) => dispose());
  }, []);

  async function chooseImage(file: File) {
    try {
      const data = await readFile(file);
      const loaded = await loadImage(data);
      const path = await invoke<string>("save_background_image", { image: data, thumbnail: thumbnailOf(loaded) });
      setImage(loaded);
      setImagePath(path);
      updateSettings({ background: { kind: "image", blur: 0, path } });
      void refreshRecentImages();
    } catch {
      setExportState({ status: "failed", message: t("frame.imageFailed") });
    }
  }

  function chooseRecentImage(path: string) {
    const blur = settings.background.kind === "image" ? settings.background.blur : 0;
    updateSettings({ background: { kind: "image", blur, path } });
  }

  async function deleteRecentImage(path: string) {
    try {
      await invoke("delete_background_image", { path });
    } catch {
      // Already gone.
    }
    if (wantedImage === path) {
      setImage(null);
      setImagePath(null);
      updateSettings({ background: DEFAULT_FRAME_SETTINGS.background });
    }
    void refreshRecentImages();
  }

  async function createMagic() {
    try {
      const thumbnail = await invoke<string | null>("read_thumbnail", { projectPath: recording.projectPath });
      const background = thumbnail ? magicBackground(await loadImage(thumbnail)) : MAGIC_FALLBACK;
      setMagic(background);
      updateSettings({ background });
    } catch {
      setMagic(MAGIC_FALLBACK);
      updateSettings({ background: MAGIC_FALLBACK });
    }
  }

  async function exportVideo() {
    setExportState({ status: "running", progress: 0 });
    try {
      const source = { width: recording.width, height: recording.height };
      const effective = effectiveSettings;
      const layout = computeLayout(effective, source);
      const canvas = document.createElement("canvas");
      canvas.width = layout.width;
      canvas.height = layout.height;
      paintFrameBase(canvas.getContext("2d")!, layout, effective, image);

      const result = await invoke<ExportResult>("export_recording", {
        projectPath: recording.projectPath,
        fileName: exportFileName(),
        baseLayer: canvas.toDataURL("image/png"),
        cursor: renderCursorPng(),
        job: {
          width: layout.width,
          height: layout.height,
          fps: EXPORT_FPS,
          cursorHotspotX: CURSOR_HOTSPOT.x,
          cursorHotspotY: CURSOR_HOTSPOT.y,
          video: layout.video,
          radius: layout.videoRadius,
          roundTopCorners: layout.roundVideoTop,
          startMs: range.startMs,
          frames: buildRenderFrames(recording.pointerEvents, source, layout, recording.durationMs, EXPORT_FPS, autoZoom, {
            zooms,
            startMs: range.startMs,
            endMs: range.endMs,
          }),
        },
      });
      setExportState({ status: "done", result });
    } catch (error) {
      const message = String(error);
      setExportState(message === "Export cancelled." ? { status: "idle" } : { status: "failed", message });
    }
  }

  const running = exportState.status === "running";

  return (
    <div className="studio-editor">
      <ZoomPreview
        recording={recording}
        settings={effectiveSettings}
        backgroundImage={image}
        autoZoom={autoZoom}
        onAutoZoomChange={setAutoZoom}
        edits={edits}
        onEditsChange={updateEdits}
        zooms={zooms}
        range={range}
      />

      <aside className="editor-panel glass">
        <FrameEditor
          settings={settings}
          onChange={updateSettings}
          onImage={(file) => void chooseImage(file)}
          hasImage={Boolean(image)}
          onMagic={() => void createMagic()}
          magicBackground={magic}
          recentImages={recentImages}
          onRecentImage={chooseRecentImage}
          onDeleteRecentImage={(path) => void deleteRecentImage(path)}
        />

        <div className="export-box">
          {running ? (
            <>
              <div className="export-progress" role="progressbar" aria-valuenow={exportState.progress} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ transform: `scaleX(${exportState.progress / 100})` }} />
              </div>
              <div className="export-row">
                <span className="export-status"><Loader2 size={15} className="spin" aria-hidden="true" /> {t("export.running", { percent: exportState.progress })}</span>
                <button className="editor-button" onClick={() => void invoke("cancel_export")}>
                  <X size={15} aria-hidden="true" /> {t("export.cancel")}
                </button>
              </div>
            </>
          ) : (
            <button className="record-button export-button" onClick={() => void exportVideo()}>
              <Download size={17} aria-hidden="true" /> {t("export.start")}
            </button>
          )}

          {exportState.status === "done" && (
            <div className="capture-message success" role="status">
              <CheckCircle2 size={18} aria-hidden="true" />
              <span>
                <strong>{t("export.done")}</strong>
                <small>{exportState.result.width} × {exportState.result.height} · 60 fps</small>
                <span className="export-actions">
                  <button className="editor-button" onClick={() => void invoke("open_export", { path: exportState.result.outputPath, reveal: false })}>
                    <Play size={14} aria-hidden="true" /> {t("export.open")}
                  </button>
                  <button className="editor-button" onClick={() => void invoke("open_export", { path: exportState.result.outputPath, reveal: true })}>
                    <FolderOpen size={14} aria-hidden="true" /> {t("export.reveal")}
                  </button>
                </span>
              </span>
            </div>
          )}
          {exportState.status === "failed" && (
            <div className="capture-message error" role="alert">
              <AlertCircle size={18} aria-hidden="true" />
              <span><strong>{t("export.failed")}</strong><small>{exportState.message}</small></span>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

const MAGIC_FALLBACK: BackgroundSpec = DEFAULT_FRAME_SETTINGS.background;
