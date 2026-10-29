# Analytics

ScreenSway measures downloads, landing-page visits, browser-app usage and desktop feature usage, and collects the feedback people choose to send, with its own small service, so every number lives in one place and no third-party tracker is involved.

```
landing page (apps/web)        ──┐
browser app (apps/studio-web)  ──┼─ POST /v1/events ───┐
desktop app (opt-in)           ──┘                     ├─► Worker + D1 (apps/analytics) ─► GET /v1/stats, /v1/feedback ─► dashboard (/)
landing, browser app, desktop app ─ POST /v1/feedback ┤
downloads Worker ───── service binding: download starts ┘
```

`apps/analytics` is a Cloudflare Worker with a D1 (SQLite) database. It serves the public ingestion and feedback endpoints, a token-protected reporting API, the admin feedback API, and the dashboard page that reads them.

## Privacy rules

- Recordings, audio, captions, file names and paths are never sent. An event is a name from a fixed list plus a few short labels such as `quality: "4k"`.
- Values are filtered twice, in the app (`telemetry.rs`) and in the Worker: only booleans, numbers and labels of at most 40 characters without slashes are kept; unknown event names are dropped.
- The desktop app sends nothing until the user agrees. The first launch asks once; Settings has a switch. Declining or switching off stops all requests.
- The app identifies an installation by a random ID stored in `telemetry.json` in the app's config folder. It is not derived from hardware or the user account.
- The landing page and the browser app use no cookies. A visitor is a salted hash of address, browser and day; it changes every day and the address is not stored. `Do Not Track` and Global Privacy Control are honoured: nothing is sent and nothing is stored. The browser app sends only labels (browser, kind of shared surface, export settings, coarse durations, failure kinds), never anything from the recording.
- Journeys: the landing page and the browser app share one random ID per tab in `sessionStorage` (`screensway.journey`, 32 hex), so landing → `/app/` in the same tab is one journey. It disappears when the tab closes and is never derived from the address, the browser or any fingerprint. The desktop app makes a random ID per launch (`sessionId`).
- Return visits: browsers are not recognised across visits. 0.4.1 offered an opt-in footer switch that kept a random ID in `localStorage` (`screensway.analytics.visitor`); it was removed as hardly used, and the browser app now deletes that key on load. The desktop app's install ID is stable and already behind its consent prompt.
- Feedback is the deliberate exception: what a person types in the feedback form, an optional email to reply to, and, only if they tick the box, technical details (source, version, system, browser, language; the server adds the country). It is stored in its own table, never in events, properties or breakdowns, and kept 24 months (`FEEDBACK_RETENTION_DAYS`). Only the admin can read it.
- The Worker stores the country reported by Cloudflare (`request.cf.country`: an ISO 3166-1 alpha-2 code from IP geolocation, `T1` for Tor, `XX` when unknown; a VPN shows the VPN's country), never the IP address.

- Country is IP geolocation at Cloudflare's edge. A VPN, proxy, Tor, a mobile carrier's gateway or a company network shows where traffic leaves that network, not where the person is. Treat it as a rough market signal, never as a location.

Keep the in-app wording in step with these rules when they change. The landing page shows no notice about the anonymous counting; the browser app's "stays on your computer" promise is about the recording, which never leaves the browser. The feedback form states what is sent before it is sent.

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
| studio, app | `export_started` | `quality`, `frame`, `aspect` |
| studio, app | `feature_interest` | `feature`: `captions`, `webcam`, `export_4k60`, `brand_kit`, `vertical_social`, `gif`, `share_link`, `collaboration`, `import_video`, `automation`, `other` (one event per choice; free text goes to feedback) |
| studio, app | `feedback_submitted` | `category` (never the text) |
| web, studio | `pricing_viewed`, `checkout_started` | accepted, not sent yet: there is no pricing page or checkout |
| app | `license_activated` | accepted, not sent yet: there are no licences |
| downloads | `download_started` | `platform` (`macos`/`windows`/`macos_update`), `channel` (`latest` from the site, `versioned` from the updater); written by the Worker, never accepted from clients |

Every batch carries `version`, `os`, `locale` and `sessionId`:

- App: the app version, `os` as `<system>-<architecture>` (for example `macos-aarch64`), the UI language and a per-launch session.
- Browser app: the app version it was built from, `os` (`macos`/`windows`/`linux`/`mobile`/`other`), the page language and the tab's journey. The browser name stays in `app_open` properties.
- Landing page: its build version, `<app version>+<commit>` (for example `0.4.0+c235699`, set at build time in `apps/web/vite.config.ts`), `os`, the page language and the journey.

Rows stored before this change keep `NULL` versions; nothing is back-filled. For landing rows without `os` the Worker reads the browser's User-Agent (same labels), and the activity list falls back to an old `page_view`'s `os` property. The country is always Cloudflare's: a `country` in the body is ignored.

The browser app sends from `apps/studio-web/src/analytics.ts` (its own events) and answers the shared studio's `track_event` command in `backend.ts`, so export and style events come from the same `RecordingStudio` code as on the desktop. It only sends when built with `VITE_ANALYTICS_URL` (set in `web.yml`); local builds and tests send nothing. To add a browser-app event, add it to `STUDIO_EVENTS` in `analytics.ts` and to `EVENTS.studio` (plus `STUDIO_BREAKDOWNS`) in the Worker, and deploy the Worker first.

Adding an event takes three edits: the allow-list in `apps/analytics/src/index.ts` (`EVENTS`, plus `BREAKDOWNS` for a property the dashboard should chart), the allow-list in `apps/desktop/src-tauri/src/telemetry.rs`, and the `TelemetryEvent` type in `apps/desktop/src/telemetry.ts`. Deploy the Worker before shipping an app that sends the new event.

## Journeys, first successes and retention

Reports derive these on the server from stored events; no client claims a "first".

- **Funnels** join steps by `session_id`. A step counts only when every earlier step happened at or before it in the same journey, so a finish from another tab cannot complete a journey, and an export without a recording in that journey is not a funnel export. Browser: landing → open `/app/` (journeys that saw the landing page), and open → recording started → finished → export started → finished. Desktop: per launch, open → … → export finished. Breakdowns by system, browser, version, country, language and referrer use the journey's first studio values. Events without a session (older builds) are left out of funnels.
- **First successes**: per desktop installation; in the browser per consenting visitor, otherwise per journey. A subject counts when its first event of all time falls in the range. First recording and first export are its earliest `recording_finished` and `export_finished` ever, so a second export is never another first. Time to first recording and to first export run from its first `app_open` (median and p90, nearest rank). "Tries" are recordings started up to the first export.
- **Retention**: a cohort is the Vietnam day a stable ID was first seen; Dn is the share active again exactly n days later. Only desktop installs count (plus the few browser visitors who opted in under 0.4.1); daily hashes and journeys are excluded. A cohort younger than n days reports `null` ("Chưa đủ ngày"), and overall rates only use cohorts old enough, so young data never reads as 0%.

## Downloads and installs

- `download_click` (landing) is a click, not a download.
- `download_started` is recorded by the downloads Worker for a GET of an installer from byte 0 (resumed ranges and `HEAD` are not counted), over the service binding `ANALYTICS` with `DOWNLOADS_EVENT_TOKEN`. Updater fetches use versioned URLs and are reported as `channel: versioned`.
- A completed download is **not** measured: the Worker returns the R2 stream and cannot reliably tell that the client received the last byte. There is no `download_completed` metric.
- Downloads cannot be tied to installs: installers carry no attribution token, and the app's install ID is created on first launch. Tying them would need, for example, a short random token in a versioned download URL that the first launch reads from the installer name; that would change the stable `/latest/` URLs and CDN caching, so it is not done.

## Commerce

ScreenSway sells nothing yet, so no purchase data exists and the dashboard says "Chưa có dữ liệu".

- Client events `pricing_viewed` and `checkout_started` are accepted for when a pricing page and checkout exist; send them only from those pages.
- Purchases, refunds and licence activations must come from the Merchant of Record (for example Paddle) through a webhook whose signature the Worker verifies, never from a client. The table `commerce_events` (migration 0003) is ready: `provider`, `provider_event_id` (unique per provider, for idempotent redelivery), `ts`/`day`, `type` (`checkout_completed`, `checkout_failed`, `purchase_completed`, `refund_completed`, `license_activated`), `product`, `amount_minor`, `currency`, `country`, and `transaction_hash` (salted SHA-256 of the provider's transaction ID, to tie a refund to its purchase). No email, name or raw payment ID is stored.
- To add it: store the provider's webhook secret with `wrangler secret put`, add `POST /v1/webhooks/<provider>` that verifies the signature over the raw body (rejecting old timestamps), maps event types, and `INSERT OR IGNORE`s by `provider_event_id`. Until that exists there is deliberately no webhook endpoint. Revenue stays in its own dashboard section, apart from product analytics.

## Feedback

People open the form (`apps/desktop/src/FeedbackDialog.tsx`, shared by both apps) after an export, from desktop Settings, from the web app's header and from the landing page's header (`apps/web/src/Feedback.tsx`, the same fields and checks in the landing's own dialog, source `web`). The desktop app posts from Rust (`src-tauri/src/feedback.rs`), the web app from `apps/studio-web/src/backend.ts` and the landing page from `apps/web/src/analytics.ts`, both without a `Content-Type` (a `text/plain` request, so no CORS preflight). Both treat `409` as received. After a successful export, a feature card (`FeatureSurvey.tsx`) appears at most every 14 days (`localStorage` key `screensway.survey.shownAt`, a UI convenience) and only when statistics are on; it sends `feature_interest` events, and text under "Other" opens the feedback form.

`POST /v1/feedback` (public, its own `FEEDBACK_LIMITER`: 5 a minute per address):

```json
{ "source": "studio", "category": "bug", "rating": 4, "message": "…", "email": "me@example.com",
  "includeMetadata": true, "metadata": { "version": "0.4.0", "os": "windows", "browser": "edge", "locale": "vi", "sessionId": "<32 hex>" },
  "website": "" }
```

- `source`: `studio` (browser app), `app` (desktop) or `web` (landing page; the dashboard calls it "Landing"). `browser` is kept for `studio` and `web`. `category`: `idea`, `bug`, `feature`, `experience`, `other`. `rating`: integer 1–5 or `null`. `message`: 1–4,000 characters after trimming (control characters other than line breaks and tabs are removed; more than 5 links is refused). `email`: optional, at most 254 characters, roughly an address. `website` is a honeypot that must stay empty.
- The body is at most 12 KiB of valid UTF-8. Metadata is kept only when `includeMetadata` is true, then filtered to short labels; the country is added from Cloudflare. The same text from the same address within a day gets `409` (a salted hash, not the address, is stored).
- Answers: `201 {ok:true}`, `400 {error:"invalid"}` without details, `409`, `413`, `429`.

Admin only (bearer token or the dashboard session), with no CORS headers:

- `GET /v1/feedback?category=&status=&rating=&source=&os=&version=&country=&from=&to=&q=&limit=&cursor=` returns `items` (newest first, `limit` up to 100), `nextCursor` and a `summary` over the same filters (`total`, `unread`, `averageRating`, `rated`, and counts by rating, category, status, source, system, version and country). `q` searches message, email and note (`LIKE` wildcards escaped).
- `PATCH /v1/feedback/:id` with `{status, adminNote}`; statuses `new`, `read`, `in_progress`, `resolved`, `archived`. With the session cookie the request must be same-origin JSON with `X-ScreenSway-Dashboard: 1` (CSRF protection on top of `SameSite=Strict`).

Table `feedback` (migration 0003): `id`, `created_at`, `updated_at`, `day` (Vietnam), `source`, `category`, `rating`, `message`, `email`, `version`, `os`, `browser`, `locale`, `country`, `session_id`, `message_hash`, `status`, `admin_note`, with indexes on day, status, category and the duplicate hash. A daily cron (`17 3 * * *` UTC) deletes rows older than `FEEDBACK_RETENTION_DAYS` (730). Emails appear only in the admin list, never in `/v1/stats`.

## API

`POST /v1/events` (public)

```json
{ "source": "app", "installId": "<32 hex>", "version": "0.3.0", "os": "macos-aarch64", "locale": "vi",
  "events": [{ "name": "export_finished", "props": { "quality": "4k", "captions": true } }] }
```

`source: "web"` and `source: "studio"` need no `installId`. `sessionId` and `visitorId` are 16–64 letters, digits, `-` or `_`; anything else is dropped. `visitorId` is ignored for the app; current web builds no longer send it (only 0.4.1 browser visitors who opted in did). Up to 50 events and 16 KiB (UTF-8 bytes) per request; the response is `202 {"accepted": n}`. Each client address may send 120 requests a minute (generous because mobile carriers share one address among many people) (the `INGEST_LIMITER` rate limit in `wrangler.toml`); more get `429`. Web and studio events are refused with `503` while `ACTOR_SALT` is not set, so visitors are never hashed without the salt.

`GET /v1/stats?days=30` (`days` 1–365; the dashboard's session cookie, or header `Authorization: Bearer <DASHBOARD_TOKEN>` for scripts) returns one JSON document:

- `range`: `from`, `to`, the previous period, `timeZone` (`Asia/Ho_Chi_Minh`) and `tzOffsetMinutes` (420). Timestamps are stored as Unix milliseconds (UTC); every `day` is the Vietnam calendar day (a new day starts at 17:00 UTC), and ranges cover whole Vietnam days.
- `totals` and `previous`: `pageViews`, `visitors`, `downloads`, `guideOpens`, `activeInstalls`, `newInstalls`, `appOpens`, `recordings`, `exports`, `captions` for the range and for the equally long period before it.
- `allTime`, `activeNow` (`daily`/`weekly`/`monthly` active installations).
- `series`: one entry per day with `pageViews`, `visitors`, `downloadsMac`, `downloadsWindows`, `activeInstalls`, `newInstalls`, `recordings`, `exports`, `captions`.
- `events`: count and number of distinct installations (or visitors) per event.
- `web` (`countries`, `referrers`, `os`, `languages`, `themes`) and `app` (`versions`, `os`, `countries`, `locales`) as `{key, count}` lists.
- `breakdowns`: `{key, count}` lists per charted property, for example `exportQuality`, `exportFrame`, `recordingSource`, `captionLocale`, `downloadPlacement`.
- `recent`: the latest 40 events (`ts`, `source`, `name`, `version`, `os`, `country`, `locale`, `session` and `consented` as booleans, `props`; older landing rows report the `os` property as `os`). IDs are never returned.
- `funnels` (`web`: `journeys`, `landing`, `steps`, `outcomes`, `by`; `app`: `sessions`, `steps`, `outcomes`, `by`), `firstSuccess` (`studio`, `app`), `retention` (`app`, `web`: `cohorts`, `overall`), `featureInterest` (`key`, `people`, `choices`), `downloadsStarted` (`total` from the site, `byPlatform`, daily `series`), `commerce` (`funnel`, `revenue`) and `feedbackSubmitted` (counts by category).
- `studio`: the browser app. `totals`/`previous` (`visitors`, `opens`, `unsupported`, `recordingsStarted`, `recordings`, `recordingFailures`, `exports`, `exportFailures`, `exportCancels`, `styles`, `desktopClicks`), `funnel` (visitor-days that `opened`, `started`, `recorded`, `exported`), daily `series` (`visitors`, `recordings`, `exports`, `failures`), `events`, `countries`, `os`, `locales` and `breakdowns` (for example `browser`, `recordingSource`, `recordingFailure`, `exportQuality`, `unsupportedReason`, `desktopPlacement`). Visitors and the funnel count visitor-days, because the visitor hash rotates daily.

The API sends CORS headers, so another page or script can read it with the same token. `GET /v1/health` is an unauthenticated liveness check.

"Visitors" is the sum of daily unique visitors, because the visitor hash rotates daily. App numbers only cover installations that agreed to share statistics.

## Dashboard

The Worker serves the dashboard at `/` (Vietnamese only). It signs in with the one admin account, the `ADMIN_USERNAME` and `ADMIN_PASSWORD` secrets: `POST /v1/login` (`{username, password, remember}`) sets an `HttpOnly; Secure; SameSite=Strict` cookie holding an expiry and an HMAC of it keyed by `DASHBOARD_TOKEN`, so no session is stored and the page never sees a credential. "Ghi nhớ trên máy này" (on by default) keeps the session 30 days, otherwise it ends with the browser session (12 hours at most). The account is part of the signed text: changing the username or password, or rotating `DASHBOARD_TOKEN`, signs every browser out. `POST /v1/logout` clears the cookie. Each client address may try 10 sign-ins a minute (`LOGIN_LIMITER`); more get `429`. The dashboard refreshes every five minutes (and on "Làm mới", which asks for a fresh report) and offers 7, 30, 90 and 365-day ranges. Its "Bản web" view shows the browser app: visitors, the open → record → export funnel, success rates, browsers, shared surfaces and audio, export settings, failures and unsupported browsers. It only reads `/v1/stats` from its own origin; a Content-Security-Policy (`connect-src 'self'`, inline script allowed by hash) enforces that. Every label goes through one presentation block at the top of its script (`VI` and the helpers next to it): event, source, property and value names, export settings, systems ("macOS · Apple Silicon", "Windows · x64", unknown values shown as they are), languages and countries (`Intl.DisplayNames("vi")`; `XX` "Không xác định", `T1` "Mạng Tor", missing "Không rõ"). Raw codes stay in the API. Every date and time uses one `vi-VN` formatter with `timeZone: "Asia/Ho_Chi_Minh"`, whatever the viewer's computer is set to. "Hành trình" shows funnels, first successes, retention, feature interest, server-side download starts and revenue; "Phản hồi" lists feedback with filters, search, paging and status changes, and draws every message with `textContent` (no HTML is ever parsed from feedback, and links are not made clickable). After editing the dashboard script, update the `sha256-…` hash in its CSP meta tag; `test:e2e` fails until it matches.

## Running and deploying

```bash
pnpm --filter @screensway/analytics dev     # local Worker + local D1 on http://localhost:8787
pnpm --filter @screensway/analytics test      # unit tests (Vietnam days, countries, IDs)
pnpm --filter @screensway/analytics test:e2e  # end-to-end test against a throwaway local database, plus the dashboard in Edge
                                              # (BROWSER=chrome; SCREENSWAY_SKIP_BROWSER=1 skips it; SCREENSWAY_SCREENSHOTS=<dir> saves views)
```

For local runs put `DASHBOARD_TOKEN=…`, `ACTOR_SALT=…`, `ADMIN_USERNAME=…` and `ADMIN_PASSWORD=…` in `apps/analytics/.dev.vars` (not committed). To change the account: `npx wrangler secret put ADMIN_PASSWORD` (or `ADMIN_USERNAME`) in `apps/analytics`.

The service runs at `https://stats.screensway.site` (dashboard at `/`). The old `https://screensway-analytics.visual-lab-dm4.workers.dev` address stays enabled, because desktop builds before the move send their opt-in statistics there. Later changes only need `pnpm run deploy` (it applies pending migrations first; migration 0003 only adds columns, tables and indexes, so existing events are kept).

Download reporting needs the same random value in both Workers, then the analytics Worker deployed before the downloads Worker (the service binding names it):

```bash
(cd apps/analytics && npx wrangler secret put DOWNLOADS_EVENT_TOKEN && pnpm run deploy)
(cd apps/downloads && npx wrangler secret put DOWNLOADS_EVENT_TOKEN && pnpm run deploy)
``` The first deployment, from `apps/analytics`, was:

```bash
npx wrangler login
npx wrangler d1 create screensway-analytics      # copy the database_id into wrangler.toml
npx wrangler secret put DASHBOARD_TOKEN          # long random value: script access and the session signing key
npx wrangler secret put ADMIN_USERNAME           # the dashboard account
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ACTOR_SALT               # any long random value; keep it stable
pnpm run deploy                                  # applies migrations, then deploys
```

Then point the clients at the deployed URL:

- Landing page: `VITE_ANALYTICS_URL` on the build step in `.github/workflows/web.yml`. Local builds leave it unset and send nothing.
- Desktop app: `DEFAULT_ENDPOINT` in `apps/desktop/src-tauri/src/telemetry.rs` (or `SCREENSWAY_ANALYTICS_URL` at build or run time). Without it the consent prompt and the Settings switch are hidden.

`SCREENSWAY_ANALYTICS_URL=http://localhost:8787 cargo test --lib live -- --ignored` (in `apps/desktop/src-tauri`) sends real events from the Rust client to a running API.

## Limits

- The ingestion endpoint is public, as any client-side analytics endpoint is. The allow-lists keep junk out of the reports but a determined sender can still inflate counts within the per-address rate limit.
- A download click is a click. Download starts are seen by the downloads Worker; completed downloads and installs are not observable (see "Downloads and installs").
- Browsers are not recognised across visits, so browser retention is not measured (it stays empty apart from the few 0.4.1 opt-ins); retention means the desktop app.
- Journeys need the tab's sessionStorage: opening `/app/` in a new tab starts a new journey, and events from builds before the journey ID have none.
- D1's free tier (5 GB, 100k writes per day at the time of writing) is far above current needs; reports aggregate at query time, so add rollup tables if the events table grows into millions of rows.

## Load and cost

Ingestion is one small `INSERT` batch per request and scales with Cloudflare; the costly part is reading. A report runs about 45 queries over the events in its range, so `/v1/stats` keeps the last report per range for 60 s in the isolate (`?fresh=1` bypasses it), the dashboard refreshes every five minutes, and `migrations/0002_events_by_name.sql` adds an index on `(source, name, day)` so each breakdown reads only its own event's rows. On the Workers free plan the account has 100k requests a day (both Workers together) and D1 100k rows written and 5M rows read a day; a few dashboard loads a day over a large range can use most of the read allowance, so move to the paid plan before traffic grows past a few thousand visits a day.
