/**
 * Anonymous identifiers for the statistics of the landing page and the browser app, which
 * share an origin. Neither is derived from the browser or device (no fingerprinting), and
 * when the visitor asks not to be tracked (Do Not Track, Global Privacy Control) none is
 * made, read or stored.
 *
 * - The journey ID lives in this tab's sessionStorage, so a visit from the landing page to
 *   /app/ in one tab counts as one journey; it ends when the tab closes.
 * - The visitor ID exists only after the visitor turns on "recognise this browser" in the
 *   browser app, and is deleted when they turn it off.
 */
export const JOURNEY_KEY = "screensway.journey";
export const VISITOR_KEY = "screensway.analytics.visitor";
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

/** The visitor ID the visitor agreed to, or null. */
export function visitorId(): string | null {
  if (optedOut()) return null;
  try {
    const stored = localStorage.getItem(VISITOR_KEY);
    return stored && ID.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Turns recognition on (makes the ID) or off (deletes it); returns whether it is now on. */
export function setVisitorConsent(on: boolean): boolean {
  try {
    if (!on || optedOut()) {
      localStorage.removeItem(VISITOR_KEY);
      return false;
    }
    if (!visitorId()) localStorage.setItem(VISITOR_KEY, randomId());
    return visitorId() !== null;
  } catch {
    return false;
  }
}

/** The fields every event batch carries to tell journeys and (consenting) visitors apart. */
export function identityFields(): { sessionId?: string; visitorId?: string } {
  const session = journeyId();
  const visitor = visitorId();
  return { ...(session ? { sessionId: session } : {}), ...(visitor ? { visitorId: visitor } : {}) };
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
