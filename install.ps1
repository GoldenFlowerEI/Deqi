# Install deqi (Golden Flower Emergent Intelligence) from a local clone on Windows.
#
# Usage (PowerShell):
#   .\install.ps1                 # install to ~\bin (creates if needed)
#   .\install.ps1 -Prefix C:\tools
#
# After install, add $Prefix to your PATH and open a NEW PowerShell window
# so PATH + Deqi_HOME take effect, then:
#   deqi --version
#   deqi --list-models
#   deqi

[CmdletBinding()]
param(
    [string]$Prefix = "$HOME\bin"
)

$ErrorActionPreference = 'Stop'

# Project root is the directory containing this script.
$ProjectRoot = $PSScriptRoot

Write-Host "deqi installer"
Write-Host "  project: $ProjectRoot"
Write-Host "  prefix:  $Prefix"

# Pre-flight.
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Error "bun is required. Install from https://bun.sh"
    exit 1
}

# Build.
Write-Host "-> bun install"
& bun install | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "bun install failed"; exit 1 }
Write-Host "-> bun run build"
& bun run build | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "bun run build failed"; exit 1 }

# Install the launcher.
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
Copy-Item -Path "$ProjectRoot\bin\deqi.cmd" -Destination "$Prefix\deqi.cmd" -Force
Copy-Item -Path "$ProjectRoot\bin\deqi.js"  -Destination "$Prefix\deqi.js"  -Force

# Add $Prefix to user PATH if it isn't there yet.
$currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$hasOnPath = $false
foreach ($p in $currentUserPath -split ";") { if ($p -ieq $Prefix) { $hasOnPath = $true; break } }
if (-not $hasOnPath) {
    $newPath = "$currentUserPath;$Prefix"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "  added $Prefix to user PATH"
} else {
    Write-Host "  $Prefix already on user PATH"
}

# Set Deqi_HOME so the launcher can locate the project.
[Environment]::SetEnvironmentVariable("Deqi_HOME", $ProjectRoot, "User")
Write-Host "  set Deqi_HOME=$ProjectRoot"

Write-Host ""
Write-Host "Installed:"
Write-Host "  $Prefix\deqi.cmd"
Write-Host ""
Write-Host "Open a NEW PowerShell window so PATH + Deqi_HOME take effect, then:"
Write-Host "  deqi --version"
Write-Host "  deqi --list-models"
Write-Host "  deqi"
