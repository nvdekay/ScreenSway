import { Apple } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { version as appVersion } from "../../desktop/src-tauri/tauri.conf.json";
import { track, trackDownload, trackPageView } from "./analytics";
import { DOWNLOADS, preferredPlatform } from "./downloads";
import { CONTACT_MAILTO } from "./contact";
import { Benefits } from "./Benefits";
import { StudioShowcase } from "./StudioShowcase";
import { Faq } from "./Faq";
import { WebBrowserSection } from "./WebBrowserSection";
import { InstallGuide, openInstallGuide } from "./InstallGuide";
import { FeedbackButton, FeedbackDialog } from "./Feedback";
import { LanguageToggle } from "../../desktop/src/LanguageToggle";
import { LogoMark } from "../../desktop/src/LogoMark";
import { HeroBackdrop } from "./HeroBackdrop";
import { useI18n } from "./i18n";

// Served by the landing page itself; the deploy workflow copies it from the latest release.
const MAC_DOWNLOAD = DOWNLOADS.macos;

function WindowsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="#0078d4" aria-hidden="true">
      <path d="M3 4.7 10.4 3.7v7.6H3V4.7Zm8.4-1.15L21 2.2v9.1h-9.6V3.55ZM3 12.3h7.4v7.6L3 18.85V12.3Zm8.4 0H21v9.5l-9.6-1.35V12.3Z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg className="arw" viewBox="0 0 12 10" fill="none" aria-hidden="true">
      <path d="M0.8 5h10M7.1 1.4 10.9 5l-3.8 3.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


/**
 * Looping globe and starfield fixed behind the whole page; a veil in the page
 * colour thickens once the hero scrolls away so later sections stay readable.
 * The clip's last frame does not match its first, so two copies cross-fade at
 * the loop point instead of snapping. Under reduced motion it holds on the
 * first frame.
 */

/** Scrolls to an in-page section without adding a #fragment to the URL. */
function scrollToSection(id: string, focus = false) {
  const target = document.getElementById(id);
  if (!target) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  if (focus) target.focus({ preventScroll: true });
}

function SectionLink({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode; "aria-label"?: string; "aria-current"?: "location" }) {
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
      <LogoMark size={28} tone="flat" />
      <span className="wordmark">ScreenSway</span>
    </SectionLink>
  );
}

/** Both languages side by side; the current one is lit. */
function LanguageSwitch() {
  const { language, setLanguage, t } = useI18n();
  return <LanguageToggle language={language} onChange={setLanguage} label={t("nav.language")} />;
}

function DownloadActions({ centered = false, placement }: { centered?: boolean; placement: "hero" | "cta" }) {
  const { t } = useI18n();
  return (
    <div className={`download-actions${centered ? " centered" : ""}`}>
      <a className="button-primary" href={MAC_DOWNLOAD} download onClick={() => { trackDownload("macos", placement); openInstallGuide("macos"); }}>
        <Apple size={20} fill="currentColor" aria-hidden="true" />
        {t("hero.mac")}
        <ArrowIcon />
      </a>
      <a className="button-primary" href={DOWNLOADS.windows} download onClick={() => { trackDownload("windows", placement); openInstallGuide("windows"); }}>
        <WindowsIcon />
        {t("hero.windows")}
        <ArrowIcon />
      </a>
    </div>
  );
}

const NAV_SECTIONS = ["demo", "features", "faq"] as const;

/** Marks the section crossing the middle of the viewport as the current nav item. */
function useCurrentSection() {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        setCurrent([...NAV_SECTIONS].reverse().find((id) => visible.has(id)) ?? null);
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    for (const id of NAV_SECTIONS) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, []);
  return current;
}

/**
 * Top navigation. Below the collapse width the same links and controls
 * re-compose into a panel opened by the burger button.
 */
