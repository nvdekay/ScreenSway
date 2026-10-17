# Analytics

ScreenSway measures downloads, landing-page visits, browser-app usage and desktop feature usage with its own small service, so every number lives in one place and no third-party tracker is involved.

```
landing page (apps/web)        ──┐
browser app (apps/studio-web)  ──┼─ POST /v1/events ─► Worker + D1 (apps/analytics) ─► GET /v1/stats ─► dashboard (/)
desktop app (opt-in)           ──┘
```

`apps/analytics` is a Cloudflare Worker with a D1 (SQLite) database. It serves three things: the public ingestion endpoint, a token-protected reporting API, and the dashboard page that reads that API.

## Privacy rules

- Recordings, audio, captions, file names and paths are never sent. An event is a name from a fixed list plus a few short labels such as `quality: "4k"`.
- Values are filtered twice, in the app (`telemetry.rs`) and in the Worker: only booleans, numbers and labels of at most 40 characters without slashes are kept; unknown event names are dropped.
- The desktop app sends nothing until the user agrees. The first launch asks once; Settings has a switch. Declining or switching off stops all requests.
- The app identifies an installation by a random ID stored in `telemetry.json` in the app's config folder. It is not derived from hardware or the user account.
- The landing page and the browser app use no cookies and no browser storage for counting. A visitor is a salted hash of address, browser and day; it changes every day and the address is not stored. `Do Not Track` and Global Privacy Control are honoured. The browser app sends only labels (browser, kind of shared surface, export settings, coarse durations, failure kinds), never anything from the recording.
- The Worker stores the country reported by Cloudflare, never the IP address.

Keep the in-app wording in step with these rules when they change. Neither the landing page nor the browser app shows a notice about this counting; the browser app's "stays on your computer" promise is about the recording, which never leaves the browser.

## Events

| Source | Event | Properties |
|---|---|---|
| web | `page_view` | `referrer` (host or `direct`), `lang`, `theme`, `os` |
| web | `download_click` | `platform` (`macos`/`windows`), `placement` (`hero`/`cta`/`guide`) |
| web | `guide_open` | `placement` |
| studio | `app_open` | `browser` (`chrome`/`edge`/…), `referrer` (`landing`, a host or `direct`) |
| studio | `unsupported_shown` | `browser`, `reason` (`insecure`/`display`/`recorder`/`streams`/`codecs`/`mobile`) |
| studio | `recording_started` | `source` (`monitor`/`window`/`browser`), `system_audio`, `shared_audio` (the surface really sent sound), `microphone` |
| studio | `recording_finished` | `duration` (buckets as below), `format` (`mp4`/`webm`) |
| studio | `recording_failed` | `reason` (`share_denied`, `mic_denied`, `no_storage`, `start_failed`, `disk_full`, `finish_failed`) |
| studio | `export_finished` | as the app's |
| studio | `export_failed` | `reason` (`toolarge`, `unreadable`, `writefailed`, `nostorage`) |
| studio | `export_cancelled`, `style_applied` | as the app's |
| studio | `desktop_click` | `placement` (`header`/`unsupported`) |
| app | `app_open` | — |
| app | `telemetry_enabled` | — |
| app | `recording_started` | `source` (`display`/`window`), `system_audio`, `microphone` |
| app | `recording_finished` | `duration` (`<30s`, `30s-2m`, `2-10m`, `>10m`) |
| app | `recording_failed` | `reason` (`permission`, `microphone`, `other`) |
| app | `recording_opened` | — |
| app | `export_finished` | `quality`, `frame`, `aspect`, `background`, `captions`, `auto_zoom`, `trimmed`, `duration` |
| app | `export_failed`, `export_cancelled` | — |
| app | `captions_generated` | `locale` |
| app | `captions_failed` | — |
| app | `style_applied` | `style` (built-in ID or `custom`) |

Every app batch also carries the app version, `os` (for example `macos-aarch64`) and the UI language. Browser-app batches carry the site's version, `os` (`macos`/`windows`/`linux`/`mobile`) and the page language.

The browser app sends from `apps/studio-web/src/analytics.ts` (its own events) and answers the shared studio's `track_event` command in `backend.ts`, so export and style events come from the same `RecordingStudio` code as on the desktop. It only sends when built with `VITE_ANALYTICS_URL` (set in `web.yml`); local builds and tests send nothing. To add a browser-app event, add it to `STUDIO_EVENTS` in `analytics.ts` and to `EVENTS.studio` (plus `STUDIO_BREAKDOWNS`) in the Worker, and deploy the Worker first.

Adding an event takes three edits: the allow-list in `apps/analytics/src/index.ts` (`EVENTS`, plus `BREAKDOWNS` for a property the dashboard should chart), the allow-list in `apps/desktop/src-tauri/src/telemetry.rs`, and the `TelemetryEvent` type in `apps/desktop/src/telemetry.ts`. Deploy the Worker before shipping an app that sends the new event.

## API

`POST /v1/events` (public)

```json
{ "source": "app", "installId": "<32 hex>", "version": "0.3.0", "os": "macos-aarch64", "locale": "vi",
  "events": [{ "name": "export_finished", "props": { "quality": "4k", "captions": true } }] }
```

`source: "web"` and `source: "studio"` need no `installId`. Up to 50 events and 16 KiB (UTF-8 bytes) per request; the response is `202 {"accepted": n}`. Each client address may send 120 requests a minute (generous because mobile carriers share one address among many people) (the `INGEST_LIMITER` rate limit in `wrangler.toml`); more get `429`. Web and studio events are refused with `503` while `ACTOR_SALT` is not set, so visitors are never hashed without the salt.

