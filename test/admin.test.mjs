/**
 * Admin HTTP endpoint tests.
 *
 * These start a real bridge with an admin port and exercise /healthz, /stats,
 * /jobs and the optional shutdown token.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { fakeBin } from './fake-bin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    import('node:http')
      .then(({ default: http }) => {
        http.get(url, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
          });
        }).on('error', reject);
      })
      .catch(reject);
  });
}

function httpPost(url, headers = {}) {
  return new Promise((resolve, reject) => {
    import('node:http')
      .then(({ default: http }) => {
        const req = http.request(url, { method: 'POST', headers }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
          });
        });
        req.on('error', reject);
        req.end();
      })
      .catch(reject);
  });
}

function startAdminBridge(envExtra = {}) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'wbrepo-'));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-'));
  const proc = spawn(
    process.execPath,
    [path.join(ROOT, 'dist', 'index.js')],
    {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CURSOR_BIN: fakeBin('cursor'),
        CURSOR_BRIDGE_WORKSPACE_ROOTS: repo,
        CURSOR_BRIDGE_STATE_DIR: stateDir,
        CURSOR_BRIDGE_LOG_LEVEL: 'info',
        CURSOR_BRIDGE_ADMIN_PORT: '0',
        ...envExtra,
      },
    },
  );
  return { proc, repo, stateDir };
}

function waitForPort(proc, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('admin port not announced')), timeoutMs);
    const rl = readline.createInterface({ input: proc.stderr });
    rl.on('line', (line) => {
      const m = line.match(/http:\/\/127\.0\.0\.1:(\d+)\/healthz/);
      if (m) {
        clearTimeout(timer);
        rl.close();
        resolve(Number(m[1]));
      }
    });
  });
}

/**
 * Wait for the child to exit, but never forever.
 *
 * `await new Promise((r) => proc.on('close', r))` is a silent hang when the
 * child does not exit (Windows shutdown paths differ): the whole suite stalls
 * until the CI job timeout with no failing test to point at. A bounded wait
 * turns "hung" into "failed with a reason".
 */
function waitClose(proc, timeoutMs = 15_000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`bridge did not exit within ${timeoutMs}ms`)),
      timeoutMs,
    );
    proc.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('admin: /healthz and /stats are readable without token', { timeout: 30_000 }, async () => {
  const { proc, repo, stateDir } = startAdminBridge({ CURSOR_BRIDGE_ADMIN_PORT: '17901' });
  try {
    const port = await waitForPort(proc);
    const health = await httpGet(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const stats = await httpGet(`http://127.0.0.1:${port}/stats`);
    assert.equal(stats.status, 200);
    assert.equal(typeof stats.body.started, 'number');

    const jobs = await httpGet(`http://127.0.0.1:${port}/jobs`);
    assert.equal(jobs.status, 200);
    assert.ok(Array.isArray(jobs.body));
  } finally {
    proc.kill();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('admin: /admin/shutdown requires token when configured', { timeout: 30_000 }, async () => {
  const { proc, repo, stateDir } = startAdminBridge({
    CURSOR_BRIDGE_ADMIN_PORT: '17902',
    CURSOR_BRIDGE_ADMIN_SHUTDOWN_TOKEN: 'secret-xyz',
  });
  try {
    const port = await waitForPort(proc);
    const noToken = await httpPost(`http://127.0.0.1:${port}/admin/shutdown`);
    assert.equal(noToken.status, 401);

    const withHeader = await httpPost(`http://127.0.0.1:${port}/admin/shutdown`, {
      'X-Shutdown-Token': 'secret-xyz',
    });
    assert.equal(withHeader.status, 200);
    assert.equal(withHeader.body.ok, true);

    // Wait for the bridge to actually exit — bounded, so a stuck shutdown is a
    // test failure rather than a 30-minute CI stall.
    await waitClose(proc);
  } finally {
    proc.kill();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('admin: /admin/shutdown is refused when no token is configured (fail closed)', { timeout: 30_000 }, async () => {
  const { proc, repo, stateDir } = startAdminBridge({ CURSOR_BRIDGE_ADMIN_PORT: '17903' });
  try {
    const port = await waitForPort(proc);
    const res = await httpPost(`http://127.0.0.1:${port}/admin/shutdown`);
    // No token configured => the endpoint is disabled, not open. A control
    // plane reachable by any local process is not a control plane.
    assert.equal(res.status, 503);
    assert.match(JSON.stringify(res.body), /set CURSOR_BRIDGE_ADMIN_SHUTDOWN_TOKEN/);
    let exited = false;
    proc.on('close', () => {
      exited = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(exited, false, 'the bridge must keep running');
  } finally {
    proc.kill();
    // Wait for the child to stop writing before removing its state directory.
    await new Promise((r) => {
      const t = setTimeout(r, 1500);
      proc.once('close', () => {
        clearTimeout(t);
        r();
      });
    });
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(repo, { recursive: true, force: true });
  }
});
