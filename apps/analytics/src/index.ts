/**
 * ScreenSway analytics: a small ingestion and reporting API.
 *
 *   POST /v1/events   public; anonymous events from the landing page, the browser app and the desktop app
 *   POST /v1/login    the admin account (Worker secrets) → a signed session cookie
 *   POST /v1/logout   clears that cookie
 *   GET  /v1/stats    session cookie or bearer token; every number the dashboard shows, as one JSON document
 *   POST /v1/feedback public; a message someone chose to send (see feedback.ts)
 *   GET  /v1/feedback, PATCH /v1/feedback/:id   admin only: read and triage feedback
 *   POST /v1/internal/downloads   the downloads Worker only (DOWNLOADS_EVENT_TOKEN): a download started
 *   GET  /v1/health   liveness
 *   GET  /            the dashboard (static asset in ./public)
 *
 * See docs/analytics.md for the event catalogue and the response format.
 */
import { listFeedback, pruneFeedback, submitFeedback, updateFeedback } from "./feedback";
import { extras, firstSuccess, funnels, retention } from "./insights";
import { TIME_ZONE, dayOf as dayAt, normalizeCountry, osFromAgent, randomId, shiftDay, shortText, tzOffsetMinutes } from "./normalize";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Bearer token for scripts; also the key that signs dashboard sessions. */
  DASHBOARD_TOKEN?: string;
  /** The one dashboard account (secrets, never in wrangler.toml). */
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  ACTOR_SALT?: string;
  TZ_OFFSET_MINUTES?: string;
  /** Cloudflare rate limiter for POST /v1/events, keyed by client address (wrangler.toml). */
  INGEST_LIMITER?: RateLimit;
  /** Sign-in attempts per client address, so the password cannot be guessed quickly. */
  LOGIN_LIMITER?: RateLimit;
  /** Feedback submissions per client address, apart from event ingestion. */
  FEEDBACK_LIMITER?: RateLimit;
  FEEDBACK_RETENTION_DAYS?: string;
  /** Shared with the downloads Worker, which reports download starts. */
  DOWNLOADS_EVENT_TOKEN?: string;
}

/**
 * web = landing page, studio = the browser app at /app/, app = the desktop app, downloads =
 * the downloads Worker (server side, never accepted from the public endpoint).
 */
type Source = "web" | "studio" | "app" | "downloads";
type ClientSource = Exclude<Source, "downloads">;

/** Events the API accepts. Anything else is dropped, so a typo or abuse cannot invent metrics. */
// Pricing and checkout events are accepted for when those pages exist; nothing sends them yet.
// Purchases, refunds and licences never come from a client: a verified Merchant of Record
// webhook will write them to commerce_events (docs/analytics.md).
const EVENTS: Record<ClientSource, readonly string[]> = {
  web: ["page_view", "download_click", "guide_open", "pricing_viewed", "checkout_started"],
  studio: [
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
    "pricing_viewed",
    "checkout_started",
  ],
  app: [
    "app_open",
    "telemetry_enabled",
    "recording_started",
    "recording_finished",
    "recording_failed",
    "recording_opened",
    "export_finished",
    "export_failed",
    "export_cancelled",
    "captions_generated",
    "captions_failed",
    "style_applied",
    "export_started",
    "feature_interest",
    "feedback_submitted",
    "license_activated",
  ],
};

/** Property breakdowns reported by /v1/stats: [key in the response, source, event, property]. */
const BREAKDOWNS: readonly [string, Source, string, string][] = [
  ["downloadPlacement", "web", "download_click", "placement"],
  ["recordingSource", "app", "recording_started", "source"],
  ["recordingSystemAudio", "app", "recording_started", "system_audio"],
  ["recordingMicrophone", "app", "recording_started", "microphone"],
  ["recordingDuration", "app", "recording_finished", "duration"],
  ["recordingFailure", "app", "recording_failed", "reason"],
  ["exportQuality", "app", "export_finished", "quality"],
  ["exportFrame", "app", "export_finished", "frame"],
  ["exportAspect", "app", "export_finished", "aspect"],
  ["exportBackground", "app", "export_finished", "background"],
  ["exportCaptions", "app", "export_finished", "captions"],
  ["exportAutoZoom", "app", "export_finished", "auto_zoom"],
  ["exportTrimmed", "app", "export_finished", "trimmed"],
  ["exportDuration", "app", "export_finished", "duration"],
  ["captionLocale", "app", "captions_generated", "locale"],
  ["styleApplied", "app", "style_applied", "style"],
];

