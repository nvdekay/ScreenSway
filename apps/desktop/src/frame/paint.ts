import type { BackgroundSpec, FrameLayout, FrameSettings, Rect } from "@screensway/core";

/**
 * Draws everything except the recording itself: background, shadow and window frame.
 * The preview paints it at screen size and the export at output size, so both match.
 */
export function paintFrameBase(
  context: CanvasRenderingContext2D,
  layout: FrameLayout,
  settings: FrameSettings,
  backgroundImage: CanvasImageSource | null,
) {
  const { width, height, window: frame, radius } = layout;
  context.save();
  context.clearRect(0, 0, width, height);
  paintBackground(context, settings.background, width, height, backgroundImage);
  if (settings.grain) paintGrain(context, width, height);

  // Shadow, cast by the whole window (title bar included).
  const shadow = Math.min(Math.max(settings.shadow, 0), 1);
  if (shadow > 0) {
    context.save();
    context.shadowColor = `rgba(0, 0, 0, ${0.2 + shadow * 0.35})`;
    context.shadowBlur = frame.width * 0.05 * shadow;
    context.shadowOffsetY = frame.width * 0.018 * shadow;
    roundedRect(context, frame, radius);
    context.fillStyle = "#000";
    context.fill();
    context.restore();
  }

  if (settings.frame === "glass") {
    const ring = Math.max(2, frame.width * 0.012);
    const outer = { x: frame.x - ring, y: frame.y - ring, width: frame.width + ring * 2, height: frame.height + ring * 2 };
    roundedRect(context, outer, radius + ring);
    context.fillStyle = "rgba(255, 255, 255, 0.22)";
    context.fill();
    context.lineWidth = Math.max(1, ring * 0.12);
    context.strokeStyle = "rgba(255, 255, 255, 0.55)";
    context.stroke();
  }

  if (layout.titleBar > 0) {
    const dark = settings.frame === "macos-dark";
    roundedRect(context, frame, radius);
    context.fillStyle = dark ? "#26252d" : "#ececf0";
    context.fill();
    // The three window controls.
    const dot = layout.titleBar * 0.2;
    const colors = ["#ff5f57", "#febc2e", "#28c840"];
    colors.forEach((color, index) => {
      context.beginPath();
      context.arc(frame.x + layout.titleBar * 0.62 + index * dot * 3.1, frame.y + layout.titleBar / 2, dot, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
    });
    context.fillStyle = dark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.08)";
    context.fillRect(frame.x, frame.y + layout.titleBar - Math.max(1, layout.titleBar * 0.03), frame.width, Math.max(1, layout.titleBar * 0.03));
  }

  if (settings.frame === "outline") {
    const line = Math.max(1, frame.width * 0.0025);
    roundedRect(context, { x: frame.x - line, y: frame.y - line, width: frame.width + line * 2, height: frame.height + line * 2 }, radius + line);
    context.lineWidth = line * 2;
    context.strokeStyle = "rgba(255, 255, 255, 0.7)";
    context.stroke();
  }
  context.restore();
}

export function paintBackground(
  context: CanvasRenderingContext2D,
  background: BackgroundSpec,
  width: number,
  height: number,
  image: CanvasImageSource | null,
) {
  switch (background.kind) {
    case "solid":
      context.fillStyle = background.color;
      context.fillRect(0, 0, width, height);
      return;
    case "linear": {
      const radians = ((background.angle - 90) * Math.PI) / 180;
      const half = (Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians))) / 2;
      const [cx, cy] = [width / 2, height / 2];
      const gradient = context.createLinearGradient(
        cx - Math.cos(radians) * half, cy - Math.sin(radians) * half,
        cx + Math.cos(radians) * half, cy + Math.sin(radians) * half,
      );
      background.stops.forEach((stop) => gradient.addColorStop(stop.offset, stop.color));
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
      return;
    }
    case "mesh":
      context.fillStyle = background.base;
      context.fillRect(0, 0, width, height);
      for (const blob of background.blobs) {
        context.save();
        context.translate(blob.x * width, blob.y * height);
        context.scale(blob.radius * width, blob.radius * height);
        const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
        gradient.addColorStop(0, blob.color);
        gradient.addColorStop(1, transparent(blob.color));
        context.fillStyle = gradient;
        context.fillRect(-1, -1, 2, 2);
        context.restore();
      }
      return;
    case "image":
      context.fillStyle = "#18181b";
      context.fillRect(0, 0, width, height);
      if (image) drawCover(context, image, width, height, background.blur);
      return;
  }
}

