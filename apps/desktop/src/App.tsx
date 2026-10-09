import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { generateZoomSegments } from "@screensway/core";
import { AlertCircle, CheckCircle2, ChevronDown, Monitor, MousePointer2, Pause, Play, Settings2, Sparkles, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatDuration } from "./format";
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

const recentRecordings = [
  { title: "Product walkthrough", detail: "Draft · 2m 14s", color: "violet" },
  { title: "Welcome to ScreenSway", detail: "Draft · 38s", color: "blue" },
];

export default function App() {
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

  const statusLabel = {
    idle: "Ready to record",
    countdown: `Starting in ${recorder.countdown ?? ""}…`,
    recording: `Recording · ${formatDuration(recorder.elapsedMs)}`,
    paused: `Paused · ${formatDuration(recorder.elapsedMs)}`,
    finishing: "Saving recording…",
  }[recorder.status];

  return (
    <main className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <a className="brand" href="#" aria-label="ScreenSway home">
          <span className="brand-mark"><MousePointer2 size={15} strokeWidth={2.5} /></span>
          <span>ScreenSway</span>
        </a>
        <button className="icon-button" aria-label="Open settings"><Settings2 size={18} /></button>
      </header>

      <section className="welcome">
        <div>
          <span className="eyebrow">Local workspace</span>
          <h1>What will you show today?</h1>
          <p>Record your screen. ScreenSway handles the camera work.</p>
        </div>

        <div className="record-card">
          <div className="source-row">
            <span className="source-icon"><Monitor size={20} /></span>
            <label>
              <span className="source-label">Capture source</span>
              <select
                value={selectedSourceKey}
                onChange={(event) => setSelectedSourceKey(event.target.value)}
                disabled={recording || busy || loadingSources}
                aria-label="Capture source"
              >
                {loadingSources && <option>Loading sources…</option>}
                {sources.map((source) => (
                  <option key={`${source.kind}:${source.id}`} value={`${source.kind}:${source.id}`}>
                    {source.kind === "display" ? "Screen" : "Window"} · {source.name}
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
                {paused ? "Resume" : "Pause"}
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
              {recording ? (recorder.status === "finishing" ? "Saving…" : "Stop recording") : "Start recording"}
            </button>
          </div>
          {!recording && !result && !error && (
            <p className="record-hint">A 3-second countdown runs first. ScreenSway hides itself and stays out of the video.</p>
          )}
          {result && (
            <div className="capture-message success">
              <CheckCircle2 size={15} />
              <span><strong>Recording saved</strong><small>{result.projectPath}</small></span>
            </div>
          )}
          {error && (
            <div className="capture-message error">
              <AlertCircle size={15} />
              <span><strong>Recording failed</strong><small>{error}</small></span>
            </div>
          )}
        </div>
      </section>

      <section className="recent-section">
        {result && (
          <div className="preview-card">
            <div className="section-heading">
              <h2>Auto-zoom preview</h2>
              <span>{zoomCount} zoom{zoomCount === 1 ? "" : "s"} generated from clicks · {formatDuration(result.durationMs)}</span>
            </div>
            <ZoomPreview recording={result} key={result.videoPath} />
          </div>
        )}
        <div className="section-heading">
          <h2>Recent recordings</h2>
          <span>Stored on this Mac</span>
        </div>
        <div className="recording-grid">
          {recentRecordings.map((recording) => (
            <article className="recording" key={recording.title}>
              <div className={`thumbnail ${recording.color}`}>
                <div className="mock-window">
                  <span /><span /><span />
                  <div className="mock-content"><i /><i /><i /></div>
                </div>
                <span className="focus-ring"><MousePointer2 size={13} fill="white" /></span>
              </div>
              <div className="recording-meta">
                <div><strong>{recording.title}</strong><span>{recording.detail}</span></div>
                <button aria-label={`Options for ${recording.title}`}>•••</button>
              </div>
            </article>
          ))}
          <article className="recording empty-state">
            <Sparkles size={21} />
            <strong>Your next idea</strong>
            <span>Press record when you are ready</span>
          </article>
        </div>
      </section>
    </main>
  );
}

