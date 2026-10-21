import { formatChapters, suggestChapters, suggestTitle, type CaptionLine, type Chapter } from "@screensway/core";
import { Check, Copy, ListOrdered, Wand2 } from "lucide-react";
import { useState } from "react";
import { formatPrecise } from "../format";
import { useI18n } from "../i18n";

/** A title and chapters suggested from what was said, all made on this computer and editable. */
export function ChaptersPanel({ lines, chapters, onChange, toOutput, onRename, onSeek }: {
  lines: CaptionLine[];
  chapters: Chapter[] | undefined;
  onChange: (chapters: Chapter[]) => void;
  /** Recording time to the exported video's time (after cuts and an intro card). */
  toOutput: (timeMs: number) => number;
  onRename: (title: string) => Promise<void>;
  onSeek: (timeMs: number) => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(() => suggestTitle(lines));
  const [renamed, setRenamed] = useState(false);
  const [copied, setCopied] = useState(false);
  const list = chapters ?? [];
  const exported = list.map((chapter, index) => ({ ...chapter, startMs: index === 0 ? 0 : toOutput(chapter.startMs) }));
  return (
    <section className="editor-section chapters-panel">
      <h3><ListOrdered size={15} aria-hidden="true" /> {t("chapters.title")}</h3>
      <p className="editor-note">{t("chapters.note")}</p>
      <div className="chapter-title">
        <input value={title} maxLength={120} aria-label={t("chapters.suggestedName")} onChange={(event) => { setTitle(event.target.value); setRenamed(false); }} />
        <button className="editor-button compact" disabled={!title.trim()} onClick={() => void onRename(title.trim()).then(() => setRenamed(true))}>
          {renamed ? <Check size={13} aria-hidden="true" /> : null} {t(renamed ? "chapters.named" : "chapters.useName")}
        </button>
      </div>
      {list.length === 0 ? (
        <button className="editor-button" onClick={() => onChange(suggestChapters(lines))}><Wand2 size={14} aria-hidden="true" /> {t("chapters.suggest")}</button>
      ) : (
        <>
          <ol className="chapter-list">
            {list.map((chapter, index) => (
              <li key={`${chapter.startMs}-${index}`}>
                <button className="caption-time" onClick={() => onSeek(chapter.startMs)}>{formatPrecise(exported[index].startMs)}</button>
                <input
                  value={chapter.title}
                  maxLength={100}
                  aria-label={t("chapters.edit", { time: formatPrecise(exported[index].startMs) })}
                  onChange={(event) => onChange(list.map((other, position) => (position === index ? { ...other, title: event.target.value } : other)))}
                />
              </li>
            ))}
          </ol>
          <div className="export-done-actions">
            <button
              className="editor-button"
              onClick={() => void navigator.clipboard.writeText(formatChapters(exported)).then(() => setCopied(true)).catch(() => {})}
            >
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} {t(copied ? "export.copied" : "chapters.copy")}
            </button>
            <button className="editor-button" onClick={() => { onChange([]); setCopied(false); }}>{t("chapters.clear")}</button>
          </div>
        </>
      )}
    </section>
  );
}
