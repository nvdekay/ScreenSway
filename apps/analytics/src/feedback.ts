/**
 * Feedback people write and send on purpose, from the browser app and the desktop app.
 *
 *   POST  /v1/feedback       public, rate limited; stores one message
 *   GET   /v1/feedback       admin; filtered, searchable, paginated list plus a summary
 *   PATCH /v1/feedback/:id   admin; status and an optional note
 *
 * It lives in its own table and never reaches the events table, its properties or any
 * breakdown, and the email address is only ever returned by the admin list.
 */
import { dayOf, normalizeCountry, randomId, shortText, tzOffsetMinutes } from "./normalize";

export interface FeedbackEnv {
  DB: D1Database;
  TZ_OFFSET_MINUTES?: string;
  FEEDBACK_LIMITER?: RateLimit;
  FEEDBACK_RETENTION_DAYS?: string;
  ACTOR_SALT?: string;
}

export const FEEDBACK_SOURCES = ["studio", "app"] as const;
export const FEEDBACK_CATEGORIES = ["idea", "bug", "feature", "experience", "other"] as const;
export const FEEDBACK_STATUSES = ["new", "read", "in_progress", "resolved", "archived"] as const;

export const MAX_FEEDBACK_BYTES = 12 * 1024;
export const MAX_MESSAGE_CHARS = 4_000;
export const MAX_EMAIL_CHARS = 254;
const MAX_NOTE_CHARS = 2_000;
const MAX_LINKS = 5;
const DUPLICATE_WINDOW_MS = 24 * 3_600_000;
const DEFAULT_RETENTION_DAYS = 730;
const PAGE_SIZE = 25, MAX_PAGE_SIZE = 100;
// Roughly an address: something, @, a dotted domain, no spaces or angle brackets.
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

type Reply = (body: unknown, status?: number) => Response;
type Row = Record<string, string | number | null>;

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

