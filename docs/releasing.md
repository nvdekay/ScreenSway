# Releasing ScreenSway

## Download URL

The repository is private, so GitHub Release assets are not publicly downloadable. The landing page serves the macOS build itself:

```text
https://nvdekay.github.io/ScreenSway/download/ScreenSway-macos-universal.dmg
```

The "Deploy landing page" workflow downloads `ScreenSway-macos-universal.dmg` from the latest release and publishes it with the site. It runs when a release is published. If you replace the asset of an existing release, re-run the workflow (`gh workflow run web.yml`) so the site picks up the new file.

## Publish a release

1. Update the version in the root package, desktop package, `tauri.conf.json`, and `Cargo.toml`.
2. Commit and push the changes.
3. Create and push a matching tag, for example `v0.2.0`. The "Release macOS app" workflow refuses a tag that differs from the `tauri.conf.json` version.
4. The workflow builds the universal DMG on a macOS 26 runner, verifies its signature, architectures and icon, publishes the release with install notes and the SHA-256 checksum, then starts the landing page deploy so the site serves the new DMG.
5. Download the DMG from the landing page and test it before announcing the release.

Only macOS is released for now; Windows capture is not implemented yet.

## Signing

Unsigned macOS and Windows builds trigger security warnings. Before a public release, configure Apple Developer signing/notarization and a Windows code-signing certificate in repository secrets. Never commit signing credentials.

