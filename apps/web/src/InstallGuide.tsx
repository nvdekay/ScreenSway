import { ArrowRight, Check, Copy, Folder, Lock, ShieldAlert, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n";
import { LogoMark } from "./LogoMark";

export const INSTALL_GUIDE_EVENT = "screensway:install-guide";
const QUARANTINE_COMMAND = "xattr -dr com.apple.quarantine /Applications/ScreenSway.app";

/** Opens the install guide from anywhere on the page. */
export function openInstallGuide() {
  window.dispatchEvent(new Event(INSTALL_GUIDE_EVENT));
}

/**
 * Shown right after the download starts. The build is not notarized yet, so macOS
 * blocks the first launch; this walks people through it before they hit the wall.
 */
export function InstallGuide({ downloadUrl }: { downloadUrl: string }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const open = () => {
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
        <p className="guide-lead">
          {t("guide.downloading")} <a href={downloadUrl} download>{t("guide.retry")}</a>
        </p>

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
        <button className="guide-confirm" onClick={() => dialogRef.current?.close()}>{t("guide.gotIt")}</button>
      </div>
    </dialog>
  );
}
