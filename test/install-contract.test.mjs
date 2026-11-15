/**
 * One-click installer contract (0.6.2).
 *
 * The release runs on Windows and this repo's CI executes the PowerShell entry
 * points on a Windows runner. We lock the installer's *contract* with static
 * assertions here, so a future edit cannot silently reintroduce the
 * interactive prompt, drop the default workspace, or forget to ship
 * install.cmd.
 *
 * In addition, the release was validated with PowerShell 7.2.23 (installed via
 * `dotnet tool`): Parser::ParseFile on all three scripts, plus an execution of
 * the real workspace-resolution block for the zero-arg / idempotent / bad-path
 * cases. This file is the permanent, platform-independent lock; the full
 * double-click install chain (MCP config, Node download, self-check) still
 * needs a real Windows machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const installPs1 = fs.readFileSync(path.join(ROOT, 'scripts', 'install.ps1'), 'utf8');
const buildRelease = fs.readFileSync(path.join(ROOT, 'scripts', 'build-release.mjs'), 'utf8');

test('installer never prompts interactively (zero-parameter, unattended)', () => {
  assert.equal(
    /Read-Host/.test(installPs1),
    false,
    'install.ps1 must not call Read-Host: a default install must be unattended',
  );
  assert.equal(
    /No workspace roots supplied/.test(installPs1),
    false,
    'the old interactive branch must be gone',
  );
});

test('-WorkspaceRoots stays an OPTIONAL parameter (only knob a user needs)', () => {
  assert.match(installPs1, /\[string\[\]\]\s*\$WorkspaceRoots/);
  // No [Parameter(Mandatory=...)] on it, and it has no positional binding.
  assert.equal(/Mandatory\s*=\s*\$true/.test(installPs1), false);
  assert.match(installPs1, /\.PARAMETER WorkspaceRoots[\s\S]*?OPTIONAL/);
});

test('omitting roots auto-creates a single dedicated, isolated default workspace', () => {
  // Default is a dedicated folder, NOT the whole user profile / drive root.
  assert.match(installPs1, /wb-cursor-bridge-workspace/);
  assert.match(installPs1, /Join-Path \$env:USERPROFILE 'wb-cursor-bridge-workspace'/);
  // It is created when missing, so Test-Path validation cannot fail on a fresh install.
  assert.match(installPs1, /New-Item -ItemType Directory -Path \$DefaultWorkspace -Force/);
  // The default branch is the "no roots supplied" branch.
  assert.match(installPs1, /if \(-not \$WorkspaceRoots -or \$WorkspaceRoots\.Count -eq 0\)/);
  assert.match(installPs1, /\$usedDefaultWorkspace = \$true/);
});

test('explicit but non-existent root fails with an actionable error', () => {
  // Keeps the fail-closed allowlist: we never silently widen or create arbitrary
  // user-specified paths, but the error now tells the operator what to do.
  assert.match(installPs1, /Workspace root does not exist:/);
  assert.match(installPs1, /Create that directory first/);
  assert.match(installPs1, /without -WorkspaceRoots to use the default isolated workspace/);
});

test('Next steps print a real path (no broken $WorkspaceRoots[0] interpolation)', () => {
  assert.match(installPs1, /\$firstRoot = \$WorkspaceRoots\[0\]/);
  assert.equal(/\$WorkspaceRoots\[0\]'/.test(installPs1), false);
  assert.match(installPs1, /To target your own repos instead, re-run:/);
});

test('install.cmd is generated into the staged payload (enters SHA256SUMS + zip)', () => {
  assert.match(buildRelease, /writeFileSync\(path\.join\(STAGE, 'install\.cmd'\), INSTALL_CMD/);
  // It must invoke install.ps1 with an execution-policy bypass and forward args.
  const installCmd = buildRelease.slice(
    buildRelease.indexOf('const INSTALL_CMD'),
    buildRelease.indexOf('`;', buildRelease.indexOf('const INSTALL_CMD')) + 2,
  );
  assert.match(installCmd, /powershell\.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\.ps1" %\*/);
  assert.match(installCmd, /if not "%~1"=="" exit \/b %RC%/);
  assert.match(installCmd, /`@echo off/);
});

test('release build report tells a double-click user what to run', () => {
  assert.match(buildRelease, /double-click install\.cmd/);
});
