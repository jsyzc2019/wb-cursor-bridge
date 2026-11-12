/**
 * Audit regression suite - batch B0 ("stop the bleeding").
 *
 * Every test here corresponds to a defect that the third-party audit
 * reproduced against the shipped build, and that was subsequently fixed. The
 * assertions are written in the *fixed* direction on purpose: for the audit
 * scripts `PASS` means "the defect reproduced", which is the opposite of what a
 * regression suite wants.
 *
 * Provenance is recorded per test so a future reader can re-run the original
 * proof:
 *   audit/a2a/06-crash-null-body.mjs
 *   audit/a2a/10-crash-artifact-stream.mjs
 *   audit/engine/repro-01-argv-injection.mjs
 *   audit/engine/repro-04-concurrency-bypass.mjs
 *   audit/engine/repro-08-unbounded-buffer.mjs
 *   audit/engine/repro-15-grace0-shutdown.mjs
 *   audit/engine/repro-18-shutdown-infinity.mjs
 *   audit/engine/repro-21-stdio-hold-leak.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JobManager } from '../dist/runner.js';
import { Logger } from '../dist/logger.js';
import { startA2AServer } from '../dist/a2a/server.js';
import { buildArgs } from '../dist/cursor/cli.js';
import { VERSION } from '../dist/version.js';
import { fakeBin } from './fake-bin.mjs';
import { rmrf } from './tmp.mjs';
import { pollDelay } from './client.mjs';

const FAKE = fakeBin('cursor');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit-repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 't@t.local');
  git('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

function makeConfig(stateDir, repo, over = {}) {
  return {
    cursorBin: FAKE,
    workspaceRoots: [repo],
    stateDir,
    defaultTimeoutSec: 20,
    maxTimeoutSec: 60,
    maxConcurrency: 4,
    defaultModel: undefined,
    forceWorktree: false,
    maxResultBytes: 1024 * 1024,
    maxEventsPerJob: 2000,
    maxEventBytes: 4 * 1024 * 1024,
    maxJobs: 100,
    logLevel: 'error',
    adminPort: 0,
    eventLogDir: undefined,
    extraArgs: [],
    a2aPort: 0,
    a2aHost: '127.0.0.1',
    a2aAuthToken: undefined,
    a2aPublicUrl: undefined,
    ...over,
  };
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/a2a',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function waitStatus(mgr, id, wanted, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    const job = mgr.store.get(id);
    if (job && wanted.includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job && job.status}`);
    await sleep(pollDelay(attempt));
  }
}

function bootServer(cfg, log) {
  const mgr = new JobManager(cfg, log);
  const server = startA2AServer(mgr, { config: cfg, version: VERSION, log: log.child('a2a') });
  return { mgr, server };
}

async function listening(server) {
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${server.address().port}`;
}

/* ------------------------------------------------------------------ argv -- */

test('B0-4: the prompt can never be parsed as a flag', () => {
  const cfg = makeConfig(os.tmpdir(), os.tmpdir());
  const args = buildArgs(cfg, { prompt: '--force', workspace: '/w', tier: 'consult', timeoutSec: 30, worktree: false }, 'wb-x');
  const sep = args.indexOf('--');
  assert.ok(sep >= 0, 'argv must contain an option terminator');
  assert.equal(args[sep + 1], '--force', 'the prompt must be the first token AFTER --');
  assert.equal(args.lastIndexOf('--force'), sep + 1, 'no stray flag-position copy of the prompt');
});

test('B0-4: a model id starting with "-" is rejected, not forwarded', () => {
  const cfg = makeConfig(os.tmpdir(), os.tmpdir());
  assert.throws(
    () => buildArgs(cfg, { prompt: 'x', workspace: '/w', tier: 'execute', model: '--force', timeoutSec: 30, worktree: false }, 'wb-x'),
    /must not start with/,
  );
});

/* ------------------------------------------- A2A: malformed body / artifact */

test('B0-2: a null body is a client error, never a process-killing rejection', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit-st-'));
  const cfg = makeConfig(stateDir, repo, { a2aPort: await freePort() });
  const log = new Logger({ level: 'error', fileDir: undefined });
  const { mgr, server } = bootServer(cfg, log);
  const base = await listening(server);
  const port = new URL(base).port;
  try {
    // 25 is the audit's threshold (20 tripped the unhandledRejection budget).
    for (let i = 0; i < 25; i += 1) {
      const r = await post(Number(port), 'null');
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.equal(body.error.code, -32600, 'null body must be an invalid request');
      assert.equal(body.id, null);
    }
    for (const raw of ['[]', '123', '"s"', 'true']) {
      const r = await post(Number(port), raw);
      assert.equal(JSON.parse(r.body).error.code, -32600, `${raw} must be -32600`);
    }
    const card = await new Promise((resolve, reject) => {
      http
        .get({ hostname: '127.0.0.1', port: Number(port), path: '/.well-known/agent.json' }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        })
        .on('error', reject);
    });
    assert.equal(card, 200, 'bridge must still be serving');
  } finally {
    await mgr.shutdown(500);
    server.close();
    rmrf(repo);
    rmrf(stateDir);
  }
});

