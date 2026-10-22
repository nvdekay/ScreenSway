import { Check, X } from "lucide-react";
import { useId, useState } from "react";
import { MAX_FEEDBACK_MESSAGE, SURVEY_FEATURES, type SurveyFeature } from "./feedback";
import { useI18n } from "./i18n";
import { track } from "./telemetry";

/**
 * A small, optional question after an export. Each chosen feature is counted as one
 * anonymous `feature_interest` event (the name only); text written under "Other" is
 * handed to the feedback form for the user to review, never put in an event.
 */
export function FeatureSurvey({ onOther, onDismiss }: {
  /** Opens the feedback form with the user's "Other" text. */
  onOther: (text: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [chosen, setChosen] = useState<SurveyFeature[]>([]);
  const [other, setOther] = useState("");
  const [sent, setSent] = useState(false);

  const toggle = (feature: SurveyFeature) =>
    setChosen((current) => (current.includes(feature) ? current.filter((item) => item !== feature) : [...current, feature]));

  function submit() {
    for (const feature of chosen) track("feature_interest", { feature });
    setSent(true);
    const text = other.trim();
    if (chosen.includes("other") && text) onOther(text);
  }

  if (sent) {
    return (
      <div className="feature-survey" role="status">
        <p className="feature-survey-thanks"><Check size={14} aria-hidden="true" /> {t("survey.thanks")}</p>
      </div>
    );
  }

  return (
    <section className="feature-survey" aria-labelledby={`${id}-title`}>
      <div className="feature-survey-head">
        <div>
          <strong id={`${id}-title`}>{t("survey.title")}</strong>
          <small>{t("survey.hint")}</small>
        </div>
        <button className="icon-button small" onClick={onDismiss} aria-label={t("survey.dismiss")}>
          <X size={15} />
        </button>
      </div>
      <div className="chip-row" role="group" aria-labelledby={`${id}-title`}>
        {SURVEY_FEATURES.map((feature) => (
          <button
            key={feature}
            type="button"
            className={`chip${chosen.includes(feature) ? " selected" : ""}`}
            aria-pressed={chosen.includes(feature)}
            onClick={() => toggle(feature)}
          >
            {t(`survey.feature.${feature}`)}
          </button>
        ))}
      </div>
      {chosen.includes("other") && (
        <label className="feedback-field">
          <span>{t("survey.otherLabel")}</span>
          <input type="text" value={other} maxLength={MAX_FEEDBACK_MESSAGE} onChange={(event) => setOther(event.target.value)} />
          <small>{t("survey.otherHint")}</small>
        </label>
      )}
      <div className="export-done-actions">
        <button className="editor-button accent" disabled={chosen.length === 0} onClick={submit}>{t("survey.submit")}</button>
        <button className="editor-button" onClick={onDismiss}>{t("survey.dismiss")}</button>
      </div>
    </section>
  );
}
