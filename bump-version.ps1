# bump-version.ps1 — set the app version across all three manifests.
# Called by release.bat. Reads/writes UTF-8 *without* BOM so the JSON stays
# parseable by the release workflow and non-ASCII text (em dashes) survives.
param([Parameter(Mandatory = $true)][string]$Version)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8 = New-Object System.Text.UTF8Encoding($false)   # $false = no BOM

function Set-Version($rel, $pattern, $replacement) {
  $p = Join-Path $root $rel
  $c = [System.IO.File]::ReadAllText($p)
  $new = [regex]::Replace($c, $pattern, $replacement, 1)
  if ($new -eq $c) { throw "version pattern not found / unchanged in $rel" }
  [System.IO.File]::WriteAllText($p, $new, $utf8)
}

# package.json + tauri.conf.json: first   "version": "x"
Set-Version 'package.json'              '("version":\s*")[^"]*(")' ('${1}' + $Version + '${2}')
Set-Version 'src-tauri/tauri.conf.json' '("version":\s*")[^"]*(")' ('${1}' + $Version + '${2}')
# Cargo.toml: the [package] version line, anchored to line start
Set-Version 'src-tauri/Cargo.toml'      '(?m)^version = "[^"]*"'   ('version = "' + $Version + '"')

Write-Host "  Updated package.json, tauri.conf.json, Cargo.toml"
