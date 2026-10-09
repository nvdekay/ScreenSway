import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { generateZoomSegments, type PointerEvent } from "@screensway/core";
import { AlertCircle, CheckCircle2, ChevronDown, Monitor, MousePointer2, Settings2, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

interface RecordingResult {
  projectPath: string;
  videoPath: string;
  pointerEventsPath: string;
  durationMs: number;
  width: number;
  height: number;
  pointerEvents: PointerEvent[];
}

const recentRecordings = [
  { title: "Product walkthrough", detail: "Draft · 2m 14s", color: "violet" },
  { title: "Welcome to ScreenSway", detail: "Draft · 38s", color: "blue" },
];

export default function App() {
  const [recording, setRecording] = useState(false);
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

  async function startRecording() {
    setRecording(true);
    setResult(null);
    setError(null);

    try {
      const capture = await invoke<RecordingResult>("record_main_display", { durationSeconds: 10 });
      setResult(capture);
    } catch (captureError) {
      setError(String(captureError));
    } finally {
      setRecording(false);
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
            <div>
              <span className="source-label">Capture source</span>
              <strong>Entire screen</strong>
            </div>
            <ChevronDown size={17} />
          </div>
          <div className="record-options">
            <span><i className="status-dot" /> Microphone ready</span>
            <span>1440 × 900</span>
          </div>
          <button className="record-button" onClick={startRecording} disabled={recording}>
            <span className="record-dot" /> {recording ? "Recording 10 seconds…" : "Start 10-second test"}
          </button>
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

