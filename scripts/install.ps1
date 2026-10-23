<#
.SYNOPSIS
  One-command installer for wb-cursor-bridge (win-x64).

.DESCRIPTION
  Installs the bridge, guarantees a Node runtime, registers it as an MCP
  server with WorkBuddy/CodeBuddy and Cursor, and self-verifies the result.

  MCP servers are launched with child_process.spawn, and Node refuses to run a
  .cmd/.bat without a shell. The MCP entry therefore points directly at a node
  executable plus the bundled script - launcher.cmd exists for humans, not for
  the protocol.

.PARAMETER WorkspaceRoots
  Semicolon-separated list of repository roots the sub-agent may touch.
  Anything outside these roots is refused.

.PARAMETER CursorBin
  Full path to the Cursor CLI (agent.exe). Auto-detected when omitted.

.PARAMETER BundleNode
  Download a private Node runtime into the install directory instead of
  relying on Node being present on PATH.

.PARAMETER NodeMirror
  Base URL for the Node.js distribution mirror (default: https://nodejs.org/dist).
  Environment variable CURSOR_BRIDGE_NODE_MIRROR overrides this parameter.

.PARAMETER NodeOfflinePackage
  Path to a pre-downloaded node-$version-win-x64.zip. When provided and the file
  exists, the installer skips the network download entirely.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -WorkspaceRoots "C:\src\api;C:\src\web"

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -WorkspaceRoots "C:\src\api" -BundleNode -Force

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -WorkspaceRoots "C:\src\api" -BundleNode -NodeVersion v22.12.0 -Force

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1 -WorkspaceRoots "C:\src\api" -BundleNode -NodeOfflinePackage "C:\cache\node-v22.11.0-win-x64.zip"
#>
[CmdletBinding()]
param(
  [string[]] $WorkspaceRoots,
  [string]   $CursorBin,
  [string]   $InstallDir = "$env:LOCALAPPDATA\Programs\wb-cursor-bridge",
  [int]      $AdminPort = 0,
  [string]   $AdminShutdownToken,
  [int]      $MaxConcurrency = 4,
  [int]      $TimeoutSec = 900,
  [string]   $NodeVersion = 'v22.11.0',
  [string]   $NodeMirror = 'https://nodejs.org/dist',
  [string]   $NodeOfflinePackage,
  [switch]   $BundleNode,
  [switch]   $SkipMcp,
  [switch]   $Force,
  [switch]   $NoSelfCheck
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:Source = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $script:Source 'lib\McpConfig.ps1')
$script:StateDir = "$env:LOCALAPPDATA\wb-cursor-bridge"
$script:Log = Join-Path $script:StateDir 'install.log'

# ----------------------------------------------------------------- output
function Write-Step  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok    ($m) { Write-Host "    [ok] $m" -ForegroundColor Green }
function Write-Warn  ($m) { Write-Host "    [warn] $m" -ForegroundColor Yellow }
function Write-Fail  ($m) { Write-Host "    [fail] $m" -ForegroundColor Red }
function Write-Info  ($m) { Write-Host "    $m" -ForegroundColor Gray }

function Write-Log ($m) {
  try {
    if (-not (Test-Path $script:StateDir)) {
      New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null
    }
    Add-Content -Path $script:Log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
  } catch { }
}

# -------------------------------------------------------------- validation
if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -lt 6) {
  Write-Warn 'This installer is intended for Windows PowerShell 5.1 or PowerShell 7+.'
}

foreach ($f in @('lib\index.mjs', 'launcher.cmd')) {
  if (-not (Test-Path (Join-Path $script:Source $f))) {
    throw "Payload is incomplete: '$f' is missing. Extract the whole archive before installing."
  }
}

if (-not $WorkspaceRoots -or $WorkspaceRoots.Count -eq 0) {
  Write-Step 'No workspace roots supplied'
  $raw = Read-Host 'Repository roots the sub-agent may access (separate several with ";")'
  $WorkspaceRoots = $raw -split ';' | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() }
  if (-not $WorkspaceRoots -or $WorkspaceRoots.Count -eq 0) {
    throw 'At least one workspace root is required. Re-run with -WorkspaceRoots "C:\src\repo".'
  }
}

