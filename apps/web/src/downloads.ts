export type DownloadPlatform = "macos" | "windows";

// Public copies of the private release assets, bundled by the Pages workflow.
export const DOWNLOADS = {
  macos: "./download/ScreenSway-macos-universal.dmg",
  windows: "./download/ScreenSway-windows-x64-setup.exe",
} as const;

export function preferredPlatform(): DownloadPlatform {
  return /Windows/i.test(navigator.userAgent) ? "windows" : "macos";
}