function SiteHeader() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const current = useCurrentSection();
  const panelRef = useRef<HTMLDivElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !burgerRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      burgerRef.current?.focus();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header className="site-header" data-scrolled={scrolled}>
      <div className="navrow" data-open={open}>
        <Logo />
        <div className="links" id="site-nav" ref={panelRef} onClick={(event) => { if ((event.target as Element).closest("a, .header-download, .header-feedback")) setOpen(false); }}>
          <nav aria-label="Main">
            {NAV_SECTIONS.map((id) => (
              <SectionLink key={id} to={id} aria-current={current === id ? "location" : undefined}>{t(`nav.${id}`)}</SectionLink>
            ))}
          </nav>
          <div className="header-actions">
            <LanguageSwitch />
            <FeedbackButton />
          </div>
          {/* The browser version is part of this site, at ./app/. */}
          <a className="header-web" href="./app/"><span className="header-web-dot" aria-hidden="true" />{t("nav.web")}</a>
          <button className="header-download" onClick={() => { track("guide_open", { placement: "header" }); openInstallGuide(preferredPlatform()); }}>{t("nav.download")}<ArrowIcon /></button>
        </div>
        <button ref={burgerRef} className="burger" type="button" aria-label={open ? t("nav.menuClose") : t("nav.menuOpen")} aria-expanded={open} aria-controls="site-nav" onClick={() => setOpen(!open)}>
          <span /><span /><span />
        </button>
      </div>
    </header>
  );
}

/**
 * Plays the opening sequence once. index.html adds `.anim` before first paint
 * (never under reduced motion); afterwards both classes are removed so the page
 * rests in its plain authored state.
 */
function useEntrance() {
  useEffect(() => {
    const root = document.documentElement;
    if (!root.classList.contains("anim")) return;
    let cancelled = false;
    let frame = 0;
    let done = 0;
    const play = () => {
      if (cancelled || frame) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          root.classList.add("play");
          done = window.setTimeout(() => root.classList.remove("anim", "play"), 1900);
        });
      });
    };
    // A stalled font must not hold the page back.
    const guard = window.setTimeout(play, 500);
    document.fonts?.ready.then(play);
    return () => {
      cancelled = true;
      clearTimeout(guard);
      clearTimeout(done);
      cancelAnimationFrame(frame);
      root.classList.remove("play");
    };
  }, []);
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
  useEntrance();
  useEffect(() => {
    trackPageView(language, "dark");
    // Only the first render counts as a visit; switching language does not.
  }, []);

  return (
    <div id="top">
      <SectionLink to="main" className="skip-link">{t("nav.skip")}</SectionLink>
      <HeroBackdrop src={`${import.meta.env.BASE_URL}hero/globe.mp4`} poster={`${import.meta.env.BASE_URL}hero/globe.jpg`} />
      <SiteHeader />

      <main id="main" tabIndex={-1}>
        <section className="hero">
          <div className="hero-stage">
            <div className="hero-inner">
              <h1>
                <span className="ent-mask"><span className="ent-line">{t("hero.titleA")}</span></span>
                <span className="ent-mask"><span className="ent-line">{t("hero.titleB")}</span></span>
              </h1>
              <p className="hero-copy">{t("hero.copy")}</p>
              <DownloadActions centered placement="hero" />
              <p className="hero-web">
                <a href="./app/"><span>{t("hero.webBeta")}</span>{t("hero.web")}<ArrowIcon /></a>
              </p>
              <p className="hero-note">
                v{appVersion} · {t("hero.perks")} · {t("hero.platforms")} ·{" "}
                <button className="link-button" onClick={() => { track("guide_open", { placement: "hero" }); openInstallGuide(preferredPlatform()); }}>{t("hero.howToInstall")}</button>
              </p>
            </div>
          </div>
          <div className="hero-demo" id="demo">
            <StudioShowcase />
          </div>
        </section>

        <Benefits />

        <WebBrowserSection />

        <Faq />

        <section className="cta" data-reveal>
          <div className="cta-glow" aria-hidden="true" />
          <h2>{t("cta.title")}</h2>
          <DownloadActions centered placement="cta" />
        </section>
      </main>

      <InstallGuide />
      <FeedbackDialog />

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
