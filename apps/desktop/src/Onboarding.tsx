import { Check, ChevronRight, Lock, Mic, Monitor, Sparkles, Subtitles, X } from "lucide-react";
import { useState } from "react";
import { useI18n } from "./i18n";

export type ScreenCheck = "idle" | "checking" | "ready" | "denied" | "error";

export function Onboarding({
  screenCheck,
  sourceCount,
  onCheckScreen,
  onOpenScreenSettings,
  onComplete,
  onTestRecording,
  canClose,
}: {
  screenCheck: ScreenCheck;
  sourceCount: number;
  onCheckScreen: () => void;
  onOpenScreenSettings: () => void;
  onComplete: () => void;
  onTestRecording: () => void;
  canClose: boolean;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);

  return (
    <div className="onboarding-backdrop" role="presentation">
      <section className="onboarding-card glass" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        {canClose && (
          <button className="icon-button onboarding-close" onClick={onComplete} aria-label={t("onboarding.close")}>
            <X size={18} />
          </button>
        )}

        <div className="onboarding-progress" aria-label={t("onboarding.progress", { current: step + 1 })}>
          {[0, 1, 2].map((item) => <span key={item} className={item <= step ? "active" : ""} />)}
        </div>

        {step === 0 && (
          <div className="onboarding-step">
            <span className="onboarding-hero" aria-hidden="true"><Sparkles size={28} /></span>
            <span className="eyebrow">{t("onboarding.eyebrow")}</span>
            <h1 id="onboarding-title">{t("onboarding.welcome")}</h1>
            <p>{t("onboarding.intro")}</p>
            <div className="onboarding-promise">
              <Lock size={18} aria-hidden="true" />
              <span><strong>{t("onboarding.localTitle")}</strong><small>{t("onboarding.localBody")}</small></span>
            </div>
            <button className="record-button onboarding-primary" onClick={() => setStep(1)}>
              {t("onboarding.continue")} <ChevronRight size={17} aria-hidden="true" />
            </button>
          </div>
        )}

        {step === 1 && (
          <div className="onboarding-step">
            <span className="onboarding-hero" aria-hidden="true"><Monitor size={28} /></span>
            <span className="eyebrow">{t("onboarding.screenEyebrow")}</span>
            <h1 id="onboarding-title">{t("onboarding.screenTitle")}</h1>
            <p>{t("onboarding.screenBody")}</p>

            <div className={`onboarding-check ${screenCheck}`} aria-live="polite">
              <span>{screenCheck === "ready" ? <Check size={18} /> : <Monitor size={18} />}</span>
              <div>
                <strong>{t(screenCheck === "ready" ? "onboarding.screenReady" : screenCheck === "checking" ? "onboarding.screenChecking" : screenCheck === "denied" ? "onboarding.screenDenied" : screenCheck === "error" ? "onboarding.screenError" : "onboarding.screenNeeded")}</strong>
                <small>{screenCheck === "ready" ? t("onboarding.sourcesFound", { count: sourceCount }) : t("onboarding.screenWhenNeeded")}</small>
              </div>
            </div>

            {screenCheck === "denied" && (
              <button className="secondary-button onboarding-settings" onClick={onOpenScreenSettings}>{t("permission.open")}</button>
            )}
            <div className="onboarding-actions">
              {screenCheck !== "ready" && (
                <button className="record-button onboarding-primary" disabled={screenCheck === "checking"} onClick={onCheckScreen}>
                  {t(screenCheck === "checking" ? "onboarding.screenChecking" : "onboarding.checkScreen")}
                </button>
              )}
              {screenCheck === "ready" && (
                <button className="record-button onboarding-primary" onClick={() => setStep(2)}>
                  {t("onboarding.continue")} <ChevronRight size={17} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboarding-step">
            <span className="onboarding-hero" aria-hidden="true"><Mic size={28} /></span>
            <span className="eyebrow">{t("onboarding.optionalEyebrow")}</span>
            <h1 id="onboarding-title">{t("onboarding.optionalTitle")}</h1>
            <p>{t("onboarding.optionalBody")}</p>
            <div className="onboarding-options">
              <div><Mic size={18} aria-hidden="true" /><span><strong>{t("onboarding.microphoneTitle")}</strong><small>{t("onboarding.microphoneBody")}</small></span></div>
              <div><Subtitles size={18} aria-hidden="true" /><span><strong>{t("onboarding.speechTitle")}</strong><small>{t("onboarding.speechBody")}</small></span></div>
            </div>
            <div className="onboarding-actions split">
              <button className="secondary-button" onClick={onTestRecording}>{t("onboarding.test")}</button>
              <button className="record-button onboarding-primary" onClick={onComplete}>{t("onboarding.finish")}</button>
            </div>
            <small className="onboarding-test-note">{t("onboarding.testNote")}</small>
          </div>
        )}
      </section>
    </div>
  );
}
