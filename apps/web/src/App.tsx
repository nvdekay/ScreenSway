import {
  Apple,
  ArrowRight,
  Check,
  Circle,
  EyeOff,
  FolderOpen,
  Languages,
  MousePointer2,
  Moon,
  MousePointerClick,
  Pause,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Video,
  ZoomIn,
} from "lucide-react";
import { useEffect, useId, type ReactNode } from "react";
import { version as appVersion } from "../../desktop/src-tauri/tauri.conf.json";
import { DOWNLOADS, preferredPlatform } from "./downloads";
import { CONTACT_MAILTO } from "./contact";
import { StudioFeatures, StudioShowcase } from "./StudioShowcase";
import { Faq } from "./Faq";
import { InstallGuide, openInstallGuide } from "./InstallGuide";
import { LogoMark } from "./LogoMark";
import { useI18n, type Language, type MessageKey } from "./i18n";
import { useTheme } from "./theme";

// Served by the landing page itself; the deploy workflow copies it from the latest release.
const MAC_DOWNLOAD = DOWNLOADS.macos;

function WindowsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="#0078d4" aria-hidden="true">
      <path d="M3 4.7 10.4 3.7v7.6H3V4.7Zm8.4-1.15L21 2.2v9.1h-9.6V3.55ZM3 12.3h7.4v7.6L3 18.85V12.3Zm8.4 0H21v9.5l-9.6-1.35V12.3Z" />
    </svg>
  );
}

function AppleIcon() {
  const gradientId = useId();
  return (
    <Apple size={20} fill={`url(#${gradientId})`} stroke={`url(#${gradientId})`} aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#61bb46" /><stop offset="16.67%" stopColor="#61bb46" />
          <stop offset="16.67%" stopColor="#fdb827" /><stop offset="33.33%" stopColor="#fdb827" />
          <stop offset="33.33%" stopColor="#f5821f" /><stop offset="50%" stopColor="#f5821f" />
          <stop offset="50%" stopColor="#e03a3e" /><stop offset="66.67%" stopColor="#e03a3e" />
          <stop offset="66.67%" stopColor="#963d97" /><stop offset="83.33%" stopColor="#963d97" />
          <stop offset="83.33%" stopColor="#009ddc" /><stop offset="100%" stopColor="#009ddc" />
        </linearGradient>
      </defs>
    </Apple>
  );
}

/** Scrolls to an in-page section without adding a #fragment to the URL. */
function scrollToSection(id: string, focus = false) {
  const target = document.getElementById(id);
  if (!target) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  if (focus) target.focus({ preventScroll: true });
}

function SectionLink({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode; "aria-label"?: string }) {
  return (
    <a
      href={`#${to}`}
      className={className}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        scrollToSection(to, to === "main");
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

function Logo() {
  const { t } = useI18n();
  return (
    <SectionLink to="top" className="logo" aria-label={t("nav.home")}>
      <LogoMark size={32} />
      <span>ScreenSway</span>
    </SectionLink>
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

function ThemeSwitch() {
  const { t } = useI18n();
  const { theme, toggleTheme } = useTheme();
  const label = theme === "dark" ? t("nav.lightMode") : t("nav.darkMode");
  return (
    <button className="theme-switch" onClick={toggleTheme} aria-label={label} title={label}>
      {theme === "dark" ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
    </button>
  );
}

function DownloadActions({ centered = false }: { centered?: boolean }) {
  const { t } = useI18n();
  return (
    <div className={`download-actions${centered ? " centered" : ""}`}>
      <a className="button-primary" href={MAC_DOWNLOAD} download onClick={() => openInstallGuide("macos")}>
        <AppleIcon />
        {t("hero.mac")}
        <ArrowRight size={18} className="button-arrow" aria-hidden="true" />
      </a>
      <a className="button-secondary" href={DOWNLOADS.windows} download onClick={() => openInstallGuide("windows")}>
        <WindowsIcon />
        {t("hero.windows")}
      </a>
    </div>
  );
}

/** Fades sections in as they scroll into view; content stays visible without JavaScript. */
function useScrollReveal() {
  const { language } = useI18n();
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
  }, [language]);
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
  { icon: <Video size={22} />, title: "features.nativeTitle", copy: "features.nativeCopy", className: "full" },
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
      <SectionLink to="main" className="skip-link">{t("nav.skip")}</SectionLink>
      <header className="site-header">
        <Logo />
        <nav aria-label="Main">
          <SectionLink to="demo">{t("nav.demo")}</SectionLink>
          <SectionLink to="studio">Studio</SectionLink>
          <SectionLink to="features">{t("nav.features")}</SectionLink>
          <SectionLink to="privacy">{t("nav.privacy")}</SectionLink>
          <SectionLink to="faq">{t("nav.faq")}</SectionLink>
        </nav>
        <div className="header-actions">
          <ThemeSwitch />
          <LanguageSwitch />
          <button className="header-download" onClick={() => openInstallGuide(preferredPlatform())}>{t("nav.download")}</button>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <section className="hero">
          <div className="hero-glow" aria-hidden="true" />
          <p className="release-pill">
            <span className="release-tag">{t("hero.releaseTag")}</span>
            <span>{t("hero.release", { version: appVersion })}</span>
          </p>
          <h1>
            <span className="hero-line">{t("hero.titleA")}</span>
            <span className="hero-line accent">{t("hero.titleB")}</span>
          </h1>
          <p className="hero-copy">{t("hero.copy")}</p>
          <DownloadActions centered />
          <p className="hero-note">
            {t("hero.perks")} · {t("hero.macNote")} · {t("hero.windowsNote")} ·{" "}
            <button className="link-button" onClick={() => openInstallGuide(preferredPlatform())}>{t("hero.howToInstall")}</button>
          </p>
          <div className="hero-demo" id="demo">
            <StudioShowcase />
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

        <StudioFeatures />

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

        <Faq />

        <section className="cta" data-reveal>
          <div className="cta-glow" aria-hidden="true" />
          <span className="cta-mark"><LogoMark size={72} /></span>
          <h2>{t("cta.title")}</h2>
          <p>{t("cta.copy")}</p>
          <DownloadActions centered />
        </section>
      </main>

      <InstallGuide />

      <footer className="site-footer">
        <Logo />
        <p>{t("footer.tagline")}</p>
        <div>
          <a href={CONTACT_MAILTO}>{t("footer.contact")}</a>
          <span>© 2026 ScreenSway</span>
        </div>
      </footer>
    </div>
  );
}