$WorkspaceRoots = $WorkspaceRoots | ForEach-Object {
  $p = [Environment]::ExpandEnvironmentVariables($_.Trim())
  if (-not [System.IO.Path]::IsPathRooted($p)) {
    $p = Join-Path (Get-Location).Path $p
  }
  [System.IO.Path]::GetFullPath($p).TrimEnd('\')
}

foreach ($r in $WorkspaceRoots) {
  if (-not (Test-Path $r -PathType Container)) {
    throw "Workspace root does not exist: $r"
  }
}

if (Test-Path $InstallDir) {
  if (-not $Force) {
    Write-Step "Upgrading an existing installation at $InstallDir"
  }
  # A previous bridge may still be running; ask it to exit cleanly.
  #
  # The match must look at the command line, which contains the install path
  # (<InstallDir>\lib\index.mjs). The state directory never appears in a
  # command line - it is passed via the env block - so matching on it would
  # silently find nothing and leave the old process holding lib\index.mjs open.
  $stopped = 0
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -like "*$InstallDir*" -or $_.CommandLine -like "*wb-cursor-bridge*"
    } |
    ForEach-Object {
      Write-Info "stopping running bridge pid=$($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      $stopped += 1
    }
  if ($stopped -gt 0) {
    # Give Windows a moment to release the file locks before we overwrite.
    Start-Sleep -Milliseconds 600
  }
} else {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# ---------------------------------------------------------- 1. copy files
Write-Step "Installing to $InstallDir"
foreach ($f in @('lib', 'launcher.cmd', 'verify.cmd', 'uninstall.ps1')) {
  $src = Join-Path $script:Source $f
  if (-not (Test-Path $src)) { continue }
  $dst = Join-Path $InstallDir $f
  if ((Get-Item $src).PSIsContainer) {
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    Copy-Item $src $dst -Recurse -Force
  } else {
    Copy-Item $src $dst -Force
  }
}
Write-Ok 'bridge files copied'

# ------------------------------------------------------------- 2. runtime
Write-Step 'Resolving the Node.js runtime'
$nodeExe = $null
if (-not $BundleNode) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) {
    $ver = (& node -p 'process.versions.node.split(".")[0]') 2>$null
    if ($ver -and [int]$ver -ge 18) {
      $nodeExe = $cmd.Source
      Write-Ok "using Node v$ver from PATH ($nodeExe)"
    } else {
      Write-Warn "Node on PATH is too old (v$ver); Node 18+ is required"
    }
  }
}

if (-not $nodeExe) {
  $bundled = Join-Path $InstallDir 'runtime\node.exe'
  if (Test-Path $bundled) {
    $nodeExe = $bundled
    Write-Ok "using the bundled runtime ($nodeExe)"
  } else {
    $version = $NodeVersion
    $runtimeDir = Join-Path $InstallDir 'runtime'

    if ($NodeOfflinePackage -and (Test-Path $NodeOfflinePackage)) {
      Write-Step "Using offline Node.js package ($NodeOfflinePackage)"
      $extract = Join-Path $env:TEMP "node-extract-$([guid]::NewGuid().ToString('N').Substring(0,8))"
      Expand-Archive -Path $NodeOfflinePackage -DestinationPath $extract -Force
      $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
      if (Test-Path $runtimeDir) { Remove-Item $runtimeDir -Recurse -Force }
      Move-Item $inner.FullName $runtimeDir
      Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
      $nodeExe = Join-Path $runtimeDir 'node.exe'
      Write-Ok "Node $version installed from offline package ($nodeExe)"
    } else {
      Write-Step "Downloading a private Node.js runtime ($NodeVersion)"
      $mirror = $env:CURSOR_BRIDGE_NODE_MIRROR
      if (-not $mirror) { $mirror = $NodeMirror }
      $fallback = 'https://nodejs.org/dist'
      $url = "$mirror/$version/node-$version-win-x64.zip"
      $fallbackUrl = "$fallback/$version/node-$version-win-x64.zip"
      $tmp = Join-Path $env:TEMP "node-$version-win-x64.zip"
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      try {
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
      } catch {
        if ($mirror -ne $fallback) {
          Write-Warn "mirror download failed, falling back to $fallback"
          Invoke-WebRequest -Uri $fallbackUrl -OutFile $tmp -UseBasicParsing
        } else {
          throw
        }
      }
      $extract = Join-Path $env:TEMP "node-extract-$([guid]::NewGuid().ToString('N').Substring(0,8))"
      Expand-Archive -Path $tmp -DestinationPath $extract -Force
      $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
      if (Test-Path $runtimeDir) { Remove-Item $runtimeDir -Recurse -Force }
      Move-Item $inner.FullName $runtimeDir
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
      Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
      $nodeExe = Join-Path $runtimeDir 'node.exe'
      Write-Ok "Node $version installed privately ($nodeExe)"
    }
  }
}

if (-not (Test-Path $nodeExe)) { throw 'Node.js runtime could not be resolved.' }

# --------------------------------------------------------- 3. cursor cli
Write-Step 'Locating the Cursor CLI'
if (-not $CursorBin) {
  $candidates = @()
  $la = $env:LOCALAPPDATA
  $pf = ${env:ProgramFiles}
  if ($la) {
    $candidates += (Join-Path $la 'Programs\cursor\bin\agent.exe')
    $candidates += (Join-Path $la 'Programs\cursor-agent\agent.exe')
  }
  if ($pf) { $candidates += (Join-Path $pf 'Cursor\bin\agent.exe') }
  $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($found) {
    $CursorBin = $found
  } else {
    $onPath = Get-Command agent -ErrorAction SilentlyContinue
    if ($onPath) { $CursorBin = $onPath.Source }
  }
}

