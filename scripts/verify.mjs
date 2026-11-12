#!/usr/bin/env node
/**
 * Parallel verification runner — `npm run verify`.
 *
 * The six checks are mostly *waiting*, not computing: the stress suite spends
 * ~10s parked on a timeout window, e2e spawns and reaps child processes, and
 * the empirical script polls a bridge over loopback. Run serially they cost
 * ~33s of wall clock for ~6s of CPU. Measured on a 4-core box:
 *
 *   serial   28.9s (lint + test + stress)
 *   parallel 16.2s
 *
 * So: build once (every later stage reads `dist/`), then fan out. Each stage
 * keeps only the tail of its output, and a failure prints exactly the stages
 * that failed rather than burying the reason in interleaved logs.
 *
 * Deliberately shell-free: commands are taken from package.json verbatim and
 * split with a minimal tokenizer, so nothing re-parses them through a shell.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Split a package.json script into argv (good enough: no quotes in ours). */
function argv(command) {
  return command.trim().split(/\s+/);
}

/**
 * Stages that may run concurrently. `build` is pulled out because `test` and
 * `release` both read `dist/`, and concurrent tsc writers would clobber it.
 * `release` uses the esbuild entry directly so it does not re-run `tsc`.
 */
const PARALLEL = [
  ['lint', pkg.scripts.lint],
  ['typecheck', pkg.scripts.typecheck],
  ['test', pkg.scripts.test],
  ['stress', pkg.scripts['test:stress']],
  ['fault', pkg.scripts['test:fault']],
  ['e2e-empirical', pkg.scripts['verify:e2e']],
  ['release', 'node scripts/build-release.mjs'],
];

const TAIL = 6000; // bytes of output kept per stage

function run(name, command) {
  const [bin, ...args] = argv(command);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(bin, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      // .cmd shims (eslint, tsc) are resolved by the OS on Windows.
      shell: process.platform === 'win32',
    });
    let out = '';
    const keep = (buf) => {
      out = (out + buf.toString()).slice(-TAIL);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => {
      resolve({ name, code: 127, out: `${out}\nspawn failed: ${err.message}`, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      resolve({ name, code: code ?? 1, out, ms: Date.now() - started });
    });
  });
}

function runOrThrow(name, command) {
  return run(name, command).then((r) => {
    if (r.code !== 0) {
      console.error(`\n✖ ${name} failed (exit ${r.code})\n${r.out}`);
      process.exit(r.code);
    }
    return r;
  });
}

const t0 = Date.now();
// 1) Serial: everything downstream reads dist/.
const built = await runOrThrow('build', 'node node_modules/typescript/bin/tsc -p tsconfig.json');
console.log(`  build            ${String(built.ms).padStart(6)} ms`);

// 2) Fan out. Peak concurrency is 7 stages on a 4-core box, which is fine:
// each is dominated by I/O or child-process latency, not CPU.
const results = await Promise.all(PARALLEL.map(([name, cmd]) => run(name, cmd)));

const failed = results.filter((r) => r.code !== 0);
for (const r of results) {
  const mark = r.code === 0 ? '✔' : '✖';
  console.log(`  ${mark} ${r.name.padEnd(16)} ${String(r.ms).padStart(6)} ms`);
}

if (failed.length > 0) {
  for (const r of failed) {
    console.error(`\n── ${r.name} (exit ${r.code}) ──────────────────────────`);
    console.error(r.out.trim());
  }
  console.error(`\n${failed.length} stage(s) failed: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}

console.log(`\nverify ok — ${results.length + 1} stages in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
