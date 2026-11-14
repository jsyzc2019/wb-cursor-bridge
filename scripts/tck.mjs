#!/usr/bin/env node
/**
 * Official A2A TCK runner for wb-cursor-bridge.
 *
 * Boots the *real* built bridge (dist/index.js) with the fake Cursor worker,
 * puts the test-only Gherkin SUT adapter (tck-sut.mjs) in front of it, and runs
 * the pinned official a2a-tck MUST subset over JSON-RPC. Reports are collected
 * into reports/tck/ and the process fails when the JUnit report contains any
 * failure or error.
 *
 * Environment:
 *   A2A_TCK_DIR      path to the pinned a2a-tck checkout (default /tmp/a2a-tck)
 *   TCK_REPORT_DIR   where to copy reports (default <repo>/reports/tck)
 *   TCK_LEVEL        pytest marker level (default must)
 *   TCK_TRANSPORT    transport filter (default jsonrpc)
 *
 * The TCK is deliberately pinned: its main branch moved to Python >= 3.15,
 * which this project's CI (Python 3.11) cannot install. See the plan document
 * for the pin rationale.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startTckSut, TCK_SCENARIO_PREFIXES } from './tck-sut.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TCK = process.env.A2A_TCK_DIR || '/tmp/a2a-tck';
const TCK_PY = path.join(TCK, '.venv/bin/python');
const PINNED_COMMIT = '70f6f73c30208e80c889141907e094899e6e9f05';
const OUT = process.env.TCK_REPORT_DIR || path.join(ROOT, 'reports', 'tck');
const DIST = path.join(ROOT, 'dist', 'index.js');
const FAKE = path.join(ROOT, 'test', 'fake-agent.sh');
const LEVEL = process.env.TCK_LEVEL || 'must';
const TRANSPORT = process.env.TCK_TRANSPORT || 'jsonrpc';

for (const [p, label] of [
  [DIST, 'dist/index.js — run `npm run build` first'],
  [FAKE, 'test/fake-agent.sh'],
  [TCK_PY, `TCK venv python (${TCK})`],
  [path.join(TCK, 'run_tck.py'), 'TCK run_tck.py'],
]) {
  if (!fs.existsSync(p)) {
    console.error(`[tck] missing ${label}: ${p}`);
    process.exit(2);
  }
}

try {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: TCK, encoding: 'utf8' }).trim();
  if (head === PINNED_COMMIT) {
    console.log(`[tck] TCK pinned at ${PINNED_COMMIT.slice(0, 12)}`);
  } else {
    console.warn(`[tck] WARNING: TCK HEAD ${head.slice(0, 12)} != pinned ${PINNED_COMMIT.slice(0, 12)}`);
  }
} catch {
  console.warn('[tck] WARNING: cannot verify TCK commit (not a git checkout?)');
}

fs.mkdirSync(OUT, { recursive: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tck-repo-'));
execFileSync('git', ['init', '-q'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=ci@wb', '-c', 'user.name=ci', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# tck sut workspace\n');
execFileSync('git', ['-c', 'user.email=ci@wb', '-c', 'user.name=ci', 'add', '-A'], { cwd: repo });
execFileSync('git', ['-c', 'user.email=ci@wb', '-c', 'user.name=ci', 'commit', '-q', '-m', 'baseline'], { cwd: repo });

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tck-state-'));
const bridgePort = await freePort();
const shimPort = await freePort();
const cfg = {
  cursorBin: FAKE,
  workspaceRoots: [repo],
  stateDir,
  a2aPort: bridgePort,
  a2aHost: '127.0.0.1',
  // The card must advertise the SUT adapter so TCK traffic flows through it.
  a2aPublicUrl: `http://127.0.0.1:${shimPort}/a2a`,
  logLevel: 'info',
  defaultTimeoutSec: 60,
  maxConcurrency: 8,
};
const cfgPath = path.join(stateDir, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));

const bridge = spawn(process.execPath, [DIST], {
  cwd: ROOT,
  env: {
    ...process.env,
    WB_CURSOR_BRIDGE_CONFIG: cfgPath,
    CURSOR_BIN: FAKE,
    WB_FAKE_MODE: 'ok',
    CURSOR_BRIDGE_LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let bridgeErr = '';
bridge.stderr.on('data', (d) => { bridgeErr += d.toString(); });
bridge.stdout.on('data', () => {});

let shim;
try {
  shim = await startTckSut({ bridgePort, shimPort });
} catch (err) {
  console.error('[tck] SUT adapter failed to start:', String(err));
  try { process.kill(-bridge.pid, 'SIGKILL'); } catch { /* ignore */ }
  process.exit(2);
}