/** The same kind of breakdowns for the browser app, reported under `studio.breakdowns`. */
const STUDIO_BREAKDOWNS: readonly [string, string, string][] = [
  ["browser", "app_open", "browser"],
  ["referrer", "app_open", "referrer"],
  ["unsupportedBrowser", "unsupported_shown", "browser"],
  ["unsupportedReason", "unsupported_shown", "reason"],
  ["recordingSource", "recording_started", "source"],
  ["recordingSystemAudio", "recording_started", "system_audio"],
  ["recordingSharedAudio", "recording_started", "shared_audio"],
  ["recordingMicrophone", "recording_started", "microphone"],
  ["recordingDuration", "recording_finished", "duration"],
  ["recordingFormat", "recording_finished", "format"],
  ["recordingFailure", "recording_failed", "reason"],
  ["exportQuality", "export_finished", "quality"],
  ["exportFrame", "export_finished", "frame"],
  ["exportAspect", "export_finished", "aspect"],
  ["exportBackground", "export_finished", "background"],
  ["exportAutoZoom", "export_finished", "auto_zoom"],
  ["exportTrimmed", "export_finished", "trimmed"],
  ["exportDuration", "export_finished", "duration"],
  ["exportFailure", "export_failed", "reason"],
  ["styleApplied", "style_applied", "style"],
  ["desktopPlacement", "desktop_click", "placement"],
];

const MAX_BODY_BYTES = 16 * 1024;
const MAX_EVENTS = 50;
const MAX_PROPS = 12;
const INSTALL_ID = /^[0-9a-f]{32}$/;
const PROP_KEY = /^[a-z][a-z0-9_]{0,23}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS },
  });

const dayOf = (ts: number, env: Env) => dayAt(ts, tzOffsetMinutes(env.TZ_OFFSET_MINUTES));

/** Keeps only short, flat values so an event can never carry a file path or free text. */
function cleanProps(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>).slice(0, MAX_PROPS)) {
    if (!PROP_KEY.test(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) output[key] = value;
    else if (shortText(value)) output[key] = value as string;
  }
  return Object.keys(output).length > 0 ? JSON.stringify(output) : null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares secrets without returning early, so response time does not reveal a matching prefix. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (let index = 0; index < b.length; index++) difference |= b[index] ^ (a[index] ?? 0);
  return difference === 0;
}

