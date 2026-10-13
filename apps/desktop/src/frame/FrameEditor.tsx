import {
  BUILT_IN_STYLES,
  computeLayout,
  MESH_PRESETS,
  omitQuality,
  SOLID_PRESETS,
  WAVE_PRESETS,
  type AspectPreset,
  type BackgroundSpec,
  type FrameSettings,
  type FrameStyle,
  type QualityPreset,
} from "@screensway/core";
import { Check, ImagePlus, Plus, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n, type MessageKey } from "../i18n";
import { paintBackground, paintFrameBase } from "./paint";
import { createStyle, loadStyles, sameLook, storeStyles, type SavedStyle } from "./styles";
import { track } from "../telemetry";

export interface RecentImage {
  path: string;
  thumbnail: string;
}

type BackgroundTab = "gradient" | "color" | "image" | "magic";

const FRAME_STYLES: { id: FrameStyle; label: MessageKey }[] = [
  { id: "none", label: "frame.style.none" },
  { id: "macos-light", label: "frame.style.macosLight" },
  { id: "macos-dark", label: "frame.style.macosDark" },
  { id: "browser-light", label: "frame.style.browserLight" },
  { id: "browser-dark", label: "frame.style.browserDark" },
  { id: "macbook", label: "frame.style.macbook" },
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

/** A miniature of the whole frame, painted by the export's own code. */
function StylePreview({ settings, thumbnail }: { settings: Omit<FrameSettings, "quality">; thumbnail?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  // Image styles show their saved image's thumbnail, which is plenty at this size.
  useEffect(() => {
    if (!thumbnail) return setImage(null);
    const loaded = new Image();
    loaded.onload = () => setImage(loaded);
    loaded.src = thumbnail;
  }, [thumbnail]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const full = { ...settings, quality: "1080p" as const };
    const layout = computeLayout({ ...full, aspect: "auto" }, { width: 1600, height: 1000 }, canvas.height);
    paintFrameBase(context, layout, full, image);
    // Stand-in app content, so the card reads as a recording in its frame.
    const { video } = layout;
    context.save();
    context.beginPath();
    context.roundRect(video.x, video.y, video.width, video.height, layout.roundVideoTop ? layout.videoRadius : [0, 0, layout.videoRadius, layout.videoRadius]);
    context.clip();
    context.fillStyle = "#f4f4f7";
    context.fillRect(video.x, video.y, video.width, video.height);
    context.fillStyle = "#d9d9e3";
    context.fillRect(video.x, video.y, video.width * 0.22, video.height);
    context.fillStyle = "#c7c8f5";
    context.fillRect(video.x + video.width * 0.3, video.y + video.height * 0.2, video.width * 0.5, video.height * 0.12);
    context.fillStyle = "#e4e4ec";
    context.fillRect(video.x + video.width * 0.3, video.y + video.height * 0.42, video.width * 0.6, video.height * 0.38);
    context.restore();
  }, [image, settings]);
  return <canvas ref={canvasRef} width={176} height={110} />;
}

function imageThumbnail(background: BackgroundSpec, images: RecentImage[]): string | undefined {
  return background.kind === "image" ? images.find((image) => image.path === background.path)?.thumbnail : undefined;
}

function StylesSection({ settings, onChange, recentImages }: {
  settings: FrameSettings;
  onChange: (patch: Partial<FrameSettings>) => void;
  recentImages: RecentImage[];
}) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<SavedStyle[]>(loadStyles);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const look = omitQuality(settings);
  const update = (next: SavedStyle[]) => {
    setSaved(next);
    storeStyles(next);
  };
  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    update([createStyle(trimmed, settings), ...saved]);
    setNaming(false);
    setName("");
  };
  const alreadySaved = saved.some((style) => sameLook(style.settings, look));

  return (
    <Section title={t("frame.styles")}>
      <div className="style-grid">
        {saved.map((style) => (
          <div key={style.id} className={`style-card${sameLook(style.settings, look) ? " selected" : ""}`}>
            <button className="style-apply" onClick={() => { onChange(style.settings); track("style_applied", { style: "custom" }); }} aria-pressed={sameLook(style.settings, look)}>
              <StylePreview
                settings={style.settings}
                thumbnail={imageThumbnail(style.settings.background, recentImages)}
              />
              <span>{style.name}</span>
            </button>
            <button
              className="style-delete"
              onClick={() => update(saved.filter((other) => other.id !== style.id))}
              aria-label={t("frame.deleteStyle", { name: style.name })}
              title={t("frame.deleteStyle", { name: style.name })}
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        ))}
        {BUILT_IN_STYLES.map((style) => (
          <div key={style.id} className={`style-card${sameLook(style.settings, look) ? " selected" : ""}`}>
            <button className="style-apply" onClick={() => { onChange(style.settings); track("style_applied", { style: style.id }); }} aria-pressed={sameLook(style.settings, look)}>
              <StylePreview settings={style.settings} />
              <span>{t(`style.${style.id}` as MessageKey)}</span>
            </button>
          </div>
        ))}
      </div>
      {naming ? (
        <form
          className="style-name"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input
            autoFocus
            value={name}
            maxLength={32}
            placeholder={t("frame.styleName")}
            aria-label={t("frame.styleName")}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setNaming(false);
            }}
          />
          <button type="submit" className="editor-button accent icon" disabled={!name.trim()} aria-label={t("frame.saveStyle")}>
            <Check size={15} aria-hidden="true" />
          </button>
          <button type="button" className="editor-button icon" onClick={() => setNaming(false)} aria-label={t("hud.cancel")}>
            <X size={15} aria-hidden="true" />
          </button>
        </form>
      ) : (
        <button className="editor-button style-save" onClick={() => setNaming(true)} disabled={alreadySaved}>
          <Plus size={15} aria-hidden="true" /> {alreadySaved ? t("frame.styleSaved") : t("frame.saveStyle")}
        </button>
      )}
    </Section>
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

