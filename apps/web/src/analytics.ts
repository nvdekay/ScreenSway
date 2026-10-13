/// <reference types="vite/client" />
import type { DownloadPlatform } from "./downloads";

/**
 * Anonymous, cookieless counts of visits and downloads, sent to the ScreenSway
 * analytics API (apps/analytics). Nothing is stored in the browser and nothing is
 * sent when the endpoint is not configured or the visitor asks not to be tracked.
 */
const ENDPOINT = (import.meta.env.VITE_ANALYTICS_URL as string | undefined)?.replace(/\/$/, "");

type Props = Record<string, string | number | boolean>;

function optedOut(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.doNotTrack === "1" || nav.globalPrivacyControl === true;
}

export function track(name: "page_view" | "download_click" | "guide_open", props: Props = {}) {
  if (!ENDPOINT || optedOut()) return;
  const body = JSON.stringify({ source: "web", events: [{ name, props }] });
  try {
    // A beacon survives the navigation that a download link starts.
    if (!navigator.sendBeacon?.(`${ENDPOINT}/v1/events`, body)) {
      void fetch(`${ENDPOINT}/v1/events`, { method: "POST", body, keepalive: true }).catch(() => {});
    }
  } catch {
    // Analytics must never get in the visitor's way.
  }
}

function referrer(): string {
  try {
    const host = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, "") : "";
    return host && host !== location.hostname ? host : "direct";
  } catch {
    return "direct";
  }
}

function visitorOs(): string {
  const agent = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod/i.test(agent)) return "mobile";
  if (/Windows/i.test(agent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(agent)) return "macos";
  return "other";
}

let viewed = false;
/** Counts the visit once per page load. */
export function trackPageView(lang: string, theme: string) {
  if (viewed) return;
  viewed = true;
  track("page_view", { referrer: referrer(), lang, theme, os: visitorOs() });
}

export function trackDownload(platform: DownloadPlatform, placement: "hero" | "cta" | "guide") {
  track("download_click", { platform, placement });
}
