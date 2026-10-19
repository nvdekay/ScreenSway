import type { FrameLayout } from "@screensway/core";

export type CaptionSize = "s" | "m" | "l";
export type CaptionLook = "dark" | "light" | "outline";

export interface CaptionStyle {
  size: CaptionSize;
  look: CaptionLook;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = { size: "m", look: "dark" };

/** Font size as a fraction of the output height. */
const SIZE_RATIO: Record<CaptionSize, number> = { s: 0.034, m: 0.043, l: 0.054 };
const FONT_FAMILY = `"Plus Jakarta Sans Variable", system-ui, sans-serif`;
const MAX_LINES = 2;

interface PaintedCaption {
  canvas: HTMLCanvasElement;
  /** Top-left corner in layout pixels. */
  x: number;
  y: number;
}

/** The bundled font must be loaded before a canvas can draw with it. */
export async function loadCaptionFont() {
  try {
    await document.fonts.load(`600 32px ${FONT_FAMILY}`, "Ảnh chụp màn hình");
  } catch {
    // Falls back to the system font.
  }
}

/**
 * Draws one caption the same way for the preview and the export: centered near the
 * bottom of the video, wrapped to at most two lines (shrinking the text if needed).
 */
export function paintCaption(text: string, layout: FrameLayout, style: CaptionStyle): PaintedCaption | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const measure = document.createElement("canvas").getContext("2d")!;
  const maxWidth = layout.video.width * 0.86;

  let fontSize = Math.max(10, layout.height * SIZE_RATIO[style.size]);
  let lines = wrap(measure, clean, fontSize, maxWidth);
  while (lines.length > MAX_LINES && fontSize > 10) {
    fontSize *= 0.9;
    lines = wrap(measure, clean, fontSize, maxWidth);
  }

  measure.font = font(fontSize);
  const lineHeight = fontSize * 1.28;
  const paddingX = style.look === "outline" ? fontSize * 0.2 : fontSize * 0.55;
  const paddingY = style.look === "outline" ? fontSize * 0.2 : fontSize * 0.32;
  const textWidth = Math.max(...lines.map((line) => measure.measureText(line).width));
  const width = Math.ceil(textWidth + paddingX * 2);
  const height = Math.ceil(lineHeight * lines.length + paddingY * 2);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  if (style.look !== "outline") {
    context.beginPath();
    context.roundRect(0, 0, width, height, Math.min(height / 2, fontSize * 0.45));
    context.fillStyle = style.look === "dark" ? "rgba(12, 11, 18, 0.8)" : "rgba(255, 255, 255, 0.94)";
    context.fill();
  }
  context.font = font(fontSize);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  lines.forEach((line, index) => {
    const y = paddingY + lineHeight * (index + 0.5);
    if (style.look === "outline") {
      context.lineWidth = fontSize * 0.16;
      context.strokeStyle = "rgba(0, 0, 0, 0.85)";
      context.strokeText(line, width / 2, y);
    }
    context.fillStyle = style.look === "light" ? "#111118" : "#ffffff";
    context.fillText(line, width / 2, y);
  });

  const bottom = layout.video.y + layout.video.height - layout.video.height * 0.06;
  return {
    canvas,
    x: Math.round(layout.video.x + (layout.video.width - width) / 2),
    y: Math.round(bottom - height),
  };
}

function font(size: number) {
  return `600 ${size}px ${FONT_FAMILY}`;
}

function wrap(context: CanvasRenderingContext2D, text: string, fontSize: number, maxWidth: number): string[] {
  context.font = font(fontSize);
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && context.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}
