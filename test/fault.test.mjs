/**
 * Fault-injection tests for disk/permission failures.
 *
 * These run the real bridge in adverse filesystem conditions and verify that
 * it degrades gracefully rather than crashing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

function startClient(env = {}) {
  const stateDir =
    env.CURSOR_BRIDGE_STATE_DIR ??
    mkdtempSync(path.join(os.tmpdir(), 'wbstate-'));
  const client = createClient({
    CURSOR_BIN: FAKE,
    CURSOR_BRIDGE_LOG_LEVEL: 'error',
    ...env,
    CURSOR_BRIDGE_STATE_DIR: stateDir,
  });
  return { client, stateDir };
}

test('fault: bridge survives a stateDir path occupied by a file', async () => {
  const repo = makeRepo();
  const blocked = mkdtempSync(path.join(os.tmpdir(), 'wbblocked-'));
  const stateDir = path.join(blocked, 'state.json');
  writeFileSync(stateDir, 'not-a-directory');
  const { client } = startClient({
    CURSOR_BRIDGE_WORKSPACE_ROOTS: repo,
    CURSOR_BRIDGE_STATE_DIR: stateDir,
  });
  try {
    await client.init();
    const health = await client.call('bridge_health', {});
    assert.equal(health.data.ok, false);
    assert.equal(health.data.stateDirWritable, false);
  } finally {
    await client.close();
    rmSync(blocked, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fault: eventLogDir occupied by a file does not break the job', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-'));
  const eventLogDir = path.join(stateDir, 'events-file');
  writeFileSync(eventLogDir, 'not-a-directory');
  const { client } = startClient({
    CURSOR_BRIDGE_WORKSPACE_ROOTS: repo,
    CURSOR_BRIDGE_EVENT_LOG_DIR: eventLogDir,
    CURSOR_BRIDGE_PERSIST_EVENTS: '1',
  });
  try {
    await client.init();
    const started = await client.call('cursor_run', {
      prompt: 'ok', workspace: repo, tier: 'consult',
    });
    const done = await waitFor(client, started.data.jobId);
    assert.equal(done.status, 'completed');
    // The file should still be a file (we never corrupt it) and no events dir exists.
    assert.ok(existsSync(eventLogDir));
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
