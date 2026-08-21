# windows-setup.ps1 — set up the Windows machine as the always-on Ashby apply
# box (Chrome + the JobWatch extension). Run once in an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File windows-setup.ps1
#
# It makes the machine keep running with the lid closed and launches Chrome with
# the extension at login so the extension's alarm can auto-apply around the clock.

$ErrorActionPreference = "Stop"

Write-Host "==> power settings: never sleep, do nothing on lid close (plugged in)"
# Never sleep or turn off disks on AC power
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /change disk-timeout-ac 0
# Lid close action = Do nothing (0) on AC. PowerButtons/LidAction GUID:
$scheme = (powercfg /getactivescheme) -replace '.*GUID: ([0-9a-f-]+).*','$1'
powercfg /setacvalueindex $scheme SUB_BUTTONS LIDACTION 0
powercfg /setactive $scheme
Write-Host "    lid close on AC is now 'Do nothing'."

# ── Launch Chrome with the extension at login ────────────────────────────────
# EDIT these two paths for your machine:
$Chrome    = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$Extension = "C:\JobWatch\extension"   # folder that contains manifest.json

if (-not (Test-Path $Chrome))    { Write-Warning "Chrome not found at $Chrome - edit the path." }
if (-not (Test-Path $Extension)) { Write-Warning "Extension not found at $Extension - edit the path." }

$action  = New-ScheduledTaskAction -Execute $Chrome `
  -Argument "--load-extension=`"$Extension`" --restore-last-session --no-first-run"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName "JobWatch-Chrome" -Action $action -Trigger $trigger `
  -Settings $settings -Force -RunLevel Highest | Out-Null

Write-Host "==> scheduled task 'JobWatch-Chrome' created (launches Chrome + extension at login)."
Write-Host "Next: log into JobWatch once in that Chrome so the extension stores its session."
Write-Host "The extension's alarm then auto-applies on its own after each run."
