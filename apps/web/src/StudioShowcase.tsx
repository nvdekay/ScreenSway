import { Check, Captions, Film, SlidersHorizontal, Sparkles } from "lucide-react";
import { useState } from "react";
import { BUILT_IN_STYLES, type FrameSettings, type FrameStyle } from "@screensway/core";
import { Demo } from "./Demo";
import { RecordingFrame } from "./RecordingFrame";
import { useI18n } from "./i18n";

const CONTENT = {
  en: {
    label: "Interactive Studio illustration", project: "Your next product walkthrough", studio: "ScreenSway Studio",
    styles: "Make it yours", stylesCopy: "One recording. A whole new look.", tryStyle: "Try a style", caption: "Show sample captions",
    sample: "A little focus makes a big difference.", note: "Interactive illustration · explore styles and auto zoom", export: "MP4 · up to 4K · 60 fps",
  },
  vi: {
    label: "Minh họa Studio tương tác", project: "Video giới thiệu sản phẩm tiếp theo", studio: "ScreenSway Studio",
    styles: "Mang dấu ấn của bạn", stylesCopy: "Một bản quay. Nhiều diện mạo.", tryStyle: "Thử một phong cách", caption: "Hiện phụ đề mẫu",
    sample: "Tập trung đúng chỗ. Khác biệt rõ ràng.", note: "Minh họa tương tác · thử style và tự zoom", export: "MP4 · đến 4K · 60 fps",
  },
};

const STYLE_NAMES: Record<"en" | "vi", Record<string, string>> = {
  en: { studio: "Studio", clean: "Clean", product: "MacBook", web: "Website", social: "Social" },
  vi: { studio: "Studio", clean: "Tối giản", product: "MacBook", web: "Website", social: "Mạng xã hội" },
};
const FRAME_NAMES: Record<"en" | "vi", Record<FrameStyle, string>> = {
  en: { none: "None", "macos-light": "macOS light", "macos-dark": "macOS dark", "browser-light": "Browser light", "browser-dark": "Browser dark", macbook: "MacBook", glass: "Glass", outline: "Outline" },
  vi: { none: "Không", "macos-light": "macOS sáng", "macos-dark": "macOS tối", "browser-light": "Trình duyệt sáng", "browser-dark": "Trình duyệt tối", macbook: "MacBook", glass: "Kính", outline: "Viền" },
};

export function StudioShowcase() {
  const { language } = useI18n();
  const c = CONTENT[language];
  const [look, setLook] = useState(BUILT_IN_STYLES[0].id);
  const [frameOverride, setFrameOverride] = useState<FrameStyle | null>(null);
  const [captions, setCaptions] = useState(false);
  const preset = BUILT_IN_STYLES.find((style) => style.id === look) ?? BUILT_IN_STYLES[0];
  const settings: FrameSettings = { ...preset.settings, frame: frameOverride ?? preset.settings.frame, quality: "1080p" };
  return (
    <div className="studio-showcase" role="region" aria-label={c.label} data-look={look}>
      <div className="studio-titlebar">
        <span className="studio-window-dots" aria-hidden="true"><i /><i /><i /></span>
        <span>{c.studio} <span className="studio-project">/ {c.project}</span></span>
        <span className="studio-export-label"><Film size={14} aria-hidden="true" /> {c.export}</span>
      </div>
      <div className="studio-workspace">
        <div className="studio-live-preview">
          <Demo showCaptions={captions} settings={settings} />
        </div>
        <aside className="studio-style-panel">
          <span className="studio-panel-label"><SlidersHorizontal size={16} aria-hidden="true" /> {c.styles}</span>
          <p>{c.stylesCopy}</p>
          <div className="studio-looks" role="group" aria-label={c.tryStyle}>
            {BUILT_IN_STYLES.map((style) => (
              <button key={style.id} aria-pressed={look === style.id && settings.frame === style.settings.frame} onClick={() => { setLook(style.id); setFrameOverride(null); }} className="studio-look" data-style={style.id}>
                <RecordingFrame settings={{ ...style.settings, quality: "1080p" }} thumbnail />
                <span>{STYLE_NAMES[language][style.id]}</span>
                {look === style.id && settings.frame === style.settings.frame && <Check size={15} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <fieldset className="studio-frame-picker">
            <legend>{language === "vi" ? "Khung cửa sổ" : "Window frame"}</legend>
            <div className="studio-frame-options">
              {(Object.keys(FRAME_NAMES.en) as FrameStyle[]).map((frame) => (
                <button key={frame} aria-pressed={settings.frame === frame} data-frame-option={frame} onClick={() => setFrameOverride(frame)}>{FRAME_NAMES[language][frame]}</button>
              ))}
            </div>
          </fieldset>
          <button className="studio-caption-toggle" aria-pressed={captions} onClick={() => setCaptions(!captions)}>
            <Captions size={18} aria-hidden="true" /> {c.caption}<span className="mini-switch" aria-hidden="true" />
          </button>
        </aside>
      </div>
      <p className="studio-demo-note"><Sparkles size={13} aria-hidden="true" />{c.note}</p>
    </div>
  );
}
