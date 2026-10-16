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
const server = spawn(wrangler, ["dev", "--port", String(port), "--persist-to", state, "--var", "DASHBOARD_TOKEN:secret", "--var", "ACTOR_SALT:salt"], { cwd: root, stdio: "pipe" });
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
  await post({ source: "web", events: [{ name: "page_view", props: { referrer: "direct", lang: "en", os: "windows" } }, { name: "download_click", props: { platform: "windows", placement: "hero" } }] }, { "User-Agent": "visitor-2" });
  await post({ source: "web", events: [{ name: "download_click", props: { platform: "macos", placement: "hero" } }, { name: "download_click", props: { platform: "macos", placement: "guide" } }] }, { "User-Agent": "visitor-1" });
  await post({ source: "app", installId: installA, version: "0.3.1", os: "macos-aarch64", locale: "vi", events: [
    { name: "app_open" },
    { name: "recording_started", props: { source: "display", system_audio: true, microphone: false } },
    { name: "recording_finished", props: { duration: "30s-2m" } },
    { name: "export_finished", props: { quality: "4k", frame: "macos-dark", captions: true, path: "/Users/someone/Movies/secret.mp4", note: "x".repeat(80) } },
    { name: "made_up_event" },
  ] });
  await post({ source: "app", installId: installB, version: "0.3.1", os: "windows-x86_64", locale: "en", events: [{ name: "app_open" }, { name: "export_finished", props: { quality: "1080p", frame: "none", captions: false } }] });

  assert.equal((await post({ source: "app", installId: "not-an-id", events: [{ name: "app_open" }] })).status, 400);
  assert.equal((await post({ source: "other", events: [] })).status, 400);
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post({ source: "web", events: [{ name: "page_view", props: { referrer: "y".repeat(20000) } }] })).status, 413);
  // The limit counts UTF-8 bytes: 6,000 characters of Vietnamese text is over 16 KB.
  assert.equal((await post({ source: "web", events: [{ name: "page_view", props: { referrer: "ữ".repeat(6000) } }] })).status, 413);
  // A browser beacon arrives as text/plain; it must be accepted without a preflight.
  assert.equal((await post(JSON.stringify({ source: "web", events: [{ name: "guide_open" }] }), { "Content-Type": "text/plain", "User-Agent": "visitor-1" })).status, 202);

  // Reporting requires the token.
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

  // Floods from one address are cut off by the rate limiter.
  let limited = false;
  for (let attempt = 0; attempt < 80 && !limited; attempt++) limited = (await post({ source: "web", events: [] })).status === 429;
  assert.ok(limited, "ingestion was not rate limited");
  console.log("analytics e2e: ok");
} finally {
  server.kill("SIGTERM");
  rmSync(state, { recursive: true, force: true });
}
