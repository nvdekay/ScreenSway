import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { generateZoomSegments, type PointerEvent } from "@screensway/core";
import { AlertCircle, CheckCircle2, ChevronDown, Monitor, MousePointer2, Pause, Play, Settings2, Sparkles, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

interface CaptureSource {
  id: string;
  kind: "display" | "window";
  name: string;
  width: number;
  height: number;
}

interface RecordingResult {
  projectPath: string;
  videoPath: string;
  pointerEventsPath: string;
  durationMs: number;
  width: number;
  height: number;
  pointerEvents: PointerEvent[];
}

interface RecordingStarted {
  projectPath: string;
}

const recentRecordings = [
  { title: "Product walkthrough", detail: "Draft · 2m 14s", color: "violet" },
  { title: "Welcome to ScreenSway", detail: "Draft · 38s", color: "blue" },
];

export default function App() {
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [activeProjectPath, setActiveProjectPath] = useState<string | null>(null);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [selectedSourceKey, setSelectedSourceKey] = useState("");
  const [loadingSources, setLoadingSources] = useState(true);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playbackTimeMs, setPlaybackTimeMs] = useState(0);
  const zoomSegments = useMemo(
    () => generateZoomSegments(result?.pointerEvents ?? []),
    [result],
  );
  const activeZoom = zoomSegments.find(
    (zoom) => playbackTimeMs >= zoom.startMs && playbackTimeMs <= zoom.endMs,
  );
  const activePointer = result?.pointerEvents
    .filter((event) => event.timeMs <= playbackTimeMs)
    .at(-1);
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
    if (!recording || paused) return;
    const timer = window.setInterval(() => setElapsedSeconds((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [recording, paused]);

  async function startRecording() {
    if (!selectedSource) return;
    setBusy(true);
    setResult(null);
    setError(null);
    setElapsedSeconds(0);
    setPaused(false);

    try {
      const started = await invoke<RecordingStarted>("start_recording", {
        sourceKind: selectedSource.kind,
        sourceId: selectedSource.id,
      });
      setActiveProjectPath(started.projectPath);
      setRecording(true);
    } catch (captureError) {
      setError(String(captureError));
    } finally {
      setBusy(false);
    }
  }

  async function stopRecording() {
    setBusy(true);
    setError(null);

    try {
      const capture = await invoke<RecordingResult>("stop_recording");
      setResult(capture);
      setRecording(false);
      setPaused(false);
      setActiveProjectPath(null);
    } catch (captureError) {
      setError(String(captureError));
    } finally {
      setBusy(false);
    }
  }

  async function togglePause() {
    const nextPaused = !paused;
    setBusy(true);
    setError(null);

    try {
      await invoke("set_recording_paused", { paused: nextPaused });
      setPaused(nextPaused);
    } catch (captureError) {
      setError(String(captureError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="titlebar">
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
            <span><i className={`status-dot${recording && !paused ? " recording" : ""}`} /> {recording ? `${paused ? "Paused" : "Recording"} · ${elapsedSeconds}s` : "Pointer metadata ready"}</span>
            <span>{selectedSource ? `${selectedSource.width} × ${selectedSource.height}` : "—"}</span>
          </div>
          <div className={`record-controls${recording ? " active" : ""}`}>
            {recording && (
              <button className="pause-button" onClick={togglePause} disabled={busy}>
                {paused ? <Play size={13} fill="currentColor" /> : <Pause size={13} fill="currentColor" />}
                {paused ? "Resume" : "Pause"}
              </button>
            )}
            <button
              className={`record-button${recording ? " stop" : ""}`}
              onClick={recording ? stopRecording : startRecording}
              disabled={busy || (!recording && !selectedSource)}
            >
              {recording ? <Square size={9} fill="currentColor" /> : <span className="record-dot" />}
              {busy ? (recording ? "Working…" : "Starting…") : recording ? "Stop recording" : "Start recording"}
            </button>
          </div>
          {recording && activeProjectPath && (
            <div className="capture-message active">
              <span className={`live-indicator${paused ? " paused" : ""}`} />
              <span><strong>{paused ? "Recording paused" : "Recording in progress"}</strong><small>{activeProjectPath}</small></span>
            </div>
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
              <span>{zoomSegments.length} zoom{zoomSegments.length === 1 ? "" : "s"} generated from clicks</span>
            </div>
            <div className="preview-viewport">
              <div
                className="preview-content"
                style={{
                  transform: `scale(${activeZoom?.scale ?? 1})`,
                  transformOrigin: activeZoom
                    ? `${(activeZoom.centerX / result.width) * 100}% ${(activeZoom.centerY / result.height) * 100}%`
                    : "50% 50%",
                }}
              >
                <video
                  src={convertFileSrc(result.videoPath)}
                  controls
                  autoPlay
                  onTimeUpdate={(event) => setPlaybackTimeMs(event.currentTarget.currentTime * 1_000)}
                />
                {activePointer && (
                  <MousePointer2
                    className="preview-cursor"
                    size={22}
                    fill="white"
                    style={{
                      left: `${(activePointer.x / result.width) * 100}%`,
                      top: `${(activePointer.y / result.height) * 100}%`,
                    }}
                  />
                )}
              </div>
            </div>
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

