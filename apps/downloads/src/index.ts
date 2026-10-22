// Serves the desktop installers and updater bundles from R2.
//
// Public:
//   GET|HEAD /latest/<file>    the file from the release the landing page offers
//   GET|HEAD /<tag>/<file>     a file from one release (the updater feed uses these)
//   GET      /current          {"tag": "vX.Y.Z"} of that release
//   GET|HEAD /update/latest.json  the signed updater feed, also routed from screensway.site
//                                 (anything else there, or a missing feed, goes on to Pages)
// Deploy workflow only (Authorization: Bearer UPLOAD_TOKEN):
//   POST /admin/uploads/<tag>/<file>                      start a multipart upload
//   PUT  /admin/uploads/<tag>/<file>?uploadId=&part=N     upload one part
//   POST /admin/uploads/<tag>/<file>/complete?uploadId=   finish it
//   PUT  /admin/current                                    {"tag"} switch releases, keep one previous
//   PUT  /admin/update                                     the updater feed (latest.json)

export interface Env {
  BUCKET: R2Bucket;
  UPLOAD_TOKEN: string;
}

const TAG = /^v\d+\.\d+\.\d+$/;
const FILES = new Set([
  "ScreenSway-macos-universal.dmg",
  "ScreenSway-macos-universal.app.tar.gz",
  "ScreenSway-windows-x64-setup.exe",
]);
// A release is only offered once every installer is there.
const REQUIRED = ["ScreenSway-macos-universal.dmg", "ScreenSway-windows-x64-setup.exe"];
const CURRENT_KEY = "current";
const UPDATE_KEY = "update/latest.json";
// The site the updater feed is routed from; every other path there is GitHub Pages.
const SITE_HOST = "screensway.site";
const SHA256 = /^[0-9a-f]{64}$/;

