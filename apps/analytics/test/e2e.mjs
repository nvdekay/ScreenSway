// End-to-end check of the Worker against a throwaway local D1 database:
// ingestion rules, authentication, and the numbers /v1/stats reports.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const state = mkdtempSync(join(tmpdir(), "screensway-analytics-"));
const port = 8799;
const base = `http://127.0.0.1:${port}`;
const wrangler = join(root, "node_modules", ".bin", "wrangler");

execFileSync(wrangler, ["d1", "migrations", "apply", "screensway-analytics", "--local", "--persist-to", state], { cwd: root, stdio: "pipe" });
const server = spawn(wrangler, ["dev", "--port", String(port), "--persist-to", state, "--var", "DASHBOARD_TOKEN:secret", "--var", "ACTOR_SALT:salt", "--var", "ADMIN_USERNAME:admin", "--var", "ADMIN_PASSWORD:pass word"], { cwd: root, stdio: "pipe" });
let log = "";
server.stdout.on("data", (chunk) => (log += chunk));
server.stderr.on("data", (chunk) => (log += chunk));

const post = (body, headers = {}) => fetch(`${base}/v1/events`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers });
const stats = async (token = "secret", query = "") => {
  const response = await fetch(`${base}/v1/stats${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: response.status, body: await response.json() };
};
const installA = "a".repeat(32), installB = "b".repeat(32);

try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(`${base}/v1/health`)).ok) break;
    } catch {}
    if (attempt > 120) throw new Error(`wrangler dev did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // Ingestion: valid batches are stored, everything else is rejected or dropped.
  let response = await post({ source: "web", events: [{ name: "page_view", props: { referrer: "google.com", lang: "vi", theme: "dark", os: "macos" } }] }, { "User-Agent": "visitor-1" });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: 1 });
  await post({ source: "web", events: [{ name: "page_view", props: { referrer: "direct", lang: "en", os: "windows" } }, { name: "download_click", props: { platform: "windows", placement: "hero" } }] }, { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) visitor-2" });
  await post({ source: "web", events: [{ name: "download_click", props: { platform: "macos", placement: "hero" } }, { name: "download_click", props: { platform: "macos", placement: "guide" } }] }, { "User-Agent": "visitor-1" });
  await post({ source: "app", installId: installA, version: "0.3.1", os: "macos-aarch64", locale: "vi", events: [
    { name: "app_open" },
    { name: "recording_started", props: { source: "display", system_audio: true, microphone: false } },
    { name: "recording_finished", props: { duration: "30s-2m" } },
    { name: "export_finished", props: { quality: "4k", frame: "macos-dark", captions: true, path: "/Users/someone/Movies/secret.mp4", note: "x".repeat(80) } },
    { name: "made_up_event" },
  ] });
  await post({ source: "app", installId: installB, version: "0.3.1", os: "windows-x86_64", locale: "en", events: [{ name: "app_open" }, { name: "export_finished", props: { quality: "1080p", frame: "none", captions: false } }] });

  // The browser app (source "studio") is counted per visitor-day, like the landing page.
  await post({ source: "studio", version: "0.3.3", os: "macos", locale: "vi", events: [
    { name: "app_open", props: { browser: "edge", referrer: "landing" } },
    { name: "recording_started", props: { source: "monitor", system_audio: true, shared_audio: false, microphone: false } },
    { name: "recording_finished", props: { duration: "<30s", format: "mp4" } },
    { name: "style_applied", props: { style: "clean" } },
    { name: "export_finished", props: { quality: "1080p", frame: "macos-dark", aspect: "auto", background: "mesh", auto_zoom: true, trimmed: false, duration: "<30s" } },
    { name: "made_up_event" },
  ] }, { "User-Agent": "studio-visitor-1" });
  await post({ source: "studio", events: [{ name: "desktop_click", props: { placement: "header" } }] }, { "User-Agent": "studio-visitor-1" });
  await post({ source: "studio", events: [{ name: "unsupported_shown", props: { browser: "safari", reason: "streams" } }] }, { "User-Agent": "studio-visitor-2" });

  assert.equal((await post({ source: "app", installId: "not-an-id", events: [{ name: "app_open" }] })).status, 400);
  assert.equal((await post({ source: "other", events: [] })).status, 400);
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post({ source: "web", events: [{ name: "page_view", props: { referrer: "y".repeat(20000) } }] })).status, 413);
  // The limit counts UTF-8 bytes: 6,000 characters of Vietnamese text is over 16 KB.
  assert.equal((await post({ source: "web", events: [{ name: "page_view", props: { referrer: "ữ".repeat(6000) } }] })).status, 413);
  // A browser beacon arrives as text/plain; it must be accepted without a preflight.
  assert.equal((await post(JSON.stringify({ source: "web", events: [{ name: "guide_open" }] }), { "Content-Type": "text/plain", "User-Agent": "visitor-1" })).status, 202);

  // Reporting requires the token or a signed-in session.
  assert.equal((await stats("")).status, 401);
  assert.equal((await stats("wrong")).status, 401);
  assert.equal((await stats("secretx")).status, 401);
  assert.equal((await stats("secre")).status, 401);
  const { status, body } = await stats();
  assert.equal(status, 200);
  assert.equal(body.range.days, 30);
  assert.equal(body.series.length, 30);
  assert.deepEqual(body.totals, {
    pageViews: 2, visitors: 2, downloads: 3, guideOpens: 1,
    activeInstalls: 2, newInstalls: 2, appOpens: 2, recordings: 1, exports: 2, captions: 0,
  });
  assert.equal(body.previous.downloads, 0);
  assert.deepEqual(body.activeNow, { daily: 2, weekly: 2, monthly: 2 });
  const today = body.series.at(-1);
  assert.equal(today.day, body.range.to);
  assert.deepEqual([today.downloadsMac, today.downloadsWindows, today.visitors, today.activeInstalls, today.newInstalls, today.exports], [2, 1, 2, 2, 2, 2]);
  assert.deepEqual(body.breakdowns.exportQuality.map((row) => `${row.key}:${row.count}`).sort(), ["1080p:1", "4k:1"]);
  assert.deepEqual(body.breakdowns.exportCaptions.map((row) => row.key).sort(), ["false", "true"]);
  assert.deepEqual(body.breakdowns.downloadPlacement, [{ key: "hero", count: 2 }, { key: "guide", count: 1 }]);
  assert.deepEqual(body.web.referrers.map((row) => row.key).sort(), ["direct", "google.com"]);
  assert.deepEqual(body.app.versions, [{ key: "0.3.1", count: 2 }]);
  assert.equal(body.app.os.length, 2);
  // Unknown events and unsafe properties never reach the database.
  assert.ok(!body.events.some((event) => event.name === "made_up_event"));
  const exported = body.recent.find((event) => event.name === "export_finished" && event.props.quality === "4k");
  assert.deepEqual(exported.props, { quality: "4k", frame: "macos-dark", captions: true });
  assert.equal((await stats("secret", "?days=7")).body.series.length, 7);
  // Landing rows get their system from the browser and their language from the page view.
  const download = body.recent.find((event) => event.source === "web" && event.name === "download_click" && event.props.platform === "windows");
  assert.equal(download.os, "windows");
  assert.equal(download.locale, "en");
  assert.equal(download.version, null);

  // The browser app has its own section, and its events never leak into the desktop numbers.
  const studio = body.studio;
  assert.deepEqual(
    [studio.totals.visitors, studio.totals.opens, studio.totals.recordingsStarted, studio.totals.recordings, studio.totals.exports, studio.totals.styles, studio.totals.unsupported, studio.totals.desktopClicks],
    [2, 1, 1, 1, 1, 1, 1, 1],
  );
  assert.deepEqual(studio.funnel, { opened: 1, started: 1, recorded: 1, exported: 1 });
  assert.deepEqual(studio.breakdowns.browser, [{ key: "edge", count: 1 }]);
  assert.deepEqual(studio.breakdowns.recordingSource, [{ key: "monitor", count: 1 }]);
  assert.deepEqual(studio.breakdowns.recordingSharedAudio, [{ key: "false", count: 1 }]);
  assert.deepEqual(studio.breakdowns.unsupportedReason, [{ key: "streams", count: 1 }]);
  assert.deepEqual(studio.breakdowns.desktopPlacement, [{ key: "header", count: 1 }]);
  assert.equal(studio.series.length, 30);
  assert.deepEqual([studio.series.at(-1).visitors, studio.series.at(-1).recordings, studio.series.at(-1).exports], [2, 1, 1]);
  assert.ok(!studio.events.some((event) => event.name === "made_up_event"));
  assert.equal(body.totals.exports, 2, "studio exports are not counted as desktop exports");

  // The dashboard account signs in to an HttpOnly session cookie.
  const login = (body) => fetch(`${base}/v1/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const withCookie = async (cookie) => (await fetch(`${base}/v1/stats?days=7`, { headers: { Cookie: cookie } })).status;
  for (const wrong of [{ username: "admin", password: "pass" }, { username: "Admin", password: "pass word" }, { username: "admin" }, {}, { username: "admin", password: "pass word " }]) {
    const refused = await login(wrong);
    assert.equal(refused.status, 401, `refuses ${JSON.stringify(wrong)}`);
    assert.equal(refused.headers.get("Set-Cookie"), null);
  }
  assert.equal((await fetch(`${base}/v1/login`, { method: "POST", body: "{" })).status, 400);
  let signIn = await login({ username: "admin", password: "pass word", remember: true });
  assert.equal(signIn.status, 204);
  const remembered = signIn.headers.get("Set-Cookie");
  assert.match(remembered, /^screensway_session=\d+\.[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/);
  const session = remembered.split(";")[0];
  assert.equal(await withCookie(session), 200, "a session reads reports");
  assert.equal(await withCookie(`other=1; ${session}`), 200, "among other cookies");
  const [, expires, signature] = session.match(/=(\d+)\.(.+)$/);
  assert.equal(await withCookie(`screensway_session=${Number(expires) + 86400}.${signature}`), 401, "a longer expiry needs a new signature");
  assert.equal(await withCookie(`screensway_session=${expires}.${signature.slice(0, -2)}xx`), 401, "a forged signature is refused");
  assert.equal(await withCookie(`screensway_session=${expires}`), 401);
  signIn = await login({ username: "admin", password: "pass word" });
  assert.doesNotMatch(signIn.headers.get("Set-Cookie"), /Max-Age/, "without remember the cookie ends with the browser session");
  const signOut = await fetch(`${base}/v1/logout`, { method: "POST" });
  assert.equal(signOut.status, 204);
  assert.match(signOut.headers.get("Set-Cookie"), /^screensway_session=; .*Max-Age=0$/);

  // Reports are shared for a minute; "fresh" (the Refresh button) always recomputes.
  await post({ source: "web", events: [{ name: "page_view", props: { referrer: "direct" } }] }, { "User-Agent": "visitor-3" });
  assert.equal((await stats()).body.totals.pageViews, 2, "a report within a minute is reused");
  assert.equal((await stats("secret", "?fresh=1")).body.totals.pageViews, 3, "fresh recomputes");

  // The dashboard itself is served as a static page.
  const page = await fetch(base);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /ScreenSway/);
  // It only talks to its own origin, and its CSP still matches the inline script.
  assert.doesNotMatch(html, /get\("api"\)|localStorage\.setItem\(k/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const hash = createHash("sha256").update(script).digest("base64");
  assert.match(html, new RegExp(`script-src 'sha256-${hash.replace(/[+/]/g, "\\$&")}'`), "update the dashboard CSP hash");
  assert.match(html, /connect-src 'self'/);

  // Password guessing from one address is cut off.
  let throttled = false;
  for (let attempt = 0; attempt < 30 && !throttled; attempt++) throttled = (await login({ username: "admin", password: `guess-${attempt}` })).status === 429;
  assert.ok(throttled, "sign-in was not rate limited");

  // Floods from one address are cut off by the rate limiter.
  let limited = false;
  for (let attempt = 0; attempt < 160 && !limited; attempt++) limited = (await post({ source: "web", events: [] })).status === 429;
  assert.ok(limited, "ingestion was not rate limited");
  console.log("analytics e2e: ok");
} finally {
  server.kill("SIGTERM");
  rmSync(state, { recursive: true, force: true });
}