async function ingest(request: Request, env: Env): Promise<Response> {
  const address = request.headers.get("CF-Connecting-IP") ?? "";
  if (env.INGEST_LIMITER && !(await env.INGEST_LIMITER.limit({ key: address || "unknown" })).success) {
    return json({ error: "too many requests" }, 429);
  }
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);
  const text = new TextDecoder().decode(bytes);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const source = body.source;
  if (source !== "web" && source !== "studio" && source !== "app") return json({ error: "unknown source" }, 400);
  if (!Array.isArray(body.events)) return json({ error: "events must be an array" }, 400);

  const now = Date.now();
  const day = dayOf(now, env);
  const agent = request.headers.get("User-Agent") ?? "";
  let actor: string;
  if (source === "app") {
    if (typeof body.installId !== "string" || !INSTALL_ID.test(body.installId)) return json({ error: "invalid installId" }, 400);
    actor = body.installId;
  } else {
    // Without the salt the visitor hash would be an unsalted digest of address and browser.
    if (!env.ACTOR_SALT) return json({ error: "ACTOR_SALT is not configured" }, 503);
    // A visitor (of the landing page or the browser app) is "the same address and browser on the same day". The hash cannot be
    // reversed or linked across days, and the address itself is never stored.
    actor = (await sha256Hex(`${day}|${address}|${agent}|${env.ACTOR_SALT}`)).slice(0, 32);
  }

  // The country always comes from Cloudflare's edge, never from the request body.
  const country = normalizeCountry((request as Request<unknown, IncomingRequestCfProperties>).cf?.country);
  const version = shortText(body.version);
  // Older landing builds sent the system and language only as page_view properties: fill the
  // columns from the browser so every row says where it came from.
  const os = shortText(body.os) ?? (source === "app" ? null : osFromAgent(agent));
  const firstLang = (body.events as ({ props?: { lang?: unknown } } | null)[])[0]?.props?.lang;
  const locale = shortText(body.locale) ?? (source === "web" ? shortText(firstLang) : null);
  const sessionId = randomId(body.sessionId);
  // A stable browser ID exists only after the visitor opted in; the desktop app's install ID
  // is already stable (and consented).
  const visitorId = source === "app" ? null : randomId(body.visitorId);
  const insert = env.DB.prepare(
    "INSERT INTO events (ts, day, source, name, actor, version, os, country, locale, props, session_id, visitor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const statements = (body.events as unknown[]).slice(0, MAX_EVENTS).flatMap((event) => {
    const name = (event as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !EVENTS[source].includes(name)) return [];
    return [insert.bind(now, day, source, name, actor, version, os, country, locale, cleanProps((event as { props?: unknown }).props), sessionId, visitorId)];
  });
  if (statements.length > 0) await env.DB.batch(statements);
  return json({ accepted: statements.length }, 202);
}

const DOWNLOAD_PLATFORMS = ["macos", "windows", "macos_update"];

/**
 * A download the downloads Worker saw start (a GET of an installer from its first byte). It
 * cannot see a download finish, so nothing here claims one did. The visitor is the same
 * daily hash as the landing page's, from the address and browser the downloads Worker passes.
 */
async function ingestDownload(request: Request, env: Env): Promise<Response> {
  if (!env.DOWNLOADS_EVENT_TOKEN || !sameSecret(request.headers.get("Authorization") ?? "", `Bearer ${env.DOWNLOADS_EVENT_TOKEN}`)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env.ACTOR_SALT) return json({ error: "ACTOR_SALT is not configured" }, 503);
  const body = (await request.json().catch(() => null)) as { platform?: unknown; channel?: unknown; tag?: unknown; country?: unknown; address?: unknown; agent?: unknown } | null;
  if (!body || typeof body.platform !== "string" || !DOWNLOAD_PLATFORMS.includes(body.platform)) return json({ error: "invalid" }, 400);
  if (body.channel !== "latest" && body.channel !== "versioned") return json({ error: "invalid" }, 400);
  const now = Date.now();
  const day = dayOf(now, env);
  const agent = typeof body.agent === "string" ? body.agent.slice(0, 512) : "";
  const address = typeof body.address === "string" ? body.address.slice(0, 64) : "";
  const actor = (await sha256Hex(`${day}|${address}|${agent}|${env.ACTOR_SALT}`)).slice(0, 32);
  const props = JSON.stringify({ platform: body.platform, channel: body.channel });
  await env.DB.prepare(
    "INSERT INTO events (ts, day, source, name, actor, version, os, country, locale, props) VALUES (?, ?, 'downloads', 'download_started', ?, ?, ?, ?, NULL, ?)",
  ).bind(now, day, actor, shortText(body.tag), osFromAgent(agent), normalizeCountry(body.country), props).run();
  return json({ accepted: 1 }, 202);
}

/** A property as text; JSON booleans read as "true"/"false" instead of SQLite's 1/0. */
const propValue = (prop: string) =>
  `CASE json_type(props, '$.${prop}') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE json_extract(props, '$.${prop}') END`;

