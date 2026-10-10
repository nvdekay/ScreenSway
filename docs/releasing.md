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
3. Create and push a tag, for example `v0.1.0`.
4. Verify both build jobs in GitHub Actions.
5. Test both downloaded installers before announcing the release.

## Signing

Unsigned macOS and Windows builds trigger security warnings. Before a public release, configure Apple Developer signing/notarization and a Windows code-signing certificate in repository secrets. Never commit signing credentials.

