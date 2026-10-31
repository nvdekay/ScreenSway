import { DEFAULT_MUSIC_VOLUME, type BackgroundMusic } from "@screensway/core";
import { Music, Trash2 } from "lucide-react";
import { useI18n } from "../i18n";

/** Music from the user's computer under the whole video: pick a file, set its level, loop it. */
export function MusicPanel({ value, onPick, onChange, busy, error }: {
  value: BackgroundMusic | null;
  onPick: () => void;
  onChange: (value: BackgroundMusic | null) => void;
  busy: boolean;
  error: string | null;
}) {
  const { t } = useI18n();
  return <section className="editor-section music-panel">
    <h3><Music size={15} /> {t("music.title")}</h3>
    <p className="editor-note">{t("music.note")}</p>
    {value ? <>
      <div className="music-file">
        <span title={value.name}>{value.name}</span>
        <button className="editor-button compact icon-only" onClick={() => onChange(null)} aria-label={t("music.remove")} title={t("music.remove")}><Trash2 size={13} /></button>
      </div>
      <label className="editor-slider">
        <span><span>{t("music.volume")}</span><output>{Math.round(value.volume * 100)}%</output></span>
        <input type="range" min={0} max={1} step={0.05} value={value.volume} onChange={(event) => onChange({ ...value, volume: Number(event.target.value) })} />
      </label>
      <label className="audio-toggle compact"><span>{t("music.loop")}</span><input type="checkbox" role="switch" checked={value.loop} onChange={(event) => onChange({ ...value, loop: event.target.checked })} /><span className="switch" /></label>
      <button className="editor-button compact" onClick={onPick} disabled={busy}>{t("music.replace")}</button>
    </> : (
      <button className="editor-button" onClick={onPick} disabled={busy}><Music size={14} aria-hidden="true" /> {t("music.choose")}</button>
    )}
    {error && <p className="editor-note error" role="alert">{error}</p>}
  </section>;
}

export const NEW_MUSIC = { volume: DEFAULT_MUSIC_VOLUME, loop: true };