if ($CursorBin -and (Test-Path $CursorBin)) {
  Write-Ok "Cursor CLI: $CursorBin"
} else {
  Write-Warn 'Cursor CLI was not found.'
  Write-Info 'Install it with: curl https://cursor.com/install -fsS | bash'
  Write-Info 'or set CURSOR_BIN in the config file once it is available.'
  if ($CursorBin) { $CursorBin = 'agent.exe' }
}

# -------------------------------------------------------------- 4. config
Write-Step 'Writing configuration'
New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null
$configPath = Join-Path $script:StateDir 'config.json'
$config = [ordered]@{
  cursorBin        = if ($CursorBin) { $CursorBin } else { 'agent.exe' }
  workspaceRoots   = @($WorkspaceRoots)
  stateDir         = $script:StateDir
  defaultTimeoutSec= $TimeoutSec
  maxConcurrency   = $MaxConcurrency
  adminPort        = $AdminPort
  logLevel         = 'info'
  forceWorktree    = $true
}
if ($AdminShutdownToken) {
  $config['adminShutdownToken'] = $AdminShutdownToken
}
$config | ConvertTo-Json -Depth 8 | Set-Content -Path $configPath -Encoding UTF8
Write-Ok "config: $configPath"

# ---------------------------------------------------------- 5. MCP wiring
if (-not $SkipMcp) {
  Write-Step 'Registering as an MCP server'

  $entry = @{
    command = $nodeExe
    args    = @((Join-Path $InstallDir 'lib\index.mjs'))
    env     = [ordered]@{
      CURSOR_BIN                     = $(if ($CursorBin) { $CursorBin } else { 'agent.exe' })
      CURSOR_BRIDGE_WORKSPACE_ROOTS  = ($WorkspaceRoots -join ';')
      CURSOR_BRIDGE_STATE_DIR        = $script:StateDir
      CURSOR_BRIDGE_TIMEOUT_SEC      = "$TimeoutSec"
      CURSOR_BRIDGE_MAX_CONCURRENCY  = "$MaxConcurrency"
      CURSOR_BRIDGE_ADMIN_PORT       = "$AdminPort"
      CURSOR_BRIDGE_LOG_LEVEL        = 'info'
      CURSOR_BRIDGE_FORCE_WORKTREE   = '1'
    }
  }
  if ($AdminShutdownToken) {
    $entry.env['CURSOR_BRIDGE_ADMIN_SHUTDOWN_TOKEN'] = $AdminShutdownToken
  }

  $targets = @(
    @{ Label = 'WorkBuddy / CodeBuddy'; Path = "$env:USERPROFILE\.codebuddy\.mcp.json" },
    @{ Label = 'Cursor';                Path = "$env:USERPROFILE\.cursor\mcp.json" }
  )

  foreach ($t in $targets) {
    try {
      Set-McpEntry -Path $t.Path -Name 'cursor-bridge' -Entry $entry
      Write-Ok "$($t.Label): registered in $($t.Path)"
    } catch {
      Write-Warn "$($t.Label): $($_.Exception.Message)"
    }
  }
}

# --------------------------------------------------------- 6. self-check
if (-not $NoSelfCheck) {
  Write-Step 'Self-check'
  $env:CURSOR_BIN = $(if ($CursorBin) { $CursorBin } else { 'agent.exe' })
  $env:CURSOR_BRIDGE_WORKSPACE_ROOTS = ($WorkspaceRoots -join ';')
  $env:CURSOR_BRIDGE_STATE_DIR = $script:StateDir
  $env:CURSOR_BRIDGE_SELFCHECK = '1'
  $env:CURSOR_BRIDGE_LOG_LEVEL = 'error'
  if ($AdminShutdownToken) { $env:CURSOR_BRIDGE_ADMIN_SHUTDOWN_TOKEN = $AdminShutdownToken }

  $check = & $nodeExe (Join-Path $InstallDir 'lib\index.mjs') 2>&1
  $code = $LASTEXITCODE
  Remove-Item Env:\CURSOR_BRIDGE_SELFCHECK -ErrorAction SilentlyContinue

  if ($code -eq 0) {
    Write-Ok 'bridge started and reported healthy'
  } else {
    Write-Warn "self-check exited with code $code"
    $check | ForEach-Object { Write-Info $_ }
  }
}

Write-Log "install completed node=$nodeExe roots=$($WorkspaceRoots -join ';')"

Write-Host ''
Write-Host 'Installation complete.' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps:'
Write-Host "  1. Restart WorkBuddy/CodeBuddy and Cursor so they reload the MCP config."
Write-Host "  2. In WorkBuddy ask:  'use cursor-bridge to review my repo at $WorkspaceRoots[0]'"
Write-Host "  3. Diagnostics:  & '$nodeExe' '$InstallDir\lib\index.mjs'  (then call bridge_health)"
if ($AdminPort -gt 0) {
  Write-Host "  4. Health endpoint: http://127.0.0.1:$AdminPort/healthz"
}
Write-Host ''
Write-Host "State and logs: $script:StateDir"
Write-Host "To remove:      powershell -ExecutionPolicy Bypass -File '$InstallDir\uninstall.ps1'"
Write-Host ''