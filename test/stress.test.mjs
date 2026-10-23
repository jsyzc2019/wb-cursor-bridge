/**
 * Stress tests: real MCP client drives the bridge under load.
 *
 * These are intentionally NOT part of the default `npm test` because they take
 * longer and are meant for release validation rather than every edit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, waitFor } from './client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = process.platform === 'win32'
  ? path.join(ROOT, 'test', 'fake-agent.cmd')
  : path.join(ROOT, 'test', 'fake-agent.sh');

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbrepo-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 't@t.local');
  git('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

function startClient(repo, extra = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-'));
  const client = createClient({
    CURSOR_BIN: FAKE,
    CURSOR_BRIDGE_WORKSPACE_ROOTS: repo,
    CURSOR_BRIDGE_STATE_DIR: stateDir,
    CURSOR_BRIDGE_TIMEOUT_SEC: '20',
    CURSOR_BRIDGE_LOG_LEVEL: 'error',
    ...extra,
  });
  return { client, stateDir };
}

test('stress: 50 ok jobs saturate maxConcurrency=20 and drain cleanly', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo, {
    CURSOR_BRIDGE_MAX_CONCURRENCY: '20',
    WB_FAKE_MODE: 'ok',
  });
  try {
    await client.init();
    const started = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        client.call('cursor_run', {
          prompt: `job ${i}`, workspace: repo, tier: 'consult',
        }),
      ),
    );
    const rejected = started.filter((r) => r.isError).length;
    const jobIds = started.filter((r) => !r.isError).map((r) => r.data.jobId);

    const settled = await Promise.all(jobIds.map((id) => waitFor(client, id, 60_000)));
    const completed = settled.filter((j) => j.status === 'completed').length;
    const failed = settled.filter((j) => j.status === 'failed').length;

    assert.equal(rejected, 30, '30 jobs should be immediately rejected at concurrency cap');
    assert.equal(failed, 0, 'no accepted job should fail');
    assert.equal(completed, 20, 'all accepted jobs should complete');

    const stats = await client.call('bridge_stats', {});
    assert.equal(stats.data.started, 20);
    assert.equal(stats.data.completed, 20);
    assert.equal(stats.data.rejected, 30);
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('stress: 20 rounds of cancel then reply on a hanging job', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo, {
    WB_FAKE_MODE: 'hang',
    CURSOR_BRIDGE_TIMEOUT_SEC: '60',
  });
  try {
    await client.init();
    let jobId;
    for (let i = 0; i < 20; i += 1) {
      const started = await client.call('cursor_run', {
        prompt: `round ${i}`, workspace: repo, tier: 'consult',
      });
      assert.equal(started.isError, false, `round ${i} should start`);
      jobId = started.data.jobId;

      await client.call('cursor_cancel', { jobId });
      const cancelled = await waitFor(client, jobId, 10_000);
      assert.equal(cancelled.status, 'cancelled', `round ${i} should be cancelled`);

      const replied = await client.call('cursor_reply', {
        jobId, prompt: `follow-up ${i}`,
      });
      assert.equal(replied.isError, false, `round ${i} reply should start`);
      await client.call('cursor_cancel', { jobId: replied.data.jobId });
      const replyCancelled = await waitFor(client, replied.data.jobId, 10_000);
      assert.equal(replyCancelled.status, 'cancelled');
    }
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('stress: hanging job times out within configured window', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo, {
    WB_FAKE_MODE: 'hang',
    CURSOR_BRIDGE_TIMEOUT_SEC: '10',
  });
  try {
    await client.init();
    const started = await client.call('cursor_run', {
      prompt: 'hang forever', workspace: repo, tier: 'consult',
    });
    const done = await waitFor(client, started.data.jobId, 30_000);
    assert.equal(done.status, 'timeout');

    const stats = await client.call('bridge_stats', {});
    assert.ok(stats.data.timedOut >= 1, 'metrics should record a timeout');
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
