import {
  MESH_PRESETS,
  SOLID_PRESETS,
  type AspectPreset,
  type BackgroundSpec,
  type FrameSettings,
  type FrameStyle,
  type QualityPreset,
} from "@screensway/core";
import { ImagePlus, Sparkles, Wand2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n, type MessageKey } from "../i18n";
import { paintBackground } from "./paint";

type BackgroundTab = "gradient" | "color" | "image" | "magic";

const FRAME_STYLES: { id: FrameStyle; label: MessageKey }[] = [
  { id: "none", label: "frame.style.none" },
  { id: "macos-light", label: "frame.style.macosLight" },
  { id: "macos-dark", label: "frame.style.macosDark" },
  { id: "glass", label: "frame.style.glass" },
  { id: "outline", label: "frame.style.outline" },
];
const ASPECTS: AspectPreset[] = ["auto", "16:9", "4:3", "1:1", "9:16"];
const QUALITIES: QualityPreset[] = ["1080p", "1440p", "4k"];

function tabFor(background: BackgroundSpec): BackgroundTab {
  if (background.kind === "solid") return "color";
  if (background.kind === "image") return "image";
  return "gradient";
}

/** A small canvas painted by the same code as the export, so swatches never lie. */
function Swatch({ background, selected, label, onSelect }: {
  background: BackgroundSpec;
  selected: boolean;
  label: string;
  onSelect: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) paintBackground(context, background, canvas.width, canvas.height, null);
  }, [background]);
  return (
    <button className={`swatch${selected ? " selected" : ""}`} onClick={onSelect} aria-label={label} aria-pressed={selected}>
      <canvas ref={canvasRef} width={96} height={64} />
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="editor-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Slider({ label, value, min, max, step, format, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="editor-slider">
      <span><span>{label}</span><output>{format(value)}</output></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

export function FrameEditor({ settings, onChange, onImage, hasImage, onMagic, magicBackground }: {
  settings: FrameSettings;
  onChange: (patch: Partial<FrameSettings>) => void;
  onImage: (file: File) => void;
  hasImage: boolean;
  onMagic: () => void;
  magicBackground: BackgroundSpec | null;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<BackgroundTab>(() => tabFor(settings.background));
  const fileRef = useRef<HTMLInputElement>(null);
  const sameBackground = (background: BackgroundSpec) => JSON.stringify(background) === JSON.stringify(settings.background);
  const percent = (value: number) => `${Math.round(value * 100)}%`;

  return (
    <div className="frame-editor">
      <Section title={t("frame.background")}>
        <div className="editor-tabs" role="tablist">
          {(["gradient", "color", "image", "magic"] as const).map((id) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "selected" : ""} onClick={() => setTab(id)}>
              {t(`frame.tab.${id}` as MessageKey)}
            </button>
          ))}
        </div>

        {tab === "gradient" && (
          <div className="swatch-grid">
            {MESH_PRESETS.map((preset) => (
              <Swatch
                key={preset.id}
                background={preset.background}
                label={preset.id}
                selected={sameBackground(preset.background)}
                onSelect={() => onChange({ background: preset.background })}
              />
            ))}
          </div>
        )}

        {tab === "color" && (
          <div className="swatch-grid colors">
            {SOLID_PRESETS.map((color) => (
              <button
                key={color}
                className={`color-dot${settings.background.kind === "solid" && settings.background.color === color ? " selected" : ""}`}
                style={{ background: color }}
                aria-label={color}
                onClick={() => onChange({ background: { kind: "solid", color } })}
              />
            ))}
            <label className="color-custom" title={t("frame.customColor")}>
              <input
                type="color"
                value={settings.background.kind === "solid" ? settings.background.color : "#6366f1"}
                onChange={(event) => onChange({ background: { kind: "solid", color: event.target.value } })}
                aria-label={t("frame.customColor")}
              />
            </label>
          </div>
        )}

        {tab === "image" && (
          <div className="editor-image">
            <button className="editor-button" onClick={() => fileRef.current?.click()}>
              <ImagePlus size={16} aria-hidden="true" /> {hasImage ? t("frame.changeImage") : t("frame.chooseImage")}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/heic"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onImage(file);
                event.target.value = "";
              }}
            />
            {settings.background.kind === "image" && (
              <Slider
                label={t("frame.blur")}
                value={settings.background.blur}
                min={0}
                max={1}
                step={0.05}
                format={percent}
                onChange={(blur) => onChange({ background: { kind: "image", blur } })}
              />
            )}
            <p className="editor-note">{t("frame.imageNote")}</p>
          </div>
        )}

        {tab === "magic" && (
          <div className="editor-image">
            <p className="editor-note">{t("frame.magicNote")}</p>
            <button className="editor-button accent" onClick={onMagic}>
              <Wand2 size={16} aria-hidden="true" /> {t("frame.magic")}
            </button>
            {magicBackground && (
              <div className="swatch-grid">
                <Swatch
                  background={magicBackground}
                  label={t("frame.magic")}
                  selected={sameBackground(magicBackground)}
                  onSelect={() => onChange({ background: magicBackground })}
                />
              </div>
            )}
          </div>
        )}

        <label className="editor-check">
          <input type="checkbox" checked={settings.grain} onChange={(event) => onChange({ grain: event.target.checked })} />
          <Sparkles size={14} aria-hidden="true" /> {t("frame.grain")}
        </label>
      </Section>

      <Section title={t("frame.window")}>
        <div className="chip-row">
          {FRAME_STYLES.map((style) => (
            <button key={style.id} className={`chip${settings.frame === style.id ? " selected" : ""}`} onClick={() => onChange({ frame: style.id })}>
              {t(style.label)}
            </button>
          ))}
        </div>
      </Section>

      <Section title={t("frame.layout")}>
        <div className="chip-row">
          {ASPECTS.map((aspect) => (
            <button key={aspect} className={`chip${settings.aspect === aspect ? " selected" : ""}`} onClick={() => onChange({ aspect })}>
              {aspect === "auto" ? t("frame.aspectAuto") : aspect}
            </button>
          ))}
        </div>
        <Slider label={t("frame.padding")} value={settings.padding} min={0} max={0.25} step={0.005} format={percent} onChange={(padding) => onChange({ padding })} />
        <Slider label={t("frame.radius")} value={settings.radius} min={0} max={0.06} step={0.001} format={(value) => `${Math.round((value / 0.06) * 100)}%`} onChange={(radius) => onChange({ radius })} />
        <Slider label={t("frame.shadow")} value={settings.shadow} min={0} max={1} step={0.05} format={percent} onChange={(shadow) => onChange({ shadow })} />
      </Section>

      <Section title={t("frame.quality")}>
        <div className="chip-row">
          {QUALITIES.map((quality) => (
            <button key={quality} className={`chip${settings.quality === quality ? " selected" : ""}`} onClick={() => onChange({ quality })}>
              {quality === "4k" ? "4K" : quality}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}
