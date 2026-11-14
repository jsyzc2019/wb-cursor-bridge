/**
 * P3 regression: idempotent submissions, atomic checkpoints and lease-based
 * reconciliation. Recovery is exercised by rebuilding a JobStore against the
 * SAME index.json the first writer left behind (a deterministic stand-in for a
 * hard kill + restart); no sleep-based "wait and hope" assertions.
 *
 * Design doc: wb-cursor-bridge-p3-design.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JobStore, LEASE_TTL_MS } from '../dist/store.js';
import { JobManager } from '../dist/runner.js';
import { Logger } from '../dist/logger.js';
import { fakeBin } from './fake-bin.mjs';
import { rmrf } from './tmp.mjs';

const FAKE = fakeBin('a2a');
chmodSync(FAKE, 0o755);
const LIMITS = { maxJobs: 100, maxEventsPerJob: 2000, maxEventBytes: 2 * 1024 * 1024 };

function tmpState() {
  return mkdtempSync(path.join(os.tmpdir(), 'wbstate-p3-'));
}
function readIndex(stateDir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'index.json'), 'utf8'));
}
function makeConfig(stateDir, repo) {
  return {
    cursorBin: FAKE, workspaceRoots: [repo], stateDir,
    defaultTimeoutSec: 30, maxTimeoutSec: 60, maxConcurrency: 8,
    defaultModel: undefined, forceWorktree: false,
    maxResultBytes: 2 * 1024 * 1024, maxEventsPerJob: 2000, maxJobs: 100,
    logLevel: 'error', adminPort: 0, eventLogDir: undefined, extraArgs: [],
    a2aPort: 0, a2aHost: '127.0.0.1', a2aAuthToken: undefined, a2aPublicUrl: undefined,
  };
}

function makeJob(id, overrides = {}) {
  return {
    id, tier: 'consult', workspace: '/tmp/repo', prompt: 'probe',
    status: 'running', createdAt: new Date().toISOString(),
    events: [], cursor: 0,
    ...overrides,
  };
}

/* ------------------------------------------------------------- store layer */

test('p3: create commits the lease atomically with the initial state', () => {
  const dir = tmpState();
  try {
    const store = new JobStore(dir, LIMITS, undefined, undefined, 'instance-A');
    const job = store.create(makeJob('j1', { requestKey: 'k1', checkpoint: 'accepted' }));
    assert.ok(job.leaseOwner === 'instance-A');
    assert.ok(job.leaseExpiresAt);
    const rec = readIndex(dir).jobs.find((j) => j.id === 'j1');
    assert.equal(rec.status, 'running');
    assert.equal(rec.requestKey, 'k1');
    assert.equal(rec.checkpoint, 'accepted');
    assert.equal(rec.leaseOwner, 'instance-A', 'lease must be in the SAME write as status');
  } finally { rmrf(dir); }
});

test('p3: checkpoint() commits phase + state + lease renewal in one write', () => {
  const dir = tmpState();
  try {
    const store = new JobStore(dir, LIMITS, undefined, undefined, 'instance-A');
    const job = store.create(makeJob('j2'));
    store.checkpoint(job, 'spawned', { pid: 4242 });
    const rec = readIndex(dir).jobs.find((j) => j.id === 'j2');
    assert.equal(rec.checkpoint, 'spawned');
    assert.equal(rec.pid, 4242, 'field patch and phase are atomic');
    assert.equal(rec.leaseOwner, 'instance-A');

    job.status = 'completed';
    store.checkpoint(job, 'settled');
    const settled = readIndex(dir).jobs.find((j) => j.id === 'j2');
    assert.equal(settled.checkpoint, 'settled');
    assert.equal(settled.status, 'completed');
    assert.equal(settled.leaseOwner, undefined, 'settled job holds no lease');
  } finally { rmrf(dir); }
});

test('p3: side-effect markers are committed and never replayed', () => {
  const dir = tmpState();
  try {
    const store = new JobStore(dir, LIMITS, undefined, undefined, 'instance-A');
    const job = store.create(makeJob('j3'));
    assert.equal(store.hasSideEffect(job, 'push-delivery:abc'), false);
    store.checkpoint(job, 'push-sending');
    store.markSideEffect(job, 'push-delivery:abc');
    assert.equal(store.hasSideEffect(job, 'push-delivery:abc'), true);
    const rec = readIndex(dir).jobs.find((j) => j.id === 'j3');
    assert.equal(rec.checkpoint, 'push-sending');
    assert.ok(rec.sideEffects['push-delivery:abc'], 'marker persisted with the phase');
  } finally { rmrf(dir); }
});

test('p3: findByRequestKey resolves an idempotent repeat', () => {
  const dir = tmpState();
  try {
    const store = new JobStore(dir, LIMITS, undefined, undefined, 'instance-A');
    store.create(makeJob('j4', { requestKey: 'same-key' }));
    assert.equal(store.findByRequestKey('same-key')?.id, 'j4');
    assert.equal(store.findByRequestKey('other'), undefined);
    assert.equal(store.findByRequestKey(undefined), undefined);
  } finally { rmrf(dir); }
});

