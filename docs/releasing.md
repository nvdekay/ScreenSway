# Releasing ScreenSway

## Download URL

The repository is private, so GitHub Release assets are not publicly downloadable. The landing page serves both desktop builds itself:

```text
https://nvdekay.github.io/ScreenSway/download/ScreenSway-macos-universal.dmg
https://nvdekay.github.io/ScreenSway/download/ScreenSway-windows-x64-setup.exe
```

The "Deploy landing page" workflow downloads `ScreenSway-macos-universal.dmg`, `ScreenSway-windows-x64-setup.exe` and its `.sha256` checksum from the latest release and publishes it with the site. It runs when a release is published. If you replace the asset of an existing release, re-run the workflow (`gh workflow run web.yml`) so the site picks up the new file.

## Publish a release

1. Update the version in the root package, desktop package, `tauri.conf.json`, and `Cargo.toml`.
2. Commit and push the changes.
3. Create and push a matching tag, for example `v0.2.0`. The "Release macOS app" workflow refuses a tag that differs from the `tauri.conf.json` version.
4. The workflow builds the universal DMG and signed updater bundle on a macOS 26 runner, verifies the app, publishes the release, then dispatches `windows.yml` with `publish=true`. The Windows workflow builds and uploads the matching installer, checksum and signed updater bundle, then deploys both downloads and `update/latest.json`.
5. Download the DMG from the landing page and test it before announcing the release.

Both macOS and Windows x64 are publicly available. Relevant pushes build a Windows test artifact. To replace the Windows release asset, dispatch `windows.yml` with `publish=true`; the app version must have a matching release. The unsigned Windows installer includes the offline speech model (about 494 MiB). Windows 11 has been tested; offline captions require AVX2, FMA, F16C and BMI2.

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

Do not place these values in `.env` files. The public feed is `https://nvdekay.github.io/ScreenSway/update/latest.json`; it is generated only after updater artifacts for both platforms exist on the latest release.

