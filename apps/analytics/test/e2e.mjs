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
const server = spawn(wrangler, ["dev", "--port", String(port), "--persist-to", state, "--var", "DOWNLOADS_EVENT_TOKEN:dltoken", "--var", "DASHBOARD_TOKEN:secret", "--var", "ACTOR_SALT:salt", "--var", "ADMIN_USERNAME:admin", "--var", "ADMIN_PASSWORD:pass word"], { cwd: root, stdio: "pipe" });
let log = "";
server.stdout.on("data", (chunk) => (log += chunk));
server.stderr.on("data", (chunk) => (log += chunk));

const post = (body, headers = {}) => fetch(`${base}/v1/events`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers });
const stats = async (token = "secret", query = "") => {
  const response = await fetch(`${base}/v1/stats${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: response.status, body: await response.json() };
};
const installA = "a".repeat(32), installB = "b".repeat(32);

/**
 * Opens the dashboard in Edge (BROWSER=chrome for Chrome) with an admin session. Skipped with
 * SCREENSWAY_SKIP_BROWSER=1. SCREENSWAY_SCREENSHOTS=<folder> saves a screenshot of each view.
 */
async function dashboardInBrowser(sessionCookie, message) {
  if (process.env.SCREENSWAY_SKIP_BROWSER === "1") return;
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: process.env.BROWSER ?? "msedge" });
  try {
    // A viewer far from Vietnam: times must still be Vietnam's.
    const context = await browser.newContext({ timezoneId: "America/Los_Angeles", locale: "en-US" });
    const [name, value] = sessionCookie.split("=");
    await context.addCookies([{ name, value, url: base }]);
    const page = await context.newPage();
    const problems = [];
    page.on("dialog", (dialog) => { problems.push(`dialog: ${dialog.message()}`); void dialog.dismiss(); });
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    page.on("console", (entry) => { if (entry.type() === "error" && !entry.text().startsWith("Failed to load resource")) problems.push(`console: ${entry.text()}`); });
    // The browser asks for /favicon.ico on its own; any other failed request is a problem.
    page.on("response", (response) => { if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) problems.push(`HTTP ${response.status()} ${response.url()}`); });
    const shot = async (view) => {
      if (process.env.SCREENSWAY_SCREENSHOTS) await page.screenshot({ path: join(process.env.SCREENSWAY_SCREENSHOTS, `${view}.png`), fullPage: true });
    };
    await page.goto(`${base}/#overview`);
    await page.waitForSelector("#app:not([hidden]) .tile");
    const updated = await page.textContent("#updated");
    assert.match(updated, /giờ Việt Nam \(Asia\/Ho_Chi_Minh\)/);
    await shot("overview");
    for (const view of ["journey", "activity"]) {
      await page.click(`[data-nav="${view}"]`);
      await page.waitForSelector(`[data-view="${view}"]:not([hidden])`);
      await shot(view);
    }
    const activity = await page.textContent('[data-view="activity"]');
    assert.match(activity, /Thời gian \(giờ VN\)/);
    assert.match(activity, /Windows/);
    assert.doesNotMatch(activity, /macos-aarch64|page_view|export_finished/, "raw codes are translated");
    // The newest row's time, read back as Vietnam time, is within a minute of now.
    const firstTime = await page.textContent('[data-view="activity"] tbody tr td');
    const vietnamNow = new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
    assert.ok(firstTime.includes(vietnamNow), `${firstTime} is not Vietnam's date ${vietnamNow}`);
    const journey = await page.textContent('[data-view="journey"]');
    assert.match(journey, /Chưa đủ ngày/);
    assert.match(journey, /Chưa có dữ liệu: ScreenSway chưa bán hàng/);

    await page.click('[data-nav="feedback"]');
    await page.waitForSelector(".fb-item");
    await shot("feedback");
    const shown = await page.$$eval(".fb-message", (nodes) => nodes.map((node) => node.textContent));
    assert.ok(shown.includes(message), "the message is shown exactly as typed");
    assert.equal(await page.$$eval(".fb-list script, .fb-list b", (nodes) => nodes.length), 0, "no HTML from a message is parsed");
    assert.match(await page.textContent("#feedback-view"), /nguoi\.dung@example\.com/, "the admin sees the email");
    // Filter, open a message and change its status from the page.
    await page.selectOption('#fb-filters select[name="category"]', "idea");
    await page.click('#fb-filters button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll(".fb-item").length === 1);
    await page.click(".fb-item .btn");
    await page.click('.fb-item .fb-actions .btn:text-is("Đang xử lý")');
    await page.waitForFunction(() => document.querySelector("#fb-status")?.textContent?.includes("Đã lưu"));
    assert.deepEqual(problems, []);
    await context.close();
  } finally {
    await browser.close();
  }
}

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

  // Metadata, journeys and first successes. Each batch carries version, system, language and
  // its journey; the country comes from Cloudflare, never from the body.
  const J1 = "1".repeat(32), J2 = "2".repeat(32), J3 = "3".repeat(32), J4 = "4".repeat(32), V1 = "v".repeat(32);
  const later = () => new Promise((resolve) => setTimeout(resolve, 15));
  const web = (sessionId, events, extra = {}) => post({ source: "web", version: "0.4.0+abc1234", os: "windows", locale: "vi", sessionId, events, ...extra }, { "User-Agent": "journey-visitor" });
  const studioBatch = (sessionId, events, extra = {}) => post({ source: "studio", version: "0.4.0", os: "windows", locale: "vi", sessionId, events, ...extra }, { "User-Agent": "journey-visitor" });
  await web(J1, [{ name: "page_view", props: { referrer: "direct", lang: "vi" } }], { visitorId: V1, country: "US" });
  await later();
  await studioBatch(J1, [{ name: "app_open", props: { browser: "edge", referrer: "landing" } }], { visitorId: V1 });
  await later();
  await studioBatch(J1, [{ name: "recording_started", props: { source: "monitor" } }], { visitorId: V1 });
  await later();
  await studioBatch(J1, [{ name: "recording_finished", props: { duration: "<30s" } }], { visitorId: V1 });
  await later();
  await studioBatch(J1, [{ name: "export_started", props: { quality: "1080p" } }, { name: "export_finished", props: { quality: "1080p" } }], { visitorId: V1 });
  // Opened but never recorded, and a finish from another journey that must not complete it.
  await studioBatch(J2, [{ name: "app_open", props: { browser: "chrome", referrer: "direct" } }]);
  await studioBatch(J3, [{ name: "recording_finished", props: { duration: "<30s" } }]);
  // The same consenting visitor exports again later: still one first export.
  await later();
  await studioBatch(J4, [{ name: "app_open", props: { browser: "edge" } }, { name: "export_finished", props: { quality: "4k" } }], { visitorId: V1 });
  // Enum-only feature interest; the desktop app's visitorId is ignored (its install ID is stable already).
  await studioBatch(J1, [{ name: "feature_interest", props: { feature: "webcam" } }, { name: "feature_interest", props: { feature: "gif" } }], { visitorId: V1 });
  await post({ source: "app", installId: installA, version: "0.4.0", os: "macos-aarch64", locale: "vi", sessionId: "a1".repeat(16), visitorId: V1, events: [{ name: "feature_interest", props: { feature: "webcam" } }] });

  // Download starts are reported by the downloads Worker only, with its token.
  const reportDownload = (token, body) => fetch(`${base}/v1/internal/downloads`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });
  assert.equal((await reportDownload("", { platform: "macos", channel: "latest" })).status, 401);
  assert.equal((await reportDownload("wrong", { platform: "macos", channel: "latest" })).status, 401);
  assert.equal((await reportDownload("dltoken", { platform: "linux", channel: "latest" })).status, 400);
  assert.equal((await reportDownload("dltoken", { platform: "macos", channel: "latest", tag: "v0.4.0", country: "vn", address: "203.0.113.9", agent: "Mozilla/5.0 (Macintosh)" })).status, 202);
  assert.equal((await reportDownload("dltoken", { platform: "macos_update", channel: "versioned", tag: "v0.4.0" })).status, 202);

  const journeys = (await stats("secret", "?fresh=1")).body;
  assert.equal(journeys.range.timeZone, "Asia/Ho_Chi_Minh");
  assert.equal(journeys.range.tzOffsetMinutes, 420);
  assert.deepEqual(journeys.funnels.web.steps, { opened: 3, started: 1, recorded: 1, exportStarted: 1, exported: 1 }, "an export without a recording in its journey is not a funnel export");
  assert.deepEqual(journeys.funnels.web.landing, { visited: 1, openedStudio: 1 });
  assert.deepEqual(journeys.funnels.web.by.browser.find((row) => row.key === "edge"), { key: "edge", opened: 2, recorded: 1, exported: 1 });
  const firsts = journeys.firstSuccess.studio;
  // Subjects: the consenting visitor (two journeys, one subject) plus journeys J2 and J3.
  assert.equal(firsts.subjects, 3);
  assert.equal(firsts.firstRecordings, 2);
  assert.equal(firsts.firstExports, 1, "a second export is not a second first export");
  assert.equal(firsts.averageTriesBeforeFirstExport, 1);
  assert.equal(firsts.timeToFirstExportMs.samples, 1);
  assert.ok(firsts.timeToFirstExportMs.median > 0 && firsts.timeToFirstExportMs.median < 10_000);
  assert.ok(firsts.timeToFirstRecordingMs.median <= firsts.timeToFirstExportMs.median);
  // Retention uses consented stable IDs only, and today's cohort is too young for day 1.
  const webCohort = journeys.retention.web.cohorts.at(-1);
  assert.deepEqual(webCohort, { day: journeys.range.to, size: 1, d1: null, d7: null, d30: null });
  assert.deepEqual(journeys.retention.web.overall.d1, { rate: null, cohortSize: 0 });
  assert.equal(journeys.retention.app.cohorts.at(-1).size, 2);
  assert.deepEqual(journeys.featureInterest.find((item) => item.key === "webcam"), { key: "webcam", people: 2, choices: 2 });
  assert.equal(journeys.downloadsStarted.total, 1, "only /latest downloads count as site downloads");
  assert.deepEqual(journeys.downloadsStarted.byPlatform.map((row) => `${row.platform}:${row.channel}:${row.count}`).sort(), ["macos:latest:1", "macos_update:versioned:1"]);
  assert.deepEqual(journeys.commerce, { funnel: { pricing_viewed: 0, checkout_started: 0 }, revenue: [] });
  // Every new row shows where it came from.
  const pageView = journeys.recent.find((event) => event.source === "web" && event.name === "page_view" && event.session);
  assert.deepEqual([pageView.version, pageView.os, pageView.locale, pageView.consented], ["0.4.0+abc1234", "windows", "vi", true]);
  assert.ok(pageView.country === null || /^([A-Z]{2}|T1)$/.test(pageView.country), "the country is Cloudflare's code");
  const appInterest = journeys.recent.find((event) => event.source === "app" && event.name === "feature_interest");
  assert.deepEqual([appInterest.version, appInterest.os, appInterest.consented], ["0.4.0", "macos-aarch64", false]);
  assert.ok(!JSON.stringify(journeys.recent).includes(J1), "session IDs are not returned");

  // Feedback: its own table, its own rate limit, never in events or reports.
  const feedback = (body, headers = {}) =>
    fetch(`${base}/v1/feedback`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) });
  let address = 0;
  // Each request from its own address, so the 5-a-minute limit is tested on its own below.
  const send = (body) => feedback(body, { "CF-Connecting-IP": `198.51.100.${++address}` });
  const message = "<script>alert('xss')</script>\nDòng thứ hai & <b>đậm</b>";
  const valid = { source: "studio", category: "bug", rating: 4, message, email: "nguoi.dung@example.com", includeMetadata: true, metadata: { version: "0.4.0", os: "windows", browser: "edge", locale: "vi", sessionId: J1 }, website: "" };
  response = await send(valid);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await send({ source: "app", category: "feature", rating: null, message: "Cần export GIF nhanh hơn", includeMetadata: false, metadata: { version: "0.4.0" } })).status, 201);
  assert.equal((await send({ ...valid, message: "Một ý kiến khác", rating: 5, category: "idea" })).status, 201);
  for (const [label, body, expected] of [
    ["oversized", { ...valid, message: "x".repeat(13_000) }, 413],
    ["unknown category", { ...valid, message: "a", category: "praise" }, 400],
    ["rating 6", { ...valid, message: "b", rating: 6 }, 400],
    ["rating 0", { ...valid, message: "c", rating: 0 }, 400],
    ["fractional rating", { ...valid, message: "d", rating: 2.5 }, 400],
    ["honeypot", { ...valid, message: "e", website: "http://spam.example" }, 400],
    ["empty message", { ...valid, message: "   " }, 400],
    ["too long", { ...valid, message: "ữ".repeat(4001) }, 400],
    ["link spam", { ...valid, message: Array.from({ length: 6 }, (_, i) => `https://spam${i}.example`).join(" ") }, 400],
    ["bad email", { ...valid, message: "f", email: "not an email" }, 400],
    ["long email", { ...valid, message: "g", email: `${"a".repeat(250)}@example.com` }, 400],
    ["unknown source", { ...valid, message: "h", source: "web" }, 400],
    ["not JSON", "{", 400],
    ["invalid UTF-8", new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]), 400],
  ]) {
    assert.equal((await send(body)).status, expected, label);
  }
  // A resend of the same text from the same address within a day is refused.
  assert.equal((await feedback({ ...valid, message: "Gửi hai lần" }, { "CF-Connecting-IP": "192.0.2.50" })).status, 201);
  assert.equal((await feedback({ ...valid, message: "Gửi hai lần" }, { "CF-Connecting-IP": "192.0.2.50" })).status, 409);

  // Only the admin reads or changes feedback.
  const admin = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { Authorization: "Bearer secret", ...(init.headers ?? {}) } });
  assert.equal((await fetch(`${base}/v1/feedback`)).status, 401);
  assert.equal((await fetch(`${base}/v1/feedback`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(`${base}/v1/feedback/1`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "read" }) })).status, 401);
  let list = await (await admin("/v1/feedback")).json();
  assert.equal(list.items.length, 4);
  assert.equal(list.summary.total, 4);
  assert.equal(list.summary.unread, 4);
  assert.deepEqual(list.summary.categories.find((row) => row.key === "bug"), { key: "bug", count: 2 });
  const stored = list.items.find((item) => item.message === message);
  assert.ok(stored, "the message is stored exactly as typed, line break included");
  assert.deepEqual([stored.email, stored.version, stored.os, stored.browser, stored.locale, stored.status], ["nguoi.dung@example.com", "0.4.0", "windows", "edge", "vi", "new"]);
  assert.ok(stored.country === null || /^([A-Z]{2}|T1)$/.test(stored.country));
  const plain = list.items.find((item) => item.source === "app");
  assert.deepEqual([plain.version, plain.os, plain.country, plain.rating], [null, null, null, null], "no metadata without consent");
  assert.equal((await admin("/v1/feedback")).headers.get("Access-Control-Allow-Origin"), null, "admin answers are not shared cross-origin");
  // Filters, search and pages.
  assert.equal((await (await admin("/v1/feedback?category=idea")).json()).items.length, 1);
  assert.equal((await (await admin("/v1/feedback?rating=5")).json()).items.length, 1);
  assert.equal((await (await admin("/v1/feedback?source=app")).json()).items.length, 1);
  assert.equal((await (await admin(`/v1/feedback?q=${encodeURIComponent("GIF nhanh")}`)).json()).items.length, 1);
  assert.equal((await (await admin(`/v1/feedback?q=${encodeURIComponent("100%")}`)).json()).items.length, 0, "LIKE wildcards are escaped");
  assert.equal((await (await admin(`/v1/feedback?from=${journeys.range.to}&to=${journeys.range.to}`)).json()).items.length, 4);
  const first = await (await admin("/v1/feedback?limit=3")).json();
  assert.equal(first.items.length, 3);
  assert.ok(first.nextCursor);
  const second = await (await admin(`/v1/feedback?limit=3&cursor=${first.nextCursor}`)).json();
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.ok(!first.items.some((item) => second.items.some((other) => other.id === item.id)));

  // Status changes: the token, or the dashboard's session with its same-origin header.
  const patch = (id, body, headers) => fetch(`${base}/v1/feedback/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await patch(stored.id, { status: "in_progress", adminNote: "Đã tái hiện" }, { Authorization: "Bearer secret" })).status, 200);
  assert.equal((await patch(stored.id, { status: "done" }, { Authorization: "Bearer secret" })).status, 400);
  assert.equal((await patch(999999, { status: "read" }, { Authorization: "Bearer secret" })).status, 404);
  const adminSession = (await login({ username: "admin", password: "pass word" })).headers.get("Set-Cookie").split(";")[0];
  assert.equal((await patch(stored.id, { status: "resolved" }, { Cookie: adminSession })).status, 403, "a cookie alone cannot change feedback");
  assert.equal((await patch(stored.id, { status: "resolved" }, { Cookie: adminSession, "X-ScreenSway-Dashboard": "1", Origin: "https://evil.example" })).status, 403);
  assert.equal((await patch(stored.id, { status: "resolved" }, { Cookie: adminSession, "X-ScreenSway-Dashboard": "1" })).status, 200);
  assert.equal((await fetch(`${base}/v1/feedback?status=resolved`, { headers: { Cookie: adminSession } })).status, 200);
  list = await (await admin("/v1/feedback?status=resolved")).json();
  assert.deepEqual([list.items.length, list.items[0].adminNote, list.summary.unread], [1, "Đã tái hiện", 0]);

  // Feedback text and email never reach events or reports.
  const report = JSON.stringify((await stats("secret", "?fresh=1")).body);
  assert.ok(!report.includes("nguoi.dung@example.com"), "no email in reports");
  assert.ok(!report.includes("Dòng thứ hai") && !report.includes("xss"), "no feedback text in reports");
  // Free text in an event property is dropped like any long label.
  await studioBatch(J1, [{ name: "feedback_submitted", props: { category: "bug", message: "Một câu góp ý dài có dấu cách và chữ có dấu" } }]);
  const submitted = (await stats("secret", "?fresh=1")).body;
  assert.deepEqual(submitted.feedbackSubmitted, [{ key: "bug", count: 1 }]);
  assert.ok(!JSON.stringify(submitted.recent).includes("Một câu góp ý"), "free text never lands in props");

  // The dashboard in a real browser: Vietnamese, Vietnam time, and feedback shown as text.
  await dashboardInBrowser(adminSession, message);

  // Feedback has its own rate limit per address.
  let feedbackLimited = false;
  for (let attempt = 0; attempt < 12 && !feedbackLimited; attempt++) {
    feedbackLimited = (await feedback({ ...valid, message: `spam ${attempt}` }, { "CF-Connecting-IP": "192.0.2.99" })).status === 429;
  }
  assert.ok(feedbackLimited, "feedback was not rate limited");

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
