# Build the Tauri shell detached from any harness timeout.
#
# Why: the bash tool has a 30-minute hard limit on background tasks.
# A fresh Tauri 2 build on Windows easily takes longer (130+ crates to
# download, 250+ to compile). We use Start-Process to fully decouple
# cargo from the harness, log to a file, and let the user check on it
# later.
#
# Usage: powershell -File scripts/build-tauri-detached.ps1
#        (or `bun run build:tauri-detached` from the desktop package)
#
# Tail the log: Get-Content scripts/tauri-build.log -Wait
# Check status: Get-Process cargo,rustc | Format-Table
# After success: D:\cargo-target\deqi\debug\deqi-desktop.exe

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptsDir = Join-Path $projectRoot "scripts"
$logPath = Join-Path $scriptsDir "tauri-build.log"
$errPath = Join-Path $scriptsDir "tauri-build.err"
$pidPath = Join-Path $scriptsDir "tauri-build.pid"

# Wipe stale state
if (Test-Path $logPath) { Remove-Item $logPath -Force }
if (Test-Path $errPath) { Remove-Item $errPath -Force }
if (Test-Path $pidPath) { Remove-Item $pidPath -Force }

# Wipe stale state
if (Test-Path $logPath) { Remove-Item $logPath -Force }
if (Test-Path $pidPath) { Remove-Item $pidPath -Force }

$packagesDir = Join-Path $projectRoot "packages"
$desktopDir = Join-Path $packagesDir "desktop"
Push-Location $desktopDir

try {
    $proc = Start-Process `
        -FilePath "cmd.exe" `
        -ArgumentList "/c", "bun run tauri:dev" `
        -WorkingDirectory $desktopDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $logPath `
        -RedirectStandardError $errPath `
        -PassThru

    Set-Content -Path $pidPath -Value $proc.Id -NoNewline
    Write-Host "[tauri-build] started detached (pid=$($proc.Id))"
    Write-Host "[tauri-build] stdout: $logPath"
    Write-Host "[tauri-build] stderr: $errPath"
    Write-Host "[tauri-build] tail with: Get-Content '$logPath' -Wait"

    # Wait for the deqi-server to be reachable so the user can hit
    # the URL right away even if the Tauri shell is still compiling.
    Write-Host "[tauri-build] waiting for deqi-server on 7700..."
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        $ok = Test-NetConnection -ComputerName 127.0.0.1 -Port 7700 -WarningAction SilentlyContinue
        if ($ok.TcpTestSucceeded) {
            Write-Host "[tauri-build] deqi-server is listening on 7700"
            break
        }
        Start-Sleep -Seconds 2
    }
}
finally {
    Pop-Location
}
Push-Location $desktopDir

try {
    $proc = Start-Process `
        -FilePath "cmd.exe" `
        -ArgumentList "/c", "bun run tauri:dev > `"$logPath`" 2>&1" `
        -WorkingDirectory $desktopDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $logPath `
        -RedirectStandardError $logPath `
        -PassThru

    Set-Content -Path $pidPath -Value $proc.Id -NoNewline
    Write-Host "[tauri-build] started detached (pid=$($proc.Id))"
    Write-Host "[tauri-build] log: $logPath"
    Write-Host "[tauri-build] tail it with: Get-Content '$logPath' -Wait"
    Write-Host "[tauri-build] check status with: Get-Process -Id $($proc.Id)"

    # Wait for the deqi-server + Vite to be reachable so the user can
    # hit the URL right away even if the Tauri shell is still compiling.
    Write-Host "[tauri-build] waiting for deqi-server on 7700..."
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        $ok = Test-NetConnection -ComputerName 127.0.0.1 -Port 7700 -WarningAction SilentlyContinue
        if ($ok.TcpTestSucceeded) {
            Write-Host "[tauri-build] deqi-server is listening on 7700"
            break
        }
        Start-Sleep -Seconds 2
    }
}
finally {
    Pop-Location
}
