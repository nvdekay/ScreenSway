import { ChevronDown, HelpCircle } from "lucide-react";
import { useId, useState } from "react";
import { CONTACT_MAILTO } from "./contact";
import { useI18n, type MessageKey } from "./i18n";

const QUESTIONS: [MessageKey, MessageKey][] = [
  ["faq.q1", "faq.a1"],
  ["faq.q2", "faq.a2"],
  ["faq.q3", "faq.a3"],
  ["faq.q7", "faq.a7"],
  ["faq.q9", "faq.a9"],
];

export function Faq() {
  const { t } = useI18n();
  const baseId = useId();
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section className="faq" id="faq">
      <div className="faq-intro" data-reveal>
        <span className="faq-badge"><HelpCircle size={15} aria-hidden="true" /> {t("faq.kicker")}</span>
        <h2>{t("faq.title")}</h2>
        <p>
          {t("faq.more")} <a href={CONTACT_MAILTO}>{t("faq.email")}</a>.
        </p>
      </div>

      <div className="faq-list" data-reveal>
        {QUESTIONS.map(([question, answer], index) => {
          const open = openIndex === index;
          const buttonId = `${baseId}-q${index}`;
          const panelId = `${baseId}-a${index}`;
          return (
            <div key={question} className={`faq-item${open ? " open" : ""}`}>
              <h3>
                <button
                  id={buttonId}
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => setOpenIndex(open ? null : index)}
                >
                  <span>{t(question)}</span>
                  <span className="faq-chevron" aria-hidden="true"><ChevronDown size={16} /></span>
                </button>
              </h3>
              <div id={panelId} role="region" aria-labelledby={buttonId} className="faq-answer" inert={!open}>
                <div><p>{t(answer)}</p></div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
