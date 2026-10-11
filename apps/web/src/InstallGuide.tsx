import { ArrowRight, Check, Copy, Folder, Lock, ShieldAlert, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";
import { DOWNLOADS, preferredPlatform, type DownloadPlatform } from "./downloads";
import { LogoMark } from "./LogoMark";

export const INSTALL_GUIDE_EVENT = "screensway:install-guide";
const QUARANTINE_COMMAND = "xattr -dr com.apple.quarantine /Applications/ScreenSway.app";

/** Opens the install guide from anywhere on the page. */
export function openInstallGuide(platform: DownloadPlatform = preferredPlatform()) {
  window.dispatchEvent(new CustomEvent(INSTALL_GUIDE_EVENT, { detail: platform }));
}

/** Platform-specific setup and first-launch permissions, also available before downloading. */
export function InstallGuide() {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  const [platform, setPlatform] = useState<DownloadPlatform>(preferredPlatform);
  const downloadUrl = DOWNLOADS[platform];

  useEffect(() => {
    const open = (event: Event) => {
      const target = (event as CustomEvent).detail;
      setPlatform(target === "windows" ? "windows" : "macos");
      setCopied(false);
      dialogRef.current?.showModal();
    };
    window.addEventListener(INSTALL_GUIDE_EVENT, open);
    return () => window.removeEventListener(INSTALL_GUIDE_EVENT, open);
  }, []);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(QUARANTINE_COMMAND);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the command stays selectable.
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="install-guide"
      aria-labelledby="install-guide-title"
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current.close();
      }}
    >
      <div className="guide-panel">
        <button className="guide-close" onClick={() => dialogRef.current?.close()} aria-label={t("guide.close")}>
          <X size={18} />
        </button>
        <span className="kicker">{t("guide.kicker")}</span>
        <h2 id="install-guide-title">{t("guide.title")}</h2>
        <div className="guide-platforms">
          {(["macos", "windows"] as const).map((option) => <button key={option} aria-pressed={platform === option} onClick={() => setPlatform(option)}>{option === "macos" ? "macOS" : "Windows"}</button>)}
        </div>
        <p className="guide-lead">
          {t(platform === "windows" ? "guide.windowsDownload" : "guide.downloading")} <a href={downloadUrl} download>{t("guide.retry")}</a>
        </p>

        {platform === "windows" ? <>
          <ol className="guide-steps">
            {([1, 2, 3] as const).map((step) => <li key={step}><div className="guide-text"><span className="guide-number">{step}</span><div><h3>{t(`guide.win${step}Title`)}</h3><p>{t(`guide.win${step}`)}</p></div></div></li>)}
          </ol>
          <p className="guide-why">{t("guide.windowsRequirements")}</p>
        </> : <>
        <ol className="guide-steps">
          <li>
            <div className="guide-text">
              <span className="guide-number">1</span>
              <div><h3>{t("guide.step1Title")}</h3><p>{t("guide.step1")}</p></div>
            </div>
            <div className="guide-visual drag" aria-hidden="true">
              <span className="drag-item"><LogoMark size={44} /><small>ScreenSway</small></span>
              <ArrowRight size={22} className="drag-arrow" />
              <span className="drag-item"><span className="folder"><Folder size={30} /></span><small>{t("guide.applications")}</small></span>
            </div>
          </li>
          <li>
            <div className="guide-text">
              <span className="guide-number">2</span>
              <div><h3>{t("guide.step2Title")}</h3><p>{t("guide.step2")}</p></div>
            </div>
            <div className="guide-visual" aria-hidden="true">
              <div className="mock-alert">
                <ShieldAlert size={22} className="mock-alert-icon" />
                <strong>{t("guide.alertTitle")}</strong>
                <span className="mock-alert-button trash">{t("guide.trash")}</span>
                <span className="mock-alert-button done">{t("guide.done")}</span>
              </div>
            </div>
          </li>
          <li>
            <div className="guide-text">
              <span className="guide-number">3</span>
              <div><h3>{t("guide.step3Title")}</h3><p>{t("guide.step3")}</p></div>
            </div>
            <div className="guide-visual" aria-hidden="true">
              <div className="mock-settings">
                <span className="mock-settings-path"><Lock size={13} /> {t("guide.settingsPath")}</span>
                <div className="mock-settings-row">
                  <span>{t("guide.blocked")}</span>
                  <span className="mock-open-anyway">{t("guide.openAnyway")}</span>
                </div>
              </div>
            </div>
          </li>
          <li>
            <div className="guide-text">
              <span className="guide-number">4</span>
              <div><h3>{t("guide.step4Title")}</h3><p>{t("guide.step4")}</p></div>
            </div>
          </li>
        </ol>

        <details className="guide-terminal">
          <summary><Terminal size={16} aria-hidden="true" /> {t("guide.terminalSummary")}</summary>
          <p>{t("guide.terminal")}</p>
          <div className="command">
            <code>{QUARANTINE_COMMAND}</code>
            <button onClick={() => void copyCommand()} aria-label={t("guide.copy")}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              <span>{copied ? t("guide.copied") : t("guide.copy")}</span>
            </button>
          </div>
        </details>

        <p className="guide-why">{t("guide.why")}</p>
        </>}
        <button className="guide-confirm" onClick={() => dialogRef.current?.close()}>{t("guide.gotIt")}</button>
      </div>
    </dialog>
  );
}
