import { omitQuality, type FrameSettings } from "@screensway/core";

/** A look the user saved: everything about the frame except the export quality. */
export interface SavedStyle {
  id: string;
  name: string;
  settings: Omit<FrameSettings, "quality">;
}

const STYLES_KEY = "screensway.styles";

export function loadStyles(): SavedStyle[] {
  try {
    const stored = JSON.parse(localStorage.getItem(STYLES_KEY) ?? "[]") as SavedStyle[];
    return Array.isArray(stored) ? stored.filter((style) => style?.id && style.name && style.settings?.background) : [];
  } catch {
    return [];
  }
}

export function storeStyles(styles: SavedStyle[]) {
  try {
    localStorage.setItem(STYLES_KEY, JSON.stringify(styles));
  } catch {
    // Styles still apply for this session.
  }
}

export function createStyle(name: string, settings: FrameSettings): SavedStyle {
  return { id: `style-${Date.now().toString(36)}`, name: name.trim(), settings: omitQuality(settings) };
}

/** Compares looks regardless of key order or export quality. */
export function sameLook(a: Omit<FrameSettings, "quality">, b: Omit<FrameSettings, "quality">): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).filter(([key]) => key !== "quality").sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}