export function FrameEditor({ settings, onChange, onImage, hasImage, onMagic, magicBackground, recentImages, onRecentImage, onDeleteRecentImage, children }: {
  settings: FrameSettings;
  onChange: (patch: Partial<FrameSettings>) => void;
  onImage: (file: File) => void;
  hasImage: boolean;
  onMagic: () => void;
  magicBackground: BackgroundSpec | null;
  recentImages: RecentImage[];
  onRecentImage: (path: string) => void;
  onDeleteRecentImage: (path: string) => void;
  /** Recording-specific sections shown above the look settings. */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<BackgroundTab>(() => tabFor(settings.background));
  const fileRef = useRef<HTMLInputElement>(null);
  const sameBackground = (background: BackgroundSpec) => JSON.stringify(background) === JSON.stringify(settings.background);
  const percent = (value: number) => `${Math.round(value * 100)}%`;

  return (
    <div className="frame-editor">
      {children}
      <StylesSection settings={settings} onChange={onChange} recentImages={recentImages} />

      <Section title={t("frame.background")}>
        <div className="editor-tabs" role="tablist">
          {(["gradient", "color", "image", "magic"] as const).map((id) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "selected" : ""} onClick={() => setTab(id)}>
              {t(`frame.tab.${id}` as MessageKey)}
            </button>
          ))}
        </div>

        {tab === "gradient" && (
          <>
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
            <h4 className="swatch-heading">{t("frame.waves")}</h4>
            <div className="swatch-grid">
              {WAVE_PRESETS.map((preset) => (
                <Swatch
                  key={preset.id}
                  background={preset.background}
                  label={preset.id}
                  selected={sameBackground(preset.background)}
                  onSelect={() => onChange({ background: preset.background })}
                />
              ))}
            </div>
          </>
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
        {tab === "color" && <CustomGradient background={settings.background} onChange={(background) => onChange({ background })} />}

        {tab === "image" && (
          <div className="editor-image">
            {recentImages.length > 0 && (
              <div className="swatch-grid recent-images">
                {recentImages.map((image) => {
                  const selected = settings.background.kind === "image" && settings.background.path === image.path;
                  return (
                    <div key={image.path} className={`recent-image${selected ? " selected" : ""}`}>
                      <button className="swatch-image" onClick={() => onRecentImage(image.path)} aria-pressed={selected} aria-label={t("frame.useImage")}>
                        <img src={image.thumbnail} alt="" />
                      </button>
                      <button className="style-delete" onClick={() => onDeleteRecentImage(image.path)} aria-label={t("frame.deleteImage")} title={t("frame.deleteImage")}>
                        <Trash2 size={11} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <button className="editor-button" onClick={() => fileRef.current?.click()}>
              <ImagePlus size={16} aria-hidden="true" /> {hasImage || recentImages.length > 0 ? t("frame.addImage") : t("frame.chooseImage")}
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
                onChange={(blur) => onChange({ background: { ...settings.background, kind: "image", blur } })}
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

/** Two colors and an angle; edits the current gradient or starts one from the current color. */
function CustomGradient({ background, onChange }: { background: BackgroundSpec; onChange: (background: BackgroundSpec) => void }) {
  const { t } = useI18n();
  const current = background.kind === "linear" && background.stops.length === 2
    ? { from: background.stops[0].color, to: background.stops[1].color, angle: background.angle }
    : { from: background.kind === "solid" ? background.color : "#6366f1", to: "#ec4899", angle: 135 };
  const apply = (patch: Partial<typeof current>) => {
    const next = { ...current, ...patch };
    onChange({ kind: "linear", angle: next.angle, stops: [{ offset: 0, color: next.from }, { offset: 1, color: next.to }] });
  };
  return (
    <div className="custom-gradient">
      <h4 className="swatch-heading">{t("frame.customGradient")}</h4>
      <div className="custom-gradient-row">
        <label className="color-custom gradient-stop" title={t("frame.gradientFrom")} style={{ background: current.from }}>
          <input type="color" value={current.from} aria-label={t("frame.gradientFrom")} onChange={(event) => apply({ from: event.target.value })} />
        </label>
        <span className="custom-gradient-bar" style={{ background: `linear-gradient(${current.angle}deg, ${current.from}, ${current.to})` }} />
        <label className="color-custom gradient-stop" title={t("frame.gradientTo")} style={{ background: current.to }}>
          <input type="color" value={current.to} aria-label={t("frame.gradientTo")} onChange={(event) => apply({ to: event.target.value })} />
        </label>
      </div>
      <Slider label={t("frame.gradientAngle")} value={current.angle} min={0} max={360} step={5} format={(value) => `${value}°`} onChange={(angle) => apply({ angle })} />
    </div>
  );
}
