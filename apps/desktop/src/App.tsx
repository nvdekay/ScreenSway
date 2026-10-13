import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { generateZoomSegments } from "@screensway/core";
import {
  AlertCircle,
  AppWindow,
  Check,
  CheckCircle2,
  FolderOpen,
  Info,
  Languages,
  Lock,
  Mic,
  MicOff,
  Monitor,
  MousePointer2,
  Pause,
  Pencil,
  Play,
  RotateCw,
  Search,
  Settings2,
  ShieldAlert,
  Square,
  Trash2,
  Video,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration } from "./format";
import { LANGUAGES, useI18n, type Language } from "./i18n";
import { useRecordingState } from "./recordingState";
import { LogoMark } from "./LogoMark";
import { isWindows, supportsAudio } from "./platform";
import { RecordingStudio } from "./frame/RecordingStudio";
import { type RecordingResult } from "./ZoomPreview";

interface CaptureSource {
  id: string;
  kind: "display" | "window";
  name: string;
  width: number;
  height: number;
  /** Pixels per point: 2 on Retina, 1 on standard displays. */
  pixelScale?: number;
}

interface Microphone {
  id: string;
  name: string;
  isDefault: boolean;
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
const SYSTEM_AUDIO_KEY = "screensway.systemAudio";
const MICROPHONE_KEY = "screensway.microphone";
const MICROPHONE_DEVICE_KEY = "screensway.microphoneDevice";
/** Lets the capture helper use whatever input macOS currently has selected. */
const DEFAULT_MICROPHONE = "default";

/** A per-device preference; falls back to the default when storage is unavailable. */
function useStoredBoolean(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? fallback : stored === "true";
    } catch {
      return fallback;
    }
  });
  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // The choice still applies for this session.
      }
    },
    [key],
  );
  return [value, update] as const;
}
/** Like useStoredBoolean, for a short string such as a device ID. */
function useStoredString(key: string, fallback: string) {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const update = useCallback(
    (next: string) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // The choice still applies for this session.
      }
    },
    [key],
  );
  return [value, update] as const;
}
const PERMISSION_DENIED_MARKER = "SCREENSWAY_SCREEN_RECORDING_DENIED";
const MICROPHONE_DENIED_MARKER = "SCREENSWAY_MICROPHONE_DENIED";

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

function recordingTitle(entry: LibraryEntry, language: Language): string {
  return /^Recording-\d+$/.test(entry.title) ? formatCreatedAt(entry.createdAt, language) : entry.title;
}

export function recordingMatches(entry: LibraryEntry, query: string, language: Language): boolean {
  const words = query.trim().toLocaleLowerCase(language === "vi" ? "vi-VN" : "en-US");
  if (!words) return true;
  return [recordingTitle(entry, language), formatCreatedAt(entry.createdAt, language), `${entry.width} ${entry.height}`]
    .some((value) => value.toLocaleLowerCase(language === "vi" ? "vi-VN" : "en-US").includes(words));
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

export function LibraryCard({
  entry,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  entry: LibraryEntry;
  active: boolean;
  onOpen: () => void;
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const { language, t } = useI18n();
  const title = recordingTitle(entry, language);
  const createdAt = formatCreatedAt(entry.createdAt, language);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const saveTitle = async () => {
    if (saving) return;
    setSaving(true);
    if (await onRename(draft)) setEditing(false);
    setSaving(false);
  };

  return (
    <article className={`library-card${active ? " active" : ""}`}>
      <button
        className={`library-thumb${scrubbing ? " scrubbing" : ""}`}
        onClick={onOpen}
        onPointerEnter={() => setScrubbing(true)}
        onPointerLeave={() => setScrubbing(false)}
        onPointerMove={(event) => {
          const video = videoRef.current;
          if (!video || !Number.isFinite(video.duration)) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const progress = Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
          video.currentTime = progress * video.duration;
        }}
        aria-label={t("library.open", { title })}
      >
        {entry.thumbnailPath && (
          <img src={convertFileSrc(entry.thumbnailPath)} alt="" loading="lazy" decoding="async" />
        )}
        {(scrubbing || !entry.thumbnailPath) && (
          <video
            ref={videoRef}
            className="scrub-video"
            src={`${convertFileSrc(entry.videoPath)}#t=0.5`}
            preload="metadata"
            muted
            playsInline
            tabIndex={-1}
          />
        )}
        <span className="thumb-play" aria-hidden="true"><Play size={16} fill="currentColor" /></span>
        <span className="thumb-duration">{formatDuration(entry.durationMs)}</span>
        {active && <span className="thumb-badge">{t("library.playing")}</span>}
      </button>
      <div className="library-meta">
        {editing ? (
          <form
            className="library-rename"
            onSubmit={(event) => {
              event.preventDefault();
              void saveTitle();
            }}
          >
            <input
              autoFocus
              value={draft}
              maxLength={120}
              aria-label={t("library.name")}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setDraft(title);
                  setEditing(false);
                }
              }}
            />
            <button className="icon-button small" disabled={saving || !draft.trim()} aria-label={t("library.saveName")}><Check size={15} /></button>
            <button type="button" className="icon-button small" aria-label={t("library.cancelRename")} onClick={() => { setDraft(title); setEditing(false); }}><X size={15} /></button>
          </form>
        ) : (
          <>
            <div className="library-details">
              <strong>{title}</strong>
              <span>{createdAt} · {entry.width} × {entry.height}</span>
            </div>
            <div className="library-actions">
              <button className="icon-button small" aria-label={t("library.rename")} title={t("library.rename")} onClick={() => setEditing(true)}><Pencil size={15} /></button>
              <button className="icon-button small" aria-label={t("library.reveal")} title={t("library.reveal")} onClick={() => void invoke("reveal_recording", { projectPath: entry.projectPath }).catch(() => {})}><FolderOpen size={15} /></button>
              <button className="icon-button small danger" aria-label={t("library.delete")} title={t("library.delete")} onClick={onDelete}><Trash2 size={15} /></button>
            </div>
          </>
        )}
      </div>
    </article>
  );
}