function drawCover(context: CanvasRenderingContext2D, image: CanvasImageSource, width: number, height: number, blur: number) {
  const source = image as HTMLImageElement;
  const imageWidth = source.naturalWidth || source.width;
  const imageHeight = source.naturalHeight || source.height;
  if (!imageWidth || !imageHeight) return;
  const blurPixels = Math.max(0, blur) * Math.max(width, height) * 0.03;
  // Overscan when blurring so soft edges never reveal the canvas behind.
  const scale = Math.max(width / imageWidth, height / imageHeight) * (blurPixels > 0 ? 1.08 : 1);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  context.save();
  if (blurPixels > 0) context.filter = `blur(${blurPixels}px)`;
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  context.restore();
}

/** A fixed-seed noise tile, so preview and export get the same grain. */
let grainTile: HTMLCanvasElement | null = null;
function paintGrain(context: CanvasRenderingContext2D, width: number, height: number) {
  if (!grainTile) {
    grainTile = document.createElement("canvas");
    grainTile.width = grainTile.height = 160;
    const tile = grainTile.getContext("2d")!;
    const pixels = tile.createImageData(160, 160);
    let seed = 1;
    for (let index = 0; index < pixels.data.length; index += 4) {
      seed = (seed * 16807) % 2147483647;
      const value = seed % 256;
      pixels.data.set([value, value, value, 26], index);
    }
    tile.putImageData(pixels, 0, 0);
  }
  context.save();
  context.globalCompositeOperation = "overlay";
  context.fillStyle = context.createPattern(grainTile, "repeat")!;
  context.fillRect(0, 0, width, height);
  context.restore();
}

function roundedRect(context: CanvasRenderingContext2D, rect: Rect, radius: number) {
  context.beginPath();
  context.roundRect(rect.x, rect.y, rect.width, rect.height, Math.min(radius, rect.width / 2, rect.height / 2));
}

function transparent(color: string): string {
  const hex = color.replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex.slice(0, 6);
  return `#${full}00`;
}

/** The pointer drawn by the preview, rendered for the exporter. Its tip is the hotspot. */
export const CURSOR_PATH =
  "M4.5 2.8v16.6c0 .6.7.9 1.1.4l3.9-4.2 2.6 6.1c.2.4.6.6 1 .4l2.2-.9c.4-.2.6-.6.4-1l-2.6-6h5.7c.6 0 .9-.7.5-1.1L5.6 2.4c-.4-.4-1.1-.1-1.1.4z";
export const CURSOR_HOTSPOT = { x: 4.5 / 24, y: 2.8 / 24 };

export function renderCursorPng(size = 192): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.scale(size / 24, size / 24);
  context.shadowColor = "rgba(0, 0, 0, 0.45)";
  context.shadowBlur = 1.2;
  context.shadowOffsetY = 0.4;
  const path = new Path2D(CURSOR_PATH);
  context.fillStyle = "#111";
  context.fill(path);
  context.shadowColor = "transparent";
  context.lineJoin = "round";
  context.lineWidth = 1.5;
  context.strokeStyle = "#fff";
  context.stroke(path);
  context.fill(path);
  return canvas.toDataURL("image/png");
}

/**
 * Builds a mesh background from the recording's own colors: a dark base plus its most
 * saturated hues, so the frame feels made for this video.
 */
export function magicBackground(source: CanvasImageSource): BackgroundSpec {
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 30;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(source, 0, 0, 48, 30);
  const { data } = context.getImageData(0, 0, 48, 30);
  const colors: { r: number; g: number; b: number; saturation: number; lightness: number }[] = [];
  for (let index = 0; index < data.length; index += 4) {
    const [r, g, b] = [data[index], data[index + 1], data[index + 2]];
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const lightness = (max + min) / 2;
    const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
    colors.push({ r, g, b, saturation, lightness });
  }
  const vivid = colors
    .filter((color) => color.lightness > 0.2 && color.lightness < 0.85)
    .sort((a, b) => b.saturation - a.saturation);
  const picks: typeof colors = [];
  for (const color of vivid) {
    if (picks.every((pick) => Math.hypot(pick.r - color.r, pick.g - color.g, pick.b - color.b) > 90)) picks.push(color);
    if (picks.length === 3) break;
  }
  while (picks.length < 3) picks.push([{ r: 99, g: 102, b: 241 }, { r: 236, g: 72, b: 153 }, { r: 34, g: 211, b: 238 }][picks.length] as never);
  const hex = ({ r, g, b }: { r: number; g: number; b: number }) =>
    `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
  const darkest = colors.reduce((dark, color) => (color.lightness < dark.lightness ? color : dark), colors[0]);
  return {
    kind: "mesh",
    base: hex({ r: darkest.r * 0.6, g: darkest.g * 0.6, b: darkest.b * 0.6 }),
    blobs: [
      { x: 0.12, y: 0.15, radius: 0.7, color: hex(picks[0]) },
      { x: 0.9, y: 0.3, radius: 0.6, color: hex(picks[1]) },
      { x: 0.5, y: 1, radius: 0.75, color: hex(picks[2]) },
    ],
  };
}
