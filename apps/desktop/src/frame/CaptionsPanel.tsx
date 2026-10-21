import type { CaptionLine } from "@screensway/core";
import { Captions, Loader2, RotateCcw, RotateCw, Scissors, Trash2, X } from "lucide-react";
import { useState } from "react";
import { formatPrecise } from "../format";
import { useI18n, type MessageKey } from "../i18n";
import type { CaptionLook, CaptionSize, CaptionStyle } from "./captionPaint";

/** Captions saved with a recording in captions.json. */
export interface RecordingCaptions {
  locale: string;
  enabled: boolean;
  lines: CaptionLine[];
}

export type TranscriptionState =
  | { status: "idle" }
  | { status: "running"; progress: number }
  | { status: "failed"; message: string };

const CAPTION_LANGUAGES: { id: string; label: string }[] = [
  { id: "vi-VN", label: "Tiếng Việt" },
  { id: "en-US", label: "English" },
];

const SPEECH_DENIED_MARKER = "SCREENSWAY_SPEECH_DENIED";
const SIZES: CaptionSize[] = ["s", "m", "l"];
const LOOKS: CaptionLook[] = ["dark", "light", "outline"];

export function CaptionsPanel({ captions, transcription, style, defaultLocale, onGenerate, onCancel, onChange, onStyleChange, onSeek, onOpenSettings, onCutCaption, onRemoveSilences, isCut }: {
  captions: RecordingCaptions | null;
  transcription: TranscriptionState;
  style: CaptionStyle;
  defaultLocale: string;
  onGenerate: (locale: string) => void;
  onCancel: () => void;
  onChange: (captions: RecordingCaptions) => void;
  onStyleChange: (patch: Partial<CaptionStyle>) => void;
  onSeek: (timeMs: number) => void;
  onOpenSettings: () => void;
  /** Removes the line's speech and video, or brings them back when already removed. */
  onCutCaption: (line: CaptionLine) => void;
  onRemoveSilences: () => void;
  /** Whether a line is inside a removed part of the timeline. */
  isCut: (line: CaptionLine) => boolean;
}) {
  const { t } = useI18n();
  const [locale, setLocale] = useState(captions?.locale ?? defaultLocale);
  const running = transcription.status === "running";

  return (
    <section className="editor-section captions-panel">
      <h3>{t("captions.title")}</h3>

      {running ? (
        <div className="captions-progress">
          <div className="export-progress" role="progressbar" aria-valuenow={transcription.progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ transform: `scaleX(${transcription.progress / 100})` }} />
          </div>
          <div className="export-row">
            <span className="export-status"><Loader2 size={15} className="spin" aria-hidden="true" /> {t("captions.running", { percent: transcription.progress })}</span>
            <button className="editor-button compact" onClick={onCancel}>
              <X size={13} aria-hidden="true" /> {t("export.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="captions-generate">
          <select className="mic-select" value={locale} onChange={(event) => setLocale(event.target.value)} aria-label={t("captions.language")}>
            {CAPTION_LANGUAGES.map((language) => (
              <option key={language.id} value={language.id}>{language.label}</option>
            ))}
          </select>
          <button className={`editor-button${captions ? "" : " accent"}`} onClick={() => onGenerate(locale)}>
            {captions ? <RotateCw size={15} aria-hidden="true" /> : <Captions size={15} aria-hidden="true" />}
            {captions ? t("captions.regenerate") : t("captions.generate")}
          </button>
        </div>
      )}
      {!captions && !running && <p className="editor-note">{t("captions.note")}</p>}

      {transcription.status === "failed" && (
        <div className="captions-error" role="alert">
          <p>{transcription.message.includes(SPEECH_DENIED_MARKER) ? t("captions.denied") : transcription.message}</p>
          {transcription.message.includes(SPEECH_DENIED_MARKER) && (
            <button className="editor-button compact" onClick={onOpenSettings}>{t("permission.open")}</button>
          )}
        </div>
      )}

      {captions && !running && (
        <>
          <label className="editor-check">
            <input type="checkbox" checked={captions.enabled} onChange={(event) => onChange({ ...captions, enabled: event.target.checked })} />
            {t("captions.show")}
          </label>
          {captions.lines.length === 0 ? (
            <p className="editor-note">{t("captions.empty")}</p>
          ) : (
            <>
              <div className="chip-row">
                {SIZES.map((size) => (
                  <button key={size} className={`chip${style.size === size ? " selected" : ""}`} onClick={() => onStyleChange({ size })}>
                    {t(`captions.size.${size}` as MessageKey)}
                  </button>
                ))}
              </div>
              <div className="chip-row">
                {LOOKS.map((look) => (
                  <button key={look} className={`chip${style.look === look ? " selected" : ""}`} onClick={() => onStyleChange({ look })}>
                    {t(`captions.look.${look}` as MessageKey)}
                  </button>
                ))}
              </div>
              <button className="editor-button captions-cleanup" onClick={onRemoveSilences}><Scissors size={14} /> {t("captions.removeSilences")}</button>
              <ol className="caption-lines">
                {captions.lines.map((line) => {
                  const cut = isCut(line);
                  const label = t(cut ? "captions.restoreLine" : "captions.cutLine", { time: formatPrecise(line.startMs) });
                  return (
                  <li key={line.id} className={cut ? "is-cut" : undefined}>
                    <button className="caption-time" onClick={() => onSeek(line.startMs)} title={t("captions.jump")}>
                      {formatPrecise(line.startMs)}
                    </button>
                    <input
                      value={line.text}
                      aria-label={t("captions.edit", { time: formatPrecise(line.startMs) })}
                      onFocus={() => onSeek(line.startMs)}
                      onChange={(event) => onChange({
                        ...captions,
                        lines: captions.lines.map((other) => (other.id === line.id ? { ...other, text: event.target.value } : other)),
                      })}
                    />
                    <button className="caption-cut" onClick={() => onCutCaption(line)} aria-label={label} title={label}>
                      {cut ? <RotateCcw size={13} aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
                    </button>
                  </li>
                  );
                })}
              </ol>
              <p className="editor-note">{t("captions.srtNote")}</p>
            </>
          )}
        </>
      )}
    </section>
  );
}
