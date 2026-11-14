/**
 * P1 drift regression: the MCP and A2A surfaces must be two views of ONE
 * Action registry, not two hand-written implementations.
 *
 * These are deliberately property-style: for several (prompt, tier) inputs we
 * drive the same capability through both adapters and assert the canonical
 * Job in the store is identical. Protocol-specific shaping (MCP text blocks vs
 * A2A Task) is allowed to differ; the underlying capability is not.
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
import { createDispatcher, TOOL_DEFINITIONS } from '../dist/tools.js';
import { ACTIONS, actionNames, getAction } from '../dist/actions/index.js';
import { VERSION } from '../dist/version.js';
import { fakeBin } from './fake-bin.mjs';
import { rmrf } from './tmp.mjs';

const FAKE = fakeBin('actions');
chmodSync(FAKE, 0o755);

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbrepo-actions-'));
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

function makeConfig(repo, stateDir) {
  return {
    cursorBin: FAKE,
    workspaceRoots: [repo],
    stateDir,
    defaultTimeoutSec: 30,
    maxTimeoutSec: 60,
    // Property loops start several async jobs in one instance; the production
    // default of 4 would trip E_CONCURRENCY. This is a fixture-only ceiling.
    maxConcurrency: 16,
    defaultModel: undefined,
    forceWorktree: false,
    maxResultBytes: 2 * 1024 * 1024,
    maxEventsPerJob: 2000,
    maxJobs: 100,
    logLevel: 'error',
    adminPort: 0,
    eventLogDir: undefined,
    extraArgs: [],
    a2aPort: 0,
    a2aHost: '127.0.0.1',
    a2aAuthToken: undefined,
    a2aPublicUrl: undefined,
  };
}

async function rmSafe(target) {
  for (let i = 0; i < 20; i += 1) {
    try { rmrf(target); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  try { rmrf(target); } catch { /* best effort */ }
}

async function withBridge(fn) {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-actions-'));
  const log = new Logger({ level: 'error', fileDir: stateDir });
  const config = makeConfig(repo, stateDir);
  config.a2aPort = await freePort();
  const mgr = new JobManager(config, log);
  const server = startA2AServer(mgr, { config, version: VERSION, log: log.child('a2a') });
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const mcp = createDispatcher(mgr);
  try {
    return await fn({ base, mgr, mcp, repo });
  } finally {
    server.close();
    // Drain in-flight jobs before removing their workspace/state directories,
    // otherwise a late isolation step logs a spurious "spawn git ENOENT".
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

const legacyMessage = (text, tier, id = randomUUID()) => ({
  role: 'user',
  parts: [{ kind: 'text', text }],
  messageId: id,
  ...(tier ? { metadata: { tier } } : {}),
});

const mcpPayload = (result) => JSON.parse(result.content[0].text);

/* ----------------------------------------------------------------- tests */

test('actions: MCP tool list is generated from the single registry', () => {
  assert.equal(ACTIONS.length, 9);
  assert.equal(TOOL_DEFINITIONS.length, ACTIONS.length);
  assert.deepEqual(
    TOOL_DEFINITIONS.map((t) => t.name).sort(),
    actionNames().sort(),
  );
  // Same object identity: no second hand-maintained schema copy.
  for (let i = 0; i < ACTIONS.length; i += 1) {
    assert.equal(TOOL_DEFINITIONS[i].inputSchema, ACTIONS[i].inputSchema);
    assert.equal(TOOL_DEFINITIONS[i].description, ACTIONS[i].description);
  }
  // Adding an action is a one-place change: names are unique, so the registry
  // is the only place a capability has to be declared.
  assert.equal(new Set(actionNames()).size, actionNames().length);
});

test('actions: shared validation gives MCP the same E_BAD_ARGUMENT as the parser', async () => {
  const parseErr = (() => {
    try { getAction('cursor_run').parse({ prompt: 'x', workspace: '/tmp', tier: 'bogus' }); }
    catch (e) { return e.message; }
    return null;
  })();
  assert.match(parseErr, /"tier" must be one of consult \| plan \| execute/);

  await withBridge(async ({ mcp, repo }) => {
    const r = await mcp('cursor_run', { prompt: 'x', workspace: repo, tier: 'bogus' });
    assert.equal(r.isError, true);
    assert.ok(r.content[0].text.startsWith('E_BAD_ARGUMENT:'));
    assert.ok(r.content[0].text.includes(parseErr), 'MCP surfaces the shared parser message');
  });
});

test('actions: run via MCP and A2A yields identical canonical Job fields', async () => {
  await withBridge(async ({ base, mgr, mcp, repo }) => {
    const cases = [
      ['dual-surface consult probe', 'consult'],
      ['dual-surface plan probe', 'plan'],
      ['dual-surface execute probe', 'execute'],
    ];
    for (const [prompt, tier] of cases) {
      // MCP face.
      const m = await mcp('cursor_run', { prompt, workspace: repo, tier });
      assert.equal(m.isError, undefined, `MCP run failed: ${m.content[0].text}`);
      const mcpJobId = mcpPayload(m).jobId;

      // A2A face (same canonical input).
      const a = await rpc(base, 'message/send', { message: legacyMessage(prompt, tier) });
      assert.ok(a.result?.id, `A2A send failed: ${JSON.stringify(a)}`);
      const a2aJobId = a.result.id;

      const jm = mgr.store.get(mcpJobId);
      const ja = mgr.store.get(a2aJobId);
      assert.ok(jm && ja);
      assert.notEqual(mcpJobId, a2aJobId, 'each face starts its own job');
      for (const field of ['prompt', 'tier', 'workspace']) {
        assert.equal(ja[field], jm[field], `${field} must not drift between MCP and A2A`);
      }
      assert.equal(ja.prompt, prompt);
      assert.equal(ja.tier, tier);
    }
  });
});

test('actions: cancel is one implementation shared by both faces', async () => {
  await withBridge(async ({ base, mgr, mcp, repo }) => {
    const cancel = getAction('cursor_cancel');
    assert.ok(cancel, 'cursor_cancel is registered');

    // Drive one job through MCP, one through A2A, cancel both through the
    // shared Action, and check the terminal state is the same.
    const m = await mcp('cursor_run', { prompt: 'cancel probe', workspace: repo, tier: 'consult' });
    const mcpJobId = mcpPayload(m).jobId;
    const a = await rpc(base, 'message/send', { message: legacyMessage('cancel probe', 'consult') });
    const a2aJobId = a.result.id;

    for (const id of [mcpJobId, a2aJobId]) {
      await cancel.invoke({ mgr }, cancel.parse({ jobId: id }));
    }
    assert.equal(mgr.store.get(mcpJobId).status, mgr.store.get(a2aJobId).status);
    assert.equal(mgr.store.get(mcpJobId).status, 'cancelled');
  });
});
