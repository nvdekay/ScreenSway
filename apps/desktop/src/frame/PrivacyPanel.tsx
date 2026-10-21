import type { Redaction } from "@screensway/core";
import { EyeOff, Plus, Trash2 } from "lucide-react";
import { useI18n, type MessageKey } from "../i18n";

export function PrivacyPanel({ redactions, onChange }: { redactions: Redaction[]; onChange: (redactions: Redaction[]) => void }) {
  const { t } = useI18n();
  const update = (id: string, patch: Partial<Redaction>) => onChange(redactions.map((item) => {
    if (item.id !== id) return item;
    const next = { ...item, ...patch };
    next.width = Math.min(next.width, 1 - next.x);
    next.height = Math.min(next.height, 1 - next.y);
    next.x = Math.min(next.x, 1 - next.width);
    next.y = Math.min(next.y, 1 - next.height);
    return next;
  }));
  return (
    <section className="editor-section privacy-panel">
      <h3>{t("privacy.title")}</h3>
      <p className="editor-note">{t("privacy.note")}</p>
      {redactions.map((item, index) => (
        <div className="redaction-editor" key={item.id}>
          <div className="redaction-head"><strong>{t("privacy.region", { index: index + 1 })}</strong><button onClick={() => onChange(redactions.filter((candidate) => candidate.id !== item.id))} aria-label={t("privacy.remove")}><Trash2 size={13} /></button></div>
          <div className="chip-row">
            {(["blur", "solid"] as const).map((mode) => <button key={mode} className={`chip${item.mode === mode ? " selected" : ""}`} onClick={() => update(item.id, { mode })}>{t(`privacy.${mode}` as MessageKey)}</button>)}
          </div>
          <div className="redaction-fields">
            {(["x", "y", "width", "height"] as const).map((key) => (
              <label key={key}><span>{t(`source.region.${key}` as MessageKey)}</span><input type="number" min={0} max={1} step={0.01} value={item[key]} onChange={(event) => update(item.id, { [key]: Math.max(0, Math.min(1, Number(event.target.value))) })} /></label>
            ))}
          </div>
        </div>
      ))}
      <button className="editor-button privacy-add" onClick={() => onChange([...redactions, { id: `redaction-${Date.now().toString(36)}`, x: 0.35, y: 0.35, width: 0.3, height: 0.2, mode: "blur" }])}><Plus size={14} /> {t("privacy.add")}</button>
      {redactions.length > 0 && <div className="privacy-status"><EyeOff size={14} /> {t("privacy.active", { count: redactions.length })}</div>}
    </section>
  );
}
