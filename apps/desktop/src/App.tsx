import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { generateZoomSegments } from "@screensway/core";
import {
  AlertCircle,
  AppWindow,
  Check,
  CheckCircle2,
  FolderOpen,
  Languages,
  Lock,
  Monitor,
  MousePointer2,
  Pause,
  Play,
  RotateCw,
  Settings2,
  ShieldAlert,
  Square,
  Video,
  X,
  ZoomIn,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration } from "./format";
import { LANGUAGES, useI18n, type Language } from "./i18n";
import { useRecordingState } from "./recordingState";
import { LogoMark } from "./LogoMark";
import { ZoomPreview, type RecordingResult } from "./ZoomPreview";

interface CaptureSource {
  id: string;
  kind: "display" | "window";
  name: string;
  width: number;
  height: number;
}

interface LibraryEntry {
  projectPath: string;
  videoPath: string;
  thumbnailPath: string | null;
  title: string;
  createdAt: string;
  durationMs: number;
  width: number;
  height: number;
}

const CANCELLED_MESSAGE = "Recording cancelled.";
const PERMISSION_DENIED_MARKER = "SCREENSWAY_SCREEN_RECORDING_DENIED";

function formatCreatedAt(value: string, language: Language): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-US", {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function SettingsMenu() {
  const { language, setLanguage, t } = useI18n();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="settings" ref={menuRef}>
      <button
        className={`icon-button${open ? " active" : ""}`}
        aria-label={t("settings.open")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Settings2 size={18} />
      </button>
      {open && (
        <div className="settings-popover" role="dialog" aria-label={t("settings.title")}>
          <span className="settings-label"><Languages size={14} aria-hidden="true" /> {t("settings.language")}</span>
          <div className="language-options" role="radiogroup" aria-label={t("settings.language")}>
            {LANGUAGES.map((option) => (
              <button
                key={option.code}
                role="radio"
                aria-checked={language === option.code}
                className={`language-option${language === option.code ? " selected" : ""}`}
                onClick={() => setLanguage(option.code)}
              >
                <span>{option.label}</span>
                {language === option.code && <Check size={16} aria-hidden="true" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LibraryCard({
  entry,
  active,
  onOpen,
}: {
  entry: LibraryEntry;
  active: boolean;
  onOpen: () => void;
}) {
  const { language, t } = useI18n();
  const title = formatCreatedAt(entry.createdAt, language);

  return (
    <article className={`library-card${active ? " active" : ""}`}>
      <button className="library-thumb" onClick={onOpen} aria-label={t("library.open", { title })}>
        {entry.thumbnailPath ? (
          <img src={convertFileSrc(entry.thumbnailPath)} alt="" loading="lazy" decoding="async" />
        ) : (
          <video src={`${convertFileSrc(entry.videoPath)}#t=0.5`} preload="auto" muted playsInline tabIndex={-1} />
        )}
        <span className="thumb-play" aria-hidden="true"><Play size={16} fill="currentColor" /></span>
        <span className="thumb-duration">{formatDuration(entry.durationMs)}</span>
        {active && <span className="thumb-badge">{t("library.playing")}</span>}
      </button>
      <div className="library-meta">
        <div>
          <strong>{title}</strong>
          <span>{entry.width} × {entry.height}</span>
        </div>
        <button
          className="icon-button small"
          aria-label={t("library.reveal")}
          title={t("library.reveal")}
          onClick={() => void invoke("reveal_recording", { projectPath: entry.projectPath }).catch(() => {})}
        >
          <FolderOpen size={16} />
        </button>
      </div>
    </article>
  );
}

export default function App() {
  const { t } = useI18n();
  const recorder = useRecordingState();
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [sourceKind, setSourceKind] = useState<CaptureSource["kind"]>("display");
  const [selectedSourceKey, setSelectedSourceKey] = useState("");
  const [loadingSources, setLoadingSources] = useState(true);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const previewRef = useRef<HTMLElement>(null);
  const recording = recorder.status !== "idle";
  const paused = recorder.status === "paused";
  const zoomCount = useMemo(
    () => generateZoomSegments(result?.pointerEvents ?? []).length,
    [result],
  );
  const displayIds = useMemo(
    () => sources.filter((source) => source.kind === "display").map((source) => source.id),
    [sources],
  );
  const visibleSources = sources.filter((source) => source.kind === sourceKind);
  const selectedSource = sources.find((source) => `${source.kind}:${source.id}` === selectedSourceKey);

  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await invoke<LibraryEntry[]>("list_recordings"));
    } catch {
      // The library is a convenience; recording still works without it.
    }
  }, []);

  const loadSources = useCallback(async (isCancelled: () => boolean = () => false) => {
    setLoadingSources(true);
    setError(null);
    try {
      const availableSources = await invoke<CaptureSource[]>("list_capture_sources");
      if (isCancelled()) return;
      setSources(availableSources);
      const first = availableSources[0];
      if (first) setSelectedSourceKey((current) => current || `${first.kind}:${first.id}`);
    } catch (sourceError) {
      if (!isCancelled()) setError(String(sourceError));
    } finally {
      if (!isCancelled()) setLoadingSources(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadSources(() => cancelled);
    void refreshLibrary();
    return () => {
      cancelled = true;
    };
  }, [loadSources, refreshLibrary]);

  useEffect(() => {
    if (result) previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [result]);

  // Recordings can be stopped from the floating controls or the menu bar, not only from here.
  useEffect(() => {
    const finished = listen<RecordingResult>("recording-finished", (event) => {
      setResult(event.payload);
      setJustSaved(true);
      setError(null);
      void refreshLibrary();
    });
    const failed = listen<string>("recording-failed", (event) => setError(event.payload));
    return () => {
      void finished.then((dispose) => dispose());
      void failed.then((dispose) => dispose());
    };
  }, [refreshLibrary]);

  async function startRecording() {
    if (!selectedSource) return;
    setBusy(true);
    setJustSaved(false);
    setError(null);

    try {
      await invoke("start_recording", {
        sourceKind: selectedSource.kind,
        sourceId: selectedSource.id,
      });
    } catch (captureError) {
      if (String(captureError) !== CANCELLED_MESSAGE) setError(String(captureError));
    } finally {
      setBusy(false);
    }
  }

  async function stopRecording() {
    setBusy(true);
    try {
      await invoke("stop_recording");
    } catch (captureError) {
      setError(String(captureError));
    } finally {
      setBusy(false);
    }
  }

  async function togglePause() {
    try {
      await invoke("set_recording_paused", { paused: !paused });
    } catch (captureError) {
      setError(String(captureError));
    }
  }

  async function openRecording(entry: LibraryEntry) {
    try {
      setJustSaved(false);
      setResult(await invoke<RecordingResult>("load_recording", { projectPath: entry.projectPath }));
    } catch (libraryError) {
      setError(String(libraryError));
      void refreshLibrary();
    }
  }

  const elapsed = formatDuration(recorder.elapsedMs);
  const statusLabel = {
    idle: t("status.idle"),
    countdown: t("status.countdown", { n: recorder.countdown ?? "" }),
    recording: t("status.recording", { time: elapsed }),
    paused: t("status.paused", { time: elapsed }),
    finishing: t("status.finishing"),
  }[recorder.status];
  const sourceLabel = (source: CaptureSource) =>
    source.kind === "display"
      ? t("source.display", { n: displayIds.indexOf(source.id) + 1 })
      : source.name;

  return (
    <main className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <a className="brand" href="#" aria-label={t("app.home")}>
          <LogoMark size={30} />
          <span>ScreenSway</span>
        </a>
        <SettingsMenu />
      </header>

      <section className="studio">
        <div className="studio-intro reveal">
          <span className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" /> {t("welcome.eyebrow")}</span>
          <h1>{t("welcome.title")}</h1>
          <p>{t("welcome.subtitle")}</p>
          <ul className="highlights">
            <li><span><ZoomIn size={16} aria-hidden="true" /></span>{t("highlight.zoom")}</li>
            <li><span><MousePointer2 size={16} aria-hidden="true" /></span>{t("highlight.cursor")}</li>
            <li><span><Lock size={16} aria-hidden="true" /></span>{t("highlight.private")}</li>
          </ul>
        </div>

        <div className={`recorder glass reveal${recording ? " is-recording" : ""}`}>
          <div className="recorder-head">
            <span className="recorder-label">{t("source.label")}</span>
            <div className="segmented" role="tablist" aria-label={t("source.label")}>
              {(["display", "window"] as const).map((kind) => (
                <button
                  key={kind}
                  role="tab"
                  aria-selected={sourceKind === kind}
                  className={sourceKind === kind ? "selected" : ""}
                  disabled={recording}
                  onClick={() => {
                    setSourceKind(kind);
                    const first = sources.find((source) => source.kind === kind);
                    if (selectedSource?.kind !== kind && first) setSelectedSourceKey(`${first.kind}:${first.id}`);
                  }}
                >
                  {kind === "display" ? <Monitor size={15} aria-hidden="true" /> : <AppWindow size={15} aria-hidden="true" />}
                  {kind === "display" ? t("source.screens") : t("source.windows")}
                </button>
              ))}
            </div>
          </div>

          <div className="source-list" role="radiogroup" aria-label={t("source.label")} aria-busy={loadingSources}>
            {loadingSources && (
              <>
                <span className="source-skeleton" />
                <span className="source-skeleton" />
                <span className="sr-only">{t("source.loading")}</span>
              </>
            )}
            {!loadingSources && !error && visibleSources.length === 0 && <p className="source-empty">{t("source.empty")}</p>}
            {visibleSources.map((source) => {
              const key = `${source.kind}:${source.id}`;
              const selected = key === selectedSourceKey;
              return (
                <button
                  key={key}
                  role="radio"
                  aria-checked={selected}
                  className={`source-option${selected ? " selected" : ""}`}
                  disabled={recording || busy}
                  onClick={() => setSelectedSourceKey(key)}
                >
                  <span className="source-icon" aria-hidden="true">
                    {source.kind === "display" ? <Monitor size={18} /> : <AppWindow size={18} />}
                  </span>
                  <span className="source-text">
                    <strong>{sourceLabel(source)}</strong>
                    <small>{source.width} × {source.height}</small>
                  </span>
                  <span className="source-check" aria-hidden="true">{selected && <Check size={14} strokeWidth={3} />}</span>
                </button>
              );
            })}
          </div>

          <div className="recorder-status" aria-live="polite">
            <span className={`status-dot ${recorder.status}`} aria-hidden="true" />
            <span>{statusLabel}</span>
          </div>

          <div className={`record-controls${recording ? " active" : ""}`}>
            {(recorder.status === "recording" || recorder.status === "paused") && (
              <button className="secondary-button" onClick={togglePause}>
                {paused ? <Play size={15} fill="currentColor" aria-hidden="true" /> : <Pause size={15} fill="currentColor" aria-hidden="true" />}
                {paused ? t("action.resume") : t("action.pause")}
              </button>
            )}
            <button
              className={`record-button${recording ? " stop" : ""}`}
              onClick={recording ? stopRecording : startRecording}
              disabled={
                recorder.status === "countdown"
                || recorder.status === "finishing"
                || (!recording && (busy || !selectedSource))
              }
            >
              {recording ? <Square size={12} fill="currentColor" aria-hidden="true" /> : <span className="record-dot" aria-hidden="true" />}
              {recording ? (recorder.status === "finishing" ? t("action.saving") : t("action.stop")) : t("action.start")}
            </button>
          </div>

          {!recording && !justSaved && !error && <p className="record-hint">{t("record.hint")}</p>}
          {justSaved && result && !recording && (
            <div className="capture-message success" role="status">
              <CheckCircle2 size={18} aria-hidden="true" />
              <span><strong>{t("record.saved")}</strong><small>{result.projectPath}</small></span>
            </div>
          )}
          {error?.includes(PERMISSION_DENIED_MARKER) && (
            <div className="permission-card" role="alert">
              <span className="permission-icon" aria-hidden="true"><ShieldAlert size={20} /></span>
              <strong>{t("permission.title")}</strong>
              <p>{t("permission.body")}</p>
              <div className="permission-actions">
                <button
                  className="permission-primary"
                  onClick={() => void invoke("open_screen_recording_settings").catch(() => {})}
                >
                  {t("permission.open")}
                </button>
                <button className="secondary-button compact" onClick={() => void loadSources()}>
                  <RotateCw size={14} aria-hidden="true" /> {t("permission.retry")}
                </button>
              </div>
            </div>
          )}
          {error && !error.includes(PERMISSION_DENIED_MARKER) && (
            <div className="capture-message error" role="alert">
              <AlertCircle size={18} aria-hidden="true" />
              <span><strong>{t("record.failed")}</strong><small>{error}</small></span>
            </div>
          )}
        </div>
      </section>

      {result && (
        <section className="preview-section reveal" ref={previewRef}>
          <div className="section-heading">
            <div>
              <h2>{t("preview.title")}</h2>
              <span>
                {t(zoomCount === 1 ? "preview.zoomsOne" : "preview.zooms", {
                  count: zoomCount,
                  time: formatDuration(result.durationMs),
                })}
              </span>
            </div>
            <button className="icon-button" aria-label={t("preview.close")} onClick={() => setResult(null)}>
              <X size={18} />
            </button>
          </div>
          <ZoomPreview recording={result} key={result.videoPath} />
        </section>
      )}

      <section className="library-section">
        <div className="section-heading">
          <div>
            <h2>{t("library.title")}</h2>
            {library.length > 0 && (
              <span>{t(library.length === 1 ? "library.countOne" : "library.count", { count: library.length })}</span>
            )}
          </div>
        </div>
        {library.length === 0 ? (
          <div className="library-empty glass">
            <span className="empty-icon" aria-hidden="true"><Video size={22} /></span>
            <strong>{t("library.emptyTitle")}</strong>
            <span>{t("library.emptyHint")}</span>
          </div>
        ) : (
          <div className="library-grid">
            {library.map((entry) => (
              <LibraryCard
                key={entry.projectPath}
                entry={entry}
                active={result?.projectPath === entry.projectPath}
                onOpen={() => void openRecording(entry)}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
