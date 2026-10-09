import {
  Apple,
  ArrowRight,
  Download,
  Focus,
  MousePointer2,
  ShieldCheck,
  Sparkles,
  WandSparkles,
} from "lucide-react";

const DOWNLOADS = {
  mac: "https://github.com/nvdekay/ScreenSway/releases/latest/download/ScreenSway-macos-universal.dmg",
  windows: "https://github.com/nvdekay/ScreenSway/releases/latest/download/ScreenSway-windows-x64.exe",
};

function WindowsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 4.7 10.4 3.7v7.6H3V4.7Zm8.4-1.15L21 2.2v9.1h-9.6V3.55ZM3 12.3h7.4v7.6L3 18.85V12.3Zm8.4 0H21v9.5l-9.6-1.35V12.3Z" />
    </svg>
  );
}

function Logo() {
  return (
    <a className="logo" href="#top" aria-label="ScreenSway home">
      <span className="logo-mark"><MousePointer2 size={16} strokeWidth={2.6} /></span>
      <span>ScreenSway</span>
    </a>
  );
}

function DownloadButtons({ inverse = false }: { inverse?: boolean }) {
  return (
    <div className={`download-actions${inverse ? " inverse" : ""}`}>
      <a className="download-primary" href={DOWNLOADS.mac}>
        <Apple size={19} fill="currentColor" />
        <span><small>Download for</small>macOS</span>
      </a>
      <a className="download-secondary" href={DOWNLOADS.windows}>
        <WindowsIcon />
        <span><small>Download for</small>Windows</span>
      </a>
    </div>
  );
}

function ProductStage() {
  return (
    <div className="product-stage" aria-label="Illustration of ScreenSway automatically focusing a screen recording">
      <div className="stage-glow" />
      <div className="app-window">
        <div className="window-bar">
          <div className="traffic"><i /><i /><i /></div>
          <span>Product tour</span>
          <div className="window-chip"><span /> Recording</div>
        </div>
        <div className="window-body">
          <aside className="mock-sidebar">
            <strong>acme</strong>
            <i className="active" /><i /><i /><i />
          </aside>
          <div className="mock-canvas">
            <div className="canvas-top"><span>Overview</span><i /></div>
            <div className="stat-row"><i /><i /><i /></div>
            <div className="chart-card">
              <div className="chart-title"><span>Weekly activity</span><i /></div>
              <div className="chart-bars"><i /><i /><i /><i /><i /><i /><i /></div>
            </div>
            <div className="auto-focus">
              <span className="focus-label"><Sparkles size={12} /> Auto focus</span>
              <MousePointer2 className="demo-cursor" size={24} fill="white" />
            </div>
          </div>
        </div>
        <div className="timeline">
          <button><span /></button>
          <div className="track"><i /><i className="zoom-track" /><b /></div>
          <span>00:08 / 00:24</span>
        </div>
      </div>
      <div className="floating-card zoom-card"><Focus size={17} /><span><small>Smart zoom</small>1.6× on click</span></div>
      <div className="floating-card privacy-card"><ShieldCheck size={17} /><span><small>Private by default</small>Stays on your device</span></div>
    </div>
  );
}

const features = [
  {
    icon: <Focus size={21} />,
    number: "01",
    title: "It knows where to look",
    copy: "ScreenSway reads clicks and cursor movement, then adds smooth zooms and pans around the action.",
  },
  {
    icon: <WandSparkles size={21} />,
    number: "02",
    title: "Polished, still editable",
    copy: "Keep the automatic cut or tune its timing, depth, and focal point on a simple visual timeline.",
  },
  {
    icon: <ShieldCheck size={21} />,
    number: "03",
    title: "Your screen stays yours",
    copy: "Recording, editing, and export happen locally. No account, upload, or cloud processing required.",
  },
];

export default function App() {
  return (
    <div id="top">
      <header className="site-header">
        <Logo />
        <nav aria-label="Main navigation">
          <a href="#features">Features</a>
          <a href="#privacy">Privacy</a>
          <a href="https://github.com/nvdekay/ScreenSway/releases">Releases</a>
        </nav>
        <a className="header-download" href={DOWNLOADS.mac}><Download size={15} /> Download free</a>
      </header>

      <main>
        <section className="hero">
          <div className="eyebrow"><span /> Free on macOS and Windows</div>
          <h1>Your screen knows<br />where to <em>look.</em></h1>
          <p className="hero-copy">Record once. ScreenSway turns every click into a smooth, focused story—automatically and entirely on your device.</p>
          <DownloadButtons />
          <p className="microcopy">Full features · No watermark · No account</p>
          <ProductStage />
        </section>

        <section className="statement">
          <p>Less editing.<br /><span>More showing.</span></p>
          <div>
            <strong>Screen recording should feel effortless.</strong>
            <span>ScreenSway handles the camera movement so you can stay focused on what you want to say.</span>
          </div>
        </section>

        <section className="features" id="features">
          <div className="section-intro">
            <span className="section-kicker">How it works</span>
            <h2>From raw recording<br />to ready to share.</h2>
          </div>
          <div className="feature-grid">
            {features.map((feature) => (
              <article key={feature.number}>
                <div className="feature-top"><span>{feature.icon}</span><small>{feature.number}</small></div>
                <h3>{feature.title}</h3>
                <p>{feature.copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="privacy" id="privacy">
          <div className="privacy-visual">
            <div className="privacy-orbit orbit-one" />
            <div className="privacy-orbit orbit-two" />
            <div className="device-core"><ShieldCheck size={38} /><span>On-device</span></div>
            <span className="data-pill pill-one">Screen video</span>
            <span className="data-pill pill-two">Microphone</span>
            <span className="data-pill pill-three">Cursor data</span>
          </div>
          <div className="privacy-copy">
            <span className="section-kicker">Local by design</span>
            <h2>Nothing to upload.<br />Nothing to expose.</h2>
            <p>Your projects live on your computer. ScreenSway records, edits, and renders locally without sending your work to a server.</p>
            <ul>
              <li><ShieldCheck size={16} /> No account required</li>
              <li><ShieldCheck size={16} /> No cloud processing</li>
              <li><ShieldCheck size={16} /> You control every project file</li>
            </ul>
          </div>
        </section>

        <section className="cta">
          <div className="cta-orb" />
          <span className="section-kicker">Start creating</span>
          <h2>Make every click<br />worth watching.</h2>
          <p>Full features. Zero watermark. Free to use.</p>
          <DownloadButtons inverse />
        </section>
      </main>

      <footer>
        <Logo />
        <p>Beautiful screen recordings, automatically.</p>
        <div><a href="https://github.com/nvdekay/ScreenSway/releases">Releases</a><a href="mailto:hello@screensway.app">Contact</a><span>© 2026 ScreenSway</span></div>
      </footer>
    </div>
  );
}

