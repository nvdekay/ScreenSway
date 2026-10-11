import {
  buildCameraTrack,
  generateZoomSegments,
  sampleCameraTrack,
  samplePointer,
  type Canvas,
  type CameraState,
  type PointerEvent,
} from "./index";

/** A soft blob of color used to build mesh-style gradients. All values are fractions of the canvas. */
export interface MeshBlob {
  x: number;
  y: number;
  radius: number;
  color: string;
}

export type BackgroundSpec =
  | { kind: "solid"; color: string }
  | { kind: "linear"; angle: number; stops: { offset: number; color: string }[] }
  | { kind: "mesh"; base: string; blobs: MeshBlob[] }
  /** Layered rolling hills of color, back to front, over a sky gradient. */
  | { kind: "waves"; sky: [string, string]; layers: string[] }
  /** `path` points to a copy kept in the ScreenSway folder, so the image survives restarts. */
  | { kind: "image"; blur: number; path?: string };

export type FrameStyle =
  | "none"
  | "macos-light"
  | "macos-dark"
  | "browser-light"
  | "browser-dark"
  | "macbook"
  | "glass"
  | "outline";
export type AspectPreset = "auto" | "16:9" | "4:3" | "1:1" | "9:16";
export type QualityPreset = "1080p" | "1440p" | "4k";

