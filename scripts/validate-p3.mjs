#!/usr/bin/env node
/**
 * P3 validation orchestrator.
 *
 * Runs the release build, stress tests, and fault-injection tests, then prints
 * an empirical report. Intended for release sign-off, not for every edit.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args = [], env = {}) {
  const t0 = Date.now();
  execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  return Date.now() - t0;
}

function getReleaseZip() {
  const dir = path.join(ROOT, 'release');
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('-win-x64.zip'));
  if (entries.length === 0) throw new Error('no release zip found');
  return path.join(dir, entries[0]);
}

console.log('==> P3 validation: build release');
const buildMs = run(process.execPath, ['scripts/build-release.mjs']);

const zip = getReleaseZip();
const zipSize = fs.statSync(zip).size;

console.log('\n==> P3 validation: stress tests');
const stressMs = run(process.execPath, ['--test', 'test/stress.test.mjs']);

console.log('\n==> P3 validation: fault-injection tests');
const faultMs = run(process.execPath, ['--test', 'test/fault.test.mjs']);

console.log('\n==> P3 validation: bundle smoke (manual)');
const smokeMs = run(process.execPath, [path.join(ROOT, 'dist', 'index.js')], {
  CURSOR_BRIDGE_SELFCHECK: '1',
  CURSOR_BIN: path.join(ROOT, 'test', 'fake-agent.sh'),
  CURSOR_BRIDGE_WORKSPACE_ROOTS: '/tmp',
  CURSOR_BRIDGE_STATE_DIR: path.join(ROOT, '.codebuddy', 'smoke-state'),
  CURSOR_BRIDGE_LOG_LEVEL: 'error',
});

console.log('\n==> P3 validation: end-to-end real-run empirical (real dist binary + fake-agent)');
const e2eMs = run(process.execPath, ['scripts/e2e-empirical.mjs']);

console.log('\n========================================');
console.log('P3 empirical validation complete');
console.log(`release zip : ${zip} (${(zipSize / 1024).toFixed(1)} KB)`);
console.log(`build       : ${buildMs} ms`);
console.log(`stress      : ${stressMs} ms`);
console.log(`fault       : ${faultMs} ms`);
console.log(`smoke       : ${smokeMs} ms`);
console.log(`e2e-real    : ${e2eMs} ms`);
console.log('========================================');
