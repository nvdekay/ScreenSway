import { paintBackground, type FrameLayout, type FrameSettings } from "@screensway/core";

export type LogoCorner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

export interface TitleCard {
  enabled: boolean;
  title: string;
  subtitle: string;
}

/** Pieces added to every export without re-recording, kept on this computer. */
export interface BrandKit {
  /** A logo saved in Movies › ScreenSway › Brand. */
  logoPath: string | null;
  showLogo: boolean;
  logoCorner: LogoCorner;
  /** Width as a fraction of the frame's shorter side. */
  logoSize: number;
  intro: TitleCard;
  outro: TitleCard;
}

export const DEFAULT_BRAND: BrandKit = {
  logoPath: null,
  showLogo: true,
  logoCorner: "topRight",
  logoSize: 0.12,
  intro: { enabled: false, title: "", subtitle: "" },
  outro: { enabled: false, title: "", subtitle: "" },
};

/** How long a title card stays on screen. */
export const CARD_MS = 2_000;

const STORAGE_KEY = "screensway.brand";
const FONT_FAMILY = `"Plus Jakarta Sans Variable", system-ui, sans-serif`;

export function loadBrand(): BrandKit {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<BrandKit> | null;
    if (!stored || typeof stored !== "object") return DEFAULT_BRAND;
    const card = (value: unknown, fallback: TitleCard): TitleCard => {
      const item = value as Partial<TitleCard> | null;
      return item && typeof item.enabled === "boolean" && typeof item.title === "string" && typeof item.subtitle === "string"
        ? { enabled: item.enabled, title: item.title.slice(0, 120), subtitle: item.subtitle.slice(0, 160) } : fallback;
    };
    return {
      logoPath: typeof stored.logoPath === "string" ? stored.logoPath : null,
      showLogo: typeof stored.showLogo === "boolean" ? stored.showLogo : true,
      logoCorner: ["topLeft", "topRight", "bottomLeft", "bottomRight"].includes(stored.logoCorner as string) ? stored.logoCorner as LogoCorner : "topRight",
      logoSize: typeof stored.logoSize === "number" && Number.isFinite(stored.logoSize) ? Math.min(0.4, Math.max(0.04, stored.logoSize)) : DEFAULT_BRAND.logoSize,
      intro: card(stored.intro, DEFAULT_BRAND.intro),
      outro: card(stored.outro, DEFAULT_BRAND.outro),
    };
  } catch {
    return DEFAULT_BRAND;
  }
}

export function saveBrand(brand: BrandKit) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(brand));
  } catch {
    // Kept for this session.
  }
}

/** Where the logo sits on a frame, in output pixels (also used by the preview, as fractions). */
export function logoRect(brand: BrandKit, logo: { width: number; height: number }, layout: FrameLayout) {
  const short = Math.min(layout.width, layout.height);
  const width = Math.round(short * brand.logoSize);
  const height = Math.round((width * logo.height) / Math.max(1, logo.width));
  const margin = Math.round(short * 0.04);
  const left = brand.logoCorner === "topLeft" || brand.logoCorner === "bottomLeft";
  const top = brand.logoCorner === "topLeft" || brand.logoCorner === "topRight";
  return { x: left ? margin : layout.width - margin - width, y: top ? margin : layout.height - margin - height, width, height };
}

export function paintLogo(brand: BrandKit, logo: HTMLImageElement, layout: FrameLayout) {
  const box = logoRect(brand, { width: logo.naturalWidth, height: logo.naturalHeight }, layout);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, box.width);
  canvas.height = Math.max(1, box.height);
  const context = canvas.getContext("2d")!;
  context.imageSmoothingQuality = "high";
  context.drawImage(logo, 0, 0, canvas.width, canvas.height);
  return { canvas, x: box.x, y: box.y };
}

/** A full-frame title card on the style's background, with the logo above the text. */
export function paintCard(card: TitleCard, layout: FrameLayout, settings: FrameSettings, background: CanvasImageSource | null, logo: HTMLImageElement | null): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.height;
  const context = canvas.getContext("2d")!;
  paintBackground(context, settings.background, layout.width, layout.height, background);
  const short = Math.min(layout.width, layout.height);
  const titleSize = Math.round(short * 0.075);
  const subtitleSize = Math.round(short * 0.036);
  let y = layout.height / 2;
  if (logo) {
    const width = short * 0.16;
    const height = (width * logo.naturalHeight) / Math.max(1, logo.naturalWidth);
    context.drawImage(logo, (layout.width - width) / 2, y - titleSize * 1.4 - height, width, height);
  }
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#ffffff";
  context.shadowColor = "rgba(0, 0, 0, 0.35)";
  context.shadowBlur = short * 0.02;
  context.font = `700 ${titleSize}px ${FONT_FAMILY}`;
  fitText(context, card.title, layout.width * 0.84, titleSize, 700);
  context.fillText(card.title, layout.width / 2, y);
  if (card.subtitle) {
    y += titleSize * 1.1;
    context.globalAlpha = 0.82;
    fitText(context, card.subtitle, layout.width * 0.84, subtitleSize, 500);
    context.fillText(card.subtitle, layout.width / 2, y);
  }
  return canvas;
}

function fitText(context: CanvasRenderingContext2D, text: string, maxWidth: number, size: number, weight: number) {
  let current = size;
  context.font = `${weight} ${current}px ${FONT_FAMILY}`;
  while (current > 10 && context.measureText(text).width > maxWidth) {
    current *= 0.92;
    context.font = `${weight} ${current}px ${FONT_FAMILY}`;
  }
}
