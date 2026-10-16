import { generateZoomSegments } from "@screensway/core";
import { AlertCircle, Download, Languages, Lock, Mic, MicOff, MousePointer2, Square, Volume2, VolumeX, X, ZoomIn } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { LogoMark } from "../../desktop/src/LogoMark";
import { RecordingStudio } from "../../desktop/src/frame/RecordingStudio";
import { formatDuration } from "../../desktop/src/format";
import { useI18n } from "../../desktop/src/i18n";
import type { RecordingResult } from "../../desktop/src/ZoomPreview";
import { EXPORT_SAVED, removeRecording } from "./backend";
import { MicrophoneBlockedError, ScreenRecording, ShareCancelledError, StorageFullError, unsupportedReason } from "./recorder";
import { listen } from "./tauri/event";

type Status = "idle" | "starting" | "recording" | "finishing";

function LanguageSwitch() {
  const { language, setLanguage, t } = useI18n();
  const next = language === "vi" ? "en" : "vi";
  return (
    <button className="secondary-button compact" aria-label={t("settings.language")} onClick={() => setLanguage(next)}>
      <Languages size={15} aria-hidden="true" /> {next === "vi" ? "Tiếng Việt" : "English"}
    </button>
  );
}

export function WebApp() {
  const { t } = useI18n();
  const unsupported = useMemo(unsupportedReason, []);
  const [systemAudio, setSystemAudio] = useState(true);
  const [microphone, setMicrophone] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecordingResult | null>(null);
  // Whether the open recording has been exported since it was made, so leaving loses nothing.
  const [exported, setExported] = useState(false);
  const recordingRef = useRef<ScreenRecording | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  const recording = status === "recording" || status === "finishing";

  useEffect(() => {
    if (status !== "recording") return;
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    const unlisten = listen<string>(EXPORT_SAVED, () => setExported(true));
    return () => void unlisten.then((dispose) => dispose());
  }, []);

  // A recording only exists in this tab, so leaving it asks first, unless it was exported.
  useEffect(() => {
    if (!recording && (!result || exported)) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = t("web.leave");
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [exported, recording, result, t]);

  useEffect(() => {
    if (result) previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [result]);

  async function start() {
    setError(null);
    setStatus("starting");
    const session = new ScreenRecording();
    recordingRef.current = session;
    try {
      await session.start({ systemAudio, microphone }, () => void stop());
      setStartedAt(performance.now());
      setNow(performance.now());
      setStatus("recording");
    } catch (startError) {
      // start() already releases the screen and microphone; this is a second guard.
      session.cancel();
      recordingRef.current = null;
      setStatus("idle");
      if (startError instanceof ShareCancelledError) setError(t("web.shareDenied"));
      else if (startError instanceof MicrophoneBlockedError) setError(t("web.micDenied"));
      else setError(t("web.failed", { message: startError instanceof Error ? startError.message : String(startError) }));
    }
  }

  async function stop() {
    const session = recordingRef.current;
    if (!session) return;
    recordingRef.current = null;
    setStatus("finishing");
    try {
      const captured = await session.stop();
      const { prepare } = await import("./prepare");
      const prepared = await prepare(session.id, captured).catch((error) => {
        captured.discard();
        throw error;
      });
      setExported(false);
      setResult((previous) => {
        if (previous) removeRecording(previous.projectPath);
        return prepared;
      });
    } catch (stopError) {
      if (stopError instanceof StorageFullError) setError(t("web.diskFull"));
      else setError(t("web.failed", { message: stopError instanceof Error ? stopError.message : String(stopError) }));
    } finally {
      setStatus("idle");
    }
  }

  const zoomCount = useMemo(() => (result ? generateZoomSegments(result.pointerEvents).length : 0), [result]);
  const statusLabel = {
    idle: t("status.idle"),
    starting: t("status.idle"),
    recording: t("status.recording", { time: formatDuration(now - startedAt) }),
    finishing: t("web.preparing"),
  }[status];

  return (
    <main className="app-shell">
      <header className="titlebar">
        <a className="brand" href="./" aria-label={t("app.home")}>
          <LogoMark size={30} />
          <span>ScreenSway</span>
        </a>
        <div className="titlebar-actions">
          <a className="secondary-button compact" href="../" aria-label={t("web.desktopApp")}>
            <Download size={15} aria-hidden="true" /> <span className="header-label">{t("web.desktopApp")}</span>
          </a>
          <LanguageSwitch />
        </div>
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

        {unsupported ? (
          <div className="recorder glass reveal">
            <div className="permission-card" role="alert">
              <span className="permission-icon" aria-hidden="true"><AlertCircle size={20} /></span>
              <strong>{t("web.unsupportedTitle")}</strong>
              <p>{t("web.unsupportedBody")}</p>
              <div className="permission-actions">
                <a className="permission-primary" href="../">{t("web.unsupportedDownload")}</a>
              </div>
            </div>
          </div>
        ) : (
          <div className={`recorder glass reveal${recording ? " is-recording" : ""}`}>
            <label className={`audio-toggle${recording ? " disabled" : ""}`}>
              <span className="audio-icon" aria-hidden="true">{systemAudio ? <Volume2 size={17} /> : <VolumeX size={17} />}</span>
              <span className="audio-text">
                <strong>{t("audio.label")}</strong>
                <small>{t("web.audioHint")}</small>
              </span>
              <input type="checkbox" role="switch" checked={systemAudio} disabled={recording || status === "starting"} onChange={(event) => setSystemAudio(event.target.checked)} />
              <span className="switch" aria-hidden="true" />
            </label>
            <label className={`audio-toggle${recording ? " disabled" : ""}`}>
              <span className="audio-icon" aria-hidden="true">{microphone ? <Mic size={17} /> : <MicOff size={17} />}</span>
              <span className="audio-text">
                <strong>{t("mic.label")}</strong>
                <small>{t("mic.hint")}</small>
              </span>
              <input type="checkbox" role="switch" checked={microphone} disabled={recording || status === "starting"} onChange={(event) => setMicrophone(event.target.checked)} />
              <span className="switch" aria-hidden="true" />
            </label>

            <div className="recorder-status" aria-live="polite">
              <span className={`status-dot ${status === "starting" ? "idle" : status}`} aria-hidden="true" />
              <span>{statusLabel}</span>
            </div>

            <div className={`record-controls${recording ? " active" : ""}`}>
              <button
                className={`record-button${recording ? " stop" : ""}`}
                onClick={recording ? () => void stop() : () => void start()}
                disabled={status === "starting" || status === "finishing"}
              >
                {recording ? <Square size={12} fill="currentColor" aria-hidden="true" /> : <span className="record-dot" aria-hidden="true" />}
                {recording ? (status === "finishing" ? t("action.saving") : t("action.stop")) : t("action.start")}
              </button>
            </div>

            {!error && <p className="record-hint">{t(recording ? "web.stopHint" : "record.hint")}</p>}
            {error && (
              <div className="capture-message error" role="alert">
                <AlertCircle size={18} aria-hidden="true" />
                <span><small>{error}</small></span>
              </div>
            )}
          </div>
        )}
      </section>

      {result && (
        <section className="preview-section reveal" ref={previewRef}>
          <div className="section-heading">
            <div>
              <h2>{t("preview.title")}</h2>
              <span>
                {t(zoomCount === 1 ? "preview.zoomsOne" : "preview.zooms", { count: zoomCount, time: formatDuration(result.durationMs) })}
                {" · "}
                {t("web.keepTab")}
              </span>
            </div>
            <button
              className="icon-button"
              aria-label={t("preview.close")}
              onClick={() => {
                removeRecording(result.projectPath);
                setResult(null);
              }}
            >
              <X size={18} />
            </button>
          </div>
          <RecordingStudio recording={result} key={result.videoPath} />
        </section>
      )}
    </main>
  );
}
