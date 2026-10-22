import { generateZoomSegments } from "@screensway/core";
import { AlertCircle, ArrowRight, Download, Lock, MessageSquare, Mic, MicOff, MonitorUp, MousePointer2, Square, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LanguageToggle } from "../../desktop/src/LanguageToggle";
import { FeedbackDialog } from "../../desktop/src/FeedbackDialog";
import { LogoMark } from "../../desktop/src/LogoMark";
import { RecordingStudio } from "../../desktop/src/frame/RecordingStudio";
import { formatDuration } from "../../desktop/src/format";
import { useI18n } from "../../desktop/src/i18n";
import type { RecordingResult } from "../../desktop/src/ZoomPreview";
import { durationBucket, track, trackOpen } from "./analytics";
import { forgetOldVisitorId } from "./identity";
import { EXPORT_SAVED, removeRecording } from "./backend";
import { MicrophoneBlockedError, ScreenRecording, ShareCancelledError, StorageFullError, StorageUnavailableError, unsupportedReason } from "./recorder";
import { ResultPreview } from "./ResultPreview";
import { listen } from "./tauri/event";

type Status = "idle" | "starting" | "recording" | "finishing";

/** The landing page with the desktop downloads: the app is served in its app/ folder. */
const LANDING_URL = "../";

/**
 * Links to the landing page stay in this tab, with the page transition both pages declare.
 * An unexported recording still asks before leaving (see the beforeunload effect).
 */
function LandingLink({ className, label, placement, children }: { className?: string; label?: string; placement: "header" | "unsupported"; children: ReactNode }) {
  return (
    <a className={className} href={LANDING_URL} aria-label={label} onClick={() => track("desktop_click", { placement })}>
      {children}
    </a>
  );
}

/** The landing page's language control: both languages side by side, the current one lit. */
function LanguageSwitch() {
  const { language, setLanguage, t } = useI18n();
  return <LanguageToggle language={language} onChange={setLanguage} label={t("web.language")} />;
}

/** A short label for a failed start, for the anonymous statistics (never the message itself). */
function startFailure(error: unknown): string {
  if (error instanceof ShareCancelledError) return "share_denied";
  if (error instanceof MicrophoneBlockedError) return "mic_denied";
  if (error instanceof StorageUnavailableError) return "no_storage";
  return "start_failed";
}

