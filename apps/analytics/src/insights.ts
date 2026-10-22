/**
 * Journey numbers that need more than counting events: funnels joined by session, first
 * successes, time to first success, retention cohorts, feature interest, server-side download
 * starts and commerce. Everything is derived on the server from stored events, so a client
 * cannot claim a "first" export, and nothing here is estimated.
 */
import { daysBetween, quantile, shiftDay } from "./normalize";

type Row = Record<string, string | number | null>;
const rows = (result: D1Result<unknown>) => (result.results ?? []) as Row[];
const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));

/**
 * The browser steps, in order. Each must happen at or after the previous one in the same
 * journey. Opening /app/ directly is a journey too, so the landing step is measured apart.
 */
const LANDING_STEP = "source = 'web' AND name = 'page_view'";
const WEB_STEPS = [
  ["opened", "source = 'studio' AND name = 'app_open'"],
  ["started", "source = 'studio' AND name = 'recording_started'"],
  ["recorded", "source = 'studio' AND name = 'recording_finished'"],
  ["exportStarted", "source = 'studio' AND name = 'export_started'"],
  ["exported", "source = 'studio' AND name = 'export_finished'"],
] as const;
const APP_STEPS = [
  ["opened", "name = 'app_open'"],
  ["started", "name = 'recording_started'"],
  ["recorded", "name = 'recording_finished'"],
  ["exportStarted", "name = 'export_started'"],
  ["exported", "name = 'export_finished'"],
] as const;

/** One row per journey: its key, the first time of each step and the extra columns. */
function journeySql(steps: readonly (readonly [string, string])[], scope: string, extra: string) {
  const firsts = steps.map(([name, condition]) => `MIN(CASE WHEN ${condition} THEN ts END) ${name}`).join(", ");
  return `SELECT session_id k, ${firsts}${extra} FROM events WHERE ${scope} AND session_id IS NOT NULL GROUP BY session_id`;
}

/**
 * Keeps a step only when every earlier step happened at or before it in the same journey,
 * so a finish without a start, or an export before any recording, does not count.
 */
function ordered(row: Row, steps: readonly (readonly [string, string])[]): Row {
  const result: Row = { ...row };
  let previous: number | null = null;
  steps.forEach(([name], index) => {
    const at = row[name] === null || row[name] === undefined ? null : Number(row[name]);
    const reached = at !== null && (index === 0 || (previous !== null && at >= previous));
    result[name] = reached ? at : null;
    previous = reached ? at : null;
  });
  return result;
}

function summarizeJourneys(list: Row[], steps: readonly (readonly [string, string])[]): Record<string, number> {
  return Object.fromEntries(steps.map(([name]) => [name, list.filter((row) => row[name] !== null).length]));
}

