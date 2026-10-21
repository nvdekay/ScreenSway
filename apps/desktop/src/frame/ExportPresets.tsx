import type { FrameSettings } from "@screensway/core";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { useI18n, type MessageKey } from "../i18n";

type PresetSettings = Pick<FrameSettings, "aspect" | "quality" | "fill">;
interface SavedPreset extends PresetSettings { id: string; name: string }

/** Ready-made shapes for where the video goes. */
export const EXPORT_PRESETS: { id: "docs" | "social" | "square"; settings: PresetSettings }[] = [
  { id: "docs", settings: { aspect: "16:9", quality: "1440p", fill: false } },
  { id: "social", settings: { aspect: "9:16", quality: "1080p", fill: true } },
  { id: "square", settings: { aspect: "1:1", quality: "1080p", fill: true } },
];

const STORAGE_KEY = "screensway.exportPresets";

function loadSaved(): SavedPreset[] {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((item) => item && typeof item.id === "string" && typeof item.name === "string") : [];
  } catch {
    return [];
  }
}

const matches = (settings: FrameSettings, preset: PresetSettings) =>
  settings.aspect === preset.aspect && settings.quality === preset.quality && Boolean(settings.fill) === Boolean(preset.fill);

export function ExportPresets({ settings, onApply }: { settings: FrameSettings; onApply: (settings: PresetSettings) => void }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState(loadSaved);
  const store = (next: SavedPreset[]) => {
    setSaved(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* kept for this session */ }
  };
  const current = { aspect: settings.aspect, quality: settings.quality, fill: settings.fill ?? false };
  const isNew = !EXPORT_PRESETS.some((preset) => matches(settings, preset.settings)) && !saved.some((preset) => matches(settings, preset));
  return (
    <div className="export-presets" aria-label={t("presets.label")}>
      {EXPORT_PRESETS.map((preset) => (
        <button key={preset.id} className={`chip${matches(settings, preset.settings) ? " selected" : ""}`} onClick={() => onApply(preset.settings)}>
          {t(`presets.${preset.id}` as MessageKey)}
        </button>
      ))}
      {saved.map((preset) => (
        <span key={preset.id} className={`chip saved-preset${matches(settings, preset) ? " selected" : ""}`}>
          <button onClick={() => onApply(preset)}>{preset.name}</button>
          <button aria-label={t("presets.remove", { name: preset.name })} onClick={() => store(saved.filter((item) => item.id !== preset.id))}><X size={11} aria-hidden="true" /></button>
        </span>
      ))}
      {isNew && (
        <button
          className="chip"
          onClick={() => store([...saved, { ...current, id: `preset-${Date.now().toString(36)}`, name: `${current.aspect === "auto" ? t("frame.aspectAuto") : current.aspect} · ${current.quality}` }])}
        >
          <Plus size={11} aria-hidden="true" /> {t("presets.save")}
        </button>
      )}
    </div>
  );
}
