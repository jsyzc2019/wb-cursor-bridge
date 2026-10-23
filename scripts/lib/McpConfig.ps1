<#
.SYNOPSIS
  Shared helpers for reading and writing MCP client configuration files.

.DESCRIPTION
  Both WorkBuddy/CodeBuddy (~/.codebuddy/.mcp.json) and Cursor
  (~/.cursor/mcp.json) use the same shape:

      { "mcpServers": { "<name>": { "command": ..., "args": [...], "env": {} } } }

  These helpers are deliberately conservative:
    - an existing file is backed up before any write
    - unrelated servers in the file are preserved untouched
    - invalid JSON is reported, never silently overwritten
    - the operation is idempotent, so re-running install.ps1 is safe

  Dot-source this file; it defines Set-McpEntry and Remove-McpEntry.
#>

function Get-MemberNames {
  <#
    .SYNOPSIS
      Enumerates property names safely.

    .DESCRIPTION
      Under Set-StrictMode -Version Latest, reading `.Name` directly on an
      empty PSMemberInfoCollection throws "The property 'Name' cannot be found".
      A freshly created config has zero properties, so every membership test in
      this file must go through here.
  #>
  [CmdletBinding()]
  param([Parameter(Mandatory)][AllowNull()][object] $InputObject)

  if ($null -eq $InputObject) { return @() }
  return @($InputObject.PSObject.Properties | ForEach-Object { $_.Name })
}

function Write-Utf8NoBom {
  <#
    .SYNOPSIS
      Writes text as UTF-8 without a byte-order mark.
    .DESCRIPTION
      Some MCP hosts fail to parse a leading BOM as JSON, so Set-Content's
      default encoding is not safe for configuration files.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][AllowEmptyString()][string] $Content
  )
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

function Read-McpDocument {
  <#
    .SYNOPSIS
      Loads an mcp.json, backing it up first. Returns $null for an empty file.
  #>
  [CmdletBinding()]
  param([Parameter(Mandatory)][string] $Path)

  if (-not (Test-Path $Path)) { return $null }
  Copy-Item $Path "$Path.bak" -Force
  $raw = Get-Content $Path -Raw
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  try {
    return ($raw | ConvertFrom-Json)
  } catch {
    throw "existing MCP config is not valid JSON: $Path (a .bak copy was saved)"
  }
}

function Set-McpEntry {
  <#
    .SYNOPSIS
      Adds or replaces one MCP server entry, preserving everything else.
    .PARAMETER Path
      Full path to the mcp.json file. Created if missing.
    .PARAMETER Name
      Server name, e.g. "cursor-bridge".
    .PARAMETER Entry
      Hashtable with command / args / env.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][string] $Name,
    [Parameter(Mandatory)][hashtable] $Entry
  )

  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }

  $doc = Read-McpDocument -Path $Path
  if ($null -eq $doc) { $doc = New-Object PSObject }

  # Ensure mcpServers exists and is an object we can add members to.
  $servers = $null
  if ((Get-MemberNames $doc) -contains 'mcpServers') { $servers = $doc.mcpServers }
  if ($null -eq $servers) {
    $servers = New-Object PSObject
    $doc | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue $servers -Force
  }

  $servers | Add-Member -NotePropertyName $Name -NotePropertyValue ([PSCustomObject]$Entry) -Force

  Write-Utf8NoBom -Path $Path -Content ($doc | ConvertTo-Json -Depth 12)
  return $Path
}

function Remove-McpEntry {
  <#
    .SYNOPSIS
      Removes one MCP server entry. Returns $true when something was removed.
  #>
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string] $Path,
    [Parameter(Mandatory)][string] $Name
  )

  if (-not (Test-Path $Path)) { return $false }

  try {
    $doc = Read-McpDocument -Path $Path
  } catch {
    Write-Warning $_.Exception.Message
    return $false
  }

  if ($null -eq $doc) { return $false }
  if ((Get-MemberNames $doc) -notcontains 'mcpServers') { return $false }
  $servers = $doc.mcpServers
  if ($null -eq $servers) { return $false }
  if ((Get-MemberNames $servers) -notcontains $Name) { return $false }

  $servers.PSObject.Properties.Remove($Name)
  Write-Utf8NoBom -Path $Path -Content ($doc | ConvertTo-Json -Depth 12)
  return $true
}