/** Text as typed, minus control characters other than line breaks and tabs. */
function cleanText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function submitFeedback(request: Request, env: FeedbackEnv, reply: Reply): Promise<Response> {
  const address = request.headers.get("CF-Connecting-IP") ?? "";
  if (env.FEEDBACK_LIMITER && !(await env.FEEDBACK_LIMITER.limit({ key: address || "unknown" })).success) {
    return reply({ error: "too many requests" }, 429);
  }
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_FEEDBACK_BYTES) return reply({ error: "payload too large" }, 413);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_FEEDBACK_BYTES) return reply({ error: "payload too large" }, 413);
  let body: Record<string, unknown>;
  try {
    // Invalid UTF-8 is refused rather than silently replaced.
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as Record<string, unknown>;
  } catch {
    return reply({ error: "invalid" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "invalid" }, 400);
  // The honeypot: a field people never see, so only a form-filling bot puts text in it.
  if (typeof body.website === "string" && body.website.length > 0) return reply({ error: "invalid" }, 400);
  if (!isOneOf(FEEDBACK_SOURCES, body.source) || !isOneOf(FEEDBACK_CATEGORIES, body.category)) return reply({ error: "invalid" }, 400);
  const rating = body.rating ?? null;
  if (rating !== null && !(Number.isInteger(rating) && (rating as number) >= 1 && (rating as number) <= 5)) return reply({ error: "invalid" }, 400);
  if (typeof body.message !== "string") return reply({ error: "invalid" }, 400);
  const message = cleanText(body.message);
  const length = [...message].length;
  if (length < 1 || length > MAX_MESSAGE_CHARS) return reply({ error: "invalid" }, 400);
  if ((message.match(/https?:\/\//gi)?.length ?? 0) > MAX_LINKS) return reply({ error: "invalid" }, 400);
  let email: string | null = null;
  if (body.email !== undefined && body.email !== null && body.email !== "") {
    if (typeof body.email !== "string") return reply({ error: "invalid" }, 400);
    email = body.email.trim();
    if (email.length > MAX_EMAIL_CHARS || !EMAIL.test(email)) return reply({ error: "invalid" }, 400);
  }

  // Technical details only when the person ticked the box; the country is then added here.
  const withMetadata = body.includeMetadata === true;
  const metadata = withMetadata && body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : {};
  const country = withMetadata ? normalizeCountry((request as Request<unknown, IncomingRequestCfProperties>).cf?.country) : null;

  const now = Date.now();
  // The same text from the same address, so a double click or a resend is refused while two
  // people sending "Great app" are not. The address itself is never stored.
  const hash = await sha256Hex(`${address}|${body.source}|${message}|${env.ACTOR_SALT ?? ""}`);
  const duplicate = await env.DB.prepare("SELECT 1 FROM feedback WHERE message_hash = ? AND created_at > ? LIMIT 1").bind(hash, now - DUPLICATE_WINDOW_MS).first();
  if (duplicate) return reply({ error: "duplicate" }, 409);
  await env.DB.prepare(
    `INSERT INTO feedback (created_at, updated_at, day, source, category, rating, message, email, version, os, browser, locale, country, session_id, message_hash, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
  ).bind(
    now, now, dayOf(now, tzOffsetMinutes(env.TZ_OFFSET_MINUTES)), body.source, body.category, rating, message, email,
    shortText(metadata.version), shortText(metadata.os), body.source === "studio" ? shortText(metadata.browser) : null,
    shortText(metadata.locale), country, randomId(metadata.sessionId), hash,
  ).run();
  return reply({ ok: true }, 201);
}

const FILTERS = ["category", "status", "source", "os", "version", "country"] as const;

/** Escapes LIKE wildcards so a search for "50%" finds that text. */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

export async function listFeedback(url: URL, env: FeedbackEnv, reply: Reply): Promise<Response> {
  const params = url.searchParams;
  const where: string[] = [];
  const values: (string | number)[] = [];
  for (const key of FILTERS) {
    const value = params.get(key);
    if (value) {
      where.push(`${key} = ?`);
      values.push(value);
    }
  }
  const rating = Number(params.get("rating"));
  if (Number.isInteger(rating) && rating >= 1 && rating <= 5) {
    where.push("rating = ?");
    values.push(rating);
  }
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = params.get("from"), to = params.get("to");
  if (from && day.test(from)) {
    where.push("day >= ?");
    values.push(from);
  }
  if (to && day.test(to)) {
    where.push("day <= ?");
    values.push(to);
  }
  const q = (params.get("q") ?? "").trim().slice(0, 200);
  if (q) {
    where.push("(message LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR admin_note LIKE ? ESCAPE '\\')");
    values.push(likePattern(q), likePattern(q), likePattern(q));
  }
  // The summary covers every filter; the page also stops at the cursor (newest first).
  const filtered = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const cursor = Number(params.get("cursor"));
  const pageWhere = Number.isInteger(cursor) && cursor > 0 ? [...where, "id < ?"] : where;
  const pageValues = Number.isInteger(cursor) && cursor > 0 ? [...values, cursor] : values;
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(params.get("limit")) || PAGE_SIZE));
  const group = (column: string) =>
    env.DB.prepare(`SELECT ${column} k, COUNT(*) c FROM feedback ${filtered} GROUP BY k ORDER BY c DESC LIMIT 20`).bind(...values);

  const [page, totals, ratings, categories, statuses, sources, oses, versions, countries] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, created_at, updated_at, day, source, category, rating, message, email, version, os, browser, locale, country, status, admin_note
       FROM feedback ${pageWhere.length ? `WHERE ${pageWhere.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
    ).bind(...pageValues, limit + 1),
    env.DB.prepare(`SELECT COUNT(*) total, SUM(status = 'new') unread, AVG(rating) average, COUNT(rating) rated FROM feedback ${filtered}`).bind(...values),
    group("rating"),
    group("category"),
    group("status"),
    group("source"),
    group("os"),
    group("version"),
    group("country"),
  ]);
  const rows = (result: D1Result<unknown>) => (result.results ?? []) as Row[];
  const counts = (result: D1Result<unknown>) => rows(result).map((row) => ({ key: row.k === null ? "unknown" : String(row.k), count: Number(row.c) }));
  const items = rows(page);
  const more = items.length > limit;
  const shown = more ? items.slice(0, limit) : items;
  const total = rows(totals)[0] ?? {};
  return reply({
    items: shown.map((row) => ({
      id: Number(row.id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      day: row.day,
      source: row.source,
      category: row.category,
      rating: row.rating === null ? null : Number(row.rating),
      message: row.message,
      email: row.email,
      version: row.version,
      os: row.os,
      browser: row.browser,
      locale: row.locale,
      country: row.country,
      status: row.status,
      adminNote: row.admin_note,
    })),
    nextCursor: more ? Number(shown[shown.length - 1].id) : null,
    summary: {
      total: Number(total.total ?? 0),
      unread: Number(total.unread ?? 0),
      averageRating: total.average === null || total.average === undefined ? null : Number(total.average),
      rated: Number(total.rated ?? 0),
      ratings: counts(ratings).filter((item) => item.key !== "unknown"),
      categories: counts(categories),
      statuses: counts(statuses),
      sources: counts(sources),
      os: counts(oses),
      versions: counts(versions),
      countries: counts(countries),
    },
  });
}

export async function updateFeedback(request: Request, id: number, env: FeedbackEnv, reply: Reply): Promise<Response> {
  let body: { status?: unknown; adminNote?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return reply({ error: "invalid" }, 400);
  }
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (body.status !== undefined) {
    if (!isOneOf(FEEDBACK_STATUSES, body.status)) return reply({ error: "invalid status" }, 400);
    sets.push("status = ?");
    values.push(body.status);
  }
  if (body.adminNote !== undefined) {
    if (body.adminNote !== null && typeof body.adminNote !== "string") return reply({ error: "invalid note" }, 400);
    const note = body.adminNote === null ? "" : cleanText(body.adminNote);
    if ([...note].length > MAX_NOTE_CHARS) return reply({ error: "invalid note" }, 400);
    sets.push("admin_note = ?");
    values.push(note || null);
  }
  if (!sets.length) return reply({ error: "nothing to change" }, 400);
  const result = await env.DB.prepare(`UPDATE feedback SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...values, Date.now(), id).run();
  if (!result.meta.changes) return reply({ error: "not found" }, 404);
  return reply({ ok: true });
}

/** Deletes feedback older than the retention period (24 months unless configured). */
export async function pruneFeedback(env: FeedbackEnv): Promise<number> {
  const days = Math.max(30, Number(env.FEEDBACK_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS);
  const result = await env.DB.prepare("DELETE FROM feedback WHERE created_at < ?").bind(Date.now() - days * 86_400_000).run();
  return result.meta.changes ?? 0;
}