`GET /v1/stats?days=30` (header `Authorization: Bearer <DASHBOARD_TOKEN>`, `days` 1–365) returns one JSON document:

- `range`: `from`, `to`, the previous period and `tzOffsetMinutes`. Days follow `TZ_OFFSET_MINUTES` (420, Vietnam time).
- `totals` and `previous`: `pageViews`, `visitors`, `downloads`, `guideOpens`, `activeInstalls`, `newInstalls`, `appOpens`, `recordings`, `exports`, `captions` for the range and for the equally long period before it.
- `allTime`, `activeNow` (`daily`/`weekly`/`monthly` active installations).
- `series`: one entry per day with `pageViews`, `visitors`, `downloadsMac`, `downloadsWindows`, `activeInstalls`, `newInstalls`, `recordings`, `exports`, `captions`.
- `events`: count and number of distinct installations (or visitors) per event.
- `web` (`countries`, `referrers`, `os`, `languages`, `themes`) and `app` (`versions`, `os`, `countries`, `locales`) as `{key, count}` lists.
- `breakdowns`: `{key, count}` lists per charted property, for example `exportQuality`, `exportFrame`, `recordingSource`, `captionLocale`, `downloadPlacement`.
- `recent`: the latest 40 events.
- `studio`: the browser app. `totals`/`previous` (`visitors`, `opens`, `unsupported`, `recordingsStarted`, `recordings`, `recordingFailures`, `exports`, `exportFailures`, `exportCancels`, `styles`, `desktopClicks`), `funnel` (visitor-days that `opened`, `started`, `recorded`, `exported`), daily `series` (`visitors`, `recordings`, `exports`, `failures`), `events`, `countries`, `os`, `locales` and `breakdowns` (for example `browser`, `recordingSource`, `recordingFailure`, `exportQuality`, `unsupportedReason`, `desktopPlacement`). Visitors and the funnel count visitor-days, because the visitor hash rotates daily.

The API sends CORS headers, so another page or script can read it with the same token. `GET /v1/health` is an unauthenticated liveness check.

"Visitors" is the sum of daily unique visitors, because the visitor hash rotates daily. App numbers only cover installations that agreed to share statistics.

## Dashboard

The Worker serves the dashboard at `/`. It asks for the token once per browser tab (kept in session storage, so it is gone when the tab closes), refreshes every five minutes (and on "Làm mới", which asks for a fresh report) and offers 7, 30, 90 and 365-day ranges. Its "Bản web" view shows the browser app: visitors, the open → record → export funnel, success rates, browsers, shared surfaces and audio, export settings, failures and unsupported browsers. It only reads `/v1/stats` from its own origin; a Content-Security-Policy (`connect-src 'self'`, inline script allowed by hash) enforces that. After editing the dashboard script, update the `sha256-…` hash in its CSP meta tag; `test:e2e` fails until it matches.

## Running and deploying

```bash
pnpm --filter @screensway/analytics dev     # local Worker + local D1 on http://localhost:8787
pnpm --filter @screensway/analytics test:e2e  # end-to-end test against a throwaway local database
```

For local runs put `DASHBOARD_TOKEN=…` and `ACTOR_SALT=…` in `apps/analytics/.dev.vars` (not committed).

The service runs at `https://screensway-analytics.visual-lab-dm4.workers.dev` (dashboard at `/`). Later changes only need `pnpm run deploy`. The first deployment, from `apps/analytics`, was:

```bash
npx wrangler login
npx wrangler d1 create screensway-analytics      # copy the database_id into wrangler.toml
npx wrangler secret put DASHBOARD_TOKEN          # the dashboard password; choose a long random value
npx wrangler secret put ACTOR_SALT               # any long random value; keep it stable
pnpm run deploy                                  # applies migrations, then deploys
```

Then point the clients at the deployed URL:

- Landing page: `VITE_ANALYTICS_URL` on the build step in `.github/workflows/web.yml`. Local builds leave it unset and send nothing.
- Desktop app: `DEFAULT_ENDPOINT` in `apps/desktop/src-tauri/src/telemetry.rs` (or `SCREENSWAY_ANALYTICS_URL` at build or run time). Without it the consent prompt and the Settings switch are hidden.

`SCREENSWAY_ANALYTICS_URL=http://localhost:8787 cargo test --lib live -- --ignored` (in `apps/desktop/src-tauri`) sends real events from the Rust client to a running API.

## Limits

- The ingestion endpoint is public, as any client-side analytics endpoint is. The allow-lists keep junk out of the reports but a determined sender can still inflate counts within the per-address rate limit.
- A download is counted when the button is clicked, not when the file finishes downloading.
- D1's free tier (5 GB, 100k writes per day at the time of writing) is far above current needs; reports aggregate at query time, so add rollup tables if the events table grows into millions of rows.

## Load and cost

Ingestion is one small `INSERT` batch per request and scales with Cloudflare; the costly part is reading. A report runs about 45 queries over the events in its range, so `/v1/stats` keeps the last report per range for 60 s in the isolate (`?fresh=1` bypasses it), the dashboard refreshes every five minutes, and `migrations/0002_events_by_name.sql` adds an index on `(source, name, day)` so each breakdown reads only its own event's rows. On the Workers free plan the account has 100k requests a day (both Workers together) and D1 100k rows written and 5M rows read a day; a few dashboard loads a day over a large range can use most of the read allowance, so move to the paid plan before traffic grows past a few thousand visits a day.
