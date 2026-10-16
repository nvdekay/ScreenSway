import { generateZoomSegments } from "@screensway/core";
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { AlertCircle, Download, Languages, Lock, Mic, MicOff, MousePointer2, Square, Volume2, VolumeX, X, ZoomIn } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { LogoMark } from "../../desktop/src/LogoMark";
import { RecordingStudio } from "../../desktop/src/frame/RecordingStudio";
import { formatDuration } from "../../desktop/src/format";
import { useI18n } from "../../desktop/src/i18n";
import type { RecordingResult } from "../../desktop/src/ZoomPreview";
import { addRecording, removeRecording } from "./backend";
import { MOTION_HEIGHT, MOTION_WIDTH, motionBetween, timelineMatch, type MotionSample } from "./pointer/align";
import { pointerEvents } from "./pointer/focus";
import { MicrophoneBlockedError, ScreenRecording, ShareCancelledError, unsupportedReason, type CapturedRecording } from "./recorder";

type Status = "idle" | "starting" | "recording" | "finishing";

/** Seconds of the recording compared to line up the pointer's clock. */
const ALIGN_SECONDS = 20;

/** Size, length and a still of the recording, read from the file the browser wrote. */
async function prepare(captured: CapturedRecording): Promise<RecordingResult> {
  const input = new Input({ source: new BlobSource(captured.blob), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error("The recording has no video.");
  const width = video.displayWidth;
  const height = video.displayHeight;
  const durationMs = (await video.computeDuration()) * 1_000;

  let thumbnail: string | null = null;
  try {
    const still = await new CanvasSink(video, { width: 640, height: Math.round((640 * height) / width) }).getCanvas(Math.min(0.5, durationMs / 2_000));
    if (still) {
      const canvas = still.canvas;
      const blob = canvas instanceof OffscreenCanvas ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 }) : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
      if (blob) thumbnail = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    }
  } catch {
    // The magic background falls back to the default without a still.
  }

  // Line the pointer up with the recording, using the first seconds of screen motion.
  let offsetMs = 0;
  try {
    const recorded: MotionSample[] = [];
    let previous: Uint8ClampedArray | null = null;
    const sink = new CanvasSink(video, { width: MOTION_WIDTH, height: MOTION_HEIGHT, fit: "fill" });
    for await (const { canvas, timestamp } of sink.canvases(0, ALIGN_SECONDS)) {
      const context = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!context) break;
      const pixels = context.getImageData(0, 0, MOTION_WIDTH, MOTION_HEIGHT).data;
      if (previous) recorded.push({ timeMs: timestamp * 1_000, motion: motionBetween(previous, pixels) });
      previous = pixels;
    }
    const match = timelineMatch(recorded, captured.motion.filter((sample) => sample.timeMs <= ALIGN_SECONDS * 1_000 + 2_000));
    console.debug(`ScreenSway: pointer timeline offset ${match?.offset} ms (agreement ${match?.score.toFixed(2)}, ${recorded.length}/${captured.motion.length} frames)`);
    if (match && match.score >= 0.5) offsetMs = match.offset;
  } catch {
    // Without alignment the pointer is at most a fraction of a second off.
  }
  const samples = captured.samples.map((sample) => ({ ...sample, timeMs: sample.timeMs + offsetMs }));

  const id = `recording-${Date.now()}`;
  const url = URL.createObjectURL(captured.blob);
  addRecording({ id, blob: captured.blob, url, thumbnail });
  return {
    projectPath: id,
    videoPath: url,
    pointerEventsPath: "",
    durationMs,
    width,
    height,
    pointerEvents: pointerEvents(samples, width),
  };
}

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
  const recordingRef = useRef<ScreenRecording | null>(null);
  const previewRef = useRef<HTMLElement>(null);
  const recording = status === "recording" || status === "finishing";

  useEffect(() => {
    if (status !== "recording") return;
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, [status]);

  // A recording only exists in this tab, so leaving it asks first.
  useEffect(() => {
    if (!result && !recording) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = t("web.leave");
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recording, result, t]);

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
      const prepared = await prepare(await session.stop());
      setResult((previous) => {
        if (previous) removeRecording(previous.projectPath);
        return prepared;
      });
    } catch (stopError) {
      setError(t("web.failed", { message: stopError instanceof Error ? stopError.message : String(stopError) }));
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
