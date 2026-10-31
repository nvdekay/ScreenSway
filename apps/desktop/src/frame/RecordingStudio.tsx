import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  applyZoomStrength,
  buildCaptionLines,
  buildRenderFrames,
  buildSourceTimes,
  cameraRect,
  computeLayout,
  DEFAULT_CAMERA_OVERLAY,
  DEFAULT_FRAME_SETTINGS,
  DEFAULT_KEYSTROKE_OVERLAY,
  DEFAULT_ZOOM_STRENGTH,
  MAX_ZOOM_STRENGTH,
  MIN_ZOOM_STRENGTH,
  NO_EDITS,
  keptRanges,
  retimeCaptions,
  resolveZooms,
  toSrt,
  trimRange,
  type CaptionWord,
  type CutSegment,
  type BackgroundSpec,
  type FrameSettings,
  type RecordingEdits,
  type Redaction,
  sourceToOutputTime,
} from "@screensway/core";
import { AlertCircle, Captions, Check, Copy, Download, Film, FolderOpen, Loader2, MessageSquare, Play, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isMessageKey, useI18n } from "../i18n";
import { ZoomPreview, type RecordingResult } from "../ZoomPreview";
import { FrameEditor, type RecentImage } from "./FrameEditor";
import { CaptionsPanel, type RecordingCaptions, type TranscriptionState } from "./CaptionsPanel";
import { DEFAULT_CAPTION_STYLE, keystrokeEnd, loadCaptionFont, paintCaption, paintKeystroke, type CaptionStyle } from "./captionPaint";
import { CURSOR_HOTSPOT, magicBackground, paintFrameBase, renderCursorPng } from "./paint";
import { durationBucket, statisticsOn, track, useTelemetry } from "../telemetry";
import { FeedbackDialog } from "../FeedbackDialog";
import { FeatureSurvey } from "../FeatureSurvey";
import { markSurveyShown, surveyDue, type FeedbackCategory } from "../feedback";
import { isWeb } from "../platform";
import { PrivacyPanel } from "./PrivacyPanel";
import { KeystrokePanel } from "./KeystrokePanel";
import { CameraPanel } from "./CameraPanel";
import { estimateGifBytes, GIF_PRESETS, makeGif, type GifOptions } from "./gif";
import { EXPORT_PRESETS, ExportPresets } from "./ExportPresets";
import { BrandPanel } from "./BrandPanel";
import { ChaptersPanel } from "./ChaptersPanel";
import { CARD_MS, loadBrand, logoRect, paintCard, paintLogo, saveBrand, type BrandKit } from "./brand";

const SETTINGS_KEY = "screensway.frame";
const CAPTION_STYLE_KEY = "screensway.captionStyle";
const EXPORT_FPS = 60;
/** Tells the library to reload, e.g. after the Studio renamed the recording. */
export const LIBRARY_CHANGED_EVENT = "screensway:library-changed";

interface ExportResult {
  outputPath: string;
  durationMs: number;
  width: number;
  height: number;
  subtitlesPath?: string | null;
  /** Frame rate of the file; the desktop helper always writes EXPORT_FPS. */
  fps?: number;
}

/** The last zoom strength chosen, used by recordings that have none of their own yet. */
const ZOOM_STRENGTH_KEY = "screensway.zoomStrength";

function loadZoomStrength(): number {
  try {
    const stored = Number(localStorage.getItem(ZOOM_STRENGTH_KEY));
    return stored >= MIN_ZOOM_STRENGTH && stored <= MAX_ZOOM_STRENGTH ? stored : DEFAULT_ZOOM_STRENGTH;
  } catch {
    return DEFAULT_ZOOM_STRENGTH;
  }
}

function loadCaptionStyle(): CaptionStyle {
  try {
    return { ...DEFAULT_CAPTION_STYLE, ...(JSON.parse(localStorage.getItem(CAPTION_STYLE_KEY) ?? "null") as Partial<CaptionStyle> | null) };
  } catch {
    return DEFAULT_CAPTION_STYLE;
  }
}

