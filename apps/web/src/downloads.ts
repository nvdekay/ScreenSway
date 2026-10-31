export type DownloadPlatform = "macos" | "windows";

// Copies of the release assets, served by the downloads Worker
// (apps/downloads). Local builds without the variable link to ./download/.
const BASE = (import.meta.env.VITE_DOWNLOADS_URL as string | undefined)?.replace(/\/$/, "");
const LATEST = BASE ? `${BASE}/latest` : "./download";

export const DOWNLOADS = {
  macos: `${LATEST}/ScreenSway-macos-universal.dmg`,
  windows: `${LATEST}/ScreenSway-windows-x64-setup.exe`,
} as const;

export function preferredPlatform(): DownloadPlatform {
  return /Windows/i.test(navigator.userAgent) ? "windows" : "macos";
}
