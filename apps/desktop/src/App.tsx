import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { generateZoomSegments } from "@screensway/core";
import { AlertCircle, Check, CheckCircle2, ChevronDown, Languages, Monitor, MousePointer2, Pause, Play, Settings2, Sparkles, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDuration } from "./format";
import { LANGUAGES, useI18n, type MessageKey } from "./i18n";
import { useRecordingState } from "./recordingState";
import { ZoomPreview, type RecordingResult } from "./ZoomPreview";

interface CaptureSource {
  id: string;
  kind: "display" | "window";
  name: string;
  width: number;
  height: number;
}

const CANCELLED_MESSAGE = "Recording cancelled.";

const recentRecordings: { titleKey: MessageKey; durationMs: number; color: string }[] = [
  { titleKey: "recent.sampleWalkthrough", durationMs: 134_000, color: "violet" },
  { titleKey: "recent.sampleWelcome", durationMs: 38_000, color: "blue" },
];

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
          <span className="settings-label"><Languages size={13} /> {t("settings.language")}</span>
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
                {language === option.code && <Check size={14} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { t } = useI18n();
  const recorder = useRecordingState();
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [selectedSourceKey, setSelectedSourceKey] = useState("");
  const [loadingSources, setLoadingSources] = useState(true);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recording = recorder.status !== "idle";
  const paused = recorder.status === "paused";
  const zoomCount = useMemo(
    () => generateZoomSegments(result?.pointerEvents ?? []).length,
    [result],
  );
  const selectedSource = sources.find(
    (source) => `${source.kind}:${source.id}` === selectedSourceKey,
  );

  useEffect(() => {
    async function loadSources() {
      try {
        const availableSources = await invoke<CaptureSource[]>("list_capture_sources");
        setSources(availableSources);
        if (availableSources[0]) {
          setSelectedSourceKey(`${availableSources[0].kind}:${availableSources[0].id}`);
        }
      } catch (sourceError) {
        setError(String(sourceError));
      } finally {
        setLoadingSources(false);
      }
    }

    void loadSources();
  }, []);

  useEffect(() => {
    if (result) document.querySelector(".preview-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [result]);

  // Recordings can be stopped from the floating controls or the menu bar, not only from here.
  useEffect(() => {
    const finished = listen<RecordingResult>("recording-finished", (event) => {
      setResult(event.payload);
      setError(null);
    });
    const failed = listen<string>("recording-failed", (event) => setError(event.payload));
    return () => {
      void finished.then((dispose) => dispose());
      void failed.then((dispose) => dispose());
    };
  }, []);

  async function startRecording() {
    if (!selectedSource) return;
    setBusy(true);
    setResult(null);
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

  const elapsed = formatDuration(recorder.elapsedMs);
  const statusLabel = {
    idle: t("status.idle"),
    countdown: t("status.countdown", { n: recorder.countdown ?? "" }),
    recording: t("status.recording", { time: elapsed }),
    paused: t("status.paused", { time: elapsed }),
    finishing: t("status.finishing"),
  }[recorder.status];
  const displayIds = sources.filter((source) => source.kind === "display").map((source) => source.id);
  const sourceLabel = (source: CaptureSource) =>
    source.kind === "display"
      ? t("source.display", { n: displayIds.indexOf(source.id) + 1 })
      : `${t("source.window")} · ${source.name}`;

  return (
    <main className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <a className="brand" href="#" aria-label={t("app.home")}>
          <span className="brand-mark"><MousePointer2 size={15} strokeWidth={2.5} /></span>
          <span>ScreenSway</span>
        </a>
        <SettingsMenu />
      </header>

      <section className="welcome">
        <div>
          <span className="eyebrow">{t("welcome.eyebrow")}</span>
          <h1>{t("welcome.title")}</h1>
          <p>{t("welcome.subtitle")}</p>
        </div>

        <div className="record-card">
          <div className="source-row">
            <span className="source-icon"><Monitor size={20} /></span>
            <label>
              <span className="source-label">{t("source.label")}</span>
              <select
                value={selectedSourceKey}
                onChange={(event) => setSelectedSourceKey(event.target.value)}
                disabled={recording || busy || loadingSources}
                aria-label={t("source.label")}
              >
                {loadingSources && <option>{t("source.loading")}</option>}
                {sources.map((source) => (
                  <option key={`${source.kind}:${source.id}`} value={`${source.kind}:${source.id}`}>
                    {sourceLabel(source)}
                  </option>
                ))}
              </select>
            </label>
            <ChevronDown size={17} />
          </div>
          <div className="record-options">
            <span><i className={`status-dot ${recorder.status}`} /> {statusLabel}</span>
            <span>{selectedSource ? `${selectedSource.width} × ${selectedSource.height}` : "—"}</span>
          </div>
          <div className={`record-controls${recording ? " active" : ""}`}>
            {(recorder.status === "recording" || recorder.status === "paused") && (
              <button className="pause-button" onClick={togglePause}>
                {paused ? <Play size={13} fill="currentColor" /> : <Pause size={13} fill="currentColor" />}
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
              {recording ? <Square size={9} fill="currentColor" /> : <span className="record-dot" />}
              {recording ? (recorder.status === "finishing" ? t("action.saving") : t("action.stop")) : t("action.start")}
            </button>
          </div>
          {!recording && !result && !error && (
            <p className="record-hint">{t("record.hint")}</p>
          )}
          {result && (
            <div className="capture-message success">
              <CheckCircle2 size={15} />
              <span><strong>{t("record.saved")}</strong><small>{result.projectPath}</small></span>
            </div>
          )}
          {error && (
            <div className="capture-message error">
              <AlertCircle size={15} />
              <span><strong>{t("record.failed")}</strong><small>{error}</small></span>
            </div>
          )}
        </div>
      </section>

      <section className="recent-section">
        {result && (
          <div className="preview-card">
            <div className="section-heading">
              <h2>{t("preview.title")}</h2>
              <span>
                {t(zoomCount === 1 ? "preview.zoomsOne" : "preview.zooms", {
                  count: zoomCount,
                  time: formatDuration(result.durationMs),
                })}
              </span>
            </div>
            <ZoomPreview recording={result} key={result.videoPath} />
          </div>
        )}
        <div className="section-heading">
          <h2>{t("recent.title")}</h2>
          <span>{t("recent.stored")}</span>
        </div>
        <div className="recording-grid">
          {recentRecordings.map((recording) => (
            <article className="recording" key={recording.titleKey}>
              <div className={`thumbnail ${recording.color}`}>
                <div className="mock-window">
                  <span /><span /><span />
                  <div className="mock-content"><i /><i /><i /></div>
                </div>
                <span className="focus-ring"><MousePointer2 size={13} fill="white" /></span>
              </div>
              <div className="recording-meta">
                <div>
                  <strong>{t(recording.titleKey)}</strong>
                  <span>{t("recent.draft", { time: formatDuration(recording.durationMs) })}</span>
                </div>
                <button aria-label={t("recent.options", { title: t(recording.titleKey) })}>•••</button>
              </div>
            </article>
          ))}
          <article className="recording empty-state">
            <Sparkles size={21} />
            <strong>{t("recent.emptyTitle")}</strong>
            <span>{t("recent.emptyHint")}</span>
          </article>
        </div>
      </section>
    </main>
  );
}

