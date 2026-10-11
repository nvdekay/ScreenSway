param([string]$RootPath)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class QaPointer { [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra); }'
$form=New-Object System.Windows.Forms.Form
$form.Text='ScreenSway QA Capture Target'
$form.StartPosition='Manual';$form.Location=New-Object System.Drawing.Point(220,180);$form.Size=New-Object System.Drawing.Size(800,520)
$form.BackColor=[System.Drawing.Color]::FromArgb(35,45,85)
$label=New-Object System.Windows.Forms.Label;$label.Text='ScreenSway end-to-end capture';$label.ForeColor=[System.Drawing.Color]::White;$label.AutoSize=$true;$label.Location=New-Object System.Drawing.Point(30,30);$label.Font=New-Object System.Drawing.Font('Segoe UI',20);$form.Controls.Add($label)
$button=New-Object System.Windows.Forms.Button;$button.Text='Click target';$button.Location=New-Object System.Drawing.Point(100,100);$button.Size=New-Object System.Drawing.Size(180,60);$form.Controls.Add($button)
$clock=New-Object System.Windows.Forms.Label;$clock.ForeColor=[System.Drawing.Color]::White;$clock.Location=New-Object System.Drawing.Point(30,230);$clock.Size=New-Object System.Drawing.Size(600,100);$clock.Font=New-Object System.Drawing.Font('Segoe UI',16);$form.Controls.Add($clock)
$timer=New-Object System.Windows.Forms.Timer;$timer.Interval=100
$timer.Add_Tick({
 $clock.Text=[DateTime]::Now.ToString('HH:mm:ss.fff')
 $control=Join-Path $RootPath 'fixture-command.json'
 if(Test-Path -LiteralPath $control){$cmd=Get-Content -LiteralPath $control -Raw | ConvertFrom-Json;Remove-Item -LiteralPath $control
  switch($cmd.action){'move'{$form.Location=New-Object System.Drawing.Point($cmd.x,$cmd.y)} 'resize'{$form.Size=New-Object System.Drawing.Size($cmd.width,$cmd.height)} 'minimize'{$form.WindowState='Minimized'} 'restore'{$form.WindowState='Normal'} 'close'{$form.Close()} 'click'{
    $form.Activate();$form.BringToFront()
    $previousPointer=[System.Windows.Forms.Cursor]::Position
    $target=$button.PointToScreen([System.Drawing.Point]::new(90,30))
    [System.Windows.Forms.Cursor]::Position=$target
    [QaPointer]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 90
    [QaPointer]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
    [System.Windows.Forms.Cursor]::Position=$previousPointer
  }}
 }
})
$form.Add_Shown({[IO.File]::WriteAllText((Join-Path $RootPath 'fixture-ready.json'),('{"hwnd":"'+$form.Handle.ToInt64()+'"}'));$timer.Start()})
[System.Windows.Forms.Application]::Run($form)
