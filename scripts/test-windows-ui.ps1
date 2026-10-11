param(
    [Parameter(Mandatory=$true)][string]$AppPath,
    [string]$SpeechWav = '',
    [string]$ArtifactsPath = (Join-Path $env:TEMP ('screensway-ui-' + [Guid]::NewGuid().ToString('N')))
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (Get-Process screensway -ErrorAction SilentlyContinue) { throw 'Close ScreenSway before this test; an existing user session will not be terminated.' }
New-Item -ItemType Directory -Path $ArtifactsPath -Force | Out-Null
$libraryRoot = Join-Path ([Environment]::GetFolderPath('MyVideos')) 'ScreenSway'
$results = [System.Collections.Generic.List[object]]::new()
$appProcess = Start-Process -FilePath (Resolve-Path -LiteralPath $AppPath).Path -WindowStyle Hidden -PassThru
function Controls {
    $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$appProcess.Id)
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
    foreach ($window in $windows) {
        $window
        foreach ($element in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)) { $element }
    }
}
function Find-Control([string]$Name) {
    Controls | Where-Object { $_.Current.Name -eq $Name -and $_.Current.IsEnabled } | Select-Object -First 1
}
function Wait-Control([string]$Name,[int]$Seconds=30) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do { $element=Find-Control $Name; if ($element) { return $element }; Start-Sleep -Milliseconds 150 } while ([DateTime]::UtcNow -lt $deadline)
    (Controls | ForEach-Object { $_.Current.Name }) | Set-Content -Encoding utf8 (Join-Path $ArtifactsPath 'last-ui.txt')
    throw "Timed out waiting for: $Name"
}
function Click([string]$Name) {
    $element=Wait-Control $Name
    $pattern=$null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { $pattern.Invoke() }
    elseif ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) { $pattern.Select() }
    elseif ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)) { $pattern.Toggle() }
    elseif ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)) { $pattern.Expand() }
    else { throw "No activation pattern: $Name" }
}
function Set-Toggle([string]$Prefix,[bool]$Enabled) {
    $element=Controls | Where-Object { ([string]$_.Current.Name).StartsWith($Prefix) -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button } | Select-Object -First 1
    if (!$element) { throw "Toggle not found: $Prefix" }
    $pattern=$element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    if (($pattern.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) -ne $Enabled) { $pattern.Toggle() }
}
function Projects { @(Get-ChildItem -LiteralPath $libraryRoot -Directory -Filter '*.screensway' -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'project.json') }) }
function New-Project($Before) {
    $deadline=[DateTime]::UtcNow.AddSeconds(30)
    do { $fresh=Projects | Where-Object { $_.FullName -notin $Before }; if ($fresh) { return ($fresh | Sort-Object LastWriteTime -Descending | Select-Object -First 1) }; Start-Sleep -Milliseconds 150 } while ([DateTime]::UtcNow -lt $deadline)
    throw 'A completed recording was not added to the library.'
}
function Check-Video([string]$Path) {
    $json=& ffprobe -v error -show_streams -show_format -of json $Path
    if ($LASTEXITCODE -ne 0) { throw "Invalid video: $Path" }
    $probe=$json | ConvertFrom-Json
    if (!($probe.streams | Where-Object codec_name -eq 'h264')) { throw 'H.264 video missing' }
    # Capture is variable-rate. Preserve timestamps when decoding: null output's
    # default CFR conversion can round two valid frames onto the same DTS.
    & ffmpeg -v error -xerror -i $Path -fps_mode passthrough -enc_time_base demux -f null - 2> (Join-Path $ArtifactsPath 'decode-errors.log')
    if ($LASTEXITCODE -ne 0) { throw 'Full video decode failed' }
    return $probe
}
function Case([string]$Id,[scriptblock]$Body) {
    $started=[DateTime]::UtcNow
    try { & $Body; $results.Add(@{id=$Id;status='PASS';seconds=([DateTime]::UtcNow-$started).TotalSeconds}); Write-Output "PASS $Id" }
    catch { $results.Add(@{id=$Id;status='FAIL';message=$_.Exception.Message}); throw }
    finally { $results | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $ArtifactsPath 'results.json') }
}
try {
    Case 'UI-01 launch and source discovery' {
        Wait-Control 'Start recording' | Out-Null
        Click 'Refresh recording sources'
        Wait-Control 'Start recording' | Out-Null
    }
    Case 'UI-02 countdown cancellation' {
        $before=@(Projects | ForEach-Object FullName)
        Click 'Start recording'; Click 'Cancel'; Wait-Control 'Start recording' | Out-Null
        if (@(Projects).Count -ne $before.Count) { throw 'Countdown cancellation created a recording' }
    }
    Case 'UI-03 record, pause, resume, stop while paused' {
        Click 'Screens'; Set-Toggle 'Record system audio' $false; Set-Toggle 'Record microphone' $false
        $before=@(Projects | ForEach-Object FullName)
        Click 'Start recording'; Wait-Control 'Pause recording' | Out-Null
        Start-Sleep -Milliseconds 1200; Click 'Pause recording'; Start-Sleep -Milliseconds 700
        Click 'Resume recording'; Start-Sleep -Milliseconds 1200; Click 'Pause recording'; Start-Sleep -Milliseconds 500; Click 'Stop'
        Wait-Control 'Close preview' | Out-Null
        $project=New-Project $before; $manifest=Get-Content -Raw -LiteralPath (Join-Path $project.FullName 'project.json') | ConvertFrom-Json
        if ($manifest.durationMs -lt 2000 -or $manifest.durationMs -gt 6000) { throw "Unexpected pause-free duration: $($manifest.durationMs)" }
        $probe=Check-Video (Join-Path $project.FullName 'media/screen.mp4')
        if ($probe.streams | Where-Object codec_type -eq 'audio') { throw 'Silent recording unexpectedly has audio' }
        $script:silentProject=$project.FullName
    }
    Case 'UI-04 all built-in styles and frame options' {
        foreach($style in @('Studio','Clean','MacBook','Website','Social')) { Click $style }
        foreach($frame in @('None','macOS light','macOS dark','Browser light','Browser dark','MacBook','Glass','Outline')) { Click $frame }
        foreach($aspect in @('Auto','16:9','4:3','1:1','9:16')) { Click $aspect }
        Click 'Clean'; Click '16:9'; Click '1080p'
    }
    Case 'UI-05 zoom editing persists after immediate preview close' {
        Click 'Replay from start'; Click 'Pause'; Click 'Add zoom'; Wait-Control 'Remove zoom' | Out-Null
        Click 'Close preview'
        $deadline=[DateTime]::UtcNow.AddSeconds(5)
        do { $file=Join-Path $silentProject 'edits.json'; if(Test-Path -LiteralPath $file) { break }; Start-Sleep -Milliseconds 100 } while([DateTime]::UtcNow -lt $deadline)
        $edits=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        if (!$edits.zooms -or $edits.zooms.Count -lt 1) { throw 'Zoom edit was lost on close' }
        $entry=Controls | Where-Object { ([string]$_.Current.Name).StartsWith('Open preview of ') } | Select-Object -First 1
        $entry.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Wait-Control 'Export video' | Out-Null
    }
    Case 'UI-06 silent captions fail gracefully and recover' {
        Click 'Create captions'; Wait-Control 'Create captions' | Out-Null
        if (!(Controls | Where-Object { $_.Current.Name -match 'no audio to transcribe' })) { throw 'No-audio error was not shown' }
    }
    Case 'UI-07 cancel export, retry and decode exported MP4' {
        Click '4K'; Click 'Export video'; Click 'Cancel'; Wait-Control 'Export video' | Out-Null
        Click '1080p'; $before=@(Get-ChildItem -LiteralPath (Join-Path $libraryRoot 'Exports') -Filter '*.mp4' -ErrorAction SilentlyContinue | ForEach-Object FullName)
        Click 'Export video'; Wait-Control 'Video exported' 180 | Out-Null
        $output=Get-ChildItem -LiteralPath (Join-Path $libraryRoot 'Exports') -Filter '*.mp4' | Where-Object {$_.FullName -notin $before} | Select-Object -First 1
        $probe=Check-Video $output.FullName
        if (($probe.streams | Where-Object codec_type -eq 'video').r_frame_rate -ne '60/1') { throw 'Export is not 60 fps' }
        $script:exportPath=$output.FullName
        Click 'Close preview'
    }
    if ($SpeechWav) {
        Case 'UI-08 system speech recording, local captions, edit and SRT export' {
            Click 'Screens'; Set-Toggle 'Record system audio' $true; Set-Toggle 'Record microphone' $false
            $before=@(Projects | ForEach-Object FullName)
            Click 'Start recording'; Wait-Control 'Pause recording' | Out-Null
            $player=[System.Media.SoundPlayer]::new((Resolve-Path -LiteralPath $SpeechWav).Path);$player.Load();$player.PlaySync()
            Start-Sleep -Milliseconds 500; Click 'Stop'; Wait-Control 'Close preview' | Out-Null
            $project=New-Project $before; $probe=Check-Video (Join-Path $project.FullName 'media/screen.mp4')
            if (!($probe.streams | Where-Object codec_name -eq 'aac')) { throw 'Loopback AAC audio missing' }
            $combo=Wait-Control 'Spoken language'
            # Select through real keyboard input. WebView2's option InvokePattern
            # can report a label as the DOM value rather than the option value.
            $combo.SetFocus(); [System.Windows.Forms.SendKeys]::SendWait('{HOME}{DOWN}{ENTER}')
            Click 'Create captions'; Click 'Cancel'; Wait-Control 'Create captions' | Out-Null
            Click 'Create captions'
            $deadline=[DateTime]::UtcNow.AddSeconds(180)
            do { $input=Controls | Where-Object { ([string]$_.Current.Name).StartsWith('Caption at ') } | Select-Object -First 1; if($input){break};Start-Sleep -Milliseconds 300 } while([DateTime]::UtcNow -lt $deadline)
            if(!$input){throw 'Speech captions did not appear'}
            $input.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('Windows E2E edited caption')
            Click 'Clean'; Click '16:9'; Click '1080p'; Click 'Export video'; Wait-Control 'Video exported' 180 | Out-Null
            $output=Get-ChildItem -LiteralPath (Join-Path $libraryRoot 'Exports') -Filter '*.mp4' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            $srt=[IO.Path]::ChangeExtension($output.FullName,'srt')
            if(!(Test-Path -LiteralPath $srt) -or !(Get-Content -Raw -LiteralPath $srt).Contains('Windows E2E edited caption')) { throw 'Edited caption was not exported to SRT' }
            Check-Video $output.FullName | Out-Null
            $script:speechProject=$project.FullName
            Click 'Close preview'
        }
    }
    Case 'UI-09 closing main exits after recording HUD was used' {
        if (!$appProcess.CloseMainWindow()) { throw 'Main window could not be closed' }
        if (!$appProcess.WaitForExit(10000)) { throw 'Closing main left an invisible ScreenSway process running' }
    }
    Case 'UI-10 restart, minimum window and persisted captions' {
        $script:appProcess=Start-Process -FilePath (Resolve-Path -LiteralPath $AppPath).Path -WindowStyle Hidden -PassThru
        Wait-Control 'Start recording' | Out-Null
        $window=Controls | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window } | Select-Object -First 1
        $window.GetCurrentPattern([System.Windows.Automation.TransformPattern]::Pattern).Resize(760,600)
        Start-Sleep -Milliseconds 300
        $record=Wait-Control 'Start recording'
        if ($record.Current.IsOffscreen) {
            $record.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView()
            Start-Sleep -Milliseconds 150
        }
        if ($record.Current.IsOffscreen) { throw 'Record action is unreachable at minimum window size' }
        if ($SpeechWav) {
            $entry=Controls | Where-Object { ([string]$_.Current.Name).StartsWith('Open preview of ') } | Select-Object -First 1
            $entry.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            Wait-Control 'Export video' | Out-Null
            $deadline=[DateTime]::UtcNow.AddSeconds(10)
            do {
                $saved=Controls | Where-Object { ([string]$_.Current.Name).StartsWith('Caption at ') } | Where-Object { $_.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -eq 'Windows E2E edited caption' } | Select-Object -First 1
                if($saved){break};Start-Sleep -Milliseconds 150
            } while([DateTime]::UtcNow -lt $deadline)
            if(!$saved){throw 'Edited caption did not survive app restart'}
            Click 'Close preview'
        }
        if (!$appProcess.CloseMainWindow() -or !$appProcess.WaitForExit(10000)) { throw 'Restarted app did not exit normally' }
    }
    Write-Output "UI_E2E_PASSED Artifacts: $ArtifactsPath"
} finally {
    # Keep test recordings and reports for review. Close only the application this test launched.
    if (!$appProcess.HasExited) {
        $stop=Find-Control 'Stop';if($stop){$stop.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke();Start-Sleep -Seconds 1}
        $appProcess.CloseMainWindow() | Out-Null
    }
}
