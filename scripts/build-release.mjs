/**
 * Release builder.
 *
 * Produces a self-contained win-x64 payload:
 *   - lib/index.mjs  : the entire server bundled into one file by esbuild,
 *                      so the target machine needs no node_modules
 *   - launcher.cmd   : starts the bundle with the bundled or system Node
 *   - install.ps1    : one-command install + MCP registration on both clients
 *   - wb-cursor-bridge-win-x64.zip
 *
 * A minimal ZIP writer is implemented here on purpose: pulling in an archiving
 * dependency would make the build itself depend on the network.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'release');
/**
 * Resolved in main() once the version is known, so every artefact - the staged
 * directory, the entries inside the archive and the archive name itself - is
 * stamped with the version.
 */
let STAGE = path.join(OUT, 'wb-cursor-bridge-win-x64');

/* ------------------------------------------------------------- zip writer */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Write a zip archive. entries: [{ name, data }] with forward-slash names. */
function writeZip(entries, zipFile) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Fall back to stored when compression does not help.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0x21, 12);       // mod date (1996-01-01, fixed)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 38);             // external file attributes
    cd.writeUInt32LE(offset, 42);        // relative offset of local header
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  fs.writeFileSync(zipFile, Buffer.concat([...locals, centralBuf, end]));
}

/* ------------------------------------------------------------------ build */

