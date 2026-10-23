/**
 * End-to-end tests: a real MCP client talks to the compiled bridge over stdio,
 * which spawns a fake Cursor CLI that speaks the same stream-json protocol.
 *
 * These are the tests that prove the whole chain works: protocol handshake,
 * dispatch, async polling, git worktree isolation, patch capture, cancellation,
 * concurrency limiting and crash recovery.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync,
} from 'node:fs';
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
  const stateDir =
    extra.CURSOR_BRIDGE_STATE_DIR ??
    mkdtempSync(path.join(os.tmpdir(), 'wbstate-'));
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

test('e2e: MCP handshake exposes exactly the documented tool surface', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo);
  try {
    await client.init();
    const tools = await client.tools();
    assert.deepEqual(tools.sort(), [
      'bridge_health', 'bridge_shutdown', 'bridge_stats',
      'cursor_cancel', 'cursor_diff', 'cursor_list', 'cursor_reply',
      'cursor_run', 'cursor_status',
    ]);
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: consult job runs read-only and returns a result', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo);
  try {
    await client.init();
    const started = await client.call('cursor_run', {
      prompt: 'explain this repo', workspace: repo, tier: 'consult',
    });
    assert.equal(started.isError, false);
    assert.equal(started.data.status, 'running');
    assert.ok(started.data.jobId);

    const done = await waitFor(client, started.data.jobId);
    assert.equal(done.status, 'completed');
    assert.match(done.result, /FAKE_RESULT:ok/);
    assert.equal(done.threadId, 'th-fake-0001');
    // A consult job never gets an isolated worktree.
    assert.equal(done.isolation, 'none');
    // Incremental polling works: no event is repeated.
    const poll = await client.call('cursor_status', {
      jobId: done.jobId, since: done.cursor,
    });
    assert.equal(poll.data.events.length, 0);
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: execute job is isolated in a worktree and its patch is captured', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo, { WB_FAKE_MODE: 'write' });
  try {
    await client.init();
    const started = await client.call('cursor_run', {
      prompt: 'add a file', workspace: repo, tier: 'execute',
    });
    assert.equal(started.data.isolation, 'bridge-worktree');
    const done = await waitFor(client, started.data.jobId);

    assert.equal(done.status, 'completed');
    assert.equal(done.isolation, 'bridge-worktree');
    assert.ok(
      done.changedFiles.includes('changed-by-fake.txt'),
      `expected the file in the patch, got ${JSON.stringify(done.changedFiles)}`,
    );
    assert.match(done.diffStat, /changed-by-fake\.txt/);

    // The caller's checkout must be untouched.
    assert.equal(existsSync(path.join(repo, 'changed-by-fake.txt')), false);

    // The patch artefact is on disk and readable.
    assert.ok(done.patchFile, 'patchFile should be set');
    assert.ok(existsSync(done.patchFile));
    const patch = readFileSync(done.patchFile, 'utf8');
    assert.match(patch, /changed-by-fake\.txt/);

    // cursor_diff serves the same evidence through the tool surface.
    const diff = await client.call('cursor_diff', {
      jobId: done.jobId, includePatch: true, limit: 200,
    });
    assert.ok(diff.data.changedFiles.includes('changed-by-fake.txt'));
    assert.equal(typeof diff.data.patch, 'string');

    // The worktree must be gone once the job settles.
    assert.deepEqual(readdirSync(path.join(stateDir, 'worktrees')), []);
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: a crashing agent is reported as failed, not swallowed', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo, { WB_FAKE_MODE: 'crash' });
  try {
    await client.init();
    const started = await client.call('cursor_run', {
      prompt: 'boom', workspace: repo, tier: 'plan',
    });
    const done = await waitFor(client, started.data.jobId);
    assert.equal(done.status, 'failed');
    assert.equal(done.exitCode, 3);
    assert.match(done.result, /simulated crash/);
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: cancelling a running job kills it and settles as cancelled', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo, { WB_FAKE_MODE: 'hang' });
  try {
    await client.init();
    const started = await client.call('cursor_run', {
      prompt: 'hang forever', workspace: repo, tier: 'consult',
    });
    assert.equal(started.data.status, 'running');
    await new Promise((r) => setTimeout(r, 400));
    const cancelled = await client.call('cursor_cancel', { jobId: started.data.jobId });
    assert.equal(cancelled.data.status, 'cancelled');

    const done = await waitFor(client, started.data.jobId);
    assert.equal(done.status, 'cancelled');
    // The tree kill lands asynchronously; durationMs is filled in after it.
    await new Promise((r) => setTimeout(r, 600));
    const settled = await client.call('cursor_status', { jobId: done.jobId });
    assert.equal(settled.data.status, 'cancelled');
    assert.equal(typeof settled.data.durationMs, 'number');
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: concurrency limit is enforced with a clear error', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo, {
    WB_FAKE_MODE: 'hang',
    CURSOR_BRIDGE_MAX_CONCURRENCY: '1',
  });
  try {
    await client.init();
    const first = await client.call('cursor_run', {
      prompt: 'a', workspace: repo, tier: 'consult',
    });
    assert.equal(first.data.status, 'running');

    const second = await client.call('cursor_run', {
      prompt: 'b', workspace: repo, tier: 'consult',
    });
    assert.equal(second.isError, true);
    assert.match(second.data, /concurrency limit reached/);

    await client.call('cursor_cancel', { jobId: first.data.jobId });
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: workspace outside the allowlist is refused before any process spawns', async () => {
  const repo = makeRepo();
  const outside = makeRepo();
  const { client, stateDir } = startClient(repo);
  try {
    await client.init();
    const bad = await client.call('cursor_run', {
      prompt: 'escape', workspace: outside, tier: 'execute',
    });
    assert.equal(bad.isError, true);
    assert.match(bad.data, /outside every configured root/);
    // Nothing must have run, so the list is still empty.
    const list = await client.call('cursor_list', {});
    assert.equal(list.data.length, 0);
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('e2e: reply resumes the same Cursor thread instead of restarting', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo);
  try {
    await client.init();
    const first = await client.call('cursor_run', {
      prompt: 'step one', workspace: repo, tier: 'consult',
    });
    const done = await waitFor(client, first.data.jobId);
    assert.equal(done.status, 'completed');

    const follow = await client.call('cursor_reply', {
      jobId: done.jobId, prompt: 'step two',
    });
    assert.equal(follow.isError, false);
    assert.equal(follow.data.parentJobId, done.jobId);
    assert.equal(follow.data.threadId, done.threadId, 'thread id must be carried over');

    const done2 = await waitFor(client, follow.data.jobId);
    assert.equal(done2.status, 'completed');
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: input-required pauses the task and cursor_reply resumes the SAME job', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo, { WB_FAKE_MODE: 'needinput' });
  try {
    await client.init();
    const started = await client.call('cursor_run', {
      prompt: 'analyse the repo', workspace: repo, tier: 'consult',
    });
    const paused = await waitFor(client, started.data.jobId);
    // The worker signalled it needs input: the task is paused, not completed.
    assert.equal(paused.status, 'input-required');
    assert.equal(paused.pendingInput, 'which file should I edit?');
    assert.equal(paused.parentJobId, undefined, 'a paused task has no parent');

    const resumed = await client.call('cursor_reply', {
      jobId: paused.jobId, prompt: 'edit src/index.ts',
    });
    assert.equal(resumed.isError, false);
    // The key A2A property: reply resumes the SAME task id, it is not a child.
    assert.equal(resumed.data.jobId, paused.jobId, 'same task id is resumed in place');
    assert.equal(resumed.data.parentJobId, undefined, 'resume is not a child job');
    assert.equal(resumed.data.threadId, paused.threadId, 'thread id is carried over');

    const done = await waitFor(client, resumed.data.jobId);
    assert.equal(done.status, 'completed');
    assert.match(done.result, /FAKE_RESULT:resumed/);
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: health and stats report the deployment accurately', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo);
  try {
    await client.init();
    const health = await client.call('bridge_health', {});
    assert.equal(health.isError, false);
    assert.equal(health.data.ok, true);
    assert.equal(health.data.cursorBinFound, true);
    assert.equal(health.data.workspaceRoots.length, 1);
    assert.deepEqual(health.data.issues, []);
    assert.equal(health.data.stateDirWritable, true);
    assert.equal(health.data.cached, false);

    // Immediate second call should be served from the 5s cache.
    const cached = await client.call('bridge_health', {});
    assert.equal(cached.data.cached, true);

    const stats = await client.call('bridge_stats', {});
    assert.equal(stats.data.started, 0);
    assert.equal(stats.data.completed, 0);
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: job state survives a bridge restart and is marked orphaned', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-'));
  const env = {
    CURSOR_BIN: FAKE,
    CURSOR_BRIDGE_WORKSPACE_ROOTS: repo,
    CURSOR_BRIDGE_STATE_DIR: stateDir,
    CURSOR_BRIDGE_LOG_LEVEL: 'error',
    WB_FAKE_MODE: 'hang',
  };
  let jobId;
  {
    const c = createClient(env);
    await c.init();
    const started = await c.call('cursor_run', {
      prompt: 'hang', workspace: repo, tier: 'consult',
    });
    jobId = started.data.jobId;
    await new Promise((r) => setTimeout(r, 400));
    // Simulate a hard crash: no shutdown, no cancel.
    c.proc.kill('SIGKILL');
  }
  {
    const c = createClient(env);
    await c.init();
    const status = await c.call('cursor_status', { jobId });
    assert.equal(status.isError, false);
    assert.equal(status.data.status, 'orphaned');
    const list = await c.call('cursor_list', { status: 'orphaned' });
    assert.equal(list.data.length, 1);
    c.close();
  }
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test('e2e: a missing cursor binary is reported by health, not by a crash', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo, {
    CURSOR_BIN: path.join(ROOT, 'no-such-binary-xyz'),
  });
  try {
    await client.init();
    const health = await client.call('bridge_health', {});
    assert.equal(health.data.ok, false);
    assert.match(health.data.issues[0], /cursor binary not found/);

    const started = await client.call('cursor_run', {
      prompt: 'x', workspace: repo, tier: 'consult',
    });
    const done = await waitFor(client, started.data.jobId);
    assert.equal(done.status, 'failed');
    assert.match(done.result, /failed to start the Cursor CLI|ENOENT|spawn error/);
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: cursor_list limit is clamped to a sane ceiling', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo);
  try {
    await client.init();
    await client.call('cursor_run', { prompt: 'a', workspace: repo, tier: 'consult' });
    const list = await client.call('cursor_list', { limit: 999999 });
    assert.equal(list.isError, false);
    assert.ok(list.data.length <= 1000, `expected <= 1000 jobs, got ${list.data.length}`);
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: cursor_diff limit is clamped to a sane ceiling', async () => {
  const repo = makeRepo();
  const { client, stateDir } = startClient(repo, { WB_FAKE_MODE: 'write' });
  try {
    await client.init();
    const started = await client.call('cursor_run', {
      prompt: 'add a file', workspace: repo, tier: 'execute',
    });
    const done = await waitFor(client, started.data.jobId);
    const diff = await client.call('cursor_diff', {
      jobId: done.jobId, includePatch: true, limit: 999999999,
    });
    assert.equal(diff.isError, false);
    assert.equal(typeof diff.data.patch, 'string');
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('e2e: optional event JSONL persistence survives the job lifecycle', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-'));
  const { client } = startClient(repo, {
    CURSOR_BRIDGE_STATE_DIR: stateDir,
    CURSOR_BRIDGE_PERSIST_EVENTS: '1',
    CURSOR_BRIDGE_EVENT_LOG_DIR: path.join(stateDir, 'events'),
  });
  try {
    await client.init();
    const started = await client.call('cursor_run', {
      prompt: 'explain this repo', workspace: repo, tier: 'consult',
    });
    const done = await waitFor(client, started.data.jobId);
    assert.equal(done.status, 'completed');

    const eventFile = path.join(stateDir, 'events', done.jobId, 'events.jsonl');
    assert.ok(existsSync(eventFile), `events.jsonl should exist at ${eventFile}`);
    const lines = readFileSync(eventFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 2, 'should have at least start and end events');
    const types = lines.map((l) => JSON.parse(l).type);
    assert.ok(types.includes('start'), `expected start event, got ${types.join(',')}`);
    assert.ok(types.includes('end'), `expected end event, got ${types.join(',')}`);
  } finally {
    await client.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});