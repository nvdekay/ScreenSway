import { ChevronDown, Monitor, MousePointer2, Settings2, Sparkles } from "lucide-react";

const recentRecordings = [
  { title: "Product walkthrough", detail: "Draft · 2m 14s", color: "violet" },
  { title: "Welcome to ScreenSway", detail: "Draft · 38s", color: "blue" },
];

export default function App() {
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
          <button className="record-button">
            <span className="record-dot" /> Start recording
          </button>
        </div>
      </section>

      <section className="recent-section">
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

