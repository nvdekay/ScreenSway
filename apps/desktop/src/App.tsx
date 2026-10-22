import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { generateZoomSegments } from "@screensway/core";
import {
  AlertCircle,
  AppWindow,
  BarChart3,
  Check,
  Captions,
  CheckCircle2,
  Crop,
  Download,
  FilePlus2,
  FolderOpen,
  HardDrive,
  Info,
  Keyboard,
  Loader2,
  Languages,
  Link2,
  Lock,
  Mic,
  MicOff,
  Monitor,
  MessageSquare,
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
  Wrench,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration } from "./format";
import { LANGUAGES, useI18n, type Language, type MessageKey } from "./i18n";
import { useRecordingState } from "./recordingState";
import { LogoMark } from "./LogoMark";
import { isWindows, supportsAudio } from "./platform";
import { LIBRARY_CHANGED_EVENT, RecordingStudio } from "./frame/RecordingStudio";
import { durationBucket, track, useTelemetry } from "./telemetry";
import { FeedbackDialog } from "./FeedbackDialog";
import { Onboarding, type ScreenCheck } from "./Onboarding";
import { type RecordingResult } from "./ZoomPreview";
import { useUpdater, type UpdaterController } from "./updater";
import { QUICK_RECORD_SHORTCUTS, useQuickRecordShortcut } from "./quickRecord";

interface CaptureSource {
  id: string;
  kind: "display" | "window";
  name: string;
  width: number;
  height: number;
  /** Pixels per point: 2 on Retina, 1 on standard displays. */
  pixelScale?: number;
}
type CaptureMode = "display" | "window" | "region";

interface Microphone {
  id: string;
  name: string;
  isDefault: boolean;
}

interface Camera {
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

interface StorageStatus {
  availableBytes: number;
  warning: boolean;
  blocked: boolean;
}

interface InterruptedRecording {
  projectPath: string;
  name: string;
  recoverable: boolean;
}

const CANCELLED_MESSAGE = "Recording cancelled.";
const SYSTEM_AUDIO_KEY = "screensway.systemAudio";
const MICROPHONE_KEY = "screensway.microphone";
const KEYSTROKES_KEY = "screensway.keystrokes";
const CAMERA_KEY = "screensway.camera";
const MICROPHONE_DEVICE_KEY = "screensway.microphoneDevice";
/** Lets the capture helper use whatever input macOS currently has selected. */
const DEFAULT_MICROPHONE = "default";
const ONBOARDING_KEY = "screensway.onboarding.v1";

function onboardingWasCompleted() {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === "complete";
  } catch {
    return false;
  }
}

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

/** Clears ScreenSway's stale Screen Recording entry (macOS) and relaunches, so macOS asks again. */
async function resetScreenPermission() {
  try {
    await invoke("reset_screen_recording_permission");
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch {
    // The settings page still lets the person remove ScreenSway by hand.
    void invoke("open_screen_recording_settings").catch(() => {});
  }
}
const MICROPHONE_DENIED_MARKER = "SCREENSWAY_MICROPHONE_DENIED";
const CAMERA_DENIED_MARKER = "SCREENSWAY_CAMERA_DENIED";

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

/** What went wrong, as a category; the message itself can contain names and paths. */
function failureReason(message: string): string {
  if (message.includes(PERMISSION_DENIED_MARKER)) return "permission";
  if (message.includes(MICROPHONE_DENIED_MARKER)) return "microphone";
  return "other";
}

/** Asked once, on first launch; nothing is sent before the user answers. */
function TelemetryPrompt() {
  const { t } = useI18n();
  const { status, setEnabled } = useTelemetry();
  if (!status.available || status.enabled !== null) return null;
  return (
    <aside className="telemetry-prompt" role="dialog" aria-labelledby="telemetry-title">
      <span className="telemetry-icon" aria-hidden="true"><BarChart3 size={18} /></span>
      <div>
        <strong id="telemetry-title">{t("telemetry.title")}</strong>
        <p>{t("telemetry.body")}</p>
        <div className="permission-actions">
          <button className="permission-primary" onClick={() => void setEnabled(true)}>{t("telemetry.allow")}</button>
          <button className="secondary-button compact" onClick={() => void setEnabled(false)}>{t("telemetry.decline")}</button>
        </div>
      </div>
    </aside>
  );
}

function recordingTitle(entry: LibraryEntry, language: Language): string {
  return /^Recording-\d+$/.test(entry.title) ? formatCreatedAt(entry.createdAt, language) : entry.title;
}

/** Lower case without accents, so "khong" finds "không". */
export function foldText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase();
}

