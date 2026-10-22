/**
 * Pure helpers shared by ingestion, reports and feedback. Raw codes are stored and returned
 * as they are; only the dashboard translates them.
 */

/** Every day boundary is Vietnam's. Vietnam has no daylight saving time, so a fixed offset is exact. */
export const TIME_ZONE = "Asia/Ho_Chi_Minh";
export const DEFAULT_TZ_OFFSET_MINUTES = 420;

export function tzOffsetMinutes(value: string | undefined): number {
  const offset = Number(value ?? DEFAULT_TZ_OFFSET_MINUTES);
  return Number.isFinite(offset) ? offset : DEFAULT_TZ_OFFSET_MINUTES;
}

/** The calendar day (YYYY-MM-DD) of a Unix millisecond timestamp, in the given offset from UTC. */
export function dayOf(ts: number, offsetMinutes = DEFAULT_TZ_OFFSET_MINUTES): string {
  return new Date(ts + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The country Cloudflare's edge reports for the connecting address (`request.cf.country`):
 * an ISO 3166-1 alpha-2 code, `XX` when it is unknown, or `T1` for Tor. Anything else is
 * dropped. It is IP geolocation, so a VPN, proxy or mobile gateway shows its exit country.
 */
export function normalizeCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  if (code === "T1") return "T1";
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** The visitor's system from the browser's User-Agent, for events that do not say it themselves. */
export function osFromAgent(agent: string): string {
  if (/Android|iPhone|iPad|iPod/i.test(agent)) return "mobile";
  if (/Windows/i.test(agent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(agent)) return "macos";
  if (/Linux|CrOS/i.test(agent)) return "linux";
  return "other";
}

// No slashes or backslashes: a value can be a label or a host name, never a path.
const SHORT_TEXT = /^[\w .:+<>×-]{1,40}$/u;

export function shortText(value: unknown): string | null {
  return typeof value === "string" && SHORT_TEXT.test(value) ? value : null;
}

/** A random session, journey or visitor ID: 16–64 letters, digits, `-` or `_`. */
const RANDOM_ID = /^[A-Za-z0-9_-]{16,64}$/;

export function randomId(value: unknown): string | null {
  return typeof value === "string" && RANDOM_ID.test(value) ? value : null;
}

/** The value at fraction `q` (0–1) of a sorted list, by the nearest-rank method; null when empty. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
  return sorted[rank - 1];
}