function parseCaptions(value: unknown): RecordingCaptions | null {
  if (!value || typeof value !== "object") return null;
  const captions = value as Partial<RecordingCaptions>;
  if (!Array.isArray(captions.lines)) return null;
  return {
    locale: typeof captions.locale === "string" ? captions.locale : "en-US",
    enabled: captions.enabled !== false,
    lines: captions.lines.filter((line) => line && typeof line.text === "string" && Number.isFinite(line.startMs) && Number.isFinite(line.endMs)),
  };
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
  const cuts = Array.isArray(edits.cuts)
    ? edits.cuts.filter((cut) => cut && typeof cut.id === "string" && number(cut.startMs) !== null && number(cut.endMs) !== null)
    : [];
  const redactions = Array.isArray(edits.redactions)
    ? edits.redactions.filter((item): item is Redaction => Boolean(item && typeof item.id === "string" && (item.mode === "blur" || item.mode === "solid") && [item.x, item.y, item.width, item.height].every((field) => number(field) !== null)))
    : [];
  const overlay = edits.keystrokeOverlay;
  const keystrokeOverlay = overlay && typeof overlay.enabled === "boolean" && ["top", "bottom"].includes(overlay.position) && ["small", "medium", "large"].includes(overlay.size) && ["dark", "light"].includes(overlay.theme)
    ? overlay : DEFAULT_KEYSTROKE_OVERLAY;
  const storedCamera = edits.camera;
  const camera = storedCamera && typeof storedCamera.visible === "boolean" && typeof storedCamera.mirror === "boolean"
    && ["circle", "rounded"].includes(storedCamera.shape) && [storedCamera.x, storedCamera.y, storedCamera.size].every((field) => number(field) !== null)
    ? storedCamera : undefined;
  const chapters = Array.isArray(edits.chapters)
    ? edits.chapters.filter((item) => item && typeof item.title === "string" && number(item.startMs) !== null)
    : undefined;
  const framing = Array.isArray(edits.framing)
    ? edits.framing.filter((item) => item && typeof item.id === "string" && [item.startMs, item.endMs, item.x].every((field) => number(field) !== null))
    : [];
  const zoomStrength = number(edits.zoomStrength) ?? undefined;
  return { trimStartMs: number(edits.trimStartMs) ?? 0, trimEndMs: number(edits.trimEndMs), zooms, cuts, redactions, keystrokeOverlay, camera, framing, chapters, zoomStrength };
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
export function RecordingStudio({ recording, startAtMs, autoExport, onAutoExportStarted }: {
  recording: RecordingResult;
  /** Where to start playing, e.g. a line found by searching speech. */
  startAtMs?: number | null;
  /** Export once the recording is ready, with an optional preset (from a screensway:// link). */
  autoExport?: { preset: string | null; id: number } | null;
  /** The link's export has started; later recordings are not exported by themselves. */
  onAutoExportStarted?: () => void;
}) {
  const { t, language } = useI18n();
  const [settings, setSettings] = useState<FrameSettings>(loadSettings);
  const [autoZoom, setAutoZoom] = useState(true);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [recentImages, setRecentImages] = useState<RecentImage[]>([]);
  const [magic, setMagic] = useState<BackgroundSpec | null>(null);
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });
  const [gif, setGif] = useState<{ status: "idle" } | { status: "running"; progress: number } | { status: "done"; path: string } | { status: "failed"; message: string }>({ status: "idle" });
  const [copied, setCopied] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ category: FeedbackCategory; message: string } | null>(null);
  // The feature question after an export, only when its answers can be counted.
  const [survey, setSurvey] = useState(false);
  const telemetry = useTelemetry();
  const canAsk = useRef(false);
  canAsk.current = statisticsOn(telemetry.status);
  const gifAbort = useRef<AbortController | null>(null);
  const [brand, setBrand] = useState<BrandKit>(loadBrand);
  const [logoData, setLogoData] = useState<string | null>(null);
  const [logoImage, setLogoImage] = useState<HTMLImageElement | null>(null);
  const updateBrand = useCallback((next: BrandKit) => {
    setBrand(next);
    saveBrand(next);
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (isWeb || !brand.logoPath) {
      setLogoData(null);
      setLogoImage(null);
      return;
    }
    invoke<string>("read_logo", { path: brand.logoPath })
      .then(async (data) => {
        const loaded = await loadImage(data);
        if (!cancelled) { setLogoData(data); setLogoImage(loaded); }
      })
      .catch(() => { if (!cancelled) { setLogoData(null); setLogoImage(null); } });
    return () => { cancelled = true; };
  }, [brand.logoPath]);
  async function chooseLogo(file: File) {
    try {
      const data = await readFile(file);
      const loaded = await loadImage(data);
      const path = await invoke<string>("save_logo", { image: data, thumbnail: thumbnailOf(loaded) });
      updateBrand({ ...brand, logoPath: path, showLogo: true });
    } catch {
      setExportState({ status: "failed", message: t("frame.imageFailed") });
    }
  }
  const [edits, setEdits] = useState<RecordingEdits>(NO_EDITS);
  const [editsLoaded, setEditsLoaded] = useState(false);
  const [captionsLoaded, setCaptionsLoaded] = useState(false);
  const [autoExportReady, setAutoExportReady] = useState<number | null>(null);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const history = useRef<{ past: RecordingEdits[]; future: RecordingEdits[]; lastChange: number }>({ past: [], future: [], lastChange: 0 });
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingEdits = useRef<RecordingEdits | null>(null);
  const mounted = useRef(true);
  const activeJobs = useRef({ export: false, transcription: false });
  const range = useMemo(() => trimRange(edits, recording.durationMs), [edits, recording.durationMs]);
  const zooms = useMemo(
    () => resolveZooms(edits, recording.pointerEvents, recording.durationMs),
    [edits, recording.durationMs, recording.pointerEvents],
  );
  const [preferredZoomStrength, setPreferredZoomStrength] = useState(loadZoomStrength);
  const zoomStrength = edits.zoomStrength ?? preferredZoomStrength;
  const sourceRanges = useMemo(() => keptRanges(edits, recording.durationMs), [edits, recording.durationMs]);
  const cameraOverlay = edits.camera ?? DEFAULT_CAMERA_OVERLAY;

  // Each recording keeps its own trim and zooms in edits.json.
  useEffect(() => {
    let cancelled = false;
    setEdits(NO_EDITS);
    history.current = { past: [], future: [], lastChange: 0 };
    setHistoryState({ canUndo: false, canRedo: false });
    invoke<unknown>("load_edits", { projectPath: recording.projectPath })
      .then((stored) => {
        if (!cancelled) setEdits(parseEdits(stored));
      })
      .finally(() => { if (!cancelled) setEditsLoaded(true); })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [recording.projectPath]);

  const [captions, setCaptions] = useState<RecordingCaptions | null>(null);
  const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(loadCaptionStyle);
  const [transcription, setTranscription] = useState<TranscriptionState>({ status: "idle" });
  const captionsTimer = useRef<number | undefined>(undefined);
  const pendingCaptions = useRef<RecordingCaptions | null>(null);
  const seekRef = useRef<((timeMs: number) => void) | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(saveTimer.current);
      window.clearTimeout(captionsTimer.current);
      if (pendingEdits.current) void invoke("save_edits", { projectPath: recording.projectPath, edits: pendingEdits.current }).catch(() => {});
      if (pendingCaptions.current) void invoke("save_captions", { projectPath: recording.projectPath, captions: pendingCaptions.current }).catch(() => {});
      if (activeJobs.current.export) void invoke("cancel_export").catch(() => {});
      if (activeJobs.current.transcription) void invoke("cancel_transcription").catch(() => {});
    };
  }, [recording.projectPath]);

  useEffect(() => {
    let cancelled = false;
    setCaptions(null);
    setTranscription({ status: "idle" });
    invoke<unknown>("load_captions", { projectPath: recording.projectPath })
      .then((stored) => {
        if (!cancelled) setCaptions(parseCaptions(stored));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setCaptionsLoaded(true); });
    return () => {
      cancelled = true;
    };
  }, [recording.projectPath]);

  useEffect(() => {
    const unlisten = listen<number>("transcribe-progress", (event) => {
      setTranscription((current) => (current.status === "running" ? { status: "running", progress: event.payload } : current));
    });
    return () => void unlisten.then((dispose) => dispose());
  }, []);

  const updateCaptions = useCallback((next: RecordingCaptions) => {
    if (!mounted.current) return;
    setCaptions(next);
    pendingCaptions.current = next;
    window.clearTimeout(captionsTimer.current);
    captionsTimer.current = window.setTimeout(() => {
      pendingCaptions.current = null;
      void invoke("save_captions", { projectPath: recording.projectPath, captions: next }).catch(() => {});
    }, 400);
  }, [recording.projectPath]);

  const updateCaptionStyle = (patch: Partial<CaptionStyle>) => {
    setCaptionStyle((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(CAPTION_STYLE_KEY, JSON.stringify(next));
      } catch {
        // The style still applies for this session.
      }
      return next;
    });
  };

  async function generateCaptions(locale: string) {
    if (activeJobs.current.transcription) return;
    activeJobs.current.transcription = true;
    setTranscription({ status: "running", progress: 0 });
    try {
      const result = await invoke<{ locale: string; words: CaptionWord[] }>("transcribe_recording", {
        projectPath: recording.projectPath,
        locale,
      });
      if (!mounted.current) return;
      updateCaptions({ locale: result.locale, enabled: true, lines: buildCaptionLines(result.words) });
      setTranscription({ status: "idle" });
      track("captions_generated", { locale: result.locale });
    } catch (error) {
      const message = String(error);
      if (message !== "Captions cancelled.") track("captions_failed");
      setTranscription(message === "Captions cancelled." ? { status: "idle" } : { status: "failed", message });
    } finally {
      activeJobs.current.transcription = false;
    }
  }

  const editsRef = useRef(edits);
  editsRef.current = edits;
  const saveEdits = useCallback((next: RecordingEdits) => {
    pendingEdits.current = next;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      pendingEdits.current = null;
      void invoke("save_edits", { projectPath: recording.projectPath, edits: next }).catch(() => {});
    }, 300);
  }, [recording.projectPath]);
  const updateEdits = useCallback((update: (current: RecordingEdits) => RecordingEdits) => {
    const current = editsRef.current;
    const next = update(current);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    const now = performance.now();
    // Pointer drags emit many changes; keep one snapshot for the whole gesture.
    if (now - history.current.lastChange > 500 || history.current.past.length === 0) {
      history.current.past.push(current);
      if (history.current.past.length > 50) history.current.past.shift();
    }
    history.current.lastChange = now;
    history.current.future = [];
    editsRef.current = next;
    setEdits(next);
    setHistoryState({ canUndo: true, canRedo: false });
    saveEdits(next);
  }, [saveEdits]);

  const changeZoomStrength = useCallback((strength: number) => {
    updateEdits((current) => ({ ...current, zoomStrength: strength }));
    setPreferredZoomStrength(strength);
    try {
      localStorage.setItem(ZOOM_STRENGTH_KEY, String(strength));
    } catch {
      // The recording keeps its own strength in edits.json either way.
    }
  }, [updateEdits]);

  const moveHistory = useCallback((direction: "undo" | "redo") => {
    const from = direction === "undo" ? history.current.past : history.current.future;
    const to = direction === "undo" ? history.current.future : history.current.past;
    const next = from.pop();
    if (!next) return;
    to.push(editsRef.current);
    history.current.lastChange = 0;
    editsRef.current = next;
    setEdits(next);
    setHistoryState({ canUndo: history.current.past.length > 0, canRedo: history.current.future.length > 0 });
    saveEdits(next);
  }, [saveEdits]);

  // Removing a line cuts its speech from the video; the line stays listed so it can be restored.
  const captionCutId = (line: { id: string }) => `cut-caption-${line.id}`;
  const isCaptionCut = useCallback((line: { startMs: number; endMs: number }) => {
    const middle = (line.startMs + line.endMs) / 2;
    return !sourceRanges.some((kept) => middle >= kept.startMs && middle < kept.endMs);
  }, [sourceRanges]);
  const cutCaption = useCallback((line: { id: string; startMs: number; endMs: number }) => {
    updateEdits((current) => {
      const cuts = current.cuts ?? [];
      if (isCaptionCut(line)) {
        // Restore: drop every cut that covers the line.
        return { ...current, cuts: cuts.filter((cut) => cut.id !== captionCutId(line) && (cut.endMs <= line.startMs || cut.startMs >= line.endMs)) };
      }
      return { ...current, cuts: [...cuts, { id: captionCutId(line), startMs: line.startMs, endMs: line.endMs }] };
    });
  }, [isCaptionCut, updateEdits]);

  const removeSilences = useCallback(() => {
    if (!captions) return;
    const lines = [...captions.lines].sort((a, b) => a.startMs - b.startMs);
    const suggested: CutSegment[] = [];
    let cursor = range.startMs;
    for (const line of lines) {
      const start = Math.max(range.startMs, line.startMs - 200);
      if (start - cursor >= 1_200) suggested.push({ id: `cut-silence-${Math.round(cursor)}`, startMs: cursor, endMs: start });
      cursor = Math.max(cursor, Math.min(range.endMs, line.endMs + 200));
    }
    if (range.endMs - cursor >= 1_200) suggested.push({ id: `cut-silence-${Math.round(cursor)}`, startMs: cursor, endMs: range.endMs });
    updateEdits((current) => ({ ...current, cuts: [...(current.cuts ?? []), ...suggested] }));
  }, [captions, range.endMs, range.startMs, updateEdits]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;
      event.preventDefault();
      moveHistory(event.shiftKey ? "redo" : "undo");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moveHistory]);
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
    if (activeJobs.current.export) return;
    activeJobs.current.export = true;
    setExportState({ status: "running", progress: 0 });
    setSurvey(false);
    track("export_started", { quality: effectiveSettings.quality, frame: effectiveSettings.frame, aspect: effectiveSettings.aspect });
    try {
      const source = { width: recording.width, height: recording.height };
      const effective = effectiveSettings;
      const layout = computeLayout(effective, source);
      const canvas = document.createElement("canvas");
      canvas.width = layout.width;
      canvas.height = layout.height;
      paintFrameBase(canvas.getContext("2d")!, layout, effective, image);

      // Captions on the exported timeline, each painted at output size like the preview.
      const keptCaptions = captions?.enabled ? retimeCaptions(captions.lines, sourceRanges) : [];
      if (keptCaptions.length > 0) await loadCaptionFont();
      const captionImages = keptCaptions.flatMap((line) => {
        const painted = paintCaption(line.text, layout, captionStyle);
        return painted
          ? [{ startMs: line.startMs, endMs: line.endMs, image: painted.canvas.toDataURL("image/png"), x: painted.x, y: painted.y }]
          : [];
      });
      const overlay = edits.keystrokeOverlay ?? DEFAULT_KEYSTROKE_OVERLAY;
      const keyImages = overlay.enabled ? (recording.keystrokes ?? []).flatMap((event, index) => {
        const kept = sourceRanges.find((item) => event.timeMs >= item.startMs && event.timeMs < item.endMs);
        if (!kept) return [];
        const painted = paintKeystroke(event.keys, layout, overlay);
        const sourceEnd = Math.min(kept.endMs, keystrokeEnd(recording.keystrokes, index));
        return [{ startMs: sourceToOutputTime(sourceRanges, event.timeMs), endMs: sourceToOutputTime(sourceRanges, sourceEnd), image: painted.canvas.toDataURL("image/png"), x: painted.x, y: painted.y }];
      }) : [];

      // Brand pieces: title cards before and after the recording and the logo over it.
      const withCards = !isWeb;
      const introMs = withCards && brand.intro.enabled && brand.intro.title.trim() ? CARD_MS : 0;
      const outroMs = withCards && brand.outro.enabled && brand.outro.title.trim() ? CARD_MS : 0;
      const sourceTimes = buildSourceTimes(sourceRanges, EXPORT_FPS);
      const recordingFrames = buildRenderFrames(recording.pointerEvents, source, layout, recording.durationMs, EXPORT_FPS, autoZoom, {
        zooms: applyZoomStrength(zooms, zoomStrength),
        startMs: range.startMs,
        endMs: range.endMs,
        sourceTimesMs: sourceTimes,
        framing: edits.framing,
      });
      const introFrames = Math.round((introMs / 1_000) * EXPORT_FPS);
      const outroFrames = Math.round((outroMs / 1_000) * EXPORT_FPS);
      const leadIn = (introFrames * 1_000) / EXPORT_FPS;
      const recordingMs = (recordingFrames.length * 1_000) / EXPORT_FPS;
      const shift = <T extends { startMs: number; endMs: number }>(item: T): T => ({ ...item, startMs: item.startMs + leadIn, endMs: item.endMs + leadIn });
      const cardImages = [
        introMs ? { startMs: 0, endMs: leadIn, image: paintCard(brand.intro, layout, effective, image, logoImage).toDataURL("image/png"), x: 0, y: 0 } : null,
        outroMs ? { startMs: leadIn + recordingMs, endMs: leadIn + recordingMs + (outroFrames * 1_000) / EXPORT_FPS, image: paintCard(brand.outro, layout, effective, image, logoImage).toDataURL("image/png"), x: 0, y: 0 } : null,
      ].filter((item) => item !== null);
      const logoImages = withCards && brand.showLogo && logoImage
        ? [(() => { const painted = paintLogo(brand, logoImage, layout); return { startMs: leadIn, endMs: leadIn + recordingMs, image: painted.canvas.toDataURL("image/png"), x: painted.x, y: painted.y }; })()]
        : [];

      if (!mounted.current) return;
      const result = await invoke<ExportResult>("export_recording", {
        projectPath: recording.projectPath,
        captions: [...logoImages, ...[...captionImages, ...keyImages].map(shift), ...cardImages],
        subtitles: keptCaptions.length > 0 ? toSrt(keptCaptions.map(shift)) : null,
        fileName: exportFileName(),
        baseLayer: canvas.toDataURL("image/png"),
        cursor: renderCursorPng(),
        job: {
          width: layout.width,
          height: layout.height,
          sourceWidth: recording.width,
          sourceHeight: recording.height,
          fps: EXPORT_FPS,
          cursorHotspotX: CURSOR_HOTSPOT.x,
          cursorHotspotY: CURSOR_HOTSPOT.y,
          video: layout.video,
          radius: layout.videoRadius,
          roundTopCorners: layout.roundVideoTop,
          startMs: range.startMs,
          sourceRanges,
          leadInMs: leadIn,
          // The cards cover the frame; under them the first and last frames stand still.
          sourceTimesMs: [...Array(introFrames).fill(sourceTimes[0]), ...sourceTimes, ...Array(outroFrames).fill(sourceTimes.at(-1))],
          redactions: edits.redactions ?? [],
          camera: recording.cameraPath && cameraOverlay.visible
            ? { ...cameraRect(cameraOverlay, layout.width, layout.height), mirror: cameraOverlay.mirror }
            : null,
          frames: [...Array(introFrames).fill(recordingFrames[0]), ...recordingFrames, ...Array(outroFrames).fill(recordingFrames.at(-1))],
        },
      });
      setExportState({ status: "done", result });
      setGif({ status: "idle" });
      setCopied(null);
      track("export_finished", {
        quality: effective.quality,
        frame: effective.frame,
        aspect: effective.aspect,
        background: effective.background.kind,
        captions: keptCaptions.length > 0,
        auto_zoom: autoZoom,
        trimmed: range.startMs > 0 || range.endMs < recording.durationMs,
        duration: durationBucket(range.endMs - range.startMs),
      });
      if (canAsk.current && surveyDue()) {
        markSurveyShown();
        setSurvey(true);
      }
    } catch (error) {
      const message = String(error);
      // The browser version's errors are message keys (web.exportTooLarge, …): a safe label.
      const reason = isWeb && message.startsWith("web.export") ? message.slice("web.export".length).toLowerCase() : null;
      track(message === "Export cancelled." ? "export_cancelled" : "export_failed", reason ? { reason } : {});
      setExportState(message === "Export cancelled." ? { status: "idle" } : { status: "failed", message });
    } finally {
      activeJobs.current.export = false;
    }
  }

  async function createGif(videoPath: string, options: GifOptions) {
    const controller = new AbortController();
    gifAbort.current = controller;
    setGif({ status: "running", progress: 0 });
    try {
      const bytes = await makeGif(convertFileSrc(videoPath), options, (progress) => setGif({ status: "running", progress }), controller.signal);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      const path = await invoke<string>("save_export_gif", { videoPath, data: btoa(binary) });
      setGif({ status: "done", path });
    } catch (error) {
      const message = String(error).replace(/^Error: /, "");
      setGif(message === "Export cancelled." ? { status: "idle" } : { status: "failed", message });
    } finally {
      gifAbort.current = null;
    }
  }

  async function copyExport(path: string) {
    try {
      await invoke("copy_export", { path });
      setCopied(path);
    } catch (error) {
      setGif({ status: "failed", message: String(error) });
    }
  }

  // An export asked for by a link: apply its preset, then export once the settings are in place.
  const handledAutoExport = useRef<number | null>(null);
  useEffect(() => {
    // Wait for everything the export draws: edits, captions and a chosen background image.
    const imageReady = settings.background.kind !== "image" || Boolean(image) || !settings.background.path;
    if (!autoExport || !editsLoaded || !captionsLoaded || !imageReady || handledAutoExport.current === autoExport.id) return;
    handledAutoExport.current = autoExport.id;
    const preset = EXPORT_PRESETS.find((item) => item.id === autoExport.preset);
    if (preset) updateSettings(preset.settings);
    setAutoExportReady(autoExport.id);
  }, [autoExport, captionsLoaded, editsLoaded, image, settings.background, updateSettings]);
  useEffect(() => {
    if (autoExportReady === null) return;
    setAutoExportReady(null);
    onAutoExportStarted?.();
    void exportVideo();
    // exportVideo reads the settings the preset has just applied.
  }, [autoExportReady]);

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
        zoomStrength={zoomStrength}
        onZoomStrengthChange={changeZoomStrength}
        range={range}
        captions={captions?.enabled ? { lines: captions.lines, style: captionStyle } : null}
        seekRef={seekRef}
        canUndo={historyState.canUndo}
        canRedo={historyState.canRedo}
        onUndo={() => moveHistory("undo")}
        onRedo={() => moveHistory("redo")}
        redactions={edits.redactions ?? []}
        keystrokeOverlay={edits.keystrokeOverlay ?? DEFAULT_KEYSTROKE_OVERLAY}
        startAtMs={startAtMs ?? undefined}
        cameraOverlay={cameraOverlay}
        logo={logoData && logoImage && brand.showLogo ? { src: logoData, rect: (layout) => logoRect(brand, { width: logoImage.naturalWidth, height: logoImage.naturalHeight }, layout) } : null}
        onCameraChange={(camera) => updateEdits((current) => ({ ...current, camera }))}
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
        >
          {!isWeb && <BrandPanel brand={brand} logo={logoData} onChange={updateBrand} onLogo={(file) => void chooseLogo(file)} />}
          {recording.cameraPath && <CameraPanel value={cameraOverlay} onChange={(camera) => updateEdits((current) => ({ ...current, camera }))} />}
          {!isWeb && <PrivacyPanel redactions={edits.redactions ?? []} onChange={(redactions) => updateEdits((current) => ({ ...current, redactions }))} />}
          {!isWeb && <KeystrokePanel count={recording.keystrokes?.length ?? 0} value={edits.keystrokeOverlay ?? DEFAULT_KEYSTROKE_OVERLAY} onChange={(keystrokeOverlay) => updateEdits((current) => ({ ...current, keystrokeOverlay }))} />}
          {!isWeb && <CaptionsPanel
            captions={captions}
            transcription={transcription}
            style={captionStyle}
            defaultLocale={language === "vi" ? "vi-VN" : "en-US"}
            onGenerate={(locale) => void generateCaptions(locale)}
            onCancel={() => void invoke("cancel_transcription")}
            onChange={updateCaptions}
            onStyleChange={updateCaptionStyle}
            onSeek={(timeMs) => seekRef.current?.(timeMs)}
            onOpenSettings={() => void invoke("open_speech_settings").catch(() => {})}
            onCutCaption={cutCaption}
            onRemoveSilences={removeSilences}
            isCut={isCaptionCut}
          />}
          {!isWeb && captions && captions.lines.length > 0 && (
            <ChaptersPanel
              key={recording.projectPath}
              lines={captions.lines}
              chapters={edits.chapters}
              onChange={(chapters) => updateEdits((current) => ({ ...current, chapters }))}
              toOutput={(timeMs) => sourceToOutputTime(sourceRanges, timeMs) + (brand.intro.enabled && brand.intro.title.trim() ? CARD_MS : 0)}
              onRename={async (title) => {
                await invoke("rename_recording", { projectPath: recording.projectPath, title });
                window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));
              }}
              onSeek={(timeMs) => seekRef.current?.(timeMs)}
            />
          )}
        </FrameEditor>

        <div className="export-box">
          {!running && <ExportPresets settings={settings} onApply={(patch) => updateSettings(patch)} />}
          {running ? (
            <>
              <div className="export-progress" role="progressbar" aria-valuenow={exportState.progress} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ transform: `scaleX(${exportState.progress / 100})` }} />
              </div>
              <div className="export-row">
                <span className="export-status"><Loader2 size={15} className="spin" aria-hidden="true" /> {t("export.running", { percent: exportState.progress })}</span>
                {/* In the browser, 100% means the file is being committed and can no longer be
                    cancelled. The desktop helper reports 100% before it finalizes and adds the
                    sound, and can still be stopped then. */}
                {(!isWeb || exportState.progress < 100) && (
                  <button className="editor-button" onClick={() => void invoke("cancel_export")}>
                    <X size={15} aria-hidden="true" /> {t("export.cancel")}
                  </button>
                )}
              </div>
            </>
          ) : (
            <button className="record-button export-button" onClick={() => void exportVideo()}>
              <Download size={17} aria-hidden="true" /> {t("export.start")}
            </button>
          )}

          {exportState.status === "done" && (
            <div className="export-done" role="status">
              <div className="export-done-head">
                <span className="export-done-icon" aria-hidden="true"><Check size={15} strokeWidth={3} /></span>
                <div>
                  <strong>{t("export.done")}</strong>
                  <small>{exportState.result.width} × {exportState.result.height} · {exportState.result.fps ?? EXPORT_FPS} fps</small>
                </div>
              </div>
              {exportState.result.subtitlesPath && (
                <p className="export-done-note"><Captions size={13} aria-hidden="true" /> {t("captions.srtSaved")}</p>
              )}
              <div className="export-done-actions">
                {/* The browser version saved straight to a file has nothing left to download again. */}
                {(!isWeb || exportState.result.outputPath) && (
                  <button className="editor-button accent" onClick={() => void invoke("open_export", { path: exportState.result.outputPath, reveal: false })}>
                    {isWeb ? <Download size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />} {t("export.open")}
                  </button>
                )}
                {!isWeb && (
                  <button className="editor-button" onClick={() => void invoke("open_export", { path: exportState.result.outputPath, reveal: true })}>
                    <FolderOpen size={14} aria-hidden="true" /> {t("export.reveal")}
                  </button>
                )}
                {!isWeb && (
                  <button className="editor-button" onClick={() => void copyExport(exportState.result.outputPath)}>
                    {copied === exportState.result.outputPath ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} {t(copied === exportState.result.outputPath ? "export.copied" : "export.copy")}
                  </button>
                )}
              </div>
              {!isWeb && (
                <div className="gif-box">
                  {gif.status === "running" ? (
                    <div className="export-row">
                      <span className="export-status"><Loader2 size={15} className="spin" aria-hidden="true" /> {t("gif.running", { percent: gif.progress })}</span>
                      <button className="editor-button" onClick={() => gifAbort.current?.abort()}><X size={15} aria-hidden="true" /> {t("export.cancel")}</button>
                    </div>
                  ) : gif.status === "done" ? (
                    <div className="export-done-actions">
                      <button className="editor-button accent" onClick={() => void invoke("open_export", { path: gif.path, reveal: false })}><Play size={14} aria-hidden="true" /> {t("gif.open")}</button>
                      <button className="editor-button" onClick={() => void copyExport(gif.path)}>
                        {copied === gif.path ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} {t(copied === gif.path ? "export.copied" : "gif.copy")}
                      </button>
                    </div>
                  ) : (
                    <div className="gif-choices">
                      {GIF_PRESETS.map((preset) => (
                        <button key={preset.id} className="editor-button" onClick={() => void createGif(exportState.result.outputPath, preset.options)}>
                          <Film size={14} aria-hidden="true" />
                          <span>{t(`gif.${preset.id}`)}<small>{t("gif.estimate", { size: formatBytes(estimateGifBytes(preset.options, exportState.result)) })}</small></span>
                        </button>
                      ))}
                    </div>
                  )}
                  {gif.status === "failed" && <p className="editor-note error-note">{gif.message}</p>}
                </div>
              )}
              <div className="export-done-actions">
                <button className="editor-button" onClick={() => setFeedback({ category: "idea", message: "" })}>
                  <MessageSquare size={14} aria-hidden="true" /> {t("feedback.open")}
                </button>
              </div>
              {survey && (
                <FeatureSurvey
                  onDismiss={() => setSurvey(false)}
                  onOther={(message) => setFeedback({ category: "feature", message })}
                />
              )}
            </div>
          )}
          {exportState.status === "failed" && (
            <div className="capture-message error" role="alert">
              <AlertCircle size={18} aria-hidden="true" />
              <span><strong>{t("export.failed")}</strong><small>{isWeb && isMessageKey(exportState.message) ? t(exportState.message) : exportState.message}</small></span>
            </div>
          )}
        </div>
      </aside>
      {feedback && <FeedbackDialog initialCategory={feedback.category} initialMessage={feedback.message} onClose={() => setFeedback(null)} />}
    </div>
  );
}

const MAGIC_FALLBACK: BackgroundSpec = DEFAULT_FRAME_SETTINGS.background;

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(bytes >= 10 * 1024 ** 2 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
