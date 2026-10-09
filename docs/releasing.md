# Releasing ScreenSway

## Download URLs

The website uses stable GitHub Release asset URLs:

```text
https://github.com/nvdekay/ScreenSway/releases/latest/download/ScreenSway-macos-universal.dmg
https://github.com/nvdekay/ScreenSway/releases/latest/download/ScreenSway-windows-x64.exe
```

The assets do not exist until the first tagged release completes.

## Publish a release

1. Update the version in the root package, desktop package, `tauri.conf.json`, and `Cargo.toml`.
2. Commit and push the changes.
3. Create and push a tag, for example `v0.1.0`.
4. Verify both build jobs in GitHub Actions.
5. Test both downloaded installers before announcing the release.

## Signing

Unsigned macOS and Windows builds trigger security warnings. Before a public release, configure Apple Developer signing/notarization and a Windows code-signing certificate in repository secrets. Never commit signing credentials.

