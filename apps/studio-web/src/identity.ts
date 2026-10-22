/**
 * The anonymous journey ID for the statistics of the landing page and the browser app, which
 * share an origin. It is not derived from the browser or device (no fingerprinting), and
 * when the visitor asks not to be tracked (Do Not Track, Global Privacy Control) none is
 * made, read or stored.
 *
 * It lives in this tab's sessionStorage, so a visit from the landing page to /app/ in one
 * tab counts as one journey; it ends when the tab closes. Nothing recognises a browser
 * across visits.
 */
export const JOURNEY_KEY = "screensway.journey";
/** Where 0.4.1 kept an opt-in visitor ID; removed on load so none lingers. */
export const OLD_VISITOR_KEY = "screensway.analytics.visitor";
const ID = /^[0-9a-f]{32}$/;

export function optedOut(): boolean {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.doNotTrack === "1" || nav.globalPrivacyControl === true;
}

export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

let pageJourney: string | null = null;

/** This tab's journey ID, made on first use; null when the visitor opted out. */
export function journeyId(): string | null {
  if (optedOut()) return null;
  try {
    const stored = sessionStorage.getItem(JOURNEY_KEY);
    if (stored && ID.test(stored)) return stored;
    const created = pageJourney ?? randomId();
    sessionStorage.setItem(JOURNEY_KEY, created);
    return created;
  } catch {
    // No session storage (blocked or a sandboxed page): one ID for this page only.
    pageJourney ??= randomId();
    return pageJourney;
  }
}

/** The fields every event batch carries to tell journeys apart. */
export function identityFields(): { sessionId?: string } {
  const session = journeyId();
  return session ? { sessionId: session } : {};
}

/** Deletes the visitor ID an earlier build may have stored. */
export function forgetOldVisitorId(): void {
  try {
    localStorage.removeItem(OLD_VISITOR_KEY);
  } catch {
    // No local storage: nothing was stored either.
  }
}

export function visitorOs(): string {
  const agent = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod/i.test(agent)) return "mobile";
  if (/Windows/i.test(agent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(agent)) return "macos";
  if (/Linux|CrOS/i.test(agent)) return "linux";
  return "other";
}

export function browserName(): string {
  const agent = navigator.userAgent;
  if (/Edg\//.test(agent)) return "edge";
  if (/OPR\//.test(agent)) return "opera";
  if (/Firefox\//.test(agent)) return "firefox";
  if (/Chrome\//.test(agent)) return "chrome";
  if (/Safari\//.test(agent)) return "safari";
  return "other";
}
