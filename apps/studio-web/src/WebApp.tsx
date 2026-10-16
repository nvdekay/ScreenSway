import { generateZoomSegments } from "@screensway/core";
import { AlertCircle, ArrowRight, Check, Download, Languages, Lock, Mic, MicOff, MonitorUp, MousePointer2, Square, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LogoMark } from "../../desktop/src/LogoMark";
import { RecordingStudio } from "../../desktop/src/frame/RecordingStudio";
import { formatDuration } from "../../desktop/src/format";
import { useI18n } from "../../desktop/src/i18n";
import type { RecordingResult } from "../../desktop/src/ZoomPreview";
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
function LandingLink({ className, label, children }: { className?: string; label?: string; children: ReactNode }) {
  return (
    <a className={className} href={LANDING_URL} aria-label={label}>
      {children}
    </a>
  );
}

function LanguageSwitch() {
  const { language, setLanguage, t } = useI18n();
  const next = language === "vi" ? "en" : "vi";
  return (
    <button className="web-language" aria-label={t("settings.language")} onClick={() => setLanguage(next)}>
      <Languages size={15} aria-hidden="true" />
      {next === "vi" ? "VI" : "EN"}
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
      else if (startError instanceof StorageUnavailableError) setError(t("web.noStorage"));
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
      const prepared = await prepare(session.id, captured).catch((prepareError) => {
        void captured.discard();
        throw prepareError;
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
  const elapsed = formatDuration(Math.max(0, now - startedAt));

  return (
    <main className="web-shell">
      <header className="web-header">
        <a className="web-brand" href="./" aria-label={t("app.home")}>
          <LogoMark size={30} />
          <span>ScreenSway</span>
          <small>Web</small>
        </a>
        <nav aria-label={t("web.headerNav")}>
          <LandingLink label={t("web.desktopApp")}>
            <Download size={15} aria-hidden="true" />
            <span>{t("web.desktopApp")}</span>
          </LandingLink>
          <LanguageSwitch />
        </nav>
      </header>

      {unsupported ? (
        <section className="unsupported-screen">
          <div className="unsupported-card" role="alert">
            <LogoMark size={42} />
            <span className="web-kicker">ScreenSway Web · Beta</span>
            <h1>{t("web.unsupportedTitle")}</h1>
            <p>{t("web.unsupportedBody")}</p>
            <LandingLink>
              {t("web.unsupportedDownload")}
              <ArrowRight size={16} aria-hidden="true" />
            </LandingLink>
          </div>
        </section>
      ) : (
        <>
          <section className="web-hero">
            <div className="web-promise">
              <span className="web-kicker">ScreenSway Web · Beta</span>
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
                      <div>
                        <span>{t("web.recorderKicker")}</span>
                        <h2>{t("web.recorderTitle")}</h2>
                      </div>
                      <MonitorUp size={24} aria-hidden="true" />
                    </div>
                    <div className="web-audio-options">
                      <label>
                        <span>
                          {systemAudio ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}
                          <b>{t("audio.label")}</b>
                          <small>{t("web.audioHint")}</small>
                        </span>
                        <input type="checkbox" role="switch" checked={systemAudio} disabled={status === "starting"} onChange={(event) => setSystemAudio(event.target.checked)} />
                        <i aria-hidden="true" />
                      </label>
                      <label>
                        <span>
                          {microphone ? <Mic aria-hidden="true" /> : <MicOff aria-hidden="true" />}
                          <b>{t("mic.label")}</b>
                          <small>{t("mic.hint")}</small>
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

            <ol className="web-steps">
              {(["1", "2", "3"] as const).map((step) => (
                <li key={step}>
                  <b>{step}</b>
                  <span>
                    <strong>{t(`web.step${step}`)}</strong>
                    <small>{t(`web.step${step}Copy`)}</small>
                  </span>
                </li>
              ))}
            </ol>

            <div className="web-compare">
              <div>
                <span>{t("web.browserIncludes")}</span>
                <ul>
                  <li><Check aria-hidden="true" />{t("web.includeZoom")}</li>
                  <li><Check aria-hidden="true" />{t("web.includeStudio")}</li>
                  <li><Check aria-hidden="true" />{t("web.includeExport")}</li>
                </ul>
              </div>
              <div>
                <span>{t("web.desktopAdds")}</span>
                <p>{t("web.desktopLimits")}</p>
                <LandingLink>
                  {t("web.viewDesktop")}
                  <ArrowRight aria-hidden="true" />
                </LandingLink>
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
    </main>
  );
}