type Row = Record<string, string | number | null>;
const rows = (result: D1Result<unknown>) => (result.results ?? []) as Row[];
const keyCounts = (result: D1Result<unknown>) =>
  rows(result).map((row) => ({ key: row.k === null ? "unknown" : String(row.k), count: Number(row.c) }));

// One report reads every event in its range many times over. Several dashboard tabs (or quick
// reloads) within a minute share the last report computed by this isolate.
const STATS_TTL_MS = 60_000;
const statsCache = new Map<number, { body: string; until: number }>();

// Dashboard sessions: the cookie holds its expiry and an HMAC of it, keyed by DASHBOARD_TOKEN.
// The account is part of the signed text, so changing the username or password (or rotating
// the token) signs every browser out. Nothing is stored server-side.
const SESSION_COOKIE = "screensway_session";
const REMEMBERED_SESSION_S = 30 * 86_400, SHORT_SESSION_S = 12 * 3_600;
const MAX_LOGIN_BYTES = 1024;

async function sessionSignature(env: Env, expires: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.DASHBOARD_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`session|${expires}|${env.ADMIN_USERNAME}|${env.ADMIN_PASSWORD}`));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const accountConfigured = (env: Env) => Boolean(env.DASHBOARD_TOKEN && env.ADMIN_USERNAME && env.ADMIN_PASSWORD);

async function hasSession(request: Request, env: Env): Promise<boolean> {
  if (!accountConfigured(env)) return false;
  const value = (request.headers.get("Cookie") ?? "").split(/;\s*/).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  const [expiresText, signature, extra] = (value ?? "").split(".");
  const expires = Number(expiresText);
  if (!signature || extra !== undefined || !Number.isInteger(expires) || expires <= Date.now() / 1000) return false;
  return sameSecret(signature, await sessionSignature(env, expires));
}

