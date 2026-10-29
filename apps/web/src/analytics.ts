/// <reference types="vite/client" />
import { browserName, identityFields, journeyId, optedOut, visitorOs } from "../../studio-web/src/identity";
import { feedbackProblem, type FeedbackRequest } from "../../desktop/src/feedback";
import type { DownloadPlatform } from "./downloads";

/**
 * Anonymous, cookieless counts of visits and downloads, sent to the ScreenSway
 * analytics API (apps/analytics). Nothing is sent or stored when the endpoint is not
 * configured or the visitor asks not to be tracked. Otherwise each batch carries this
 * tab's random journey ID, shared with the browser app at /app/ (see studio-web's
 * identity.ts).
 */
const ENDPOINT = (import.meta.env.VITE_ANALYTICS_URL as string | undefined)?.replace(/\/$/, "");

type Props = Record<string, string | number | boolean>;

function pageLocale(): string | undefined {
  const lang = document.documentElement.lang;
  return lang === "en" || lang === "vi" ? lang : undefined;
}

export function track(name: "page_view" | "download_click" | "guide_open", props: Props = {}, locale = pageLocale()) {
  if (!ENDPOINT || optedOut()) return;
  const body = JSON.stringify({
    source: "web",
    version: __SCREENSWAY_VERSION__,
    os: visitorOs(),
    locale,
    ...identityFields(),
    events: [{ name, props }],
  });
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

let viewed = false;
/** Counts the visit once per page load. */
export function trackPageView(lang: string, theme: string) {
  if (viewed) return;
  viewed = true;
  // The page language is passed in: on first render <html lang> may not be updated yet.
  track("page_view", { referrer: referrer(), lang, theme, os: visitorOs() }, lang);
}

export function trackDownload(platform: DownloadPlatform, placement: "hero" | "cta" | "guide") {
  track("download_click", { platform, placement });
}

/**
 * Sends the feedback form to the same endpoint as the browser app and the desktop app, as
 * source "web". Rejects with a message key the form translates; a 409 means the same text
 * already arrived (a retry after a lost answer), so it counts as sent. Free text never goes
 * into the usage events above.
 */
export async function sendFeedback(request: FeedbackRequest): Promise<void> {
  if (!ENDPOINT) throw "feedback.errorUnavailable";
  if (feedbackProblem(request)) throw "feedback.errorInvalid";
  const sessionId = request.includeMetadata ? journeyId() : null;
  const body = {
    source: "web",
    category: request.category,
    rating: request.rating,
    message: request.message.trim(),
    email: request.email?.trim() || null,
    includeMetadata: request.includeMetadata,
    ...(request.includeMetadata
      ? { metadata: { version: __SCREENSWAY_VERSION__, os: visitorOs(), browser: browserName(), ...(request.locale ? { locale: request.locale } : {}), ...(sessionId ? { sessionId } : {}) } }
      : {}),
    website: request.website,
  };
  let response: Response;
  try {
    // A plain-text body keeps this a simple cross-origin request (no preflight); the API reads JSON.
    response = await fetch(`${ENDPOINT}/v1/feedback`, { method: "POST", body: JSON.stringify(body) });
  } catch {
    throw "feedback.errorNetwork";
  }
  if (response.ok || response.status === 409) return;
  if (response.status === 429) throw "feedback.errorRateLimited";
  if (response.status === 400 || response.status === 413) throw "feedback.errorInvalid";
  throw "feedback.errorUnavailable";
}
