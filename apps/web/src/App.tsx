import { Apple, ArrowRight, Languages, Moon, Sun } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { version as appVersion } from "../../desktop/src-tauri/tauri.conf.json";
import { track, trackDownload, trackPageView } from "./analytics";
import { DOWNLOADS, preferredPlatform } from "./downloads";
import { CONTACT_MAILTO } from "./contact";
import { Benefits } from "./Benefits";
import { StudioShowcase } from "./StudioShowcase";
import { Faq } from "./Faq";
import { InstallGuide, openInstallGuide } from "./InstallGuide";
import { LogoMark } from "./LogoMark";
import { useI18n, type Language } from "./i18n";
import { useTheme } from "./theme";

// Served by the landing page itself; the deploy workflow copies it from the latest release.
const MAC_DOWNLOAD = DOWNLOADS.macos;

function WindowsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="#0078d4" aria-hidden="true">
      <path d="M3 4.7 10.4 3.7v7.6H3V4.7Zm8.4-1.15L21 2.2v9.1h-9.6V3.55ZM3 12.3h7.4v7.6L3 18.85V12.3Zm8.4 0H21v9.5l-9.6-1.35V12.3Z" />
    </svg>
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

function DownloadActions({ centered = false, placement }: { centered?: boolean; placement: "hero" | "cta" }) {
  const { t } = useI18n();
  return (
    <div className={`download-actions${centered ? " centered" : ""}`}>
      <a className="button-primary" href={MAC_DOWNLOAD} download onClick={() => { trackDownload("macos", placement); openInstallGuide("macos"); }}>
        <Apple size={20} fill="currentColor" aria-hidden="true" />
        {t("hero.mac")}
        <ArrowRight size={18} className="button-arrow" aria-hidden="true" />
      </a>
      <a className="button-primary" href={DOWNLOADS.windows} download onClick={() => { trackDownload("windows", placement); openInstallGuide("windows"); }}>
        <WindowsIcon />
        {t("hero.windows")}
        <ArrowRight size={18} className="button-arrow" aria-hidden="true" />
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

export default function App() {
  const { language, t } = useI18n();
  useScrollReveal();
  useEffect(() => {
    trackPageView(language, document.documentElement.dataset.theme === "light" ? "light" : "dark");
    // Only the first render counts as a visit; switching language does not.
  }, []);

  return (
    <div id="top">
      <SectionLink to="main" className="skip-link">{t("nav.skip")}</SectionLink>
      <header className="site-header">
        <Logo />
        <nav aria-label="Main">
          <SectionLink to="demo">{t("nav.demo")}</SectionLink>
          <SectionLink to="features">{t("nav.features")}</SectionLink>
          <SectionLink to="faq">{t("nav.faq")}</SectionLink>
        </nav>
        <div className="header-actions">
          <ThemeSwitch />
          <LanguageSwitch />
          <button className="header-download" onClick={() => { track("guide_open", { placement: "header" }); openInstallGuide(preferredPlatform()); }}>{t("nav.download")}</button>
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
          <DownloadActions centered placement="hero" />
          <p className="hero-note">
            {t("hero.perks")} · {t("hero.macNote")} · {t("hero.windowsNote")} ·{" "}
            <button className="link-button" onClick={() => { track("guide_open", { placement: "hero" }); openInstallGuide(preferredPlatform()); }}>{t("hero.howToInstall")}</button>
          </p>
          <div className="hero-demo" id="demo">
            <StudioShowcase />
          </div>
        </section>

        <Benefits />

        <Faq />

        <section className="cta" data-reveal>
          <div className="cta-glow" aria-hidden="true" />
          <h2>{t("cta.title")}</h2>
          <DownloadActions centered placement="cta" />
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
      <p className="site-privacy">{t("footer.privacy")}</p>
    </div>
  );
}
