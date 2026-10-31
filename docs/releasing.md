# Releasing ScreenSway

## Download URL

The repository is private, so GitHub Release assets are not publicly downloadable. A Cloudflare Worker (`apps/downloads`, bucket `screensway-downloads` in R2) serves both desktop builds:

```text
https://download.screensway.site/latest/ScreenSway-macos-universal.dmg
https://download.screensway.site/latest/ScreenSway-windows-x64-setup.exe
https://download.screensway.site/v0.4.0/ScreenSway-macos-universal.app.tar.gz   # one release
https://download.screensway.site/current                                     # {"tag": "v0.4.0"}
https://screensway.site/update/latest.json                                    # updater feed, from R2
```

The Worker is a custom domain of the `screensway.site` zone (Cloudflare DNS; the domain is registered at Tenten). Its old address `https://screensway-downloads.visual-lab-dm4.workers.dev` stays enabled, because update feeds published before the move point there.

GitHub Pages used to host these files, but the Windows installer alone is about 494 MiB, and Pages limits a site to 1 GB and about 100 GB of traffic a month. R2 has no egress fees. The Worker supports range requests (resumable downloads), sends `X-Checksum-Sha256`, and serves only the three known file names.

The "Deploy landing page" workflow runs `scripts/publish-downloads.mjs`. The script copies the latest release's DMG, macOS updater bundle and Windows installer to R2 through the Worker's token-protected multipart upload API. Files whose checksum already matches are skipped, so re-deploys upload nothing. It then makes that release current. Switching keeps the previous release, for clients that are mid-update, and deletes older ones. A release that does not have its Windows installer yet is left alone (exit code 2), and the site keeps offering the current one.

The workflow then builds `update/latest.json` from the current release's `.sig` files. The feed's version comes from the tag, not from `main`, and its URLs point at the versioned Worker paths. The feed is uploaded to the downloads Worker (`PUT /admin/update`), which also has the route `screensway.site/update/*`, so the feed address the apps check is served from R2. While R2 has no feed, that route passes the request on to the site.

## Site hosting

`screensway.site` (the landing page and the browser version at `/app/`) is served from Cloudflare as static assets by the `screensway-site` Worker (`apps/site/wrangler.toml`, route `screensway.site/*`). The deploy job uploads `apps/web/dist` with a pinned `wrangler` and the GitHub secret `CLOUDFLARE_API_TOKEN`, an "Edit Cloudflare Workers" token for this account and zone. The apex DNS records point at GitHub Pages and must stay proxied (orange cloud, SSL mode Full) for the routes to run. The more specific `/update/*` route goes to the downloads Worker.

GitHub Pages used to serve the site. Its deploys need GitHub artifact storage, and when the account's artifact quota was reported full, deploys stayed blocked for more than 13 hours after the artifacts were deleted. Pages keeps its last deployment and the custom domain, only so that `nvdekay.github.io/ScreenSway/...` (the update feed of 0.3.x apps) and `www` keep redirecting to `screensway.site`. Removing the Worker routes would serve that old Pages copy again.

Jobs hand files to each other through the Actions cache (`actions/cache/save` and `restore`, keyed by the run id), not artifacts, so a full artifact quota cannot block a release or a deploy. If you replace an asset of the current release, re-run the workflow (`gh workflow run web.yml`).

Secrets: the Worker's `UPLOAD_TOKEN` (`wrangler secret put UPLOAD_TOKEN` in `apps/downloads`) and the GitHub secret `DOWNLOADS_UPLOAD_TOKEN` must hold the same value. Deploy Worker changes with `pnpm --filter @screensway/downloads run deploy`. `pnpm --filter @screensway/downloads test:e2e` checks the Worker and the publish script against a local R2 bucket.

## Publish a release

