/**
 * P2 regression: structured artefacts and approval as first-class A2A units.
 *
 * Acceptance (research plan §4 P2): one `execute` task's A2A flow can
 * separately retrieve a diff artifact, a cost field, an approval pause that
 * can be resumed — without introducing worker-initiated work. contextId
 * continuation is explicit and validated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { JobManager } from '../dist/runner.js';
import { Logger } from '../dist/logger.js';
import { startA2AServer } from '../dist/a2a/server.js';
import { toTask } from '../dist/a2a/convert.js';
import { buildStructuredArtifacts } from '../dist/artifacts.js';
import { VERSION } from '../dist/version.js';
import { fakeBin } from './fake-bin.mjs';
import { rmrf } from './tmp.mjs';

const FAKE = fakeBin('a2a');
chmodSync(FAKE, 0o755);

function makeJob(overrides = {}) {
  return {
    id: 'job-p2',
    tier: 'execute',
    workspace: '/tmp/repo',
    prompt: 'do the work',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
    durationMs: 2000,
    model: 'fake-model',
    cursor: 4,
    events: [
      { seq: 1, ts: '2026-01-01T00:00:00.100Z', type: 'assistant', text: 'analysing the repo' },
      { seq: 2, ts: '2026-01-01T00:00:00.200Z', type: 'assistant', text: 'PLAN: edit src/index.ts, then run tests' },
      { seq: 3, ts: '2026-01-01T00:00:00.300Z', type: 'tool', detail: 'read src/index.ts' },
      { seq: 4, ts: '2026-01-01T00:00:01.000Z', type: 'end' },
    ],
    metadata: { usage: { inputTokens: 120, outputTokens: 45, costUsd: 0.0021 } },
    ...overrides,
  };
}

/* -------------------------------------------------------------- unit tests */

test('p2: event stream derives semantic transcript / toolCalls / cost', () => {
  const arts = buildStructuredArtifacts(makeJob());
  const byName = Object.fromEntries(arts.map((a) => [a.name, a]));

  const transcript = byName.transcript.parts[0].data.entries;
  assert.equal(transcript.length, 2);
  assert.deepEqual(transcript.map((e) => e.semantic), ['thinking', 'plan']);

  assert.equal(byName.toolCalls.parts[0].data.calls.length, 1);
  assert.equal(byName.toolCalls.parts[0].data.calls[0].detail, 'read src/index.ts');

  const cost = byName.cost.parts[0].data;
  assert.equal(cost.durationMs, 2000);
  assert.equal(cost.model, 'fake-model');
  assert.equal(cost.toolCallCount, 1);
  assert.equal(cost.transcriptEntryCount, 2);
  assert.deepEqual(cost.usage, { inputTokens: 120, outputTokens: 45, costUsd: 0.0021 });

  // No worker-scheduled action: artefacts are observations, not commands.
  assert.equal(byName.permissionRequest, undefined);
});

test('p2: input-required becomes a permissionRequest artifact with a resume hint', () => {
  const arts = buildStructuredArtifacts(makeJob({
    status: 'input-required',
    pendingInput: 'which file should I edit?',
    inputRequiredAt: '2026-01-01T00:00:01.500Z',
    finishedAt: undefined,
  }));
  const perm = arts.find((a) => a.name === 'permissionRequest');
  assert.ok(perm);
  assert.equal(perm.parts[0].text, 'which file should I edit?');
  assert.equal(perm.parts[1].data.state, 'input-required');
  assert.match(perm.parts[1].data.resumeWith, /taskId=job-p2/);
  // Still a pause the caller answers, never an autonomous worker action.
  assert.equal(perm.parts[1].data.action, undefined);
});

test('p2: toTask exposes cost metadata + structured artifacts on the 0.3 wire', () => {
  const task = toTask(makeJob({ patchFile: undefined }), { artifactBase: 'http://x/a2a/artifacts' });
  assert.ok(task.artifacts.some((a) => a.name === 'cost'));
  assert.ok(task.artifacts.some((a) => a.name === 'transcript'));
  assert.ok(task.metadata.cost);
  assert.equal(task.metadata.cost.toolCallCount, 1);
});

test('p2: legacy static v1.0 switch keeps its historical artifact shape', () => {
  const task = toTask(makeJob(), { a2aVersion: '1.0' });
  assert.equal((task.artifacts ?? []).some((a) => a.name === 'cost'), false,
    'compat.ts shallow mapper must not see untranslated data parts');
});

