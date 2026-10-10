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
  | { kind: "image"; blur: number };

export type FrameStyle = "none" | "macos-light" | "macos-dark" | "glass" | "outline";
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
  /** The window: video plus the title bar, if any. */
  window: Rect;
  /** Where the recording is drawn. */
  video: Rect;
  /** Title bar height (0 when the frame has none). */
  titleBar: number;
  radius: number;
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

const QUALITY_SHORT_SIDE: Record<QualityPreset, number> = { "1080p": 1080, "1440p": 1440, "4k": 2160 };
/** Title bar height as a fraction of the window width, like a macOS window. */
const TITLE_BAR_RATIO = 0.032;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export function aspectRatio(aspect: AspectPreset, source: Canvas): number {
  if (aspect === "auto") return source.width / source.height;
  const [width, height] = aspect.split(":").map(Number);
  return width / height;
}

export function hasTitleBar(frame: FrameStyle): boolean {
  return frame === "macos-light" || frame === "macos-dark";
}

/**
 * Places the window inside the canvas: inset by the padding, fitted to the recording's
 * aspect ratio (plus the title bar), and centered.
 */
export function computeLayout(settings: FrameSettings, source: Canvas, shortSide = QUALITY_SHORT_SIDE[settings.quality]): FrameLayout {
  const ratio = aspectRatio(settings.aspect, source);
  const width = even(ratio >= 1 ? shortSide * ratio : shortSide);
  const height = even(ratio >= 1 ? shortSide : shortSide / ratio);

  const inset = Math.min(width, height) * Math.min(Math.max(settings.padding, 0), 0.25);
  const available = { width: width - inset * 2, height: height - inset * 2 };
  const titleBarRatio = hasTitleBar(settings.frame) ? TITLE_BAR_RATIO : 0;
  // Window height = video height + title bar, where the title bar scales with the width.
  const windowAspect = source.width / (source.height + titleBarRatio * source.width);
  const windowWidth = Math.min(available.width, available.height * windowAspect);
  const windowHeight = windowWidth / windowAspect;
  const titleBar = windowWidth * titleBarRatio;

  const window = {
    x: (width - windowWidth) / 2,
    y: (height - windowHeight) / 2,
    width: windowWidth,
    height: windowHeight,
  };
  return {
    width,
    height,
    window,
    video: { x: window.x, y: window.y + titleBar, width: windowWidth, height: windowHeight - titleBar },
    titleBar,
    radius: windowWidth * Math.min(Math.max(settings.radius, 0), 0.06),
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