export function recordingMatches(entry: LibraryEntry, query: string, language: Language): boolean {
  const words = foldText(query.trim());
  if (!words) return true;
  return [recordingTitle(entry, language), formatCreatedAt(entry.createdAt, language), `${entry.width} ${entry.height}`]
    .some((value) => foldText(value).includes(words));
}

export interface Transcript {
  projectPath: string;
  lines: { startMs: number; text: string }[];
}

/** The first thing said in a recording that contains the query. */
export function spokenMatch(transcript: Transcript | undefined, query: string): { startMs: number; text: string } | null {
  const words = foldText(query.trim());
  if (words.length < 2 || !transcript) return null;
  return transcript.lines.find((line) => foldText(line.text).includes(words)) ?? null;
}

function SettingsMenu({ updater, onOpenSetup, quickShortcut, onQuickShortcutChange, shortcutError }: {
  updater: UpdaterController;
  onOpenSetup: () => void;
  quickShortcut: string;
  onQuickShortcutChange: (shortcut: string) => void;
  shortcutError: string | null;
}) {
  const { language, setLanguage, t } = useI18n();
  const telemetry = useTelemetry();
  const [open, setOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
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
        className={`icon-button${open ? " active" : ""}${updater.state.status === "available" ? " has-update" : ""}`}
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
          {telemetry.status.available && (
            <label className="settings-toggle">
              <span>
                <strong>{t("telemetry.setting")}</strong>
                <small>{t("telemetry.settingHint")}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={telemetry.status.enabled === true}
                onChange={(event) => void telemetry.setEnabled(event.target.checked)}
              />
              <span className="switch" aria-hidden="true" />
            </label>
          )}
          <div className="update-settings">
            <span className="settings-label"><RotateCw size={14} aria-hidden="true" /> {t("update.title")}</span>
            {updater.state.status === "available" ? (
              <>
                <strong>{t("update.available", { version: updater.state.version })}</strong>
                <button className="update-button" onClick={() => void updater.install()}><Download size={14} /> {t("update.install")}</button>
              </>
            ) : updater.state.status === "waiting" ? (
              <>
                <span className="update-status">{t("update.waiting", { version: updater.state.version })}</span>
                <button className="update-button" onClick={() => void updater.install()}><RotateCw size={14} /> {t("update.restartNow")}</button>
              </>
            ) : updater.state.status === "downloading" ? (
              <span className="update-status">{t("update.downloading", { percent: updater.state.progress ?? "…" })}</span>
            ) : updater.state.status === "restarting" ? (
              <span className="update-status">{t("update.restarting")}</span>
            ) : updater.state.status === "checking" ? (
              <span className="update-status">{t("update.checking")}</span>
            ) : updater.state.status === "upToDate" ? (
              <><span className="update-status success"><CheckCircle2 size={14} /> {t("update.current")}</span><button className="update-link" onClick={() => void updater.checkNow()}>{t("update.checkAgain")}</button></>
            ) : updater.state.status === "error" ? (
              <><span className="update-error">{t("update.failed")}</span><button className="update-link" onClick={() => void updater.checkNow()}>{t("update.retry")}</button></>
            ) : (
              <button className="update-link" onClick={() => void updater.checkNow()}>{t("update.check")}</button>
            )}
          </div>
          <div className="shortcut-settings">
            <span className="settings-label">{t("quick.shortcut")}</span>
            <select value={quickShortcut} onChange={(event) => onQuickShortcutChange(event.target.value)}>
              {QUICK_RECORD_SHORTCUTS.map((shortcut) => <option key={shortcut} value={shortcut}>{shortcut.replace("CommandOrControl", isWindows ? "Ctrl" : "⌘")}</option>)}
            </select>
            {shortcutError && <small>{t("quick.shortcutUnavailable")}</small>}
          </div>
          <ExportFolderSetting />
          <button className="update-link setup-link" onClick={() => { setOpen(false); onOpenSetup(); }}>
            {t("onboarding.openSetup")}
          </button>
          <button className="update-link setup-link" onClick={() => { setOpen(false); setFeedbackOpen(true); }}>
            <MessageSquare size={14} aria-hidden="true" /> {t("feedback.open")}
          </button>
        </div>
      )}
      {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}
    </div>
  );
}

