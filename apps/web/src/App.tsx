import {
  Apple,
  ArrowRight,
  Check,
  ChevronDown,
  Circle,
  EyeOff,
  FolderOpen,
  Languages,
  MousePointer2,
  MousePointerClick,
  Pause,
  ShieldCheck,
  Sparkles,
  Square,
  Video,
  X,
  ZoomIn,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Demo } from "./Demo";
import { useI18n, type Language, type MessageKey } from "./i18n";

const MAC_DOWNLOAD = "https://github.com/nvdekay/ScreenSway/releases/latest/download/ScreenSway-macos-universal.dmg";
const RELEASES = "https://github.com/nvdekay/ScreenSway/releases";

function WindowsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 4.7 10.4 3.7v7.6H3V4.7Zm8.4-1.15L21 2.2v9.1h-9.6V3.55ZM3 12.3h7.4v7.6L3 18.85V12.3Zm8.4 0H21v9.5l-9.6-1.35V12.3Z" />
    </svg>
  );
}

function Logo() {
  const { t } = useI18n();
  return (
    <a className="logo" href="#top" aria-label={t("nav.home")}>
      <span className="logo-mark"><MousePointer2 size={16} strokeWidth={2.6} aria-hidden="true" /></span>
      <span>ScreenSway</span>
    </a>
  );
}