/* ------------------------------------------------------- recovery / leases */

test('p3: a LIVE sibling owner is never reclaimed or re-run on restart', () => {
  const dir = tmpState();
  try {
    // Use the real pid as the owner prefix: `ownerStillAlive` resolves it and
    // sees a genuinely live sibling process, so its job stays running.
    const writer = new JobStore(dir, LIMITS, undefined, undefined, `${process.pid}-A`);
    writer.create(makeJob('j5', { requestKey: 'k5' }));
    const reader = new JobStore(dir, LIMITS, undefined, undefined, 'instance-B');
    const { orphaned } = reader.load();
    assert.deepEqual(orphaned, [], 'a live sibling must not be marked orphaned');
    assert.equal(reader.get('j5').status, 'running');
    assert.equal(reader.get('j5').leaseOwner, `${process.pid}-A`, 'lease metadata survives');
    assert.equal(reader.findByRequestKey('k5')?.id, 'j5');
  } finally { rmrf(dir); }
});

test('p3: an EXPIRED lease is reconciled to orphaned and never re-run', () => {
  const dir = tmpState();
  try {
    const writer = new JobStore(dir, LIMITS, undefined, undefined, 'instance-A');
    writer.create(makeJob('j6', { requestKey: 'k6' }));
    // Simulate the writer having died long ago.
    const idx = readIndex(dir);
    for (const j of idx.jobs) {
      j.leaseExpiresAt = new Date(Date.now() - LEASE_TTL_MS - 1000).toISOString();
      j.owner = '999999-dead';
    }
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx));

    const reader = new JobStore(dir, LIMITS, undefined, undefined, 'instance-B');
    const { orphaned } = reader.load();
    assert.deepEqual(orphaned, ['j6']);
    const recovered = reader.get('j6');
    assert.equal(recovered.status, 'orphaned');
    assert.equal(recovered.leaseOwner, undefined, 'orphan holds no lease');
    assert.equal(recovered.requestKey, 'k6', 'idempotency identity survives recovery');
  } finally { rmrf(dir); }
});

test('p3: JobManager.start deduplicates a repeated requestKey (one run only)', async () => {
  const dir = tmpState();
  const repo = mkdtempSync(path.join(os.tmpdir(), 'wbrepo-p3-'));
  try {
    const log = new Logger({ level: 'error', fileDir: dir });
    const mgr = new JobManager(makeConfig(dir, repo), log);
    const a = mgr.start({ prompt: 'dedup probe', workspace: repo, tier: 'consult', requestKey: 'dup-1' });
    const b = mgr.start({ prompt: 'dedup probe retry', workspace: repo, tier: 'consult', requestKey: 'dup-1' });
    assert.equal(b.id, a.id, 'repeat returns the SAME job');
    assert.equal(mgr.store.list({ limit: 100 }).filter((j) => j.requestKey === 'dup-1').length, 1);
    // start() spawns asynchronously; by the time we assert, the phase may
    // already have advanced to 'spawned'. Exact checkpoint atomicity is covered
    // by the store-layer tests above.
    assert.ok(['accepted', 'spawned', 'settled'].includes(a.checkpoint));
    await mgr.shutdown(1000).catch(() => {});
  } finally {
    rmrf(dir); rmrf(repo);
  }
});

test('p3: after a restart, the same requestKey resolves to the recovered job', async () => {
  const dir = tmpState();
  const repo = mkdtempSync(path.join(os.tmpdir(), 'wbrepo-p3-'));
  try {
    const log = new Logger({ level: 'error', fileDir: dir });
    const first = new JobManager(makeConfig(dir, repo), log);
    const original = first.start({
      prompt: 'restart probe', workspace: repo, tier: 'consult', requestKey: 'restart-1',
    });
    // Deterministic "hard kill": drop the first manager without shutdown, then
    // boot a second one against the very same index.json.
    const idx = readIndex(dir);
    for (const j of idx.jobs) {
      j.leaseExpiresAt = new Date(Date.now() - LEASE_TTL_MS - 1000).toISOString();
      j.owner = '999999-dead';
    }
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx));

    const second = new JobManager(makeConfig(dir, repo), log);
    const recovered = second.getMetrics(); // force nothing; load() ran in ctor
    void recovered;
    assert.equal(second.store.get(original.id).status, 'orphaned',
      'the crashed run is reconciled, never silently re-spawned');
    const again = second.start({
      prompt: 'restart probe retry', workspace: repo, tier: 'consult', requestKey: 'restart-1',
    });
    assert.equal(again.id, original.id, 'idempotent replay resolves to the recovered job');
    assert.equal(second.store.list({ limit: 100 }).filter((j) => j.requestKey === 'restart-1').length, 1);
    await second.shutdown(1000).catch(() => {});
    await first.shutdown(1000).catch(() => {});
  } finally {
    rmrf(dir); rmrf(repo);
  }
});
