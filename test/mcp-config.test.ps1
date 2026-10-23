<#
  Tests for the shared MCP configuration helpers.

  These functions rewrite files the user cares about, so the guarantee that
  matters most is: existing entries survive, and invalid files are never
  silently clobbered. Run with:

      pwsh -File test/mcp-config.test.ps1
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'scripts/lib/McpConfig.ps1') -ErrorAction Stop

$script:Pass = 0
$script:Fail = 0

function Assert-True ($cond, $msg) {
  if ($cond) { $script:Pass++; Write-Host "  ok   $msg" -ForegroundColor Green }
  else       { $script:Fail++; Write-Host "  FAIL $msg" -ForegroundColor Red }
}

function Assert-Equal ($actual, $expected, $msg) {
  if ($actual -eq $expected) { $script:Pass++; Write-Host "  ok   $msg" -ForegroundColor Green }
  else { $script:Fail++; Write-Host "  FAIL $msg (expected '$expected', got '$actual')" -ForegroundColor Red }
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("mcpcfg-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
  Write-Host 'Set-McpEntry' -ForegroundColor Cyan

  # 1. Creating a file from scratch.
  $f1 = Join-Path $tmp 'new.json'
  Set-McpEntry -Path $f1 -Name 'cursor-bridge' -Entry @{
    command = 'C:\Program Files\nodejs\node.exe'
    args    = @('C:\bridge\lib\index.mjs')
    env     = [ordered]@{ CURSOR_BIN = 'C:\bin\agent.exe' }
  }
  $d1 = Get-Content $f1 -Raw | ConvertFrom-Json
  Assert-True (Test-Path $f1) 'creates the file when it is missing'
  Assert-Equal $d1.mcpServers.'cursor-bridge'.command 'C:\Program Files\nodejs\node.exe' 'command is stored verbatim'
  Assert-Equal $d1.mcpServers.'cursor-bridge'.args.Count 1 'args survive as an array'

  # 2. Merging into a config that already has other servers.
  $f2 = Join-Path $tmp 'existing.json'
  Set-Content -Path $f2 -Encoding UTF8 -Value (@{
    mcpServers = @{
      'ima-mcp'    = @{ type = 'builtin'; status = 'connected' }
      'github-mcp' = @{ command = 'node'; args = @('gh.js') }
    }
  } | ConvertTo-Json -Depth 8)
  Set-McpEntry -Path $f2 -Name 'cursor-bridge' -Entry @{ command = 'node.exe'; args = @('x.mjs') }
  $d2 = Get-Content $f2 -Raw | ConvertFrom-Json
  Assert-Equal (Get-MemberNames $d2.mcpServers).Count 3 'existing entries are preserved'
  Assert-Equal $d2.mcpServers.'ima-mcp'.type 'builtin' 'unrelated builtin entry is untouched'
  Assert-Equal $d2.mcpServers.'github-mcp'.args[0] 'gh.js' 'unrelated args are untouched'
  Assert-True (Test-Path "$f2.bak") 'a backup is written before mutating'

  # 3. Idempotency: running install twice must not duplicate anything.
  Set-McpEntry -Path $f2 -Name 'cursor-bridge' -Entry @{ command = 'node.exe'; args = @('y.mjs') }
  $d3 = Get-Content $f2 -Raw | ConvertFrom-Json
  Assert-Equal (Get-MemberNames $d3.mcpServers).Count 3 're-install does not duplicate servers'
  Assert-Equal $d3.mcpServers.'cursor-bridge'.args[0] 'y.mjs' 're-install updates the entry'

  # 4. Invalid JSON must raise, and must not be overwritten.
  $f4 = Join-Path $tmp 'broken.json'
  Set-Content -Path $f4 -Encoding UTF8 -Value '{ this is not json'
  $threw = $false
  try { Set-McpEntry -Path $f4 -Name 'cursor-bridge' -Entry @{ command = 'x' } } catch { $threw = $true }
  Assert-True $threw 'invalid JSON raises an error'
  Assert-True (Test-Path "$f4.bak") 'invalid JSON still leaves a backup'
  Assert-Equal (Get-Content $f4 -Raw).TrimEnd() '{ this is not json' 'invalid JSON is left untouched'

  # 5. Empty file is treated as an empty document, not an error.
  $f5 = Join-Path $tmp 'empty.json'
  Set-Content -Path $f5 -Value ''
  Set-McpEntry -Path $f5 -Name 'cursor-bridge' -Entry @{ command = 'node.exe' }
  Assert-True ((Get-Content $f5 -Raw | ConvertFrom-Json).mcpServers.'cursor-bridge') 'empty file is handled'

  Write-Host 'Remove-McpEntry' -ForegroundColor Cyan

  # 6. Removal takes out only the target entry.
  $removed = Remove-McpEntry -Path $f2 -Name 'cursor-bridge'
  $d6 = Get-Content $f2 -Raw | ConvertFrom-Json
  Assert-True $removed 'removal reports success'
  Assert-Equal (Get-MemberNames $d6.mcpServers).Count 2 'only the target entry is removed'
  Assert-Equal $d6.mcpServers.'ima-mcp'.type 'builtin' 'other entries survive removal'

  # 7. Removing something absent is a no-op, not a crash.
  Assert-Equal (Remove-McpEntry -Path $f2 -Name 'cursor-bridge') $false 'removing an absent entry returns false'
  Assert-Equal (Remove-McpEntry -Path (Join-Path $tmp 'nope.json') -Name 'x') $false 'removing from a missing file returns false'

  # 8. No BOM: some MCP hosts fail to parse a leading byte-order mark.
  $bytes = [System.IO.File]::ReadAllBytes($f2)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  Assert-Equal $hasBom $false 'written JSON has no BOM'

  # 9. Backslashes in Windows paths survive the round trip.
  Assert-True ((Get-Content $f1 -Raw) -match 'Program Files') 'backslashes are escaped correctly'
}
finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "passed: $script:Pass  failed: $script:Fail" -ForegroundColor $(if ($script:Fail) { 'Red' } else { 'Green' })
if ($script:Fail -gt 0) { exit 1 }