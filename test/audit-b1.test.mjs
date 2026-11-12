/**
 * Audit regression suite - batch B1 (isolation, data, environment).
 *
 * Same contract as audit-b0: every assertion is written in the FIXED direction,
 * and each test names the audit PoC it replaces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JobManager } from '../dist/runner.js';
import { Logger } from '../dist/logger.js';
import { buildChildEnv } from '../dist/cursor/cli.js';
import { isAlreadyGone } from '../dist/util/processes.js';
import { isPrivateAddress } from '../dist/util/net.js';
import { fakeBin } from './fake-bin.mjs';

const FAKE = fakeBin('cursor');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit1-repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 't@t.local');
  git('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  mkdirSync(path.join(dir, 'pkg'));
  writeFileSync(path.join(dir, 'pkg', 'a.txt'), 'inside\n');
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
    maxLiveJobs: 20,
    inputRequiredTtlSec: 86400,
    logLevel: 'error',
    adminPort: 0,
    eventLogDir: undefined,
    extraArgs: [],
    envPassthrough: [],
    a2aPort: 0,
    a2aHost: '127.0.0.1',
    a2aAuthToken: undefined,
    a2aPublicUrl: undefined,
    ...over,
  };
}

async function waitStatus(mgr, id, wanted, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = mgr.store.get(id);
    if (job && wanted.includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job && job.status}`);
    await sleep(80);
  }
}

test('B1-8: the worker environment is an allowlist, not a copy of the host', () => {
  const env = buildChildEnv(
    { envPassthrough: [] },
    {
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'C.UTF-8',
      OPENAI_API_KEY: 'sk-live-SUPER-SECRET',
      AWS_SECRET_ACCESS_KEY: 'nope',
      GITHUB_TOKEN: 'ghp_x',
      MY_PASSWORD: 'hunter2',
      CURSOR_BRIDGE_A2A_AUTH_TOKEN: 'bridge-secret',
      WB_FAKE_MODE: 'ok',
    },
  );
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(env.WB_FAKE_MODE, 'ok', 'bridge/agent knobs stay available');
  for (const leaked of ['OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'MY_PASSWORD', 'CURSOR_BRIDGE_A2A_AUTH_TOKEN']) {
    assert.equal(env[leaked], undefined, `${leaked} must not reach the worker`);
  }
});

test('B1-8: an explicit passthrough wins over the sensitive-name filter', () => {
  const env = buildChildEnv({ envPassthrough: ['MY_PASSWORD'] }, { MY_PASSWORD: 'wanted', OTHER_TOKEN: 'no' });
  assert.equal(env.MY_PASSWORD, 'wanted');
  assert.equal(env.OTHER_TOKEN, undefined);
});

test('B1-7: taskkill exit codes are classified as "already gone" (number or string)', () => {
  assert.equal(isAlreadyGone(128), true);
  assert.equal(isAlreadyGone('128'), true);
  assert.equal(isAlreadyGone(1), true);
  assert.equal(isAlreadyGone('1'), true);
  assert.equal(isAlreadyGone(0), false);
  assert.equal(isAlreadyGone(undefined), false);
  assert.equal(isAlreadyGone('EACCES'), false);
});

test('B1-5: private address classification covers CGNAT and IPv4-mapped forms', () => {
  for (const addr of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(addr), true, `${addr} must be private`);
  }
  for (const addr of ['93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(addr), false, `${addr} must be public`);
  }
});

test('B1-1: an execute task on a non-git workspace is REFUSED, not run in place', async () => {
  const plain = mkdtempSync(path.join(os.tmpdir(), 'wbaudit1-plain-'));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit1-st-'));
  const mgr = new JobManager(makeConfig(stateDir, plain), new Logger({ level: 'error', fileDir: undefined }));
  process.env.WB_FAKE_MODE = 'write';
  try {
    const job = mgr.start({ prompt: 'write please', workspace: plain, tier: 'execute', timeoutSec: 20 });
    const done = await waitStatus(mgr, job.id, ['failed', 'completed']);
    assert.equal(done.status, 'failed', 'execute without isolation must fail closed');
    assert.match(String(done.result), /isolation|refused/i);
    assert.equal(
      (await import('node:fs')).existsSync(path.join(plain, 'changed-by-fake.txt')),
      false,
      'the worker must never have run in the caller directory',
    );
  } finally {
    delete process.env.WB_FAKE_MODE;
    await mgr.shutdown(500);
    rmSync(plain, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('B1-1: a whitelisted sub-directory runs inside the worktree copy, not the repo root', async () => {
  const repo = makeRepo();
  const sub = path.join(repo, 'pkg');
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit1-st-'));
  const mgr = new JobManager(makeConfig(stateDir, repo), new Logger({ level: 'error', fileDir: undefined }));
  process.env.WB_FAKE_MODE = 'write';
  try {
    const job = mgr.start({ prompt: 'write please', workspace: sub, tier: 'execute', timeoutSec: 20 });
    const done = await waitStatus(mgr, job.id, ['completed', 'failed']);
    assert.equal(done.isolation, 'bridge-worktree');
    assert.ok((done.changedFiles ?? []).includes('pkg/changed-by-fake.txt'),
      `expected the write under pkg/, got ${JSON.stringify(done.changedFiles)}`);
    assert.equal((done.changedFiles ?? []).includes('changed-by-fake.txt'), false,
      'the worker must not run at the repository root');
  } finally {
    delete process.env.WB_FAKE_MODE;
    await mgr.shutdown(500);
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('B1-4: a fresh execute task exports report.md from its own result', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit1-st-'));
  const mgr = new JobManager(makeConfig(stateDir, repo), new Logger({ level: 'error', fileDir: undefined }));
  process.env.WB_FAKE_MODE = 'write';
  try {
    const job = mgr.start({ prompt: 'write then answer', workspace: repo, tier: 'execute', timeoutSec: 20 });
    const done = await waitStatus(mgr, job.id, ['completed', 'failed']);
    assert.ok(done.reportFile, 'a completed execute task must point at its report');
    assert.equal(readFileSync(done.reportFile, 'utf8').trim(), 'FAKE_RESULT:write');
  } finally {
    delete process.env.WB_FAKE_MODE;
    await mgr.shutdown(500);
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
