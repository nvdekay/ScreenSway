/**
 * ScreenSway analytics: a small ingestion and reporting API.
 *
 *   POST /v1/events   public; anonymous events from the landing page and the desktop app
 *   GET  /v1/stats    bearer token; every number the dashboard shows, as one JSON document
 *   GET  /v1/health   liveness
 *   GET  /            the dashboard (static asset in ./public)
 *
 * See docs/analytics.md for the event catalogue and the response format.
 */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  DASHBOARD_TOKEN?: string;
  ACTOR_SALT?: string;
  TZ_OFFSET_MINUTES?: string;
}

type Source = "web" | "app";

/** Events the API accepts. Anything else is dropped, so a typo or abuse cannot invent metrics. */
const EVENTS: Record<Source, readonly string[]> = {
  web: ["page_view", "download_click", "guide_open"],
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

const MAX_BODY_BYTES = 16 * 1024;
const MAX_EVENTS = 50;
const MAX_PROPS = 12;
const INSTALL_ID = /^[0-9a-f]{32}$/;
const PROP_KEY = /^[a-z][a-z0-9_]{0,23}$/;
// No slashes or backslashes: a value can be a label or a host name, never a path.
const SHORT_TEXT = /^[\w .:+<>×-]{1,40}$/u;

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

function dayOf(ts: number, env: Env): string {
  const offset = Number(env.TZ_OFFSET_MINUTES ?? 0) || 0;
  return new Date(ts + offset * 60_000).toISOString().slice(0, 10);
}

function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function shortText(value: unknown): string | null {
  return typeof value === "string" && SHORT_TEXT.test(value) ? value : null;
}

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

async function ingest(request: Request, env: Env): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const source = body.source;
  if (source !== "web" && source !== "app") return json({ error: "unknown source" }, 400);
  if (!Array.isArray(body.events)) return json({ error: "events must be an array" }, 400);

  const now = Date.now();
  const day = dayOf(now, env);
  let actor: string;
  if (source === "app") {
    if (typeof body.installId !== "string" || !INSTALL_ID.test(body.installId)) return json({ error: "invalid installId" }, 400);
    actor = body.installId;
  } else {
    // A visitor is "the same address and browser on the same day". The hash cannot be
    // reversed or linked across days, and the address itself is never stored.
    const address = request.headers.get("CF-Connecting-IP") ?? "";
    const agent = request.headers.get("User-Agent") ?? "";
    actor = (await sha256Hex(`${day}|${address}|${agent}|${env.ACTOR_SALT ?? ""}`)).slice(0, 32);
  }

  const country = shortText((request as Request<unknown, IncomingRequestCfProperties>).cf?.country);
  const version = shortText(body.version);
  const os = shortText(body.os);
  const locale = shortText(body.locale);
  const insert = env.DB.prepare(
    "INSERT INTO events (ts, day, source, name, actor, version, os, country, locale, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const statements = (body.events as unknown[]).slice(0, MAX_EVENTS).flatMap((event) => {
    const name = (event as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !EVENTS[source].includes(name)) return [];
    return [insert.bind(now, day, source, name, actor, version, os, country, locale, cleanProps((event as { props?: unknown }).props))];
  });
  if (statements.length > 0) await env.DB.batch(statements);
  return json({ accepted: statements.length }, 202);
}

/** A property as text; JSON booleans read as "true"/"false" instead of SQLite's 1/0. */
const propValue = (prop: string) =>
  `CASE json_type(props, '$.${prop}') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE json_extract(props, '$.${prop}') END`;

type Row = Record<string, string | number | null>;
const rows = (result: D1Result<unknown>) => (result.results ?? []) as Row[];
const keyCounts = (result: D1Result<unknown>) =>
  rows(result).map((row) => ({ key: row.k === null ? "unknown" : String(row.k), count: Number(row.c) }));

async function stats(request: Request, env: Env): Promise<Response> {
  if (!env.DASHBOARD_TOKEN) return json({ error: "DASHBOARD_TOKEN is not configured" }, 503);
  if (request.headers.get("Authorization") !== `Bearer ${env.DASHBOARD_TOKEN}`) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
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
    db.prepare("SELECT ts, source, name, version, os, country, props FROM events ORDER BY id DESC LIMIT 40"),
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

  const life = rows(allTime)[0] ?? {};
  return json({
    generatedAt: new Date().toISOString(),
    range: { days, from, to: today, previousFrom: prevFrom, previousTo: prevTo, tzOffsetMinutes: Number(env.TZ_OFFSET_MINUTES ?? 0) || 0 },
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
    recent: rows(recent).map((row) => ({
      ts: Number(row.ts),
      source: row.source,
      name: row.name,
      version: row.version,
      os: row.os,
      country: row.country,
      props: row.props ? (JSON.parse(String(row.props)) as unknown) : null,
    })),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      if (pathname === "/v1/events" && request.method === "POST") return await ingest(request, env);
      if (pathname === "/v1/stats" && request.method === "GET") return await stats(request, env);
      if (pathname === "/v1/health") return json({ ok: true });
    } catch (error) {
      console.error(error);
      return json({ error: "internal error" }, 500);
    }
    if (pathname.startsWith("/v1/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