export function WebApp() {
  const { t, language } = useI18n();
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
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const recordingRef = useRef<ScreenRecording | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  const recording = status === "recording" || status === "finishing";

  useEffect(() => trackOpen(unsupported, language), [unsupported, language]);
  useEffect(forgetOldVisitorId, []);

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
      track("recording_started", { source: session.surface, system_audio: systemAudio, shared_audio: session.sharedAudio, microphone });
    } catch (startError) {
      // start() already releases the screen and microphone; this is a second guard.
      session.cancel();
      recordingRef.current = null;
      setStatus("idle");
      if (startError instanceof ShareCancelledError) setError(t("web.shareDenied"));
      else if (startError instanceof MicrophoneBlockedError) setError(t("web.micDenied"));
      else if (startError instanceof StorageUnavailableError) setError(t("web.noStorage"));
      else setError(t("web.failed", { message: startError instanceof Error ? startError.message : String(startError) }));
      track("recording_failed", { reason: startFailure(startError) });
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
      const prepared = await prepare(session.id, captured).catch((prepareError) => {
        void captured.discard();
        throw prepareError;
      });
      setExported(false);
      track("recording_finished", { duration: durationBucket(prepared.durationMs), format: session.format });
      setResult((previous) => {
        if (previous) removeRecording(previous.projectPath);
        return prepared;
      });
    } catch (stopError) {
      if (stopError instanceof StorageFullError) setError(t("web.diskFull"));
      else setError(t("web.failed", { message: stopError instanceof Error ? stopError.message : String(stopError) }));
      track("recording_failed", { reason: stopError instanceof StorageFullError ? "disk_full" : "finish_failed" });
    } finally {
      setStatus("idle");
    }
  }

  const zoomCount = useMemo(() => (result ? generateZoomSegments(result.pointerEvents).length : 0), [result]);
  const elapsed = formatDuration(Math.max(0, now - startedAt));

  return (
    <main className="web-shell">
      <header className="web-header">
        <a className="web-brand" href="./" aria-label={t("app.home")}>
          <LogoMark size={30} tone="flat" />
          <span>ScreenSway</span>
          <small>Web</small>
        </a>
        <nav aria-label={t("web.headerNav")}>
          <LanguageSwitch />
          <button className="web-feedback" aria-label={t("feedback.open")} onClick={() => setFeedbackOpen(true)}>
            <MessageSquare size={15} aria-hidden="true" />
            <span>{t("feedback.open")}</span>
          </button>
          <LandingLink label={t("web.desktopApp")} placement="header">
            <Download size={15} aria-hidden="true" />
            <span>{t("web.desktopApp")}</span>
          </LandingLink>
        </nav>
      </header>

      {unsupported ? (
        <section className="unsupported-screen">
          <div className="unsupported-card" role="alert">
            <LogoMark size={42} tone="flat" />
            <span className="web-kicker">ScreenSway Web · Beta</span>
            <h1>{t("web.unsupportedTitle")}</h1>
            <p>{t("web.unsupportedBody")}</p>
            <LandingLink placement="unsupported">
              {t("web.unsupportedDownload")}
              <ArrowRight size={16} aria-hidden="true" />
            </LandingLink>
          </div>
        </section>
      ) : (
        <>
          <section className="web-hero">
            <div className="web-promise">
              <h1>{t("web.heroTitle")}</h1>
              <p>{t("web.heroCopy")}</p>
              <div className="web-proof">
                <span><MousePointer2 size={15} aria-hidden="true" />{t("web.proofZoom")}</span>
                <span><Lock size={15} aria-hidden="true" />{t("web.proofPrivate")}</span>
              </div>
            </div>

            {/* Try it right away: the recorder sits under the sample, on the first screen. */}
            <div className="web-try">
              <ResultPreview />

              <div className={`web-recorder${recording ? " is-live" : ""}`}>
                {status === "recording" ? (
                  <div className="live-panel" aria-live="polite">
                    <span className="live-dot" aria-hidden="true" />
                    <div>
                      <small>{t("web.liveLabel")}</small>
                      <strong>{elapsed}</strong>
                    </div>
                    <button onClick={() => void stop()}>
                      <Square size={13} fill="currentColor" aria-hidden="true" />
                      {t("action.stop")}
                    </button>
                    <p>{t("web.stopHint")}</p>
                  </div>
                ) : status === "finishing" ? (
                  <div className="preparing-panel" role="status">
                    <span className="preparing-spinner" aria-hidden="true" />
                    <div>
                      <strong>{t("web.preparing")}</strong>
                      <small>{t("web.preparingHint")}</small>
                    </div>
                    <i aria-hidden="true"><span /></i>
                  </div>
                ) : (
                  <>
                    <div className="recorder-heading">
                      <h2>{t("web.recorderTitle")}</h2>
                      <MonitorUp size={20} aria-hidden="true" />
                    </div>
                    <div className="web-audio-options">
                      <label title={t("web.audioHint")}>
                        <span>
                          {systemAudio ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}
                          <b>{t("audio.label")}</b>
                          <small className="sr-only">{t("web.audioHint")}</small>
                        </span>
                        <input type="checkbox" role="switch" checked={systemAudio} disabled={status === "starting"} onChange={(event) => setSystemAudio(event.target.checked)} />
                        <i aria-hidden="true" />
                      </label>
                      <label title={t("mic.hint")}>
                        <span>
                          {microphone ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}
                          <b>{t("mic.label")}</b>
                          <small className="sr-only">{t("mic.hint")}</small>
                        </span>
                        <input type="checkbox" role="switch" checked={microphone} disabled={status === "starting"} onChange={(event) => setMicrophone(event.target.checked)} />
                        <i aria-hidden="true" />
                      </label>
                    </div>
                    <button className="web-start" onClick={() => void start()} disabled={status === "starting"}>
                      <span className="record-dot" aria-hidden="true" />
                      {status === "starting" ? t("web.openingPicker") : t("action.start")}
                      <ArrowRight size={18} aria-hidden="true" />
                    </button>
                    {error && (
                      <div className="capture-message error web-error" role="alert">
                        <AlertCircle size={18} aria-hidden="true" />
                        <span>{error}</span>
                      </div>
                    )}
                    <p className="requirements"><Lock size={13} aria-hidden="true" />{t("web.requirements")}</p>
                  </>
                )}
              </div>
            </div>
          </section>

          {result && (
            <section className="preview-section web-studio-section" ref={previewRef}>
              <div className="web-studio-heading">
                <div>
                  <span className="web-kicker">ScreenSway Studio</span>
                  <h2>{t("preview.title")}</h2>
                  <p>{t(zoomCount === 1 ? "preview.zoomsOne" : "preview.zooms", { count: zoomCount, time: formatDuration(result.durationMs) })}</p>
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
              <div className="tab-callout">
                <Lock size={16} aria-hidden="true" />
                <span><strong>{t("web.tabNoticeTitle")}</strong>{t("web.keepTab")}</span>
              </div>
              <div className="web-studio-surface">
                <RecordingStudio recording={result} key={result.videoPath} />
              </div>
            </section>
          )}
        </>
      )}

      {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}
    </main>
  );
}
