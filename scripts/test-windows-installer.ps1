param(
    [Parameter(Mandatory=$true)][string]$InstallerPath,
    [Parameter(Mandatory=$true)][string]$SpeechWav,
    [string]$ArtifactsPath = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (!$ArtifactsPath) { $ArtifactsPath = Join-Path $repo '.tools/qa-windows-installer' }
$installRoot = [IO.Path]::GetFullPath((Join-Path $repo '.tools/installed-qa'))
if (!$installRoot.StartsWith([IO.Path]::GetFullPath((Join-Path $repo '.tools/')),[StringComparison]::OrdinalIgnoreCase)) { throw 'QA installation must be inside workspace .tools' }
if (Get-Process screensway -ErrorAction SilentlyContinue) { throw 'Close ScreenSway before installer testing.' }
New-Item -ItemType Directory -Path $ArtifactsPath -Force | Out-Null
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$library = Join-Path ([Environment]::GetFolderPath('MyVideos')) 'ScreenSway'
function Snapshot-Library {
    $snapshot = @{}
    Get-ChildItem -LiteralPath $library -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        $snapshot[$_.FullName] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
    return $snapshot
}
function Assert-Preserved($Before) {
    foreach ($file in $Before.Keys) {
        if (!(Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $Before[$file]) { throw "User file was changed or removed: $file" }
    }
}
function Install-QA {
    $process = Start-Process -FilePath $installer -ArgumentList @('/S',"/D=$installRoot") -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
    foreach ($relative in @('screensway.exe','screensway-capture.exe','models/ggml-large-v3-turbo-q5_0.bin','models/LICENSE.txt','uninstall.exe')) {
        if (!(Test-Path -LiteralPath (Join-Path $installRoot $relative))) { throw "Installed file missing: $relative" }
    }
    # Tauri restores UNK in the release executable after embedding NSS in the
    # NSIS payload. Compare every byte after that one documented marker patch.
    $verifyApp = 'const fs=require("fs"),assert=require("assert/strict"); const expected=fs.readFileSync(process.argv[2]),actual=fs.readFileSync(process.argv[3]); const marker=Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK"),offset=expected.indexOf(marker); assert(offset>=0 && offset===expected.lastIndexOf(marker),"Expected one Tauri bundle marker"); Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS").copy(expected,offset); assert(expected.equals(actual),"Installed app differs beyond the NSIS bundle marker");'
    $verifyScript=Join-Path $ArtifactsPath 'verify-installed-app.cjs'
    Set-Content -LiteralPath $verifyScript -Value $verifyApp -Encoding utf8
    & node $verifyScript (Join-Path $repo 'apps/desktop/src-tauri/target/release/screensway.exe') (Join-Path $installRoot 'screensway.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Installed application did not match the NSIS release payload' }
    foreach ($binary in @('screensway-capture.exe')) {
        $expected = Get-FileHash -LiteralPath (Join-Path $repo "apps/desktop/src-tauri/target/release/$binary")
        $actual = Get-FileHash -LiteralPath (Join-Path $installRoot $binary)
        if ($actual.Hash -ne $expected.Hash) { throw "Installed binary differs from release: $binary" }
    }
}
$before = Snapshot-Library
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
Install-QA
Assert-Preserved $before
Write-Output 'PASS installer upgrade/reinstall preserves existing library; installed binaries match release'
& (Join-Path $PSScriptRoot 'test-windows-ui.ps1') -AppPath (Join-Path $installRoot 'screensway.exe') -SpeechWav $SpeechWav -ArtifactsPath (Join-Path $ArtifactsPath 'ui')
if (Get-Process screensway -ErrorAction SilentlyContinue) { throw 'UI test left ScreenSway running' }
$afterUi = Snapshot-Library
$uninstaller = Start-Process -FilePath (Join-Path $installRoot 'uninstall.exe') -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
if ($uninstaller.ExitCode -ne 0) { throw "Uninstaller failed: $($uninstaller.ExitCode)" }
# NSIS uninstall can relaunch a temporary copy and return before cleanup finishes.
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ((Test-Path -LiteralPath (Join-Path $installRoot 'screensway.exe')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
if (Test-Path -LiteralPath (Join-Path $installRoot 'screensway.exe')) { throw 'Uninstall left application binary behind' }
Assert-Preserved $afterUi
Write-Output 'PASS uninstall preserves all user media/edits/exports byte-for-byte'
Install-QA
Assert-Preserved $afterUi
@{status='PASS';installer=$installer;sha256=$hash;installedApp=(Join-Path $installRoot 'screensway.exe');preservedFiles=$afterUi.Count;scope='same-version upgrade, installed UI E2E, uninstall, reinstall; existing-version migration and missing WebView2 not covered'} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $ArtifactsPath 'results.json')
Write-Output "INSTALLER_E2E_PASSED $ArtifactsPath"