const sessionCookie = (value: string, maxAge?: number) =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict${maxAge === undefined ? "" : `; Max-Age=${maxAge}`}`;

async function login(request: Request, env: Env): Promise<Response> {
  if (!accountConfigured(env)) return json({ error: "the admin account is not configured" }, 503);
  const address = request.headers.get("CF-Connecting-IP") ?? "";
  if (env.LOGIN_LIMITER && !(await env.LOGIN_LIMITER.limit({ key: address || "unknown" })).success) {
    return json({ error: "too many attempts" }, 429);
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_LOGIN_BYTES) return json({ error: "payload too large" }, 413);
  let body: { username?: unknown; password?: unknown; remember?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  // Both are always compared, so the response time does not tell which one was wrong.
  const userMatches = sameSecret(String(body?.username ?? ""), env.ADMIN_USERNAME!);
  const passwordMatches = sameSecret(String(body?.password ?? ""), env.ADMIN_PASSWORD!);
  if (!userMatches || !passwordMatches) return json({ error: "wrong username or password" }, 401);

  const remember = body.remember === true;
  const expires = Math.floor(Date.now() / 1000) + (remember ? REMEMBERED_SESSION_S : SHORT_SESSION_S);
  const value = `${expires}.${await sessionSignature(env, expires)}`;
  // Without "remember", the cookie ends with the browser session (and after 12 hours at most).
  return new Response(null, { status: 204, headers: { "Set-Cookie": sessionCookie(value, remember ? REMEMBERED_SESSION_S : undefined), "Cache-Control": "no-store" } });
}

const logout = () => new Response(null, { status: 204, headers: { "Set-Cookie": sessionCookie("", 0), "Cache-Control": "no-store" } });

/** The bearer token (scripts) or a dashboard session cookie. */
async function admin(request: Request, env: Env): Promise<"bearer" | "session" | null> {
  if (!env.DASHBOARD_TOKEN) return null;
  if (sameSecret(request.headers.get("Authorization") ?? "", `Bearer ${env.DASHBOARD_TOKEN}`)) return "bearer";
  return (await hasSession(request, env)) ? "session" : null;
}

// Admin feedback answers carry no CORS headers: only this dashboard (same origin) or a
// script with the token reads them.
const privateJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * A change made with the session cookie must come from this dashboard: the cookie is
 * SameSite=Strict already, and the request must also be same-origin JSON with the
 * dashboard's header, which a cross-site form cannot send.
 */
function sameOriginWrite(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  return request.headers.get("X-ScreenSway-Dashboard") === "1" && (request.headers.get("Content-Type") ?? "").startsWith("application/json");
}

async function feedbackAdmin(request: Request, env: Env, pathname: string): Promise<Response> {
  const auth = await admin(request, env);
  if (!auth) return privateJson({ error: "unauthorized" }, 401);
  if (request.method === "GET" && pathname === "/v1/feedback") return listFeedback(new URL(request.url), env, privateJson);
  const match = /^\/v1\/feedback\/(\d{1,12})$/.exec(pathname);
  if (request.method === "PATCH" && match) {
    if (auth === "session" && !sameOriginWrite(request)) return privateJson({ error: "forbidden" }, 403);
    return updateFeedback(request, Number(match[1]), env, privateJson);
  }
  return privateJson({ error: "not found" }, 404);
}

async function stats(request: Request, env: Env): Promise<Response> {
  if (!env.DASHBOARD_TOKEN) return json({ error: "DASHBOARD_TOKEN is not configured" }, 503);
  if (!(await admin(request, env))) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
  const fresh = url.searchParams.has("fresh");
  const cached = statsCache.get(days);
  if (!fresh && cached && cached.until > Date.now()) {
    return new Response(cached.body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS } });
  }
  const response = await computeStats(env, days);
  statsCache.set(days, { body: await response.clone().text(), until: Date.now() + STATS_TTL_MS });
  return response;
}

async function computeStats(env: Env, days: number): Promise<Response> {
  const today = dayOf(Date.now(), env);
  const from = shiftDay(today, -(days - 1));
  const prevTo = shiftDay(from, -1);
  const prevFrom = shiftDay(prevTo, -(days - 1));
  const db = env.DB;
  const range = "day BETWEEN ? AND ?";
  const activeSince = (span: number) =>
    db.prepare("SELECT COUNT(DISTINCT actor) c FROM events WHERE source = 'app' AND day BETWEEN ? AND ?").bind(shiftDay(today, -(span - 1)), today);
  const totals = (a: string, b: string) =>
    db.prepare(`SELECT source, name, COUNT(*) c, COUNT(DISTINCT actor) u FROM events WHERE ${range} GROUP BY source, name`).bind(a, b);
  const visits = (a: string, b: string) =>
    db.prepare(`SELECT COALESCE(SUM(u), 0) c FROM (SELECT COUNT(DISTINCT actor) u FROM events WHERE source = 'web' AND ${range} GROUP BY day)`).bind(a, b);
  const installs = (a: string, b: string) =>
    db.prepare(`SELECT COUNT(DISTINCT actor) c FROM events WHERE source = 'app' AND ${range}`).bind(a, b);
  const firstSeen = (a: string, b: string) =>
    db.prepare("SELECT COUNT(*) c FROM (SELECT MIN(day) d FROM events WHERE source = 'app' GROUP BY actor) WHERE d BETWEEN ? AND ?").bind(a, b);
  const appDimension = (column: string) =>
    db.prepare(`SELECT ${column} k, COUNT(DISTINCT actor) c FROM events WHERE source = 'app' AND ${range} GROUP BY k ORDER BY c DESC LIMIT 12`).bind(from, today);
  const webProp = (prop: string) =>
    db.prepare(`SELECT json_extract(props, '$.${prop}') k, COUNT(*) c FROM events WHERE source = 'web' AND name = 'page_view' AND ${range} GROUP BY k ORDER BY c DESC LIMIT 12`).bind(from, today);

  const fixed = [
    db.prepare(`SELECT day, source, name, COUNT(*) c FROM events WHERE ${range} GROUP BY day, source, name`).bind(from, today),
    db.prepare(`SELECT day, source, COUNT(DISTINCT actor) c FROM events WHERE ${range} GROUP BY day, source`).bind(from, today),
    db.prepare(`SELECT day, json_extract(props, '$.platform') k, COUNT(*) c FROM events WHERE source = 'web' AND name = 'download_click' AND ${range} GROUP BY day, k`).bind(from, today),
    db.prepare("SELECT d day, COUNT(*) c FROM (SELECT MIN(day) d FROM events WHERE source = 'app' GROUP BY actor) WHERE d BETWEEN ? AND ? GROUP BY d").bind(from, today),
    totals(from, today),
    totals(prevFrom, prevTo),
    visits(from, today),
    visits(prevFrom, prevTo),
    installs(from, today),
    installs(prevFrom, prevTo),
    firstSeen(from, today),
    firstSeen(prevFrom, prevTo),
    activeSince(1),
    activeSince(7),
    activeSince(30),
    appDimension("version"),
    appDimension("os"),
    appDimension("country"),
    appDimension("locale"),
    db.prepare(`SELECT country k, COUNT(*) c FROM events WHERE source = 'web' AND name = 'page_view' AND ${range} GROUP BY k ORDER BY c DESC LIMIT 12`).bind(from, today),
    webProp("referrer"),
    webProp("os"),
    webProp("lang"),
    webProp("theme"),
    // Older landing rows kept the system only in their properties.
    db.prepare("SELECT ts, source, name, version, COALESCE(os, json_extract(props, '$.os')) os, country, locale, session_id, visitor_id IS NOT NULL consented, props FROM events ORDER BY id DESC LIMIT 40"),
    db.prepare("SELECT MIN(day) first, COUNT(*) events, COUNT(DISTINCT CASE WHEN source = 'app' THEN actor END) installs, SUM(source = 'web' AND name = 'download_click') downloads FROM events"),
  ];
  const breakdownQueries = BREAKDOWNS.map(([, source, name, prop]) =>
    db.prepare(`SELECT ${propValue(prop)} k, COUNT(*) c FROM events WHERE source = ? AND name = ? AND ${range} GROUP BY k ORDER BY c DESC LIMIT 12`).bind(source, name, from, today),
  );
  const results = await db.batch([...fixed, ...breakdownQueries]);
  const [daily, dailyActors, dailyDownloads, dailyNew, cur, prev, visitsCur, visitsPrev, installsCur, installsPrev, newCur, newPrev,
    dau, wau, mau, versions, oses, countries, locales, webCountries, referrers, webOs, webLang, webTheme, recent, allTime] = results;
  const one = (result: D1Result<unknown>) => Number(rows(result)[0]?.c ?? 0);

  const summarize = (result: D1Result<unknown>, visitors: number, active: number, fresh: number) => {
    const count = (source: Source, name: string) => Number(rows(result).find((row) => row.source === source && row.name === name)?.c ?? 0);
    return {
      pageViews: count("web", "page_view"),
      visitors,
      downloads: count("web", "download_click"),
      guideOpens: count("web", "guide_open"),
      activeInstalls: active,
      newInstalls: fresh,
      appOpens: count("app", "app_open"),
      recordings: count("app", "recording_finished"),
      exports: count("app", "export_finished"),
      captions: count("app", "captions_generated"),
    };
  };

  const series = Array.from({ length: days }, (_, index) => {
    const day = shiftDay(from, index);
    const count = (source: Source, name: string) =>
      Number(rows(daily).find((row) => row.day === day && row.source === source && row.name === name)?.c ?? 0);
    const actors = (source: Source) => Number(rows(dailyActors).find((row) => row.day === day && row.source === source)?.c ?? 0);
    const downloads = (platform: string) => Number(rows(dailyDownloads).find((row) => row.day === day && row.k === platform)?.c ?? 0);
    return {
      day,
      pageViews: count("web", "page_view"),
      visitors: actors("web"),
      downloadsMac: downloads("macos"),
      downloadsWindows: downloads("windows"),
      activeInstalls: actors("app"),
      newInstalls: Number(rows(dailyNew).find((row) => row.day === day)?.c ?? 0),
      recordings: count("app", "recording_finished"),
      exports: count("app", "export_finished"),
      captions: count("app", "captions_generated"),
    };
  });

  const studio = await studioStats(db, days, from, today, prevFrom, prevTo);
  // The range in Unix milliseconds: from the start of `from` to the end of `today`, Vietnam time.
  const offset = tzOffsetMinutes(env.TZ_OFFSET_MINUTES) * 60_000;
  const fromTs = Date.parse(`${from}T00:00:00Z`) - offset, toTs = Date.parse(`${shiftDay(today, 1)}T00:00:00Z`) - offset - 1;
  const [journeys, firsts, cohorts, more] = await Promise.all([
    funnels(db, fromTs, toTs),
    firstSuccess(db, fromTs, toTs),
    retention(db, from, today),
    extras(db, from, today, days),
  ]);
  const life = rows(allTime)[0] ?? {};
  return json({
    generatedAt: new Date().toISOString(),
    range: { days, from, to: today, previousFrom: prevFrom, previousTo: prevTo, timeZone: TIME_ZONE, tzOffsetMinutes: tzOffsetMinutes(env.TZ_OFFSET_MINUTES) },
    totals: summarize(cur, one(visitsCur), one(installsCur), one(newCur)),
    previous: summarize(prev, one(visitsPrev), one(installsPrev), one(newPrev)),
    allTime: { firstDay: life.first ?? null, events: Number(life.events ?? 0), installs: Number(life.installs ?? 0), downloads: Number(life.downloads ?? 0) },
    activeNow: { daily: one(dau), weekly: one(wau), monthly: one(mau) },
    series,
    events: rows(cur).map((row) => ({ source: row.source, name: row.name, count: Number(row.c), actors: Number(row.u) })),
    web: {
      countries: keyCounts(webCountries),
      referrers: keyCounts(referrers),
      os: keyCounts(webOs),
      languages: keyCounts(webLang),
      themes: keyCounts(webTheme),
    },
    app: {
      versions: keyCounts(versions),
      os: keyCounts(oses),
      countries: keyCounts(countries),
      locales: keyCounts(locales),
    },
    breakdowns: Object.fromEntries(BREAKDOWNS.map(([key], index) => [key, keyCounts(results[fixed.length + index])])),
    studio,
    funnels: journeys,
    firstSuccess: firsts,
    retention: cohorts,
    featureInterest: more.featureInterest,
    downloadsStarted: more.downloadsStarted,
    commerce: more.commerce,
    feedbackSubmitted: more.feedbackSubmitted,
    recent: rows(recent).map((row) => ({
      ts: Number(row.ts),
      source: row.source,
      name: row.name,
      version: row.version,
      os: row.os,
      country: row.country,
      locale: row.locale,
      // Only whether there is a session, not the ID itself.
      session: row.session_id !== null,
      consented: Number(row.consented) === 1,
      props: row.props ? (JSON.parse(String(row.props)) as unknown) : null,
    })),
  });
}

/**
 * The browser app's numbers. Its visitor hash rotates daily like the landing page's, so
 * "visitors" and the funnel count visitor-days: one person on two days counts twice.
 */
async function studioStats(db: D1Database, days: number, from: string, to: string, prevFrom: string, prevTo: string) {
  const range = "source = 'studio' AND day BETWEEN ? AND ?";
  const byName = (a: string, b: string) =>
    db.prepare(`SELECT name, COUNT(*) c, COUNT(DISTINCT day || actor) u FROM events WHERE ${range} GROUP BY name`).bind(a, b);
  const visitors = (a: string, b: string) => db.prepare(`SELECT COUNT(DISTINCT day || actor) c FROM events WHERE ${range}`).bind(a, b);
  const dimension = (column: string) =>
    db.prepare(`SELECT ${column} k, COUNT(DISTINCT day || actor) c FROM events WHERE ${range} GROUP BY k ORDER BY c DESC LIMIT 12`).bind(from, to);
  const results = await db.batch([
    byName(from, to),
    byName(prevFrom, prevTo),
    visitors(from, to),
    visitors(prevFrom, prevTo),
    db.prepare(`SELECT day, name, COUNT(*) c FROM events WHERE ${range} GROUP BY day, name`).bind(from, to),
    db.prepare(`SELECT day, COUNT(DISTINCT actor) c FROM events WHERE ${range} GROUP BY day`).bind(from, to),
    dimension("country"),
    dimension("os"),
    dimension("locale"),
    ...STUDIO_BREAKDOWNS.map(([, name, prop]) =>
      db.prepare(`SELECT ${propValue(prop)} k, COUNT(*) c FROM events WHERE ${range} AND name = ? GROUP BY k ORDER BY c DESC LIMIT 12`).bind(from, to, name),
    ),
  ]);
  const [cur, prev, visitorsCur, visitorsPrev, daily, dailyVisitors, countries, oses, locales] = results;
  const summarize = (result: D1Result<unknown>, visitorCount: number) => {
    const count = (name: string) => Number(rows(result).find((row) => row.name === name)?.c ?? 0);
    return {
      visitors: visitorCount,
      opens: count("app_open"),
      unsupported: count("unsupported_shown"),
      recordingsStarted: count("recording_started"),
      recordings: count("recording_finished"),
      recordingFailures: count("recording_failed"),
      exports: count("export_finished"),
      exportFailures: count("export_failed"),
      exportCancels: count("export_cancelled"),
      styles: count("style_applied"),
      desktopClicks: count("desktop_click"),
    };
  };
  const reached = (name: string) => Number(rows(cur).find((row) => row.name === name)?.u ?? 0);
  const one = (result: D1Result<unknown>) => Number(rows(result)[0]?.c ?? 0);
  return {
    totals: summarize(cur, one(visitorsCur)),
    previous: summarize(prev, one(visitorsPrev)),
    // Visitor-days that reached each step, in order.
    funnel: { opened: reached("app_open"), started: reached("recording_started"), recorded: reached("recording_finished"), exported: reached("export_finished") },
    series: Array.from({ length: days }, (_, index) => {
      const day = shiftDay(from, index);
      const count = (name: string) => Number(rows(daily).find((row) => row.day === day && row.name === name)?.c ?? 0);
      return {
        day,
        visitors: Number(rows(dailyVisitors).find((row) => row.day === day)?.c ?? 0),
        recordings: count("recording_finished"),
        exports: count("export_finished"),
        failures: count("recording_failed") + count("export_failed"),
      };
    }),
    events: rows(cur).map((row) => ({ name: row.name, count: Number(row.c), visitors: Number(row.u) })),
    countries: keyCounts(countries),
    os: keyCounts(oses),
    locales: keyCounts(locales),
    breakdowns: Object.fromEntries(STUDIO_BREAKDOWNS.map(([key], index) => [key, keyCounts(results[9 + index])])),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      if (pathname === "/v1/events" && request.method === "POST") return await ingest(request, env);
      if (pathname === "/v1/stats" && request.method === "GET") return await stats(request, env);
      if (pathname === "/v1/login" && request.method === "POST") return await login(request, env);
      if (pathname === "/v1/logout" && request.method === "POST") return logout();
      if (pathname === "/v1/feedback" && request.method === "POST") return await submitFeedback(request, env, json);
      if (pathname === "/v1/feedback" || pathname.startsWith("/v1/feedback/")) return await feedbackAdmin(request, env, pathname);
      if (pathname === "/v1/internal/downloads" && request.method === "POST") return await ingestDownload(request, env);
      if (pathname === "/v1/health") return json({ ok: true });
    } catch (error) {
      console.error(error);
      return json({ error: "internal error" }, 500);
    }
    if (pathname.startsWith("/v1/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(request);
  },
  // Daily: delete feedback past its retention period.
  async scheduled(_controller, env, context) {
    context.waitUntil(pruneFeedback(env).then((removed) => console.log(`feedback retention: removed ${removed}`)));
  },
} satisfies ExportedHandler<Env>;