/** A request from a screensway:// link (see the desktop shell's AutomationRequest). */
type AutomationRequest =
  | { action: "record"; source: "display" | "window"; systemAudio: boolean; microphone: boolean }
  | { action: "open"; project: string }
  | { action: "export"; project: string; preset: string | null };

interface ExportFolder {
  path: string;
  custom: boolean;
}

/** Where exports go: the library's Exports folder, or one the user picked (a synced or network folder works). */
function ExportFolderSetting() {
  const { t } = useI18n();
  const [folder, setFolder] = useState<ExportFolder | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    void invoke<ExportFolder>("get_export_folder").then(setFolder).catch(() => {});
  }, []);
  const change = (command: "choose_export_folder" | "reset_export_folder") => {
    setError(false);
    void invoke<ExportFolder>(command).then(setFolder).catch(() => setError(true));
  };
  if (!folder) return null;
  return (
    <div className="shortcut-settings export-folder-settings">
      <span className="settings-label">{t("exportFolder.label")}</span>
      <span className="export-folder-path" title={folder.path}>{folder.custom ? folder.path : t("exportFolder.default")}</span>
      <div className="export-folder-actions">
        <button className="update-link" onClick={() => change("choose_export_folder")}>{t("exportFolder.choose")}</button>
        {folder.custom && <button className="update-link" onClick={() => change("reset_export_folder")}>{t("exportFolder.reset")}</button>}
      </div>
      <small className={error ? "error" : undefined}>{error ? t("exportFolder.failed") : t("exportFolder.hint")}</small>
    </div>
  );
}

export function HeaderUpdateButton({ updater }: { updater: UpdaterController }) {
  const { t } = useI18n();
  const { state } = updater;

  if (state.status === "available") {
    return (
      <button className="header-update-button" onClick={() => void updater.install()}>
        <Download size={15} aria-hidden="true" />
        {t("update.headerInstall", { version: state.version })}
      </button>
    );
  }

  if (state.status === "waiting") {
    return (
      <button
        className="header-update-button"
        title={t("update.waiting", { version: state.version })}
        onClick={() => void updater.install()}
      >
        <RotateCw size={15} aria-hidden="true" />
        {t("update.restartNow")}
      </button>
    );
  }

  if (state.status === "downloading") {
    return (
      <button className="header-update-button is-busy" disabled aria-live="polite">
        <RotateCw className="spin" size={15} aria-hidden="true" />
        {t("update.downloading", { percent: state.progress ?? "…" })}
      </button>
    );
  }

  if (state.status === "restarting") {
    return (
      <button className="header-update-button is-busy" disabled aria-live="polite">
        <RotateCw className="spin" size={15} aria-hidden="true" />
        {t("update.restartingShort")}
      </button>
    );
  }

  return null;
}

