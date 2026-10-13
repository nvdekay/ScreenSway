# Analytics

ScreenSway measures downloads, landing-page visits and feature usage with its own small service, so every number lives in one place and no third-party tracker is involved.

```
landing page (apps/web) ──┐
                          ├─ POST /v1/events ─► Worker + D1 (apps/analytics) ─► GET /v1/stats ─► dashboard (/)
desktop app (opt-in)   ───┘
```

`apps/analytics` is a Cloudflare Worker with a D1 (SQLite) database. It serves three things: the public ingestion endpoint, a token-protected reporting API, and the dashboard page that reads that API.

## Privacy rules

- Recordings, audio, captions, file names and paths are never sent. An event is a name from a fixed list plus a few short labels such as `quality: "4k"`.
- Values are filtered twice, in the app (`telemetry.rs`) and in the Worker: only booleans, numbers and labels of at most 40 characters without slashes are kept; unknown event names are dropped.
- The desktop app sends nothing until the user agrees. The first launch asks once; Settings has a switch. Declining or switching off stops all requests.
- The app identifies an installation by a random ID stored in `telemetry.json` in the app's config folder. It is not derived from hardware or the user account.
- The landing page uses no cookies and no browser storage. A visitor is a salted hash of address, browser and day; it changes every day and the address is not stored. `Do Not Track` and Global Privacy Control are honoured.
- The Worker stores the country reported by Cloudflare, never the IP address.

Keep the in-app wording in step with these rules when they change. The landing page shows no notice about its own counting.

## Events

| Source | Event | Properties |
|---|---|---|
| web | `page_view` | `referrer` (host or `direct`), `lang`, `theme`, `os` |
| web | `download_click` | `platform` (`macos`/`windows`), `placement` (`hero`/`cta`/`guide`) |
| web | `guide_open` | `placement` |
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

Every app batch also carries the app version, `os` (for example `macos-aarch64`) and the UI language.

Adding an event takes three edits: the allow-list in `apps/analytics/src/index.ts` (`EVENTS`, plus `BREAKDOWNS` for a property the dashboard should chart), the allow-list in `apps/desktop/src-tauri/src/telemetry.rs`, and the `TelemetryEvent` type in `apps/desktop/src/telemetry.ts`. Deploy the Worker before shipping an app that sends the new event.

## API

`POST /v1/events` (public)

```json
{ "source": "app", "installId": "<32 hex>", "version": "0.3.0", "os": "macos-aarch64", "locale": "vi",
  "events": [{ "name": "export_finished", "props": { "quality": "4k", "captions": true } }] }
```

`source: "web"` needs no `installId`. Up to 50 events and 16 KiB per request; the response is `202 {"accepted": n}`.

`GET /v1/stats?days=30` (header `Authorization: Bearer <DASHBOARD_TOKEN>`, `days` 1–365) returns one JSON document:

- `range`: `from`, `to`, the previous period and `tzOffsetMinutes`. Days follow `TZ_OFFSET_MINUTES` (420, Vietnam time).
- `totals` and `previous`: `pageViews`, `visitors`, `downloads`, `guideOpens`, `activeInstalls`, `newInstalls`, `appOpens`, `recordings`, `exports`, `captions` for the range and for the equally long period before it.
- `allTime`, `activeNow` (`daily`/`weekly`/`monthly` active installations).
- `series`: one entry per day with `pageViews`, `visitors`, `downloadsMac`, `downloadsWindows`, `activeInstalls`, `newInstalls`, `recordings`, `exports`, `captions`.
- `events`: count and number of distinct installations (or visitors) per event.
- `web` (`countries`, `referrers`, `os`, `languages`, `themes`) and `app` (`versions`, `os`, `countries`, `locales`) as `{key, count}` lists.
- `breakdowns`: `{key, count}` lists per charted property, for example `exportQuality`, `exportFrame`, `recordingSource`, `captionLocale`, `downloadPlacement`.
- `recent`: the latest 40 events.

The API sends CORS headers, so another page or script can read it with the same token. `GET /v1/health` is an unauthenticated liveness check.

"Visitors" is the sum of daily unique visitors, because the visitor hash rotates daily. App numbers only cover installations that agreed to share statistics.

## Dashboard

The Worker serves the dashboard at `/`. It asks for the token once, keeps it in the browser's local storage, refreshes every minute and offers 7, 30, 90 and 365-day ranges. Append `?api=https://…` to read a different deployment.

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

- The ingestion endpoint is public, as any client-side analytics endpoint is. The allow-lists keep junk out of the reports but a determined sender can inflate counts; add a Cloudflare rate-limiting rule if that happens.
- A download is counted when the button is clicked, not when the file finishes downloading.
- D1's free tier (5 GB, 100k writes per day at the time of writing) is far above current needs; reports aggregate at query time, so add rollup tables if the events table grows into millions of rows.