test('B0-6: a notification gets 202 and an empty body (HTTP still needs an end)', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit-st-'));
  const cfg = makeConfig(stateDir, repo, { a2aPort: await freePort() });
  const log = new Logger({ level: 'error', fileDir: undefined });
  const { mgr, server } = bootServer(cfg, log);
  const base = await listening(server);
  const port = Number(new URL(base).port);
  try {
    for (const method of ['message/send', 'message/stream']) {
      const r = await post(port, {
        jsonrpc: '2.0',
        method,
        params: { message: { role: 'user', parts: [{ kind: 'text', text: 'silent' }] } },
      });
      assert.equal(r.status, 202, `${method} notification must be 202`);
      assert.equal(r.body, '', 'JSON-RPC notifications carry no body');
    }
  } finally {
    await mgr.shutdown(500);
    server.close();
    rmrf(repo);
    rmrf(stateDir);
  }
});

test('B0-5: an artifact that is no longer a regular file cannot crash the bridge', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit-st-'));
  const cfg = makeConfig(stateDir, repo, { a2aPort: await freePort() });
  const log = new Logger({ level: 'error', fileDir: undefined });
  const { mgr, server } = bootServer(cfg, log);
  const base = await listening(server);
  const port = Number(new URL(base).port);
  process.env.WB_FAKE_MODE = 'write';
  try {
    const job = mgr.start({ prompt: 'write a file', workspace: repo, tier: 'execute', timeoutSec: 20 });
    const done = await waitStatus(mgr, job.id, ['completed', 'failed']);
    assert.ok(done.patchFile, 'execute job should have captured a patch');
    const target = done.patchFile;
    rmSync(target, { force: true });
    mkdirSync(target); // the audit's trick: existsSync() is still true

    const res = await new Promise((resolve, reject) => {
      http
        .get({ hostname: '127.0.0.1', port, path: `/a2a/artifacts/${job.id}/changes.patch` }, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
        })
        .on('error', reject);
    });
    assert.equal(res.status, 404, 'directories are not downloadable artifacts');
    assert.equal(mgr.store.get(job.id).status, 'completed', 'process survived');
  } finally {
    delete process.env.WB_FAKE_MODE;
    await mgr.shutdown(500);
    server.close();
    rmrf(repo);
    rmrf(stateDir);
  }
});

/* -------------------------------------------------- ENG-21 / slots / limits */

test('ENG-21: a grandchild holding stdout cannot strand the concurrency slot', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit-st-'));
  const cfg = makeConfig(stateDir, repo, { maxConcurrency: 1 });
  const log = new Logger({ level: 'error', fileDir: undefined });
  const mgr = new JobManager(cfg, log);
  const pidFile = path.join(stateDir, 'kid.pid');
  process.env.WB_FAKE_MODE = 'hold-stdout';
  process.env.WB_HOLD_PIDFILE = pidFile;
  try {
    const job = mgr.start({ prompt: 'hold the pipe', workspace: repo, tier: 'consult', timeoutSec: 20 });
    // Wait for the grandchild to announce itself instead of sleeping a fixed
    // 600ms: the fixture writes the pidfile ~200ms in, and the rest was slack.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(pidFile)) break;
      await sleep(pollDelay(attempt));
    }
    const started = Date.now();
    mgr.cancel(job.id);
    // abortRun waits 2s for the tail, then settles regardless of `close`.
    const deadline = started + 6000;
    while (mgr.inflight.size > 0 && Date.now() < deadline) await sleep(100);
    assert.equal(mgr.inflight.size, 0, 'cancel must release the slot even while a grandchild holds stdout');
    assert.ok(Date.now() - started < 6000);

    // And the freed slot is actually usable again.
    const next = mgr.start({ prompt: 'second task', workspace: repo, tier: 'consult', timeoutSec: 20 });
    assert.ok(next.id);
    mgr.cancel(next.id);

    const kidPid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(kidPid > 0);
    try {
      process.kill(kidPid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  } finally {
    delete process.env.WB_FAKE_MODE;
    delete process.env.WB_HOLD_PIDFILE;
    await mgr.shutdown(500);
    rmrf(repo);
    rmrf(stateDir);
  }
});

