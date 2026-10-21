import { ImagePlus, Sparkles, Trash2 } from "lucide-react";
import { useRef } from "react";
import { useI18n, type MessageKey } from "../i18n";
import type { BrandKit, LogoCorner, TitleCard } from "./brand";
import { Slider } from "./FrameEditor";

const CORNERS: LogoCorner[] = ["topLeft", "topRight", "bottomLeft", "bottomRight"];

/** The logo and intro/outro cards, saved on this computer and added to every export. */
export function BrandPanel({ brand, logo, onChange, onLogo }: {
  brand: BrandKit;
  /** The loaded logo, as a data URL. */
  logo: string | null;
  onChange: (brand: BrandKit) => void;
  onLogo: (file: File) => void;
}) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const card = (key: "intro" | "outro", value: TitleCard) => (
    <div className="brand-card">
      <label className="audio-toggle compact">
        <span>{t(key === "intro" ? "brand.intro" : "brand.outro")}<small>{t("brand.cardHint")}</small></span>
        <input type="checkbox" role="switch" checked={value.enabled} onChange={(event) => onChange({ ...brand, [key]: { ...value, enabled: event.target.checked } })} />
        <span className="switch" aria-hidden="true" />
      </label>
      {value.enabled && (
        <div className="brand-fields">
          <input value={value.title} maxLength={120} placeholder={t("brand.title")} aria-label={t("brand.title")} onChange={(event) => onChange({ ...brand, [key]: { ...value, title: event.target.value } })} />
          <input value={value.subtitle} maxLength={160} placeholder={t("brand.subtitle")} aria-label={t("brand.subtitle")} onChange={(event) => onChange({ ...brand, [key]: { ...value, subtitle: event.target.value } })} />
        </div>
      )}
    </div>
  );
  return (
    <section className="editor-section brand-panel">
      <h3><Sparkles size={15} aria-hidden="true" /> {t("brand.heading")}</h3>
      <p className="editor-note">{t("brand.note")}</p>
      <div className="brand-logo">
        {logo ? <img src={logo} alt="" /> : <span className="brand-logo-empty" aria-hidden="true"><ImagePlus size={16} /></span>}
        <button className="editor-button" onClick={() => fileRef.current?.click()}>{t(logo ? "brand.replaceLogo" : "brand.chooseLogo")}</button>
        {logo && (
          <button className="icon-button small" aria-label={t("brand.removeLogo")} title={t("brand.removeLogo")} onClick={() => onChange({ ...brand, logoPath: null })}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onLogo(file);
            event.target.value = "";
          }}
        />
      </div>
      {logo && (
        <>
          <label className="audio-toggle compact">
            <span>{t("brand.showLogo")}</span>
            <input type="checkbox" role="switch" checked={brand.showLogo} onChange={(event) => onChange({ ...brand, showLogo: event.target.checked })} />
            <span className="switch" aria-hidden="true" />
          </label>
          {brand.showLogo && (
            <>
              <div className="chip-row">
                {CORNERS.map((corner) => (
                  <button key={corner} className={`chip${brand.logoCorner === corner ? " selected" : ""}`} onClick={() => onChange({ ...brand, logoCorner: corner })}>
                    {t(`camera.${corner}` as MessageKey)}
                  </button>
                ))}
              </div>
              <Slider label={t("camera.size")} value={brand.logoSize} min={0.04} max={0.3} step={0.01} format={(size) => `${Math.round(size * 100)}%`} onChange={(logoSize) => onChange({ ...brand, logoSize })} />
            </>
          )}
        </>
      )}
      {card("intro", brand.intro)}
      {card("outro", brand.outro)}
    </section>
  );
}
