/**
 * Anonymous, cookieless usage counts for the browser app, sent to the ScreenSway analytics
 * API (apps/analytics) as source "studio", like the landing page's visit counts. Nothing is
 * sent or stored when the endpoint is not configured or the visitor asks not to be tracked;
 * otherwise a batch carries this tab's random journey ID and, only if the visitor turned it
 * on, a random visitor ID (identity.ts). Events carry short labels only (which browser, what
 * kind of surface, export settings, coarse durations), never recording content, titles or files.
 */
import { version } from "../../desktop/src-tauri/tauri.conf.json";
import { durationBucket } from "../../desktop/src/telemetry";
import { browserName, identityFields, optedOut, visitorOs } from "./identity";

const ENDPOINT = (import.meta.env.VITE_ANALYTICS_URL as string | undefined)?.replace(/\/$/, "");

/** Events the analytics API accepts from the browser app (keep in sync with apps/analytics). */
export const STUDIO_EVENTS = [
  "app_open",
  "unsupported_shown",
  "recording_started",
  "recording_finished",
  "recording_failed",
  "export_finished",
  "export_failed",
  "export_cancelled",
  "style_applied",
  "desktop_click",
  "export_started",
  "feature_interest",
  "feedback_submitted",
] as const;
export type StudioEvent = (typeof STUDIO_EVENTS)[number];
type Props = Record<string, string | number | boolean>;

/** Whether statistics are sent from this browser. */
export function analyticsOn(): boolean {
  return Boolean(ENDPOINT) && !optedOut();
}

function referrer(): string {
  try {
    if (!document.referrer) return "direct";
    const from = new URL(document.referrer);
    // The landing page is the parent folder on the same site.
    if (from.origin === location.origin) return "landing";
    return from.hostname.replace(/^www\./, "");
  } catch {
    return "direct";
  }
}

export function track(name: StudioEvent, props: Props = {}, locale?: string) {
  if (!ENDPOINT || optedOut()) return;
  const body = JSON.stringify({
    source: "studio",
    version,
    os: visitorOs(),
    locale: locale ?? (document.documentElement.lang || undefined),
    ...identityFields(),
    events: [{ name, props }],
  });
  try {
    // A beacon survives the navigation a link to the landing page starts.
    if (!navigator.sendBeacon?.(`${ENDPOINT}/v1/events`, body)) {
      void fetch(`${ENDPOINT}/v1/events`, { method: "POST", body, keepalive: true }).catch(() => {});
    }
  } catch {
    // Statistics must never get in the way of recording.
  }
}

let opened = false;
/**
 * Counts the visit once per page load; `unsupported` is why recording is unavailable, if it is.
 * The page language is passed in: on first render <html lang> is not updated yet.
 */
export function trackOpen(unsupported: string | null, locale: string) {
  if (opened) return;
  opened = true;
  const props = { browser: browserName(), referrer: referrer() };
  if (unsupported) track("unsupported_shown", { ...props, reason: unsupported }, locale);
  else track("app_open", props, locale);
}

export { browserName, durationBucket, version, visitorOs };
export const ANALYTICS_ENDPOINT = ENDPOINT;