function LanguageSwitch() {
  const { language, setLanguage, t } = useI18n();
  const options: { code: Language; label: string }[] = [
    { code: "en", label: "EN" },
    { code: "vi", label: "VI" },
  ];
  return (
    <div className="language-switch" role="radiogroup" aria-label={t("nav.language")}>
      <Languages size={15} aria-hidden="true" />
      {options.map((option) => (
        <button
          key={option.code}
          role="radio"
          aria-checked={language === option.code}
          className={language === option.code ? "selected" : ""}
          onClick={() => setLanguage(option.code)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function DownloadActions({ centered = false }: { centered?: boolean }) {
  const { t } = useI18n();
  return (
    <div className={`download-actions${centered ? " centered" : ""}`}>
      <a className="button-primary" href={MAC_DOWNLOAD}>
        <Apple size={20} fill="currentColor" aria-hidden="true" />
        {t("hero.mac")}
        <ArrowRight size={18} className="button-arrow" aria-hidden="true" />
      </a>
      <span className="button-soon" aria-disabled="true">
        <WindowsIcon />
        {t("hero.windows")}
        <small>{t("hero.soon")}</small>
      </span>
    </div>
  );
}

/** Fades sections in as they scroll into view; content stays visible without JavaScript. */
function useScrollReveal() {
  useEffect(() => {
    const elements = document.querySelectorAll<HTMLElement>("[data-reveal]");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      elements.forEach((element) => element.classList.add("revealed"));
      return;
    }
    document.documentElement.classList.add("reveal-ready");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("revealed");
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" },
    );
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);
}

function SectionIntro({ kicker, title, children }: { kicker: MessageKey; title: MessageKey; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="section-intro" data-reveal>
      <span className="kicker">{t(kicker)}</span>
      <h2>{t(title)}</h2>
      {children}
    </div>
  );
}

const STEPS: { icon: ReactNode; title: MessageKey; copy: MessageKey }[] = [
  { icon: <Circle size={20} fill="currentColor" />, title: "how.step1", copy: "how.step1Copy" },
  { icon: <MousePointerClick size={20} />, title: "how.step2", copy: "how.step2Copy" },
  { icon: <Sparkles size={20} />, title: "how.step3", copy: "how.step3Copy" },
];

const FEATURES: { icon: ReactNode; title: MessageKey; copy: MessageKey; className?: string }[] = [
  { icon: <ZoomIn size={22} />, title: "features.zoomTitle", copy: "features.zoomCopy", className: "wide zoom" },
  { icon: <MousePointer2 size={22} />, title: "features.cursorTitle", copy: "features.cursorCopy", className: "cursor" },
  { icon: <EyeOff size={22} />, title: "features.hudTitle", copy: "features.hudCopy", className: "hud" },
  { icon: <Pause size={22} />, title: "features.pauseTitle", copy: "features.pauseCopy" },
  { icon: <FolderOpen size={22} />, title: "features.libraryTitle", copy: "features.libraryCopy" },
  { icon: <Apple size={22} />, title: "features.nativeTitle", copy: "features.nativeCopy", className: "full" },
];

const COMPARISON: { label: MessageKey; raw: "yes" | "no" | "depends" }[] = [
  { label: "compare.row1", raw: "no" },
  { label: "compare.row2", raw: "no" },
  { label: "compare.row3", raw: "no" },
  { label: "compare.row4", raw: "depends" },
  { label: "compare.row5", raw: "depends" },
];

const FAQ: [MessageKey, MessageKey][] = [
  ["faq.q1", "faq.a1"],
  ["faq.q2", "faq.a2"],
  ["faq.q3", "faq.a3"],
  ["faq.q4", "faq.a4"],
  ["faq.q5", "faq.a5"],
  ["faq.q6", "faq.a6"],
];

function FeatureVisual({ name }: { name?: string }) {
  if (name?.includes("zoom")) {
    return (
      <div className="visual-zoom" aria-hidden="true">
        <div className="visual-zoom-frame"><i /><i /><i /><b /></div>
        <MousePointer2 className="visual-zoom-cursor" size={20} fill="#fff" />
      </div>
    );
  }
  if (name === "cursor") {
    return (
      <div className="visual-cursor" aria-hidden="true">
        <span className="visual-ripple" />
        <MousePointer2 size={22} fill="#fff" />
      </div>
    );
  }
  if (name === "hud") {
    return (
      <div className="visual-hud" aria-hidden="true">
        <span className="visual-hud-dot" /> 0:42 <span className="visual-hud-stop"><Square size={10} fill="currentColor" /></span>
      </div>
    );
  }
  return null;
}

export default function App() {
  const { t } = useI18n();
  useScrollReveal();

  return (
    <div id="top">
      <a className="skip-link" href="#main">{t("nav.skip")}</a>
      <header className="site-header">
        <Logo />
        <nav aria-label="Main">
          <a href="#demo">{t("nav.demo")}</a>
          <a href="#features">{t("nav.features")}</a>
          <a href="#privacy">{t("nav.privacy")}</a>
          <a href="#faq">{t("nav.faq")}</a>
        </nav>
        <div className="header-actions">
          <LanguageSwitch />
          <a className="header-download" href={MAC_DOWNLOAD}>{t("nav.download")}</a>
        </div>
      </header>

      <main id="main">
        <section className="hero">
          <div className="hero-glow" aria-hidden="true" />
          <span className="hero-eyebrow"><Sparkles size={15} aria-hidden="true" /> {t("hero.eyebrow")}</span>
          <h1>
            <span className="hero-line">{t("hero.titleA")}</span>
            <span className="hero-line accent">{t("hero.titleB")}</span>
          </h1>
          <p className="hero-copy">{t("hero.copy")}</p>
          <DownloadActions centered />
          <p className="hero-note">
            {t("hero.macNote")} · <a
              href="#faq-open"
              onClick={() => {
                const answer = document.getElementById("faq-open");
                if (answer instanceof HTMLDetailsElement) answer.open = true;
              }}
            >
              {t("hero.firstOpen")}
            </a>
          </p>
          <div className="hero-demo" id="demo">
            <Demo />
          </div>
        </section>

        <section className="metrics" aria-label="ScreenSway in numbers">
          {([
            ["metrics.cursorValue", "metrics.cursor"],
            ["metrics.retinaValue", "metrics.retina"],
            ["metrics.uploadValue", "metrics.upload"],
            ["metrics.priceValue", "metrics.price"],
          ] as [MessageKey, MessageKey][]).map(([value, label]) => (
            <div key={label} data-reveal>
              <strong>{t(value)}</strong>
              <span>{t(label)}</span>
            </div>
          ))}
        </section>

        <section className="how">
          <SectionIntro kicker="how.kicker" title="how.title" />
          <ol className="steps">
            {STEPS.map((step, index) => (
              <li key={step.title} data-reveal style={{ transitionDelay: `${index * 90}ms` }}>
                <span className="step-index">0{index + 1}</span>
                <span className="step-icon" aria-hidden="true">{step.icon}</span>
                <h3>{t(step.title)}</h3>
                <p>{t(step.copy)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="features" id="features">
          <SectionIntro kicker="features.kicker" title="features.title" />
          <div className="bento">
            {FEATURES.map((feature, index) => (
              <article
                key={feature.title}
                className={`bento-card ${feature.className ?? ""}`}
                data-reveal
                style={{ transitionDelay: `${(index % 3) * 80}ms` }}
              >
                <FeatureVisual name={feature.className} />
                <span className="bento-icon" aria-hidden="true">{feature.icon}</span>
                <h3>{t(feature.title)}</h3>
                <p>{t(feature.copy)}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="compare">
          <SectionIntro kicker="compare.kicker" title="compare.title" />
          <div className="compare-table" data-reveal>
            <table>
              <thead>
                <tr>
                  <th scope="col"><span className="sr-only">Feature</span></th>
                  <th scope="col">{t("compare.raw")}</th>
                  <th scope="col" className="highlight"><MousePointer2 size={15} aria-hidden="true" /> {t("compare.sway")}</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{t(row.label)}</th>
                    <td>
                      {row.raw === "no" ? (
                        <span className="mark no"><X size={15} aria-hidden="true" /> {t("compare.no")}</span>
                      ) : (
                        <span className="mark maybe">{t("compare.depends")}</span>
                      )}
                    </td>
                    <td className="highlight">
                      <span className="mark yes"><Check size={15} aria-hidden="true" /> {t("compare.yes")}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="privacy" id="privacy">
          <div className="privacy-visual" data-reveal aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="device-core"><ShieldCheck size={36} /><span>{t("privacy.core")}</span></div>
            <span className="data-pill pill-one"><Video size={14} /> {t("privacy.video")}</span>
            <span className="data-pill pill-two"><MousePointer2 size={14} /> {t("privacy.cursor")}</span>
            <span className="data-pill pill-three"><FolderOpen size={14} /> {t("privacy.project")}</span>
          </div>
          <div className="privacy-copy" data-reveal>
            <span className="kicker">{t("privacy.kicker")}</span>
            <h2>{t("privacy.title")}</h2>
            <p>{t("privacy.copy")}</p>
            <ul>
              {(["privacy.item1", "privacy.item2", "privacy.item3"] as MessageKey[]).map((item) => (
                <li key={item}><span><Check size={14} strokeWidth={3} aria-hidden="true" /></span>{t(item)}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="faq" id="faq">
          <SectionIntro kicker="faq.kicker" title="faq.title" />
          <div className="faq-list" data-reveal>
            {FAQ.map(([question, answer]) => (
              <details key={question} id={question === "faq.q6" ? "faq-open" : undefined}>
                <summary>{t(question)}<ChevronDown size={18} aria-hidden="true" /></summary>
                <p>{t(answer)}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="cta" data-reveal>
          <div className="cta-glow" aria-hidden="true" />
          <span className="cta-mark" aria-hidden="true"><MousePointer2 size={26} strokeWidth={2.4} /></span>
          <h2>{t("cta.title")}</h2>
          <p>{t("cta.copy")}</p>
          <DownloadActions centered />
        </section>
      </main>

      <footer className="site-footer">
        <Logo />
        <p>{t("footer.tagline")}</p>
        <div>
          <a href={RELEASES}>{t("footer.releases")}</a>
          <a href="mailto:hello@screensway.app">{t("footer.contact")}</a>
          <span>© 2026 ScreenSway</span>
        </div>
      </footer>
    </div>
  );
}