const key = (tag: string, file: string) => `releases/${tag}/${file}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const notFound = () => json({ error: "not found" }, 404);

// Every /latest download needs the current tag. Keep it for a short while in this isolate, so a
// rush of visitors costs one R2 read per isolate instead of one per download. A new release is
// picked up within this time; the release it replaces stays in the bucket meanwhile.
const CURRENT_TTL_MS = 30_000;
let cachedTag: { tag: string | null; until: number } | null = null;

async function readCurrentTag(env: Env): Promise<string | null> {
  const object = await env.BUCKET.get(CURRENT_KEY);
  const tag = object ? (await object.text()).trim() : "";
  return TAG.test(tag) ? tag : null;
}

async function currentTag(env: Env, fresh = false): Promise<string | null> {
  if (!fresh && cachedTag && cachedTag.until > Date.now()) return cachedTag.tag;
  const tag = await readCurrentTag(env);
  cachedTag = { tag, until: Date.now() + CURRENT_TTL_MS };
  return tag;
}

async function serveFile(request: Request, env: Env, tag: string, file: string, immutable: boolean): Promise<Response> {
  const object = await env.BUCKET.get(key(tag, file), { range: request.headers, onlyIf: request.headers });
  if (!object) return notFound();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename="${file}"`);
  // A tagged file never changes; /latest moves when a new release is published.
  headers.set("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "public, max-age=300");
  const sha256 = object.customMetadata?.sha256;
  if (sha256) headers.set("X-Checksum-Sha256", sha256);
  if (!("body" in object)) return new Response(null, { status: 304, headers });
  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && request.headers.has("Range")) {
    const offset = range.suffix !== undefined ? object.size - range.suffix : range.offset ?? 0;
    const length = range.suffix ?? range.length ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(request.method === "HEAD" ? null : object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

function authorized(request: Request, env: Env): boolean {
  const expected = `Bearer ${env.UPLOAD_TOKEN ?? ""}`;
  const given = request.headers.get("Authorization") ?? "";
  if (!env.UPLOAD_TOKEN || given.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ given.charCodeAt(index);
  return difference === 0;
}

async function admin(request: Request, env: Env, url: URL, parts: string[]): Promise<Response> {
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

  if (parts[1] === "update" && parts.length === 2 && request.method === "PUT") {
    const feed = (await request.json().catch(() => null)) as { version?: unknown; platforms?: unknown } | null;
    if (!feed || typeof feed.version !== "string" || !feed.platforms || typeof feed.platforms !== "object") {
      return json({ error: "invalid feed" }, 400);
    }
    await env.BUCKET.put(UPDATE_KEY, JSON.stringify(feed, null, 2), { httpMetadata: { contentType: "application/json" } });
    return json({ version: feed.version });
  }

  if (parts[1] === "current" && request.method === "PUT") {
    const { tag } = (await request.json().catch(() => ({}))) as { tag?: string };
    if (!tag || !TAG.test(tag)) return json({ error: "invalid tag" }, 400);
    const missing = [];
    for (const file of REQUIRED) if (!(await env.BUCKET.head(key(tag, file)))) missing.push(file);
    if (missing.length) return json({ error: "release is incomplete", missing }, 409);
    const previous = await currentTag(env, true);
    await env.BUCKET.put(CURRENT_KEY, tag);
    cachedTag = { tag, until: Date.now() + CURRENT_TTL_MS };
    // Keep the release being replaced: a client may be mid-update from its feed entry.
    const keep = new Set([tag, previous]);
    const removed: string[] = [];
    let cursor: string | undefined;
    do {
      const listing = await env.BUCKET.list({ prefix: "releases/", cursor });
      const stale = listing.objects.map((object) => object.key).filter((name) => !keep.has(name.split("/")[1]));
      if (stale.length) await env.BUCKET.delete(stale);
      removed.push(...stale);
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
    return json({ tag, previous, removed });
  }

  const [, kind, tag, file, action] = parts;
  if (kind !== "uploads" || !TAG.test(tag ?? "") || !FILES.has(file ?? "")) return notFound();
  const objectKey = key(tag, file);
  const uploadId = url.searchParams.get("uploadId");

  if (request.method === "POST" && !action) {
    const sha256 = request.headers.get("X-Checksum-Sha256") ?? "";
    if (!SHA256.test(sha256)) return json({ error: "X-Checksum-Sha256 is required" }, 400);
    const upload = await env.BUCKET.createMultipartUpload(objectKey, { customMetadata: { sha256 } });
    return json({ uploadId: upload.uploadId });
  }
  if (!uploadId) return json({ error: "uploadId is required" }, 400);
  const upload = env.BUCKET.resumeMultipartUpload(objectKey, uploadId);

  if (request.method === "PUT" && !action) {
    const partNumber = Number(url.searchParams.get("part"));
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || !request.body) {
      return json({ error: "invalid part" }, 400);
    }
    const part = await upload.uploadPart(partNumber, request.body);
    return json(part);
  }
  if (request.method === "POST" && action === "complete") {
    const { parts: uploaded } = (await request.json()) as { parts: R2UploadedPart[] };
    const object = await upload.complete(uploaded);
    return json({ key: object.key, size: object.size });
  }
  return notFound();
}

// The feed is published by every landing deploy, so it changes without a new URL.
async function serveFeed(request: Request, env: Env): Promise<Response | null> {
  const object = await env.BUCKET.get(UPDATE_KEY);
  if (!object) return null;
  const headers = { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", ETag: object.httpEtag };
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === SITE_HOST) {
      const feed = url.pathname === `/${UPDATE_KEY}` && (request.method === "GET" || request.method === "HEAD");
      return (feed && (await serveFeed(request, env).catch(() => null))) || fetch(request);
    }
    let parts: string[];
    try {
      parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return notFound(); // a malformed %-escape
    }
    try {
      if (parts[0] === "admin") return await admin(request, env, url, parts);
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);
      if (parts.length === 1 && parts[0] === "current") return json({ tag: await currentTag(env) });
      if (url.pathname === `/${UPDATE_KEY}`) return (await serveFeed(request, env)) ?? notFound();
      if (parts.length !== 2 || !FILES.has(parts[1])) return notFound();
      if (parts[0] === "latest") {
        const tag = await currentTag(env);
        return tag ? await serveFile(request, env, tag, parts[1], false) : notFound();
      }
      return TAG.test(parts[0]) ? await serveFile(request, env, parts[0], parts[1], true) : notFound();
    } catch (error) {
      console.error(error);
      return json({ error: "internal error" }, 500);
    }
  },
};