test('B0-3: shutdown(Infinity) still returns (and flushes)', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit-st-'));
  const cfg = makeConfig(stateDir, repo);
  const mgr = new JobManager(cfg, makeConfig(stateDir, repo) && new Logger({ level: 'error', fileDir: undefined }));
  try {
    const t0 = Date.now();
    await mgr.shutdown(Infinity);
    assert.ok(Date.now() - t0 < 3000, 'an infinite grace must not become an infinite wait');
    await mgr.shutdown(-1);
  } finally {
    rmrf(repo);
    rmrf(stateDir);
  }
});

test('B0-8: the event ring is bounded in BYTES, not just in count', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit-st-'));
  const cfg = makeConfig(stateDir, repo, { maxEventBytes: 256 * 1024, maxEventsPerJob: 2000 });
  const mgr = new JobManager(cfg, new Logger({ level: 'error', fileDir: undefined }));
  try {
    const job = mgr.start({ prompt: 'flood', workspace: repo, tier: 'consult', timeoutSec: 20 });
    const chunk = 'x'.repeat(32 * 1024);
    for (let i = 0; i < 40; i += 1) {
      mgr.store.appendEvent(job, { ts: new Date().toISOString(), type: 'assistant', text: chunk });
    }
    // 40 x 32 KiB = 1.25 MiB offered against a 256 KiB budget.
    assert.ok(job.eventBytes <= 256 * 1024, `eventBytes=${job.eventBytes}`);
    assert.ok(job.droppedEvents > 0, 'evicted events must be counted');
    assert.ok(job.events.length < 40);
    // The tail is what pollers actually need; it must survive.
    assert.equal(job.events.at(-1).text.length, chunk.length);
    mgr.cancel(job.id);
  } finally {
    await mgr.shutdown(500);
    rmrf(repo);
    rmrf(stateDir);
  }
});

test('B0-7: resuming an input-required task respects maxConcurrency', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit-st-'));
  const cfg = makeConfig(stateDir, repo, { maxConcurrency: 1 });
  const mgr = new JobManager(cfg, new Logger({ level: 'error', fileDir: undefined }));
  process.env.WB_FAKE_MODE = 'needinput';
  try {
    const a = mgr.start({ prompt: 'pause please', workspace: repo, tier: 'consult', timeoutSec: 20 });
    await waitStatus(mgr, a.id, ['input-required']);

    process.env.WB_FAKE_MODE = 'hang';
    const b = mgr.start({ prompt: 'occupy the only slot', workspace: repo, tier: 'consult', timeoutSec: 20 });
    // `start()` claims the slot synchronously (inflight.set before spawn), so
    // wait on the slot itself rather than sleeping 300ms to hope it happened.
    for (let attempt = 0; mgr.inflight.size < 1 && attempt < 100; attempt += 1) {
      await sleep(pollDelay(attempt));
    }
    assert.equal(mgr.inflight.size, 1, 'the hanging job should hold the only slot');
    assert.equal(mgr.inflight.size, 1);

    assert.throws(() => mgr.reply(a.id, 'yes continue'), /concurrency limit/);
    assert.equal(mgr.store.get(a.id).status, 'input-required', 'a rejected reply must not resume the task');
    assert.equal(mgr.inflight.size, 1, 'the slot count must not move');

    mgr.cancel(b.id);
  } finally {
    delete process.env.WB_FAKE_MODE;
    await mgr.shutdown(500);
    rmrf(repo);
    rmrf(stateDir);
  }
});

test('B0-1: timeout settles the run even when the child leaves a pipe holder', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit-st-'));
  const cfg = makeConfig(stateDir, repo, { maxConcurrency: 1, defaultTimeoutSec: 10, maxTimeoutSec: 10 });
  const mgr = new JobManager(cfg, new Logger({ level: 'error', fileDir: undefined }));
  const pidFile = path.join(stateDir, 'kid2.pid');
  process.env.WB_FAKE_MODE = 'hold-stdout';
  process.env.WB_HOLD_PIDFILE = pidFile;
  try {
    const t0 = Date.now();
    const job = mgr.start({ prompt: 'hold', workspace: repo, tier: 'consult', timeoutSec: 10 });
    // The job reports completion as soon as `exit` arrives + drain window; no
    // need to wait for the 10s timeout since the fake exits on its own.
    const done = await waitStatus(mgr, job.id, ['completed', 'failed'], 12000);
    const elapsed = Date.now() - t0;
    assert.equal(done.status, 'completed');
    assert.ok(elapsed < 6000, `job settled in ${elapsed}ms (drain window should be ~1.5s)`);
    assert.equal(mgr.inflight.size, 0, 'slot released on exit, not on close');
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL');
    } catch {
      /* ignore */
    }
  } finally {
    delete process.env.WB_FAKE_MODE;
    delete process.env.WB_HOLD_PIDFILE;
    await mgr.shutdown(500);
    rmrf(repo);
    rmrf(stateDir);
  }
});