export function LibraryCard({
  entry,
  spoken,
  onOpenSpoken,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  entry: LibraryEntry;
  /** Where the search was found in what was said. */
  spoken?: { startMs: number; text: string } | null;
  onOpenSpoken?: () => void;
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
              {spoken && (
                <button className="spoken-match" onClick={onOpenSpoken} title={t("library.openAtSpoken")}>
                  <Captions size={12} aria-hidden="true" /> <time>{formatDuration(spoken.startMs)}</time> “{spoken.text}”
                </button>
              )}
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
  const updater = useUpdater();
  const [onboardingComplete, setOnboardingComplete] = useState(onboardingWasCompleted);
  const [onboardingOpen, setOnboardingOpen] = useState(() => !onboardingWasCompleted());
  const [screenCheck, setScreenCheck] = useState<ScreenCheck>("idle");
  const [testRecording, setTestRecording] = useState(false);
  const [quickMode, setQuickMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [sourceKind, setSourceKind] = useState<CaptureMode>("display");
  const [captureRegion, setCaptureRegion] = useState({ x: 10, y: 10, width: 80, height: 80 });
  const [selectedSourceKey, setSelectedSourceKey] = useState("");
  const [loadingSources, setLoadingSources] = useState(true);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startAtMs, setStartAtMs] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [pendingRecord, setPendingRecord] = useState<Extract<AutomationRequest, { action: "record" }> | null>(null);
  const [autoStart, setAutoStart] = useState<{ source: "display" | "window" } | null>(null);
  const [autoExport, setAutoExport] = useState<{ preset: string | null; id: number } | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [interrupted, setInterrupted] = useState<InterruptedRecording[]>([]);
  const [systemAudio, setSystemAudio] = useStoredBoolean(SYSTEM_AUDIO_KEY, true);
  const [microphoneOn, setMicrophoneOn] = useStoredBoolean(MICROPHONE_KEY, false);
  const [captureKeystrokes, setCaptureKeystrokes] = useStoredBoolean(KEYSTROKES_KEY, false);
  const [keysDenied, setKeysDenied] = useState(false);
  const [cameraOn, setCameraOn] = useStoredBoolean(CAMERA_KEY, false);
  const [echoCancellation, setEchoCancellation] = useStoredBoolean("screensway.echoCancellation", false);
  const [cameraDevice, setCameraDevice] = useStoredString(`${CAMERA_KEY}.device`, "default");
  const [cameras, setCameras] = useState<Camera[]>([]);
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
  const visibleSources = sources.filter((source) => source.kind === (sourceKind === "region" ? "display" : sourceKind));
  const selectedSource = sources.find((source) => `${source.kind}:${source.id}` === selectedSourceKey);
  const [transcripts, setTranscripts] = useState<Map<string, Transcript>>(new Map());
  const visibleLibrary = useMemo(
    () => library.flatMap((entry) => {
      const spoken = spokenMatch(transcripts.get(entry.projectPath), libraryQuery);
      return recordingMatches(entry, libraryQuery, language) || spoken ? [{ entry, spoken }] : [];
    }),
    [language, library, libraryQuery, transcripts],
  );
  const quickShortcut = useQuickRecordShortcut(() => {
    if (!onboardingComplete && !recording) {
      setOnboardingOpen(true);
      void invoke("show_main_window").catch(() => {});
      return;
    }
    setQuickMode(true);
    setResult(null);
    void invoke("show_main_window").catch(() => {});
  });

  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await invoke<LibraryEntry[]>("list_recordings"));
      const spoken = await invoke<Transcript[]>("list_transcripts").catch(() => []);
      setTranscripts(new Map(spoken.map((transcript) => [transcript.projectPath, transcript])));
    } catch {
      // The library is a convenience; recording still works without it.
    }
  }, []);

  useEffect(() => {
    const reload = () => void refreshLibrary();
    window.addEventListener(LIBRARY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(LIBRARY_CHANGED_EVENT, reload);
  }, [refreshLibrary]);

  const refreshHealth = useCallback(async () => {
    const [space, recoveries] = await Promise.allSettled([
      invoke<StorageStatus>("get_storage_status"),
      invoke<InterruptedRecording[]>("list_interrupted_recordings"),
    ]);
    if (space.status === "fulfilled") setStorage(space.value);
    if (recoveries.status === "fulfilled") setInterrupted(recoveries.value);
  }, []);

  const loadSources = useCallback(async (isCancelled: () => boolean = () => false) => {
    setLoadingSources(true);
    setError(null);
    setScreenCheck("checking");
    try {
      const availableSources = await invoke<CaptureSource[]>("list_capture_sources");
      if (isCancelled()) return;
      setSources(availableSources);
      // A region is drawn on a display.
      const wantedKind = sourceKind === "region" ? "display" : sourceKind;
      setSelectedSourceKey((current) => {
        if (availableSources.some((source) => `${source.kind}:${source.id}` === current && source.kind === wantedKind)) return current;
        const first = availableSources.find((source) => source.kind === wantedKind);
        return first ? `${first.kind}:${first.id}` : "";
      });
      setScreenCheck(availableSources.length > 0 ? "ready" : "error");
    } catch (sourceError) {
      if (!isCancelled()) {
        const message = String(sourceError);
        setError(message);
        setScreenCheck(message.includes(PERMISSION_DENIED_MARKER) ? "denied" : "error");
      }
    } finally {
      if (!isCancelled()) setLoadingSources(false);
    }
  }, [sourceKind]);

  useEffect(() => {
    let cancelled = false;
    if (onboardingComplete) void loadSources(() => cancelled);
    void refreshLibrary();
    void refreshHealth();
    return () => {
      cancelled = true;
    };
  }, [loadSources, onboardingComplete, refreshHealth, refreshLibrary]);

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
    if (!cameraOn) return;
    let cancelled = false;
    invoke<Camera[]>("list_cameras").then((available) => { if (!cancelled) setCameras(available); }).catch(() => {});
    return () => { cancelled = true; };
  }, [cameraOn]);

  useEffect(() => {
    if (result) previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [result]);

  useEffect(() => {
    // The document language is applied after this first effect, so pass it explicitly.
    track("app_open", {}, language);
    // Once per launch, not on every language change.
  }, []);

  // Recordings can be stopped from the floating controls or the menu bar, not only from here.
  useEffect(() => {
    const finished = listen<RecordingResult>("recording-finished", (event) => {
      setTestRecording(false);
      setStartAtMs(null);
      setAutoExport(null);
      setResult(event.payload);
      setJustSaved(true);
      setError(null);
      void refreshLibrary();
      track("recording_finished", { duration: durationBucket(event.payload.durationMs) });
      void refreshHealth();
    });
    const failed = listen<string>("recording-failed", (event) => {
      setTestRecording(false);
      setError(event.payload);
      track("recording_failed", { reason: failureReason(event.payload) });
    });
    return () => {
      void finished.then((dispose) => dispose());
      void failed.then((dispose) => dispose());
    };
  }, [refreshHealth, refreshLibrary]);

  useEffect(() => {
    const requested = listen("quick-record-requested", () => {
      if (!onboardingComplete && !recording) setOnboardingOpen(true);
      else {
        setQuickMode(true);
        setResult(null);
      }
    });
    return () => { void requested.then((dispose) => dispose()); };
  }, [onboardingComplete, recording]);

  // screensway:// links: each request is shown, and a recording only starts after the user agrees.
  useEffect(() => {
    const requested = listen<AutomationRequest>("automation-request", (event) => {
      const request = event.payload;
      if (request.action === "record") {
        if (!recording) setPendingRecord(request);
        return;
      }
      void (async () => {
        try {
          const projectPath = await invoke<string>("resolve_library_project", { name: request.project });
          setJustSaved(false);
          setStartAtMs(null);
          setAutoExport(request.action === "export" ? { preset: request.preset ?? null, id: Date.now() } : null);
          setResult(await invoke<RecordingResult>("load_recording", { projectPath }));
        } catch (automationError) {
          setError(String(automationError));
        }
      })();
    });
    return () => { void requested.then((dispose) => dispose()); };
  }, [recording]);

  useEffect(() => {
    if (!autoStart || recording || busy) return;
    if (selectedSource?.kind !== autoStart.source) return;
    setAutoStart(null);
    void startRecording();
    // startRecording reads the current choices, which autoStart has just applied.
  }, [autoStart, busy, recording, selectedSource]);

  useEffect(() => {
    if (!testRecording || recorder.status !== "recording") return;
    const timer = window.setTimeout(() => void invoke("stop_recording").catch((captureError) => setError(String(captureError))), 10_000);
    return () => window.clearTimeout(timer);
  }, [recorder.status, testRecording]);

  function completeOnboarding() {
    try {
      localStorage.setItem(ONBOARDING_KEY, "complete");
    } catch {
      // Completion still applies for this session.
    }
    setOnboardingComplete(true);
    setOnboardingOpen(false);
  }

  async function startRecording() {
    if (!selectedSource) return;
    const latestStorage = await invoke<StorageStatus>("get_storage_status").catch(() => storage);
    if (latestStorage) setStorage(latestStorage);
    if (latestStorage?.blocked) return;
    setBusy(true);
    setJustSaved(false);
    setError(null);

    try {
      await invoke("start_recording", {
        sourceKind: selectedSource.kind,
        sourceId: selectedSource.id,
        systemAudio: supportsAudio && systemAudio,
        microphone: supportsAudio && microphoneOn ? chosenMicrophone : null,
        region: sourceKind === "region" ? {
          x: captureRegion.x / 100,
          y: captureRegion.y / 100,
          width: captureRegion.width / 100,
          height: captureRegion.height / 100,
        } : null,
        captureKeystrokes,
        camera: cameraOn ? cameraDevice : null,
        echoCancellation: supportsAudio && microphoneOn && echoCancellation,
      });
      track("recording_started", {
        source: selectedSource.kind,
        system_audio: supportsAudio && systemAudio,
        microphone: supportsAudio && microphoneOn,
      });
    } catch (captureError) {
      if (String(captureError) !== CANCELLED_MESSAGE) {
        setError(String(captureError));
        track("recording_failed", { reason: failureReason(String(captureError)) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function startTestRecording() {
    const source = selectedSource ?? sources[0];
    if (!source) return;
    completeOnboarding();
    setTestRecording(true);
    setBusy(true);
    setJustSaved(false);
    setError(null);
    try {
      await invoke("start_recording", {
        sourceKind: source.kind,
        sourceId: source.id,
        systemAudio: false,
        microphone: null,
        region: null,
        captureKeystrokes: false,
        camera: null,
      });
    } catch (captureError) {
      setTestRecording(false);
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

  async function openRecording(entry: LibraryEntry, atMs?: number) {
    try {
      setJustSaved(false);
      setStartAtMs(atMs ?? null);
      setAutoExport(null);
      setResult(await invoke<RecordingResult>("load_recording", { projectPath: entry.projectPath }));
      track("recording_opened");
    } catch (libraryError) {
      setError(String(libraryError));
      void refreshLibrary();
    }
  }

  async function importRecording() {
    setImporting(true);
    try {
      const projectPath = await invoke<string | null>("import_recording");
      if (projectPath) {
        await refreshLibrary();
        setJustSaved(false);
        setStartAtMs(null);
        setAutoExport(null);
        setResult(await invoke<RecordingResult>("load_recording", { projectPath }));
      }
    } catch (importError) {
      setError(String(importError));
    } finally {
      setImporting(false);
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

  async function recoverInterrupted(item: InterruptedRecording) {
    try {
      await invoke("recover_recording", { projectPath: item.projectPath });
      await Promise.all([refreshHealth(), refreshLibrary()]);
    } catch (recoveryError) {
      setError(String(recoveryError));
    }
  }

  async function discardInterrupted(item: InterruptedRecording) {
    if (!window.confirm(t("recovery.discardConfirm", { name: item.name }))) return;
    try {
      await invoke("delete_recording", { projectPath: item.projectPath });
      await refreshHealth();
    } catch (recoveryError) {
      setError(String(recoveryError));
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
  const updateRegion = (key: "x" | "y" | "width" | "height", value: number) => {
    setCaptureRegion((current) => {
      const next = { ...current, [key]: Math.round(value) };
      next.width = Math.max(5, Math.min(next.width, 100 - next.x));
      next.height = Math.max(5, Math.min(next.height, 100 - next.y));
      next.x = Math.max(0, Math.min(next.x, 100 - next.width));
      next.y = Math.max(0, Math.min(next.y, 100 - next.height));
      return next;
    });
  };

  return (
    <main className={`app-shell${quickMode ? " quick-mode" : ""}`}>
      <header className="titlebar" data-tauri-drag-region>
        <a className="brand" href="#" aria-label={t("app.home")}>
          <LogoMark size={30} />
          <span>ScreenSway</span>
        </a>
        <div className="titlebar-actions">
          <HeaderUpdateButton updater={updater} />
          <SettingsMenu
            updater={updater}
            onOpenSetup={() => setOnboardingOpen(true)}
            quickShortcut={quickShortcut.shortcut}
            onQuickShortcutChange={quickShortcut.setShortcut}
            shortcutError={quickShortcut.error}
          />
        </div>
      </header>
      <TelemetryPrompt />

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
            <button className="icon-button small" aria-label={t("source.refresh")} title={t("source.refresh")} disabled={recording || busy || loadingSources} onClick={() => void loadSources()}>
              <RotateCw size={15} aria-hidden="true" />
            </button>
            {quickMode && <button className="quick-close" onClick={() => setQuickMode(false)}><X size={14} /> {t("quick.close")}</button>}
            <div className="segmented" role="tablist" aria-label={t("source.label")}>
              {(["display", "window", "region"] as const).map((kind) => (
                <button
                  key={kind}
                  role="tab"
                  aria-selected={sourceKind === kind}
                  className={sourceKind === kind ? "selected" : ""}
                  disabled={recording}
                  onClick={() => {
                    setSourceKind(kind);
                    const wantedKind = kind === "region" ? "display" : kind;
                    const first = sources.find((source) => source.kind === wantedKind);
                    if (selectedSource?.kind !== wantedKind && first) setSelectedSourceKey(`${first.kind}:${first.id}`);
                  }}
                >
                  {kind === "display" ? <Monitor size={15} aria-hidden="true" /> : kind === "window" ? <AppWindow size={15} aria-hidden="true" /> : <Crop size={15} aria-hidden="true" />}
                  {kind === "display" ? t("source.screens") : kind === "window" ? t("source.windows") : t("source.region")}
                </button>
              ))}
            </div>
          </div>

          {sourceKind === "region" && selectedSource && !recording && (
            <div className="region-editor">
              <div className="region-preview" style={{ aspectRatio: `${selectedSource.width} / ${selectedSource.height}` }}>
                <span style={{ left: `${captureRegion.x}%`, top: `${captureRegion.y}%`, width: `${captureRegion.width}%`, height: `${captureRegion.height}%` }} />
              </div>
              <div className="region-fields">
                {(["x", "y", "width", "height"] as const).map((key) => (
                  <label key={key}><span>{t(`source.region.${key}` as MessageKey)}</span><input type="number" min={key === "width" || key === "height" ? 5 : 0} max={100} value={captureRegion[key]} onChange={(event) => updateRegion(key, Number(event.target.value))} /><small>%</small></label>
                ))}
              </div>
              <small>{t("source.regionHint")}</small>
            </div>
          )}

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
                  <label className="mic-echo">
                    <input type="checkbox" checked={echoCancellation} disabled={recording} onChange={(event) => setEchoCancellation(event.target.checked)} />
                    <span>{t("mic.echo")}<small>{t("mic.echoHint")}</small></span>
                  </label>
                  {systemAudio && !echoCancellation && <small className="mic-tip">{t("mic.headphones")}</small>}
                </div>
              )}
            </>
          )}

          <label className={`audio-toggle${recording ? " disabled" : ""}`}>
            <span className="audio-icon" aria-hidden="true">{cameraOn ? <Video size={17} /> : <VideoOff size={17} />}</span>
            <span className="audio-text"><strong>{t("camera.label")}</strong><small>{t("camera.hint")}</small></span>
            <input type="checkbox" role="switch" checked={cameraOn} disabled={recording} onChange={(event) => setCameraOn(event.target.checked)} />
            <span className="switch" aria-hidden="true" />
          </label>
          {cameraOn && (
            <div className="mic-options">
              <select className="mic-select" aria-label={t("camera.device")} value={cameras.some((camera) => camera.id === cameraDevice) ? cameraDevice : "default"} disabled={recording} onChange={(event) => setCameraDevice(event.target.value)}>
                <option value="default">{t("camera.systemDefault")}</option>
                {cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.name}</option>)}
              </select>
            </div>
          )}

          <label className={`audio-toggle${recording ? " disabled" : ""}`}>
            <span className="audio-icon" aria-hidden="true"><Keyboard size={17} /></span>
            <span className="audio-text"><strong>{t("keys.capture")}</strong><small>{t("keys.captureHint")}</small></span>
            <input
              type="checkbox"
              role="switch"
              checked={captureKeystrokes}
              disabled={recording}
              onChange={(event) => {
                const on = event.target.checked;
                setCaptureKeystrokes(on);
                setKeysDenied(false);
                // macOS asks for Input Monitoring the first time; without it nothing is recorded.
                if (on) void invoke<boolean>("keystroke_access").then((granted) => setKeysDenied(!granted)).catch(() => {});
              }}
            />
            <span className="switch" aria-hidden="true" />
          </label>
          {captureKeystrokes && keysDenied && !recording && (
            <div className="storage-warning" role="status">
              <Keyboard size={17} aria-hidden="true" />
              <span><strong>{t("keys.denied")}</strong><small>{t("keys.deniedHint")}</small></span>
              <button className="secondary-button compact" onClick={() => void invoke("open_keystroke_settings").catch(() => {})}>{t("keys.openSettings")}</button>
            </div>
          )}

          {storage?.warning && !recording && (
            <div className={`storage-warning${storage.blocked ? " blocked" : ""}`} role={storage.blocked ? "alert" : "status"}>
              <HardDrive size={17} aria-hidden="true" />
              <span><strong>{t(storage.blocked ? "storage.blocked" : "storage.low")}</strong><small>{t("storage.available", { size: (storage.availableBytes / 1024 ** 3).toFixed(1) })}</small></span>
            </div>
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
                {!isWindows && (
                  <button className="secondary-button compact" onClick={() => void resetScreenPermission()}>
                    {t("permission.reset")}
                  </button>
                )}
                <button className="secondary-button compact" onClick={() => void loadSources()}>
                  <RotateCw size={14} aria-hidden="true" /> {t("permission.retry")}
                </button>
              </div>
            </div>
          )}
          {pendingRecord && !recording && (
            <div className="permission-card automation-card" role="alertdialog" aria-label={t("automation.title")}>
              <span className="permission-icon" aria-hidden="true"><Link2 size={20} /></span>
              <strong>{t("automation.title")}</strong>
              <p>{t(pendingRecord.source === "window" ? "automation.recordWindow" : "automation.recordDisplay")} {pendingRecord.systemAudio || pendingRecord.microphone ? t("automation.withSound") : ""}</p>
              <div className="permission-actions">
                <button
                  className="permission-primary"
                  onClick={() => {
                    setSourceKind(pendingRecord.source);
                    if (supportsAudio) {
                      setSystemAudio(pendingRecord.systemAudio);
                      setMicrophoneOn(pendingRecord.microphone);
                    }
                    setAutoStart({ source: pendingRecord.source });
                    setPendingRecord(null);
                  }}
                >
                  {t("automation.start")}
                </button>
                <button className="secondary-button compact" onClick={() => setPendingRecord(null)}>{t("automation.cancel")}</button>
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
          {error?.includes(CAMERA_DENIED_MARKER) && (
            <div className="permission-card" role="alert">
              <span className="permission-icon" aria-hidden="true"><VideoOff size={20} /></span>
              <strong>{t("cameraPermission.title")}</strong>
              <p>{t(isWindows ? "cameraPermission.windowsBody" : "cameraPermission.body")}</p>
              <div className="permission-actions">
                <button className="permission-primary" onClick={() => void invoke("open_camera_settings").catch(() => {})}>
                  {t("permission.open")}
                </button>
                <button className="secondary-button compact" onClick={() => { setCameraOn(false); setError(null); }}>
                  {t("cameraPermission.withoutCamera")}
                </button>
              </div>
            </div>
          )}
          {error && ![PERMISSION_DENIED_MARKER, MICROPHONE_DENIED_MARKER, CAMERA_DENIED_MARKER].some((marker) => error.includes(marker)) && (
            <div className="capture-message error" role="alert">
              <AlertCircle size={18} aria-hidden="true" />
              <span><strong>{t("record.failed")}</strong><small>{error}</small></span>
            </div>
          )}
        </div>
      </section>

      {onboardingOpen && (
        <Onboarding
          screenCheck={screenCheck}
          sourceCount={sources.length}
          onCheckScreen={() => void loadSources()}
          onOpenScreenSettings={() => void invoke("open_screen_recording_settings").catch(() => {})}
          onResetScreenPermission={isWindows ? undefined : () => void resetScreenPermission()}
          onComplete={completeOnboarding}
          onTestRecording={() => void startTestRecording()}
          canClose={onboardingComplete}
        />
      )}

      {interrupted.length > 0 && !quickMode && (
        <section className="recovery-section" aria-labelledby="recovery-title">
          <div className="recovery-heading"><Wrench size={18} aria-hidden="true" /><div><strong id="recovery-title">{t("recovery.title")}</strong><small>{t("recovery.body")}</small></div></div>
          <div className="recovery-list">
            {interrupted.map((item) => (
              <div key={item.projectPath} className="recovery-item">
                <span>{item.name}</span>
                <div>
                  {item.recoverable && <button className="editor-button accent" onClick={() => void recoverInterrupted(item)}>{t("recovery.recover")}</button>}
                  <button className="editor-button" onClick={() => void discardInterrupted(item)}>{t("recovery.discard")}</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

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
          <RecordingStudio recording={result} key={result.videoPath} startAtMs={startAtMs} autoExport={autoExport} onAutoExportStarted={() => setAutoExport(null)} />
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
          <button className="secondary-button compact" onClick={() => void importRecording()} disabled={importing}>
            {importing ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <FilePlus2 size={14} aria-hidden="true" />} {t("library.import")}
          </button>
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
            {visibleLibrary.map(({ entry, spoken }) => (
              <LibraryCard
                key={entry.projectPath}
                entry={entry}
                spoken={spoken}
                onOpenSpoken={() => spoken && void openRecording(entry, spoken.startMs)}
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