1. Update the version in the root package, desktop package, `tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml` and `native/windows-capture/Cargo.toml`.
2. Commit and push the changes.
3. Create and push a matching tag, for example `v0.2.0`. The "Release macOS app" workflow refuses a tag that differs from the `tauri.conf.json` version. A tag runs the workflow files of its own commit: if a fix to a workflow is needed before the release exists, move the tag to the fixed commit (`git tag -f vX.Y.Z <commit> && git push -f origin vX.Y.Z`); after the release is published, ship a new version instead.
4. The workflow builds the universal DMG and signed updater bundle on a macOS 26 runner, verifies the app, publishes the release with SHA-256 checksums, then dispatches `windows.yml` with `publish=true` on the same tag, so both installers come from the tagged commit. The Windows workflow builds the installer, signs it for the updater in a separate job and uploads it with its checksum and signature, then runs the site deploy, which copies both downloads to R2, uploads `update/latest.json` to the downloads Worker and deploys the site to Cloudflare.

Workflow hardening: `web.yml` builds the site in a read-only job and publishes it from a separate `deploy` job that installs no dependencies (its scripts use only Node built-ins), so packages never run with the Cloudflare or downloads credentials. `audit.yml` checks `pnpm-lock.yaml` and both `Cargo.lock` files for published advisories weekly, on lockfile changes and on demand (three `zip` advisories from `tauri-plugin-updater` are ignored with the reason in the workflow). Every action is pinned to a full commit SHA (Dependabot, `.github/dependabot.yml`, proposes updates; keep the version comment next to each SHA). Jobs that install and build dependencies get a read-only `GITHUB_TOKEN`; only the small publish jobs (`publish-macos`, `publish-windows`) may write releases or dispatch workflows. The macOS build still needs the updater key because Tauri signs the `.app.tar.gz` while bundling. The Windows build never sees it: it builds with `src-tauri/tauri.unsigned.conf.json` (no updater artifacts) and `publish-windows` signs the installer with `tauri signer sign`, using the CLI version from the lockfile. Push builds of `windows.yml` therefore produce an installer without a `.sig`.
5. Download both installers from the landing page and test them before announcing the release, including an in-app update from the previous version on each platform.

Both macOS and Windows x64 are publicly available. Relevant pushes build a Windows test installer, uploaded as an artifact for three days when artifact storage allows (a full quota does not fail the build). To replace the Windows release asset, dispatch `windows.yml` with `publish=true`; the app version must have a matching release. The unsigned Windows installer includes the offline speech model (about 494 MiB). Windows 11 has been tested; offline captions require AVX2, FMA, F16C and BMI2.

Before building Windows, run `pnpm setup:windows-speech` to download and verify the bundled model. See [Windows build and validation](windows-validation.md) for dependencies and checks.

## Signing

Unsigned macOS and Windows builds trigger security warnings. Configure Apple Developer signing/notarization and a Windows code-signing certificate in repository secrets to remove those warnings from future releases. Never commit signing credentials.

Updater signing is separate from operating-system code signing and is already required. GitHub Actions stores `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the matching public key is embedded in `tauri.conf.json`. Keep the private key and password backed up outside the repository. Losing or rotating it prevents installed copies from trusting future updates.

For a local updater bundle build, point the environment variable at the backed-up key before running the platform build:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/screensway.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<password from the password manager>'
pnpm build:macos
```

Do not place these values in `.env` files. The public feed is `https://screensway.site/update/latest.json`; the app lists it first and keeps `https://nvdekay.github.io/ScreenSway/update/latest.json` as a fallback (installed 0.3.x builds know only that one, and GitHub Pages redirects it to the custom domain, so keep the Pages custom domain set). The downloads Worker serves it from R2, and it always describes the release the Worker currently offers.

## Updates and macOS permissions

The macOS app is ad-hoc signed, so its code identity (the designated requirement is a `cdhash`) changes with every build. After an update, macOS may stop honoring the Screen Recording, Microphone and Speech Recognition permissions, even though System Settings still shows them switched on. For screen recording, the onboarding and the in-app permission card offer “Reset permission and reopen”: the `reset_screen_recording_permission` command runs `tccutil reset ScreenCapture app.screensway.desktop` (no administrator rights needed) and the app relaunches, so macOS asks again from the start. Microphone and speech messages still tell users to switch the permission off and on again, or remove and re-add ScreenSway. Developer ID signing would remove this. The updater waits while a recording, export or caption job is running (`background_work_active`): the update downloads, and the user restarts to install it once the job is done.

