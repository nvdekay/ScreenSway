import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  buildRenderFrames,
  computeLayout,
  DEFAULT_FRAME_SETTINGS,
  type BackgroundSpec,
  type FrameSettings,
} from "@screensway/core";
import { AlertCircle, CheckCircle2, Download, FolderOpen, Loader2, Play, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { ZoomPreview, type RecordingResult } from "../ZoomPreview";
import { FrameEditor } from "./FrameEditor";
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
    // An uploaded image is not kept between sessions, so fall back to the default background.
    if (stored?.background?.kind === "image") delete stored.background;
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
  const [magic, setMagic] = useState<BackgroundSpec | null>(null);
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });
  // An image background without a loaded image (e.g. after a restart) falls back to the default.
  const effectiveSettings = useMemo(
    () => (settings.background.kind === "image" && !image ? { ...settings, background: DEFAULT_FRAME_SETTINGS.background } : settings),
    [image, settings],
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

  useEffect(() => {
    const unlisten = listen<number>("export-progress", (event) => {
      setExportState((current) => (current.status === "running" ? { status: "running", progress: event.payload } : current));
    });
    return () => void unlisten.then((dispose) => dispose());
  }, []);

  async function chooseImage(file: File) {
    try {
      const loaded = await loadImage(URL.createObjectURL(file));
      setImage(loaded);
      updateSettings({ background: { kind: "image", blur: 0 } });
    } catch {
      setExportState({ status: "failed", message: t("frame.imageFailed") });
    }
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
          radius: layout.radius,
          roundTopCorners: layout.titleBar === 0,
          frames: buildRenderFrames(recording.pointerEvents, source, layout, recording.durationMs, EXPORT_FPS, autoZoom),
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
      />

      <aside className="editor-panel glass">
        <FrameEditor
          settings={settings}
          onChange={updateSettings}
          onImage={(file) => void chooseImage(file)}
          hasImage={Boolean(image)}
          onMagic={() => void createMagic()}
          magicBackground={magic}
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