/* ------------------------------------------------------------- e2e helpers */

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbrepo-p2-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', windowsHide: true });
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

async function rmSafe(target) {
  for (let i = 0; i < 20; i += 1) {
    try { rmrf(target); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  try { rmrf(target); } catch { /* best effort */ }
}

async function withBridge(fn) {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-p2-'));
  const log = new Logger({ level: 'error', fileDir: stateDir });
  const config = {
    cursorBin: FAKE, workspaceRoots: [repo], stateDir,
    defaultTimeoutSec: 30, maxTimeoutSec: 60, maxConcurrency: 8,
    defaultModel: undefined, forceWorktree: false,
    maxResultBytes: 2 * 1024 * 1024, maxEventsPerJob: 2000, maxJobs: 100,
    logLevel: 'error', adminPort: 0, eventLogDir: undefined, extraArgs: [],
    a2aPort: 0, a2aHost: '127.0.0.1', a2aAuthToken: undefined, a2aPublicUrl: undefined,
    a2aBlockingMaxMs: 15000,
  };
  config.a2aPort = await freePort();
  const mgr = new JobManager(config, log);
  const server = startA2AServer(mgr, { config, version: VERSION, log: log.child('a2a') });
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, mgr });
  } finally {
    server.close();
    await mgr.shutdown(1000).catch(() => {});
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
}

async function rpc(base, method, params) {
  const res = await fetch(`${base}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

const msg = (text, extra = {}) => ({
  role: 'user',
  parts: [{ kind: 'text', text }],
  messageId: randomUUID(),
  ...extra,
});

/* --------------------------------------------------------------- e2e tests */

test('p2: A2A flow exposes approval pause, cost, and an explicit context resume', async () => {
  await withBridge(async ({ base }) => {
    const ctx = randomUUID();
    // The a2a fake agent selects behaviour from markers in the prompt, which
    // keeps tests deterministic without mutating shared environment state.
    const first = await rpc(base, 'message/send', {
      message: msg('NEEDINPUT please plan the change', { contextId: ctx }),
      configuration: { blocking: true },
    });
    const paused = first.result;
    assert.ok(paused, `send failed: ${JSON.stringify(first)}`);
    assert.equal(paused.status.state, 'input-required');
    assert.equal(paused.contextId, ctx);
    assert.ok(paused.artifacts.some((a) => a.name === 'permissionRequest'));
    assert.ok(paused.artifacts.some((a) => a.name === 'cost'));
    assert.ok(paused.metadata.cost);

    // Wrong context must be rejected instead of silently attaching a turn.
    const wrong = await rpc(base, 'message/send', {
      message: msg('answer', { taskId: paused.id, contextId: randomUUID() }),
    });
    assert.ok(wrong.error, 'mismatched contextId must be rejected');
    assert.match(wrong.error.message, /contextId .* does not match/);

    // Correct context resumes the SAME task in place.
    const resumed = await rpc(base, 'message/send', {
      message: msg('edit src/index.ts', { taskId: paused.id, contextId: ctx }),
      configuration: { blocking: true },
    });
    const done = resumed.result;
    assert.ok(done, `resume failed: ${JSON.stringify(resumed)}`);
    assert.equal(done.id, paused.id, 'resume keeps the same task id');
    assert.equal(done.contextId, ctx, 'context survives the resume');
    assert.equal(done.status.state, 'completed');
  });
});

test('p2: an execute task exposes the diff artifact alongside cost metadata', async () => {
  await withBridge(async ({ base }) => {
    const r = await rpc(base, 'message/send', {
      message: msg('WRITEFILE change a file'),
      configuration: { blocking: true },
    });
    const task = r.result;
    assert.ok(task, `send failed: ${JSON.stringify(r)}`);
    assert.equal(task.status.state, 'completed');
    assert.ok(task.artifacts.some((a) => a.name === 'changes.patch'), 'diff artifact');
    assert.ok(task.artifacts.some((a) => a.name === 'cost'), 'cost artifact');
    assert.ok(task.metadata.cost, 'cost field in metadata');
    assert.ok(task.artifacts.some((a) => a.name === 'transcript'), 'thinking/plan transcript');
  });
});