export default function App() {
  const { language, t } = useI18n();
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
  const [libraryQuery, setLibraryQuery] = useState("");
  const [systemAudio, setSystemAudio] = useStoredBoolean(SYSTEM_AUDIO_KEY, true);
  const [microphoneOn, setMicrophoneOn] = useStoredBoolean(MICROPHONE_KEY, false);
  const [microphoneDevice, setMicrophoneDevice] = useStoredString(MICROPHONE_DEVICE_KEY, DEFAULT_MICROPHONE);
  const [microphones, setMicrophones] = useState<Microphone[]>([]);
  // A remembered device that is unplugged now falls back to the system input.
  const chosenMicrophone = microphones.some((microphone) => microphone.id === microphoneDevice)
    ? microphoneDevice
    : DEFAULT_MICROPHONE;
  const defaultMicrophoneName = microphones.find((microphone) => microphone.isDefault)?.name;
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
  const visibleLibrary = useMemo(
    () => library.filter((entry) => recordingMatches(entry, libraryQuery, language)),
    [language, library, libraryQuery],
  );

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

  // Devices come and go (headsets, iPhone), so the list is refreshed whenever the microphone is turned on.
  useEffect(() => {
    if (!microphoneOn) return;
    let cancelled = false;
    invoke<Microphone[]>("list_microphones")
      .then((available) => {
        if (!cancelled) setMicrophones(available);
      })
      .catch(() => {
        // Recording still works with the default input.
      });
    return () => {
      cancelled = true;
    };
  }, [microphoneOn]);

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
        systemAudio: supportsAudio && systemAudio,
        microphone: supportsAudio && microphoneOn ? chosenMicrophone : null,
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

  async function renameRecording(entry: LibraryEntry, title: string): Promise<boolean> {
    try {
      const saved = await invoke<string>("rename_recording", { projectPath: entry.projectPath, title });
      setLibrary((current) => current.map((item) => item.projectPath === entry.projectPath ? { ...item, title: saved } : item));
      return true;
    } catch (libraryError) {
      setError(String(libraryError));
      return false;
    }
  }

  async function deleteRecording(entry: LibraryEntry) {
    if (!window.confirm(t("library.deleteConfirm", { title: recordingTitle(entry, language) }))) return;
    try {
      await invoke("delete_recording", { projectPath: entry.projectPath });
      setLibrary((current) => current.filter((item) => item.projectPath !== entry.projectPath));
      if (result?.projectPath === entry.projectPath) setResult(null);
    } catch (libraryError) {
      setError(String(libraryError));
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
                    <small>
                      {Math.round(source.width * (source.pixelScale ?? 1))} × {Math.round(source.height * (source.pixelScale ?? 1))}
                      {/* Retina is a Mac idea; Windows scaling says little about sharpness. */}
                      {!isWindows && source.pixelScale !== undefined && (
                        <span className={`density${source.pixelScale >= 2 ? " retina" : ""}`}>
                          {source.pixelScale >= 2 ? "Retina" : t("source.standard")}
                        </span>
                      )}
                    </small>
                  </span>
                  <span className="source-check" aria-hidden="true">{selected && <Check size={14} strokeWidth={3} />}</span>
                </button>
              );
            })}
          </div>

          {supportsAudio && (
            <>
              <label className={`audio-toggle${recording ? " disabled" : ""}`}>
                <span className="audio-icon" aria-hidden="true">
                  {systemAudio ? <Volume2 size={17} /> : <VolumeX size={17} />}
                </span>
                <span className="audio-text">
                  <strong>{t("audio.label")}</strong>
                  <small>{t("audio.hint")}</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={systemAudio}
                  disabled={recording}
                  onChange={(event) => setSystemAudio(event.target.checked)}
                />
                <span className="switch" aria-hidden="true" />
              </label>

              <label className={`audio-toggle${recording ? " disabled" : ""}`}>
                <span className="audio-icon" aria-hidden="true">
                  {microphoneOn ? <Mic size={17} /> : <MicOff size={17} />}
                </span>
                <span className="audio-text">
                  <strong>{t("mic.label")}</strong>
                  <small>{t("mic.hint")}</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={microphoneOn}
                  disabled={recording}
                  onChange={(event) => setMicrophoneOn(event.target.checked)}
                />
                <span className="switch" aria-hidden="true" />
              </label>
              {microphoneOn && (
                <div className="mic-options">
                  <select
                    className="mic-select"
                    aria-label={t("mic.device")}
                    value={chosenMicrophone}
                    disabled={recording}
                    onChange={(event) => setMicrophoneDevice(event.target.value)}
                  >
                    <option value={DEFAULT_MICROPHONE}>
                      {defaultMicrophoneName
                        ? t("mic.systemDefaultNamed", { name: defaultMicrophoneName })
                        : t("mic.systemDefault")}
                    </option>
                    {microphones.map((microphone) => (
                      <option key={microphone.id} value={microphone.id}>{microphone.name}</option>
                    ))}
                  </select>
                  {systemAudio && <small className="mic-tip">{t("mic.headphones")}</small>}
                </div>
              )}
            </>
          )}

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

          {!recording && !isWindows && selectedSource?.pixelScale !== undefined && selectedSource.pixelScale < 2 && (
            <p className="density-hint">
              <Info size={15} aria-hidden="true" />
              <span>{t("source.standardHint")}</span>
            </p>
          )}
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
          {error?.includes(MICROPHONE_DENIED_MARKER) && (
            <div className="permission-card" role="alert">
              <span className="permission-icon" aria-hidden="true"><MicOff size={20} /></span>
              <strong>{t("micPermission.title")}</strong>
              <p>{t(isWindows ? "micPermission.windowsBody" : "micPermission.body")}</p>
              <div className="permission-actions">
                <button
                  className="permission-primary"
                  onClick={() => void invoke("open_microphone_settings").catch(() => {})}
                >
                  {t("permission.open")}
                </button>
                <button className="secondary-button compact" onClick={() => setMicrophoneOn(false)}>
                  {t("micPermission.withoutMic")}
                </button>
              </div>
            </div>
          )}
          {error && !error.includes(PERMISSION_DENIED_MARKER) && !error.includes(MICROPHONE_DENIED_MARKER) && (
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
          <RecordingStudio recording={result} key={result.videoPath} />
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
          {library.length > 0 && (
            <label className="library-search">
              <Search size={15} aria-hidden="true" />
              <span className="sr-only">{t("library.search")}</span>
              <input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder={t("library.search")} />
              {libraryQuery && <button aria-label={t("library.clearSearch")} onClick={() => setLibraryQuery("")}><X size={14} /></button>}
            </label>
          )}
        </div>
        {library.length === 0 ? (
          <div className="library-empty glass">
            <span className="empty-icon" aria-hidden="true"><Video size={22} /></span>
            <strong>{t("library.emptyTitle")}</strong>
            <span>{t("library.emptyHint")}</span>
          </div>
        ) : visibleLibrary.length === 0 ? (
          <div className="library-empty glass library-no-results">
            <Search size={22} aria-hidden="true" />
            <strong>{t("library.noResults")}</strong>
            <span>{t("library.noResultsHint", { query: libraryQuery })}</span>
          </div>
        ) : (
          <div className="library-grid">
            {visibleLibrary.map((entry) => (
              <LibraryCard
                key={entry.projectPath}
                entry={entry}
                active={result?.projectPath === entry.projectPath}
                onOpen={() => void openRecording(entry)}
                onRename={(title) => renameRecording(entry, title)}
                onDelete={() => void deleteRecording(entry)}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