/** Browser journeys (landing → /app/ → record → export) and desktop launches in the range. */
export async function funnels(db: D1Database, fromTs: number, toTs: number) {
  const webScope = `source IN ('web', 'studio') AND ts BETWEEN ${fromTs} AND ${toTs}`;
  // Dimensions of a browser journey: taken from its first studio open.
  const webExtra = `, MIN(CASE WHEN ${LANDING_STEP} THEN ts END) landing, MAX(CASE WHEN source = 'studio' THEN os END) os, MAX(CASE WHEN source = 'studio' THEN version END) version, MAX(country) country, MAX(locale) locale,
    MAX(CASE WHEN source = 'studio' AND name = 'app_open' THEN json_extract(props, '$.browser') END) browser,
    MAX(CASE WHEN name = 'app_open' THEN json_extract(props, '$.referrer') WHEN name = 'page_view' THEN json_extract(props, '$.referrer') END) referrer`;
  const appScope = `source = 'app' AND ts BETWEEN ${fromTs} AND ${toTs}`;
  const appExtra = ", MAX(os) os, MAX(version) version, MAX(country) country, MAX(locale) locale";
  const [web, app, outcomes] = await db.batch([
    db.prepare(journeySql(WEB_STEPS, webScope, webExtra)),
    db.prepare(journeySql(APP_STEPS, appScope, appExtra)),
    db.prepare(`SELECT source, name, COUNT(*) c FROM events WHERE source IN ('studio', 'app') AND ts BETWEEN ? AND ?
      AND name IN ('recording_started', 'recording_finished', 'recording_failed', 'export_started', 'export_finished', 'export_failed', 'export_cancelled') GROUP BY source, name`).bind(fromTs, toTs),
  ]);
  const rawWeb = rows(web);
  const webRows = rawWeb.map((row) => ordered(row, WEB_STEPS)), appRows = rows(app).map((row) => ordered(row, APP_STEPS));
  const breakdown = (list: Row[], column: string) => {
    const groups = new Map<string, Row[]>();
    for (const row of list) {
      if (row.opened === null) continue;
      const key = row[column] === null || row[column] === undefined ? "unknown" : String(row[column]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.entries()]
      .map(([key, group]) => ({ key, opened: group.length, recorded: group.filter((row) => row.recorded !== null).length, exported: group.filter((row) => row.exported !== null).length }))
      .sort((a, b) => b.opened - a.opened)
      .slice(0, 12);
  };
  const outcome = (source: string) => {
    const count = (name: string) => num(rows(outcomes).find((row) => row.source === source && row.name === name)?.c);
    return {
      recordingsStarted: count("recording_started"),
      recordings: count("recording_finished"),
      recordingFailures: count("recording_failed"),
      exportsStarted: count("export_started"),
      exports: count("export_finished"),
      exportFailures: count("export_failed"),
      exportCancels: count("export_cancelled"),
    };
  };
  return {
    web: {
      journeys: webRows.length,
      // Journeys that saw the landing page, and of those, how many then opened the browser app.
      landing: {
        visited: rawWeb.filter((row) => row.landing !== null).length,
        openedStudio: rawWeb.filter((row) => row.landing !== null && row.opened !== null && Number(row.opened) >= Number(row.landing)).length,
      },
      steps: summarizeJourneys(webRows, WEB_STEPS),
      outcomes: outcome("studio"),
      by: Object.fromEntries(["os", "browser", "version", "country", "locale", "referrer"].map((column) => [column, breakdown(webRows, column)])),
    },
    app: {
      sessions: appRows.length,
      steps: summarizeJourneys(appRows, APP_STEPS),
      outcomes: outcome("app"),
      by: Object.fromEntries(["os", "version", "country", "locale"].map((column) => [column, breakdown(appRows, column)])),
    },
  };
}

/**
 * First successes per subject: a desktop installation, or in the browser a consenting visitor
 * (stable ID) or else one journey. "First" is the earliest stored event of all time, so an
 * export is never counted as first twice. Only subjects first seen in the range are included.
 */
export async function firstSuccess(db: D1Database, fromTs: number, toTs: number) {
  const subject = (source: "studio" | "app") => (source === "app" ? "actor" : "COALESCE(visitor_id, session_id)");
  const query = (source: "studio" | "app") => db.prepare(`
    SELECT k, opened, recorded, exported,
      (SELECT COUNT(*) FROM events e WHERE e.source = '${source}' AND ${subject(source).replace(/(\w+_id|actor)/g, "e.$1")} = f.k AND e.name = 'recording_started' AND (f.exported IS NULL OR e.ts <= f.exported)) tries
    FROM (
      SELECT ${subject(source)} k,
        MIN(CASE WHEN name = 'app_open' THEN ts END) opened,
        MIN(CASE WHEN name = 'recording_finished' THEN ts END) recorded,
        MIN(CASE WHEN name = 'export_finished' THEN ts END) exported,
        MIN(ts) first
      FROM events WHERE source = '${source}' AND ${subject(source)} IS NOT NULL GROUP BY k
    ) f WHERE first BETWEEN ? AND ?`).bind(fromTs, toTs);
  const [studio, app] = await db.batch([query("studio"), query("app")]);
  const summarize = (list: Row[]) => {
    const toRecording = list.filter((row) => row.opened !== null && row.recorded !== null && num(row.recorded) >= num(row.opened)).map((row) => num(row.recorded) - num(row.opened)).sort((a, b) => a - b);
    const toExport = list.filter((row) => row.opened !== null && row.exported !== null && num(row.exported) >= num(row.opened)).map((row) => num(row.exported) - num(row.opened)).sort((a, b) => a - b);
    const exporters = list.filter((row) => row.exported !== null);
    return {
      subjects: list.length,
      firstRecordings: list.filter((row) => row.recorded !== null).length,
      firstExports: exporters.length,
      timeToFirstRecordingMs: { median: quantile(toRecording, 0.5), p90: quantile(toRecording, 0.9), samples: toRecording.length },
      timeToFirstExportMs: { median: quantile(toExport, 0.5), p90: quantile(toExport, 0.9), samples: toExport.length },
      // Recordings started up to and including the one that led to the first export.
      averageTriesBeforeFirstExport: exporters.length ? exporters.reduce((sum, row) => sum + num(row.tries), 0) / exporters.length : null,
    };
  };
  return { studio: summarize(rows(studio)), app: summarize(rows(app)) };
}

const RETENTION_DAYS = [1, 7, 30] as const;

/**
 * Day-N retention by first-seen cohort: the share of a cohort active again exactly N days
 * later. Only stable, consented IDs count: desktop installations that share statistics and
 * browser visitors who opted in. A cohort too young for day N reports null, never 0.
 */
export async function retention(db: D1Database, from: string, today: string) {
  const cohorts = (subject: string, scope: string) => db.prepare(`
    WITH firsts AS (SELECT ${subject} k, MIN(day) d FROM events WHERE ${scope} AND ${subject} IS NOT NULL GROUP BY k),
    active AS (SELECT DISTINCT ${subject} k, day FROM events WHERE ${scope} AND ${subject} IS NOT NULL)
    SELECT f.d cohort, COUNT(DISTINCT f.k) size,
      ${RETENTION_DAYS.map((n) => `COUNT(DISTINCT CASE WHEN a.day = date(f.d, '+${n} day') THEN f.k END) d${n}`).join(", ")}
    FROM firsts f LEFT JOIN active a ON a.k = f.k
    WHERE f.d BETWEEN ? AND ? GROUP BY f.d ORDER BY f.d`).bind(from, today);
  const [app, web] = await db.batch([cohorts("actor", "source = 'app'"), cohorts("visitor_id", "source IN ('web', 'studio')")]);
  const shape = (list: Row[]) => {
    const cohortRows = list.map((row) => {
      const age = daysBetween(String(row.cohort), today);
      const cohort: Record<string, string | number | null> = { day: String(row.cohort), size: num(row.size) };
      for (const n of RETENTION_DAYS) cohort[`d${n}`] = age >= n ? num(row[`d${n}`]) : null;
      return cohort;
    });
    // Overall rates use mature cohorts only, so young cohorts do not drag them to zero.
    const overall = Object.fromEntries(RETENTION_DAYS.map((n) => {
      const mature = cohortRows.filter((row) => row[`d${n}`] !== null);
      const size = mature.reduce((sum, row) => sum + num(row.size), 0);
      const back = mature.reduce((sum, row) => sum + num(row[`d${n}`]), 0);
      return [`d${n}`, { rate: size ? back / size : null, cohortSize: size }];
    }));
    return { cohorts: cohortRows, overall };
  };
  return { app: shape(rows(app)), web: shape(rows(web)) };
}

export async function extras(db: D1Database, from: string, today: string, days: number) {
  const range = "day BETWEEN ? AND ?";
  const [interest, downloads, downloadDaily, commerceEvents, commerce, feedbackSent] = await db.batch([
    db.prepare(`SELECT source, json_extract(props, '$.feature') k, COUNT(*) c, COUNT(DISTINCT COALESCE(visitor_id, session_id, actor)) u
      FROM events WHERE name = 'feature_interest' AND ${range} GROUP BY source, k ORDER BY u DESC, c DESC`).bind(from, today),
    db.prepare(`SELECT json_extract(props, '$.platform') platform, json_extract(props, '$.channel') channel, COUNT(*) c
      FROM events WHERE source = 'downloads' AND name = 'download_started' AND ${range} GROUP BY platform, channel`).bind(from, today),
    db.prepare(`SELECT day, COUNT(*) c FROM events WHERE source = 'downloads' AND name = 'download_started' AND json_extract(props, '$.channel') = 'latest' AND ${range} GROUP BY day`).bind(from, today),
    db.prepare(`SELECT name, COUNT(*) c FROM events WHERE name IN ('pricing_viewed', 'checkout_started') AND ${range} GROUP BY name`).bind(from, today),
    db.prepare(`SELECT type, COUNT(*) c, SUM(amount_minor) amount, currency FROM commerce_events WHERE ${range} GROUP BY type, currency`).bind(from, today),
    db.prepare(`SELECT json_extract(props, '$.category') k, COUNT(*) c FROM events WHERE name = 'feedback_submitted' AND ${range} GROUP BY k`).bind(from, today),
  ]);
  const featureRows = rows(interest);
  const features = new Map<string, { key: string; people: number; choices: number }>();
  for (const row of featureRows) {
    const key = row.k === null ? "unknown" : String(row.k);
    const item = features.get(key) ?? { key, people: 0, choices: 0 };
    item.people += num(row.u);
    item.choices += num(row.c);
    features.set(key, item);
  }
  const series = Array.from({ length: days }, (_, index) => {
    const day = shiftDay(from, index);
    return { day, downloadsStarted: num(rows(downloadDaily).find((row) => row.day === day)?.c) };
  });
  return {
    featureInterest: [...features.values()].sort((a, b) => b.people - a.people || b.choices - a.choices),
    downloadsStarted: {
      total: rows(downloads).filter((row) => row.channel === "latest").reduce((sum, row) => sum + num(row.c), 0),
      byPlatform: rows(downloads).map((row) => ({ platform: row.platform ?? "unknown", channel: row.channel ?? "unknown", count: num(row.c) })),
      series,
    },
    commerce: {
      // Product analytics (client events) and revenue (verified webhooks only) stay apart.
      funnel: Object.fromEntries(["pricing_viewed", "checkout_started"].map((name) => [name, num(rows(commerceEvents).find((row) => row.name === name)?.c)])),
      revenue: rows(commerce).map((row) => ({ type: row.type, count: num(row.c), amountMinor: num(row.amount), currency: row.currency })),
    },
    feedbackSubmitted: rows(feedbackSent).map((row) => ({ key: row.k === null ? "unknown" : String(row.k), count: num(row.c) })),
  };
}