const base = `http://127.0.0.1:${shimPort}`;
let ready = false;
for (let i = 0; i < 100; i += 1) {
  try {
    const r = await fetch(`${base}/.well-known/agent-card.json`);
    if (r.status === 200) { ready = true; break; }
  } catch { /* not listening yet */ }
  await new Promise((r) => setTimeout(r, 100));
}
if (!ready) {
  console.error(`[tck] SUT not ready: ${bridgeErr.slice(-1000)}`);
  shim.close();
  try { process.kill(-bridge.pid, 'SIGKILL'); } catch { /* ignore */ }
  process.exit(2);
}

const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
fs.writeFileSync(path.join(OUT, 'agent-card.json'), JSON.stringify(card, null, 2));
console.log(`[tck] SUT ready ${base} (bridge 127.0.0.1:${bridgePort})`);
console.log(`[tck] card interface: ${JSON.stringify(card.supportedInterfaces?.[0] ?? null)}`);
console.log(`[tck] SUT scenario prefixes (test-only adapter): ${TCK_SCENARIO_PREFIXES.join(', ')}`);

const tck = spawn(TCK_PY, [
  'run_tck.py',
  `--sut-host=${base}`,
  `--transport=${TRANSPORT}`,
  `--level=${LEVEL}`,
], { cwd: TCK, stdio: ['ignore', 'pipe', 'pipe'] });
let tckOut = '';
tck.stdout.on('data', (d) => { tckOut += d.toString(); process.stdout.write(d); });
tck.stderr.on('data', (d) => { tckOut += d.toString(); process.stderr.write(d); });
const tckCode = await new Promise((resolve) => tck.on('close', resolve));
fs.writeFileSync(path.join(OUT, 'tck-output.txt'), tckOut);
console.log(`\n[tck] run_tck.py exit code: ${tckCode}`);

const reportsDir = path.join(TCK, 'reports');
for (const f of ['junitreport.xml', 'compatibility.json', 'compatibility.html', 'tck_report.html']) {
  const src = path.join(reportsDir, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, f));
}

let failed = true;
try {
  const xml = fs.readFileSync(path.join(OUT, 'junitreport.xml'), 'utf8');
  const tag = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
  const num = (name) => Number(tag.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1] ?? 0);
  const s = {
    tests: num('tests'), failures: num('failures'),
    errors: num('errors'), skipped: num('skipped'),
  };
  console.log(
    `[tck] junit: tests=${s.tests} passed=${s.tests - s.failures - s.errors - s.skipped} ` +
    `failures=${s.failures} errors=${s.errors} skipped=${s.skipped}`,
  );
  failed = s.failures > 0 || s.errors > 0;
} catch (err) {
  console.error('[tck] cannot parse junitreport.xml:', String(err));
}
try {
  const compat = JSON.parse(fs.readFileSync(path.join(OUT, 'compatibility.json'), 'utf8'));
  const sum = compat.summary ?? {};
  console.log(
    `[tck] compatibility: overall=${sum.overall_compatibility} must=${sum.must_compatibility} ` +
    `should=${sum.should_compatibility} may=${sum.may_compatibility}`,
  );
  const manual = sum.manual_verification_required ?? [];
  console.log(`[tck] MANUAL (NOT counted as pass): ${manual.length} — ${manual.join(', ')}`);
} catch { /* compatibility report is optional */ }

shim.close();
try { process.kill(-bridge.pid, 'SIGKILL'); } catch { /* ignore */ }
console.log(`[tck] reports: ${OUT}`);
console.log(failed ? '[tck] FAIL' : '[tck] PASS');
process.exit(failed ? 1 : 0);