function copyIntoStage(srcRel, destRel) {
  const src = path.join(ROOT, srcRel);
  if (!fs.existsSync(src)) return false;
  const dest = path.join(STAGE, destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

/** Copy a whole directory into the stage, skipping build output. */
function copyDirIntoStage(srcRel, destRel) {
  const src = path.join(ROOT, srcRel);
  if (!fs.existsSync(src)) return false;
  fs.cpSync(src, path.join(STAGE, destRel), { recursive: true });
  return true;
}

const LAUNCHER = `@echo off
setlocal enabledelayedexpansion
rem wb-cursor-bridge launcher (win-x64)
set "HERE=%~dp0"

rem Prefer a Node runtime shipped next to this launcher.
if exist "%HERE%runtime\\node.exe" (
  "%HERE%runtime\\node.exe" "%HERE%lib\\index.mjs" %*
  exit /b %ERRORLEVEL%
)

rem Fall back to Node on PATH.
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  node "%HERE%lib\\index.mjs" %*
  exit /b %ERRORLEVEL%
)

echo [wb-cursor-bridge] Node.js 20+ was not found.
echo Run install.ps1 first, or install Node.js from https://nodejs.org
exit /b 9009
`;

const VERIFY = `@echo off
setlocal
set "HERE=%~dp0"
set "CURSOR_BIN=%CURSOR_BIN%"
if "%CURSOR_BIN%"=="" set "CURSOR_BIN=agent.exe"
set "CURSOR_BRIDGE_SELFCHECK=1"
if exist "%HERE%runtime\\node.exe" (
  "%HERE%runtime\\node.exe" "%HERE%lib\\index.mjs"
) else (
  node "%HERE%lib\\index.mjs"
)
exit /b %ERRORLEVEL%
`;

async function main() {
  const version = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
  ).version;
  const stageName = `wb-cursor-bridge-v${version}-win-x64`;
  STAGE = path.join(OUT, stageName);

  // Drop every previously staged payload, versioned or not, so the release
  // directory never holds two builds that look interchangeable.
  if (fs.existsSync(OUT)) {
    for (const entry of fs.readdirSync(OUT, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        entry.name.startsWith('wb-cursor-bridge-') &&
        entry.name.endsWith('-win-x64')
      ) {
        fs.rmSync(path.join(OUT, entry.name), { recursive: true, force: true });
      }
    }
  }

  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(path.join(STAGE, 'lib'), { recursive: true });

  // 1. Bundle everything, including the MCP SDK, into one ESM file.
  const result = await build({
    entryPoints: [path.join(ROOT, 'src', 'index.ts')],
    outfile: path.join(STAGE, 'lib', 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    banner: {
      js: `// wb-cursor-bridge v${version} - bundled win-x64 build (node18+).`,
    },
    metafile: true,
    logLevel: 'warning',
  });
  const bundleBytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;

  // 2. Scripts and docs.
  fs.writeFileSync(path.join(STAGE, 'launcher.cmd'), LAUNCHER, 'utf8');
  fs.writeFileSync(path.join(STAGE, 'verify.cmd'), VERIFY, 'utf8');
  copyIntoStage('scripts/install.ps1', 'install.ps1');
  copyIntoStage('scripts/uninstall.ps1', 'uninstall.ps1');
  // install.ps1 and uninstall.ps1 dot-source this, so it must ship with them.
  copyDirIntoStage('scripts/lib', 'lib');
  copyIntoStage('README.md', 'README.md');
  copyIntoStage('CHANGELOG.md', 'CHANGELOG.md');
  copyIntoStage('LICENSE', 'LICENSE');
  fs.writeFileSync(
    path.join(STAGE, 'VERSION'),
    `${version}\n${new Date().toISOString()}\n`,
    'utf8',
  );

  // 3. Archive. The runtime directory is intentionally not included: the
  //    installer downloads it on demand so the payload stays small.
  const entries = [];
  const walk = (dir, prefix) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, item.name);
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) walk(abs, rel);
      else entries.push({ name: `${stageName}/${rel}`, data: fs.readFileSync(abs) });
    }
  };
  walk(STAGE, '');

  // Remove archives from other versions so the release directory holds exactly
  // the build that was just produced.
  fs.mkdirSync(OUT, { recursive: true });
  for (const item of fs.readdirSync(OUT)) {
    if (
      item.startsWith('wb-cursor-bridge-') &&
      item.endsWith('-win-x64.zip')
    ) {
      fs.rmSync(path.join(OUT, item), { force: true });
    }
  }

  const zipFile = path.join(OUT, `${stageName}.zip`);
  writeZip(entries, zipFile);

  // ------------------------------------------------------------- smoke test
  // Verify the bundled artifact can boot, load config, and pass its own
  // self-check. This catches bundling regressions (missing files, ESM issues)
  // before the archive is ever published.
  const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-smoke-'));
  const smokeState = path.join(smokeDir, 'state');
  const fakeBin = path.join(
    smokeDir,
    process.platform === 'win32' ? 'agent.cmd' : 'agent.sh',
  );
  fs.writeFileSync(
    fakeBin,
    process.platform === 'win32' ? '@echo off\nexit /b 0\n' : '#!/bin/sh\nexit 0\n',
    'utf8',
  );
  if (process.platform !== 'win32') {
    fs.chmodSync(fakeBin, 0o755);
  }

  const smoke = spawnSync(process.execPath, [path.join(STAGE, 'lib', 'index.mjs')], {
    env: {
      ...process.env,
      CURSOR_BIN: fakeBin,
      CURSOR_BRIDGE_WORKSPACE_ROOTS: smokeDir,
      CURSOR_BRIDGE_STATE_DIR: smokeState,
      CURSOR_BRIDGE_SELFCHECK: '1',
      CURSOR_BRIDGE_LOG_LEVEL: 'error',
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  fs.rmSync(smokeDir, { recursive: true, force: true });
  if (smoke.status !== 0) {
    throw new Error(
      `bundle self-check failed (code ${smoke.status}):\n${smoke.stdout}\n${smoke.stderr}`,
    );
  }

  const zipSize = fs.statSync(zipFile).size;
  const report = [
    `wb-cursor-bridge ${version}`,
    `  bundle      : ${(bundleBytes / 1024).toFixed(0)} KB (single file, zero runtime deps)`,
    `  payload     : ${entries.length} files`,
    `  archive     : ${zipFile} (${(zipSize / 1024).toFixed(0)} KB)`,
    '',
    'Next: extract the zip on the target Windows machine and run install.ps1.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'BUILD-REPORT.txt'), report, 'utf8');
  process.stdout.write(report);
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n');
  process.exit(1);
});