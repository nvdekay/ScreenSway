import type { KeystrokeOverlay } from "@screensway/core";
import { Keyboard } from "lucide-react";
import { useI18n, type MessageKey } from "../i18n";

export function KeystrokePanel({ value, onChange, count }: { value: KeystrokeOverlay; onChange: (value: KeystrokeOverlay) => void; count: number }) {
  const { t } = useI18n();
  const choices = <T extends string>(key: keyof KeystrokeOverlay, values: T[]) => (
    <div className="chip-row">{values.map((choice) => <button key={choice} className={`chip${value[key] === choice ? " selected" : ""}`} onClick={() => onChange({ ...value, [key]: choice })}>{t(`keys.${choice}` as MessageKey)}</button>)}</div>
  );
  return <section className="editor-section keystroke-panel">
    <h3><Keyboard size={15} /> {t("keys.title")}</h3>
    <p className="editor-note">{t("keys.note", { count })}</p>
    <label className="audio-toggle compact"><span>{t("keys.show")}</span><input type="checkbox" role="switch" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} /><span className="switch" /></label>
    {value.enabled && <>{choices("position", ["top", "bottom"])}{choices("size", ["small", "medium", "large"])}{choices("theme", ["dark", "light"])}</>}
  </section>;
}