export interface FrameSettings {
  background: BackgroundSpec;
  /** Adds a subtle film grain on top of the background. */
  grain: boolean;
  frame: FrameStyle;
  aspect: AspectPreset;
  /** Space around the window, as a fraction of the canvas' shorter side (0–0.25). */
  padding: number;
  /** Corner radius, as a fraction of the window width (0–0.06). */
  radius: number;
  /** Shadow strength from 0 (none) to 1. */
  shadow: number;
  quality: QualityPreset;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Everything needed to draw one output frame size, in output pixels. */
export interface FrameLayout {
  width: number;
  height: number;
  /** The window, or a device's lid: the video plus its title bar or bezel. */
  window: Rect;
  /** Where the recording is drawn. */
  video: Rect;
  /** Height of the bar above the video for window and browser frames (0 otherwise). */
  titleBar: number;
  /** Bezel around the video for device frames (0 otherwise). */
  bezel: number;
  /** The laptop base under a device frame, or null. */
  base: Rect | null;
  /** Corner radius of the window or lid. */
  radius: number;
  /** Corner radius of the video itself. */
  videoRadius: number;
  /** False when a title bar sits on the video's top edge, so only its bottom corners are round. */
  roundVideoTop: boolean;
}

export const MESH_PRESETS: { id: string; background: BackgroundSpec }[] = [
  { id: "aurora", background: { kind: "mesh", base: "#1e1b4b", blobs: [
    { x: 0.15, y: 0.2, radius: 0.7, color: "#6366f1" },
    { x: 0.85, y: 0.25, radius: 0.6, color: "#ec4899" },
    { x: 0.55, y: 0.95, radius: 0.7, color: "#22d3ee" },
  ] } },
  { id: "sunset", background: { kind: "mesh", base: "#7c2d12", blobs: [
    { x: 0.1, y: 0.1, radius: 0.7, color: "#f97316" },
    { x: 0.9, y: 0.2, radius: 0.6, color: "#f43f5e" },
    { x: 0.5, y: 1, radius: 0.8, color: "#facc15" },
  ] } },
  { id: "lagoon", background: { kind: "mesh", base: "#064e3b", blobs: [
    { x: 0.2, y: 0.85, radius: 0.7, color: "#10b981" },
    { x: 0.85, y: 0.15, radius: 0.7, color: "#0ea5e9" },
    { x: 0.5, y: 0.4, radius: 0.5, color: "#a7f3d0" },
  ] } },
  { id: "lavender", background: { kind: "mesh", base: "#ede9fe", blobs: [
    { x: 0.15, y: 0.15, radius: 0.7, color: "#c4b5fd" },
    { x: 0.9, y: 0.4, radius: 0.6, color: "#fbcfe8" },
    { x: 0.4, y: 1, radius: 0.7, color: "#bae6fd" },
  ] } },
  { id: "peach", background: { kind: "mesh", base: "#fff1e6", blobs: [
    { x: 0.1, y: 0.9, radius: 0.7, color: "#fdba74" },
    { x: 0.9, y: 0.1, radius: 0.6, color: "#fda4af" },
    { x: 0.6, y: 0.5, radius: 0.5, color: "#fef3c7" },
  ] } },
  { id: "midnight", background: { kind: "mesh", base: "#020617", blobs: [
    { x: 0.2, y: 0.1, radius: 0.6, color: "#1d4ed8" },
    { x: 0.85, y: 0.9, radius: 0.7, color: "#7c3aed" },
  ] } },
  { id: "forest", background: { kind: "mesh", base: "#14532d", blobs: [
    { x: 0.8, y: 0.2, radius: 0.7, color: "#84cc16" },
    { x: 0.15, y: 0.9, radius: 0.7, color: "#0d9488" },
  ] } },
  { id: "ember", background: { kind: "mesh", base: "#1c0a00", blobs: [
    { x: 0.5, y: 1.05, radius: 0.8, color: "#ea580c" },
    { x: 0.1, y: 0.2, radius: 0.5, color: "#be123c" },
  ] } },
  { id: "sky", background: { kind: "linear", angle: 160, stops: [
    { offset: 0, color: "#bfdbfe" }, { offset: 1, color: "#6366f1" },
  ] } },
  { id: "candy", background: { kind: "linear", angle: 135, stops: [
    { offset: 0, color: "#f472b6" }, { offset: 1, color: "#818cf8" },
  ] } },
  { id: "mint", background: { kind: "linear", angle: 135, stops: [
    { offset: 0, color: "#d9f99d" }, { offset: 1, color: "#22d3ee" },
  ] } },
  { id: "graphite", background: { kind: "linear", angle: 180, stops: [
    { offset: 0, color: "#3f3f46" }, { offset: 1, color: "#09090b" },
  ] } },
  { id: "iris", background: { kind: "mesh", base: "#312e81", blobs: [
    { x: 0.1, y: 0.9, radius: 0.7, color: "#a855f7" },
    { x: 0.9, y: 0.1, radius: 0.7, color: "#3b82f6" },
    { x: 0.6, y: 0.6, radius: 0.4, color: "#f0abfc" },
  ] } },
  { id: "citrus", background: { kind: "mesh", base: "#fef9c3", blobs: [
    { x: 0.15, y: 0.2, radius: 0.6, color: "#fde047" },
    { x: 0.85, y: 0.85, radius: 0.7, color: "#fb923c" },
    { x: 0.8, y: 0.15, radius: 0.5, color: "#bef264" },
  ] } },
  { id: "bloom", background: { kind: "mesh", base: "#fdf2f8", blobs: [
    { x: 0.2, y: 0.8, radius: 0.7, color: "#f9a8d4" },
    { x: 0.85, y: 0.2, radius: 0.6, color: "#c4b5fd" },
    { x: 0.6, y: 0.95, radius: 0.5, color: "#fecdd3" },
  ] } },
  { id: "glacier", background: { kind: "mesh", base: "#f0f9ff", blobs: [
    { x: 0.1, y: 0.1, radius: 0.7, color: "#a5f3fc" },
    { x: 0.9, y: 0.9, radius: 0.7, color: "#c7d2fe" },
    { x: 0.7, y: 0.2, radius: 0.4, color: "#e0f2fe" },
  ] } },
  { id: "nebula", background: { kind: "mesh", base: "#0b0618", blobs: [
    { x: 0.25, y: 0.3, radius: 0.55, color: "#7e22ce" },
    { x: 0.8, y: 0.7, radius: 0.6, color: "#db2777" },
    { x: 0.5, y: 1, radius: 0.5, color: "#1d4ed8" },
  ] } },
  { id: "coral", background: { kind: "mesh", base: "#fff7ed", blobs: [
    { x: 0.85, y: 0.15, radius: 0.7, color: "#fb7185" },
    { x: 0.15, y: 0.85, radius: 0.7, color: "#fdba74" },
  ] } },
  { id: "matcha", background: { kind: "mesh", base: "#f7fee7", blobs: [
    { x: 0.2, y: 0.2, radius: 0.7, color: "#bef264" },
    { x: 0.85, y: 0.8, radius: 0.7, color: "#6ee7b7" },
  ] } },
  { id: "slate", background: { kind: "mesh", base: "#0f172a", blobs: [
    { x: 0.8, y: 0.1, radius: 0.7, color: "#334155" },
    { x: 0.2, y: 0.95, radius: 0.6, color: "#1e3a8a" },
  ] } },
];

/** Rolling hills, drawn in code so they stay sharp at 4K and cost nothing to ship. */
export const WAVE_PRESETS: { id: string; background: BackgroundSpec }[] = [
  { id: "dune", background: { kind: "waves", sky: ["#fde68a", "#fb923c"], layers: ["#f59e0b", "#ea580c", "#c2410c", "#7c2d12"] } },
  { id: "ocean", background: { kind: "waves", sky: ["#bae6fd", "#38bdf8"], layers: ["#0ea5e9", "#0284c7", "#0369a1", "#0c4a6e"] } },
  { id: "meadow", background: { kind: "waves", sky: ["#ecfccb", "#a7f3d0"], layers: ["#4ade80", "#22c55e", "#15803d", "#14532d"] } },
  { id: "dusk", background: { kind: "waves", sky: ["#fbcfe8", "#a78bfa"], layers: ["#c084fc", "#9333ea", "#6b21a8", "#3b0764"] } },
  { id: "rose", background: { kind: "waves", sky: ["#ffe4e6", "#fda4af"], layers: ["#fb7185", "#e11d48", "#be123c", "#881337"] } },
  { id: "night", background: { kind: "waves", sky: ["#1e1b4b", "#312e81"], layers: ["#4338ca", "#3730a3", "#1e1b4b", "#0f0a2e"] } },
];

export const SOLID_PRESETS = [
  "#ffffff", "#f4f4f5", "#e0e7ff", "#fce7f3", "#dcfce7", "#fef9c3",
  "#18181b", "#0b0b12", "#312e81", "#831843", "#14532d", "#7c2d12",
];

export const DEFAULT_FRAME_SETTINGS: FrameSettings = {
  background: MESH_PRESETS[0].background,
  grain: false,
  frame: "macos-dark",
  aspect: "auto",
  padding: 0.08,
  radius: 0.012,
  shadow: 0.6,
  quality: "1080p",
};

/** Ready-made looks; applying one keeps the export quality. */
export const BUILT_IN_STYLES: { id: string; settings: Omit<FrameSettings, "quality"> }[] = [
  { id: "studio", settings: { ...omitQuality(DEFAULT_FRAME_SETTINGS) } },
  { id: "clean", settings: { background: { kind: "solid", color: "#f4f4f5" }, grain: false, frame: "macos-light", aspect: "auto", padding: 0.06, radius: 0.012, shadow: 0.35 } },
  { id: "product", settings: { background: MESH_PRESETS[3].background, grain: false, frame: "macbook", aspect: "auto", padding: 0.07, radius: 0.02, shadow: 0.5 } },
  { id: "web", settings: { background: MESH_PRESETS[8].background, grain: false, frame: "browser-light", aspect: "16:9", padding: 0.07, radius: 0.014, shadow: 0.5 } },
  { id: "social", settings: { background: WAVE_PRESETS[3].background, grain: true, frame: "glass", aspect: "1:1", padding: 0.07, radius: 0.02, shadow: 0.6 } },
];

export function omitQuality(settings: FrameSettings): Omit<FrameSettings, "quality"> {
  const { quality: _quality, ...rest } = settings;
  return rest;
}

const QUALITY_SHORT_SIDE: Record<QualityPreset, number> = { "1080p": 1080, "1440p": 1440, "4k": 2160 };

/**
 * What surrounds the video, as fractions of the video width: a bar above it (window and
 * browser frames), a bezel (devices), and a laptop base below that sticks out at the sides.
 */
interface Chrome {
  titleBar: number;
  bezel: number;
  base: number;
  overhang: number;
}
const NO_CHROME: Chrome = { titleBar: 0, bezel: 0, base: 0, overhang: 0 };
const CHROME: Record<FrameStyle, Chrome> = {
  none: NO_CHROME,
  glass: NO_CHROME,
  outline: NO_CHROME,
  "macos-light": { ...NO_CHROME, titleBar: 0.032 },
  "macos-dark": { ...NO_CHROME, titleBar: 0.032 },
  "browser-light": { ...NO_CHROME, titleBar: 0.056 },
  "browser-dark": { ...NO_CHROME, titleBar: 0.056 },
  macbook: { titleBar: 0, bezel: 0.026, base: 0.03, overhang: 0.07 },
};

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export function aspectRatio(aspect: AspectPreset, source: Canvas): number {
  if (aspect === "auto") return source.width / source.height;
  const [width, height] = aspect.split(":").map(Number);
  return width / height;
}

export function hasTitleBar(frame: FrameStyle): boolean {
  return CHROME[frame].titleBar > 0;
}

export function isBrowserFrame(frame: FrameStyle): boolean {
  return frame === "browser-light" || frame === "browser-dark";
}

/**
 * Places the window (or device) inside the canvas: inset by the padding, fitted to the
 * recording's aspect ratio plus its frame, and centered.
 */
export function computeLayout(settings: FrameSettings, source: Canvas, shortSide = QUALITY_SHORT_SIDE[settings.quality]): FrameLayout {
  const ratio = aspectRatio(settings.aspect, source);
  const width = even(ratio >= 1 ? shortSide * ratio : shortSide);
  const height = even(ratio >= 1 ? shortSide : shortSide / ratio);

  const inset = Math.min(width, height) * Math.min(Math.max(settings.padding, 0), 0.25);
  const available = { width: width - inset * 2, height: height - inset * 2 };
  const chrome = CHROME[settings.frame];
  // Everything is measured in video widths: the whole footprint is `units` wide and tall.
  const videoAspect = source.height / source.width;
  const units = {
    width: 1 + chrome.bezel * 2 + chrome.overhang * 2,
    height: videoAspect + chrome.titleBar + chrome.bezel * 2 + chrome.base,
  };
  const videoWidth = Math.min(available.width / units.width, available.height / units.height);
  const origin = { x: (width - units.width * videoWidth) / 2, y: (height - units.height * videoWidth) / 2 };

  const window = {
    x: origin.x + chrome.overhang * videoWidth,
    y: origin.y,
    width: (1 + chrome.bezel * 2) * videoWidth,
    height: (videoAspect + chrome.titleBar + chrome.bezel * 2) * videoWidth,
  };
  const titleBar = chrome.titleBar * videoWidth;
  const bezel = chrome.bezel * videoWidth;
  const radius = window.width * Math.min(Math.max(settings.radius, 0), 0.06);
  return {
    width,
    height,
    window,
    video: { x: window.x + bezel, y: window.y + titleBar + bezel, width: videoWidth, height: videoAspect * videoWidth },
    titleBar,
    bezel,
    base: chrome.base > 0
      ? { x: origin.x, y: window.y + window.height, width: units.width * videoWidth, height: chrome.base * videoWidth }
      : null,
    radius,
    // A device screen has small, even corners inside the bezel.
    videoRadius: bezel > 0 ? Math.max(0, radius - bezel) * 0.5 : radius,
    roundVideoTop: titleBar === 0,
  };
}

/** Cursor width relative to the video width, matching the preview. */
export const CURSOR_SIZE_RATIO = 0.019;
const RIPPLE_SIZE_RATIO = 0.045;
const RIPPLE_MS = 550;

/**
 * One output frame: the source region shown (in source pixels) and the cursor and click
 * ripple in output pixels. Packed as numbers to keep long exports compact:
 * [cropX, cropY, cropW, cropH, cursorX, cursorY, cursorSize, rippleX, rippleY, rippleSize, rippleAlpha]
 */
export type RenderFrame = [number, number, number, number, number, number, number, number, number, number, number];

export function buildRenderFrames(
  events: PointerEvent[],
  source: Canvas,
  layout: FrameLayout,
  durationMs: number,
  fps: number,
  autoZoom: boolean,
): RenderFrame[] {
  const segments = generateZoomSegments(events);
  const track = buildCameraTrack(events, segments, source, durationMs + 1_000);
  const clicks = events.filter((event) => event.type !== "move");
  const frames: RenderFrame[] = [];
  const count = Math.max(1, Math.ceil((durationMs / 1_000) * fps));
  const round = (value: number) => Math.round(value * 100) / 100;
  let clickIndex = -1;

  for (let index = 0; index < count; index++) {
    const timeMs = (index * 1_000) / fps;
    const camera: CameraState = autoZoom ? sampleCameraTrack(track, timeMs) : { x: 0.5, y: 0.5, scale: 1 };
    const cropWidth = source.width / camera.scale;
    const cropHeight = source.height / camera.scale;
    const cropX = camera.x * source.width - cropWidth / 2;
    const cropY = camera.y * source.height - cropHeight / 2;
    const toOutput = (x: number, y: number) => [
      layout.video.x + ((x - cropX) / cropWidth) * layout.video.width,
      layout.video.y + ((y - cropY) / cropHeight) * layout.video.height,
    ];

    const pointer = samplePointer(events, timeMs);
    const [cursorX, cursorY] = pointer ? toOutput(pointer.x, pointer.y) : [0, 0];
    const cursorSize = pointer ? layout.video.width * CURSOR_SIZE_RATIO * camera.scale : 0;

    while (clickIndex + 1 < clicks.length && clicks[clickIndex + 1].timeMs <= timeMs) clickIndex++;
    const click = clicks[clickIndex];
    const age = click ? timeMs - click.timeMs : Infinity;
    let ripple = [0, 0, 0, 0];
    if (click && age < RIPPLE_MS) {
      const progress = age / RIPPLE_MS;
      const [x, y] = toOutput(click.x, click.y);
      ripple = [x, y, layout.video.width * RIPPLE_SIZE_RATIO * camera.scale * (0.4 + progress * 0.9), 1 - progress];
    }

    frames.push([
      round(cropX), round(cropY), round(cropWidth), round(cropHeight),
      round(cursorX), round(cursorY), round(cursorSize),
      round(ripple[0]), round(ripple[1]), round(ripple[2]), round(ripple[3]),
    ]);
  }
  return frames;
}
