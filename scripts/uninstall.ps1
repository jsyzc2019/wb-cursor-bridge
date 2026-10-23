<#
.SYNOPSIS
  Removes wb-cursor-bridge from this machine.

.DESCRIPTION
  Stops any running bridge, deletes the MCP entries from WorkBuddy/CodeBuddy
  and Cursor, optionally deletes the install directory, and keeps the state
  directory unless -Purge is given (so audit logs survive by default).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File uninstall.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge
#>
[CmdletBinding()]
param(
  [string] $InstallDir = "$env:LOCALAPPDATA\Programs\wb-cursor-bridge",
  [string] $StateDir   = "$env:LOCALAPPDATA\wb-cursor-bridge",
  # Remove state: job index, event logs and captured patches.
  [switch] $Purge,
  # Also delete the extracted archive directory.
  [switch] $RemovePayload
)

$ErrorActionPreference = 'Stop'

$script:Source = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $script:Source 'lib\McpConfig.ps1')

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    [ok] $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "    [warn] $m" -ForegroundColor Yellow }

Write-Step 'Stopping any running bridge'
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$StateDir*" -or $_.CommandLine -like "*wb-cursor-bridge*" }
if ($procs) {
  foreach ($p in $procs) {
    Write-Ok "stopping pid=$($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
} else {
  Write-Ok 'nothing was running'
}

Write-Step 'Removing MCP registrations'
$targets = @(
  "$env:USERPROFILE\.codebuddy\.mcp.json",
  "$env:USERPROFILE\.cursor\mcp.json"
)
foreach ($t in $targets) {
  if (Remove-McpEntry -Path $t -Name 'cursor-bridge') {
    Write-Ok "removed from $t"
  } else {
    Write-Ok "nothing to remove in $t"
  }
}

if ($RemovePayload) {
  # -RemovePayload only makes sense when this script runs from the extracted
  # archive. When it runs from the install directory, that directory is removed
  # further down anyway - deleting it here would also delete this script.
  $normSource = [System.IO.Path]::GetFullPath($script:Source).TrimEnd('\')
  $normInstall = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  if ($normSource -ne $normInstall -and (Test-Path $script:Source)) {
    Write-Step 'Removing the extracted archive'
    Remove-Item $script:Source -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "removed $script:Source"
  } else {
    Write-Ok 'running from the install directory; nothing extra to remove'
  }
}

if (Test-Path $InstallDir) {
  Write-Step "Removing $InstallDir"
  Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Ok 'install directory removed'
}

if ($Purge) {
  if (Test-Path $StateDir) {
    Write-Step "Purging $StateDir"
    Remove-Item $StateDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok 'state and logs removed'
  }
} elseif (Test-Path $StateDir) {
  Write-Ok "state kept at $StateDir (pass -Purge to delete it)"
}

Write-Host ''
Write-Host 'Uninstall complete. Restart WorkBuddy/CodeBuddy and Cursor.' -ForegroundColor Green