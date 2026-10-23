/**
 * A2A interoperability tests.
 *
 * These hit the real A2A HTTP surface (Agent Card + JSON-RPC) with a genuine
 * `fetch` client, driving the same JobManager the MCP bridge uses. They prove
 * the bridge is now a conformant A2A agent another agent can discover and talk
 * to: Agent Card discovery, message/send, tasks/get, tasks/cancel, SSE
 * streaming (message/stream), the input-required round-trip, push notifications
 * and bearer-token authentication.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { JobManager } from '../dist/runner.js';
import { Logger } from '../dist/logger.js';
import { startA2AServer } from '../dist/a2a/server.js';
import { VERSION } from '../dist/version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'test', 'a2a-fake-agent.mjs');

// The bridge spawns the fake agent as a real executable, so it must be
// executable for the whole suite. Do this once at import time.
chmodSync(FAKE, 0o755);

/** Grab a free TCP port so each test server binds without collision. */
async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  await new Promise((r) => srv.close(r));
  return port;
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbrepo-a2a-'));
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

function makeConfig(repo, stateDir, overrides = {}) {
  return {
    cursorBin: FAKE,
    workspaceRoots: [repo],
    stateDir,
    defaultTimeoutSec: 30,
    maxTimeoutSec: 60,
    maxConcurrency: 4,
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
    ...overrides,
  };
}

async function startServer(config, log) {
  // The bridge treats a2aPort 0 as "disabled"; allocate a real free port so the
  // test always brings the surface up. (Production keeps 0 = off.)
  config.a2aPort = await freePort();
  const mgr = new JobManager(config, log);
  const server = startA2AServer(mgr, { config, version: VERSION, log: log.child('a2a') });
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : config.a2aPort;
  return { mgr, server, base: `http://127.0.0.1:${port}` };
}

async function rpc(base, method, params, { token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}/a2a`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

function userMessage(text, metadata) {
  return { role: 'user', parts: [{ kind: 'text', text }], metadata };
}

/** Extract the first text part from an A2A Message (A2A carries text in parts). */
function messageText(message) {
  if (!message) return '';
  for (const part of message.parts ?? []) {
    if (part.kind === 'text' && part.text) return part.text;
  }
  return '';
}

/**
 * Remove a directory, retrying across the brief window a spawned agent process
 * may still hold a working directory inside it after cancel. Best-effort; the
 * job's worktree lives under stateDir, so the repo may be momentarily busy.
 */
async function rmSafe(target) {
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    /* give up quietly */
  }
}

async function waitForTask(base, id, states, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await rpc(base, 'tasks/get', { id, historyLength: 20 });
    const state = body.result?.status?.state;
    if (states.includes(state)) return body.result;
    if (Date.now() > deadline) {
      throw new Error(`task ${id} did not reach ${states.join('/')} (stuck at ${state})`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Read an SSE stream into parsed A2A events. */
async function readSse(response, timeoutMs = 15000) {
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          events.push(JSON.parse(line.slice(6)));
        }
      }
    }
    const final = events.find((e) => e.kind === 'status-update' && e.final);
    if (final) break;
  }
  return events;
}

async function startPushMock() {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try { received.push(JSON.parse(data)); } catch { received.push(data); }
        res.writeHead(200); res.end('ok');
      });
      return;
    }
    res.writeHead(405); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return { server, received, url: `http://127.0.0.1:${port}/hook` };
}

/* ----------------------------------------------------------------- tests */

test('a2a: Agent Card is discoverable and spec-shaped', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const res = await fetch(`${base}/.well-known/agent.json`);
    assert.equal(res.status, 200);
    const card = await res.json();
    assert.match(card.schema, /agent-card\.json$/);
    assert.equal(card.protocolVersion, '0.3.0');
    assert.equal(card.capabilities.streaming, true);
    assert.equal(card.capabilities.pushNotifications, true);
    assert.equal(card.capabilities.stateTransitionHistory, true);
    assert.ok(Array.isArray(card.skills) && card.skills.length >= 1);
    assert.ok(card.url.endsWith('/a2a'));
    assert.ok(card.skills[0].id && card.skills[0].inputModes.includes('text/plain'));
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a: message/send creates a task and it completes', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const { status, body } = await rpc(base, 'message/send', { message: userMessage('implement the feature') });
    assert.equal(status, 200);
    const task = body.result;
    assert.ok(task.id, 'task has an id');
    assert.ok(task.contextId, 'task has a contextId');
    assert.ok(['submitted', 'working'].includes(task.status.state), `got ${task.status.state}`);

    const done = await waitForTask(base, task.id, ['completed']);
    assert.equal(done.status.state, 'completed');
    assert.match(messageText(done.status.message), /FAKE_RESULT:ok/);
    // History should contain the originating user message.
    const userTurn = (done.history ?? []).find((m) => m.role === 'user');
    assert.ok(userTurn, 'history carries the user prompt');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a: tasks/get returns the task; tasks/cancel works on a running task', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const { body } = await rpc(base, 'message/send', { message: userMessage('LONGRUN please stay busy') });
    const id = body.result.id;
    const got = await rpc(base, 'tasks/get', { id });
    assert.equal(got.body.result.id, id);

    const cancelled = await rpc(base, 'tasks/cancel', { id });
    assert.equal(cancelled.body.result.status.state, 'canceled');

    const after = await rpc(base, 'tasks/get', { id });
    assert.equal(after.body.result.status.state, 'canceled');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a: tasks/cancel on a terminal task returns TASK_NOT_CANCELABLE', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const { body } = await rpc(base, 'message/send', { message: userMessage('quick job') });
    const id = body.result.id;
    await waitForTask(base, id, ['completed']);
    const res = await rpc(base, 'tasks/cancel', { id });
    assert.equal(res.body.error.code, -32002);
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a: message/stream delivers status events over SSE and ends final', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const res = await fetch(`${base}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'message/stream',
        params: { message: userMessage('stream me') },
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = await readSse(res);
    const finals = events.filter((e) => e.kind === 'status-update' && e.final);
    assert.equal(finals.length, 1, 'exactly one final event');
    assert.equal(finals[0].status.state, 'completed');
    assert.ok(events.some((e) => e.kind === 'status-update'));
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a: input-required round-trip resumes the SAME task (no new task)', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const first = await rpc(base, 'message/send', { message: userMessage('NEEDINPUT figure this out') });
    const id = first.body.result.id;
    const paused = await waitForTask(base, id, ['input-required']);
    assert.equal(paused.status.state, 'input-required');
    assert.match(messageText(paused.status.message), /which file/);

    // Resume by sending input referencing the SAME task id at the A2A message
    // top level (A2A carries taskId on the Message, not in metadata).
    const resumed = await rpc(base, 'message/send', {
      message: {
        role: 'user',
        parts: [{ kind: 'text', text: 'edit src/index.ts' }],
        taskId: id,
      },
    });
    assert.equal(resumed.body.result.id, id, 'same task id is resumed, not a new one');
    const done = await waitForTask(base, id, ['completed']);
    assert.equal(done.status.state, 'completed');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a: push notifications are POSTed to the webhook on completion', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-'));
  const mock = await startPushMock();
  // Push webhooks require A2A auth (SSRF guard) and an allowlist for the local
  // mock host, both of which mirror production hardening.
  const { server, base } = await startServer(
    makeConfig(repo, stateDir, {
      a2aAuthToken: 'topsecret',
      a2aPushUrlAllowlist: ['127.0.0.1', 'localhost'],
    }),
    new Logger({ level: 'error', fileDir: stateDir }),
  );
  try {
    const { body } = await rpc(base, 'message/send', {
      message: userMessage('please notify', {
        pushNotification: { url: mock.url, token: 'sec' },
      }),
    }, { token: 'topsecret' });
    const id = body.result.id;
    const deadline = Date.now() + 12000;
    let finalEvent;
    while (Date.now() < deadline) {
      finalEvent = mock.received.find((e) => e.kind === 'status-update' && e.final);
      if (finalEvent) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(finalEvent, 'webhook received a final status-update');
    assert.equal(finalEvent.status.state, 'completed');
    assert.equal(finalEvent.taskId, id);
  } finally {
    server.close();
    mock.server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a: push webhook to a loopback host is rejected without allowlist (SSRF guard)', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-'));
  const mock = await startPushMock();
  const { server, base } = await startServer(
    makeConfig(repo, stateDir, { a2aAuthToken: 'topsecret' }),
    new Logger({ level: 'error', fileDir: stateDir }),
  );
  try {
    const { body } = await rpc(base, 'message/send', {
      message: userMessage('notify to internal host', {
        pushNotification: { url: mock.url, token: 'sec' },
      }),
    }, { token: 'topsecret' });
    // Task still created; the webhook is simply not honoured.
    assert.ok(body.result?.id, 'task created despite rejected webhook');
    const deadline = Date.now() + 6000;
    let got = false;
    while (Date.now() < deadline) {
      if (mock.received.length > 0) { got = true; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(got, false, 'no push delivered to the loopback host');
  } finally {
    server.close();
    mock.server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a: bearer token guards the endpoint but not the Agent Card', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-'));
  const { server, base } = await startServer(
    makeConfig(repo, stateDir, { a2aAuthToken: 'topsecret' }),
    new Logger({ level: 'error', fileDir: stateDir }),
  );
  try {
    // Agent Card stays public.
    const cardRes = await fetch(`${base}/.well-known/agent.json`);
    assert.equal(cardRes.status, 200);
    assert.ok(cardRes.headers.get('content-type').includes('json'));

    // POST without token -> 401.
    const noToken = await rpc(base, 'tasks/get', { id: 'nope' });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.error.code, -32097);

    // POST with token -> reaches the handler (here, unknown task -> TASK_NOT_FOUND).
    const withToken = await rpc(base, 'tasks/get', { id: 'nope' }, { token: 'topsecret' });
    assert.equal(withToken.status, 200);
    assert.equal(withToken.body.error.code, -32001);
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

/* ---------------------------------------------------- P0-A: LRU must spare input-required */

test('a2a(P0-A): isLive and LRU eviction never drop an input-required task', async () => {
  const { JobStore, isLive } = await import('../dist/store.js');
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-evict-'));
  try {
    assert.equal(isLive('running'), true);
    assert.equal(isLive('input-required'), true);
    assert.equal(isLive('completed'), false);
    assert.equal(isLive('cancelled'), false);
    assert.equal(isLive('failed'), false);

    const store = new JobStore(stateDir, { maxJobs: 3, maxEventsPerJob: 10 });
    const repoForStore = '/tmp/wbstore';
    const mk = (status) => ({
      id: randomUUID(),
      tier: 'execute',
      workspace: repoForStore,
      prompt: 'p',
      status,
      createdAt: new Date(Date.now() - Math.floor(Math.random() * 1000)).toISOString(),
      events: [],
      cursor: 0,
    });

    // Two finished jobs, then an input-required, then over-fill with finished.
    store.create(mk('completed'));
    store.create(mk('completed'));
    const ir = mk('input-required');
    store.create(ir);
    store.create(mk('completed')); // 4th -> evict one finished
    store.create(mk('completed')); // 5th -> evict another finished

    assert.ok(store.get(ir.id), 'input-required task survives LRU eviction');
  } finally {
    await rmSafe(stateDir);
  }
});

test('a2a(P0-A): input-required task survives LRU and resumes after many completed tasks', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-lru-'));
  // Small cap so a handful of completed tasks triggers eviction.
  const { server, base } = await startServer(
    makeConfig(repo, stateDir, { maxJobs: 3 }),
    new Logger({ level: 'error', fileDir: stateDir }),
  );
  try {
    // One input-required task.
    const first = await rpc(base, 'message/send', { message: userMessage('NEEDINPUT hold') });
    const id = first.body.result.id;
    await waitForTask(base, id, ['input-required']);

    // Over-fill with completed tasks to drive eviction pressure.
    for (let i = 0; i < 4; i += 1) {
      const { body } = await rpc(base, 'message/send', { message: userMessage(`finish job ${i}`) });
      await waitForTask(base, body.result.id, ['completed']);
    }

    // The paused task must still be resolvable and resumable on the SAME id.
    const got = await rpc(base, 'tasks/get', { id });
    assert.equal(got.body.result.status.state, 'input-required', 'paused task was not evicted');

    const resumed = await rpc(base, 'message/send', {
      message: { role: 'user', parts: [{ kind: 'text', text: 'edit src/index.ts' }], taskId: id },
    });
    assert.equal(resumed.body.result.id, id, 'same task id resumes after eviction pressure');
    await waitForTask(base, id, ['completed']);
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

/* ---------------------------------------------------- P0-B: artifact `name` + fetch */

test('a2a(P0-B): file artifacts use standard `name` and are fetchable over HTTP', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-art-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const { body } = await rpc(base, 'message/send', { message: userMessage('WRITEFILE create a file') });
    const id = body.result.id;
    const done = await waitForTask(base, id, ['completed']);

    const patch = (done.artifacts ?? []).find((a) => a.name === 'changes.patch');
    assert.ok(patch, 'changes.patch artifact is present');
    const filePart = patch.parts.find((p) => p.kind === 'file');
    assert.ok(filePart?.file?.name, 'file part carries the standard `name` field');
    assert.equal(filePart.file.name, 'changes.patch');
    assert.ok(!('filename' in (filePart.file ?? {})), 'legacy `filename` field is gone');
    assert.ok(filePart.file.uri?.includes('/a2a/artifacts/'), 'uri points at the artifact endpoint');

    const res = await fetch(filePart.file.uri);
    assert.equal(res.status, 200, 'artifact endpoint returns 200');
    const txt = await res.text();
    assert.ok(txt.includes('written-by-fake.txt'), 'patch content is retrievable by a remote caller');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

/* ---------------------------------------------------- P1: cancel metric + terminal rejection */

test('a2a(P1): cancelling a running task is counted in metrics', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-cancel-'));
  const mgr = new JobManager(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const before = mgr.getMetrics().cancelled;
    const job = mgr.start({ prompt: 'LONGRUN keep busy', workspace: repo, tier: 'execute' });
    mgr.cancel(job.id);
    assert.equal(mgr.getMetrics().cancelled, before + 1, 'running cancel increments metrics.cancelled');
  } finally {
    await mgr.shutdown();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a(P1): message/send on a terminal task is rejected (no non-idempotent follow-up)', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-term-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const { body } = await rpc(base, 'message/send', { message: userMessage('finish me') });
    const id = body.result.id;
    await waitForTask(base, id, ['completed']);

    const retry = await rpc(base, 'message/send', {
      message: { role: 'user', parts: [{ kind: 'text', text: 'more work' }], taskId: id },
    });
    assert.equal(retry.body.error?.code, -32602, 'terminal taskId is rejected with INVALID_PARAMS');
    assert.ok(!retry.body.result, 'no new task is spawned from a terminal taskId');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

/* ---------------------------------------------------- P2: observability + role guard */

test('a2a(P2): /healthz /metrics /version endpoints and message/send role guard', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-obs-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const h = await fetch(`${base}/healthz`);
    assert.equal(h.status, 200);
    assert.equal((await h.json()).status, 'healthy');

    const v = await fetch(`${base}/version`);
    assert.equal(v.status, 200);
    assert.equal((await v.json()).version, VERSION);

    const m = await fetch(`${base}/metrics`);
    assert.equal(m.status, 200);
    assert.ok((await m.json()).started !== undefined, 'metrics payload returned');

      // message/send requires role "user"; an agent role is a protocol error.
    const bad = await rpc(base, 'message/send', {
      message: { role: 'agent', parts: [{ kind: 'text', text: 'hello' }] },
    });
    assert.equal(bad.body.error?.code, -32602, 'non-user role rejected');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

/* ---------------------------------------------------- Phase 3 #20: worktree cleanup on crash */

/** Leftover worktree directories under stateDir/worktrees, if any. */
function leftoverWorktrees(stateDir) {
  const dir = path.join(stateDir, 'worktrees');
  try {
    return fs.readdirSync(dir).filter((e) => e.startsWith('wb-'));
  } catch {
    return [];
  }
}

test('a2a(P3#20): a crashed agent does not leak its git worktree', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-wt-'));
  // forceWorktree=true makes the bridge own a worktree even for a quick job; a
  // CRASH marker makes the fake agent exit(7) before emitting output, which used
  // to skip the capture block and leak the worktree on disk.
  const { server, base } = await startServer(
    makeConfig(repo, stateDir, { forceWorktree: true }),
    new Logger({ level: 'error', fileDir: stateDir }),
  );
  try {
    const { body } = await rpc(base, 'message/send', { message: userMessage('CRASH blow up') });
    const id = body.result.id;
    const done = await waitForTask(base, id, ['failed'], 8000);
    assert.equal(done.status.state, 'failed', 'crashed task is marked failed');
    // Give the finally block a beat to remove the worktree.
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(
      leftoverWorktrees(stateDir),
      [],
      'no worktree left behind after the agent crashed',
    );
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

/* ---------------------------------------------------- Phase 2 #12: configuration negotiation */

test('a2a(P2#12): blocking message/send returns a settled task', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-block-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const { status, body } = await rpc(base, 'message/send', {
      message: userMessage('finish me quickly'),
      configuration: { blocking: true },
    });
    assert.equal(status, 200);
    // A blocking call must not return a still-working task.
    assert.ok(['completed', 'failed'].includes(body.result.status.state), `got ${body.result.status.state}`);
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a(P2#12): acceptedOutputModes with no overlap is rejected', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-neg-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const bad = await rpc(base, 'message/send', {
      message: userMessage('i only accept images'),
      configuration: { acceptedOutputModes: ['image/png'] },
    });
    assert.equal(bad.body.error?.code, -32005, 'INCOMPATIBLE_CONTENT_TYPES');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a(P2#12): acceptedOutputModes that overlap is accepted', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-pos-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const { status, body } = await rpc(base, 'message/send', {
      message: userMessage('overlap is fine'),
      configuration: { acceptedOutputModes: ['text/plain'] },
    });
    assert.equal(status, 200);
    assert.ok(body.result?.id, 'task created when modes overlap');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a(P2#12): historyLength is honoured on message/send', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-hist-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const { body } = await rpc(base, 'message/send', {
      message: userMessage('finish me'),
      configuration: { historyLength: 5 },
    });
    const id = body.result.id;
    await waitForTask(base, id, ['completed']);
    const got = await rpc(base, 'tasks/get', { id, historyLength: 5 });
    assert.ok(Array.isArray(got.body.result.history), 'history present with historyLength');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

/* ---------------------------------------------------- Phase 2 #14: notifications get no response */

/** Send a raw HTTP POST and collect any response bytes within `timeoutMs`. */
function rawPost(port, payload, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, timeoutMs);
    socket.on('data', (c) => (data += c.toString('utf8')));
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.on('connect', () => {
      const body = JSON.stringify(payload);
      socket.write(
        `POST /a2a HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    });
  });
}

test('a2a(P2#14): a JSON-RPC notification (no id) receives no response', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-notif-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const port = new URL(base).port;
    // A request without an `id` is a notification; per JSON-RPC 2.0 the server
    // MUST NOT reply, even though it still executes the side effect.
    const data = await rawPost(Number(port), {
      jsonrpc: '2.0',
      method: 'message/send',
      params: { message: userMessage('a silent notification') },
    });
    assert.equal(data.trim().length, 0, 'no response body for a notification');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

/* ---------------------------------------------------- Phase 2 #15: rate limit + CORS */

test('a2a(P2#15): token-bucket rate limit returns 429 past the burst', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-rl-'));
  // Tiny limit (5/sec) so the test can trip it deterministically.
  const { server, base } = await startServer(
    makeConfig(repo, stateDir, { a2aRateLimitPerSec: 5 }),
    new Logger({ level: 'error', fileDir: stateDir }),
  );
  try {
    const results = await Promise.all(
      Array.from({ length: 9 }, () => rpc(base, 'message/send', { message: userMessage('flood') })),
    );
    const tooMany = results.filter((r) => r.status === 429).length;
    assert.ok(tooMany >= 1, 'at least one request is rate-limited');
    // A sane agent under the default limit is never throttled.
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a(P2#15): default rate limit does not throttle normal traffic', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-rl2-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => rpc(base, 'message/send', { message: userMessage('normal') })),
    );
    const limited = results.filter((r) => r.status === 429).length;
    assert.equal(limited, 0, 'no 429 under the generous default limit');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a(P2#15): CORS headers appear when origins are configured', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-cors-'));
  const { server, base } = await startServer(
    makeConfig(repo, stateDir, { a2aCorsOrigins: ['http://console.example.com'] }),
    new Logger({ level: 'error', fileDir: stateDir }),
  );
  try {
    // Preflight.
    const preflight = await fetch(`${base}/a2a`, {
      method: 'OPTIONS',
      headers: { origin: 'http://console.example.com' },
    });
    assert.equal(preflight.status, 204, 'preflight returns 204');
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://console.example.com');

    // CORS header reflected on a real request.
    const res = await fetch(`${base}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://console.example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'nope' } }),
    });
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://console.example.com');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a(P2#15): CORS headers are absent when not configured', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-cors2-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const res = await fetch(`${base}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'nope' } }),
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS header by default');
    const preflight = await fetch(`${base}/a2a`, {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example.com' },
    });
    assert.equal(preflight.status, 405, 'no preflight support by default');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

/* ---------------------------------------------------- Phase 3 #19: A2A v1.0 migration route */

test('a2a(P3#19): v1.0 Agent Card drops top-level protocolVersion for supportedInterfaces', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-v1card-'));
  const { server, base } = await startServer(
    makeConfig(repo, stateDir, { a2aProtocolVersion: '1.0' }),
    new Logger({ level: 'error', fileDir: stateDir }),
  );
  try {
    const card = await (await fetch(`${base}/.well-known/agent.json`)).json();
    assert.equal(card.protocolVersion, undefined, 'v1.0 card has no top-level protocolVersion');
    assert.ok(Array.isArray(card.supportedInterfaces), 'v1.0 card declares supportedInterfaces');
    assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
    assert.ok(Array.isArray(card.extensions), 'v1.0 card declares extensions');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a(P3#19): v1.0 tasks encode FileContent as url/filename/mediaType/raw', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-v1task-'));
  const { server, base } = await startServer(
    makeConfig(repo, stateDir, { a2aProtocolVersion: '1.0' }),
    new Logger({ level: 'error', fileDir: stateDir }),
  );
  try {
    const { body } = await rpc(base, 'message/send', { message: userMessage('WRITEFILE create a file') });
    const id = body.result.id;
    const done = await waitForTask(base, id, ['completed']);
    const patch = (done.artifacts ?? []).find((a) => a.name === 'changes.patch');
    assert.ok(patch, 'changes.patch artifact present in v1.0');
    const filePart = patch.parts.find((p) => p.kind === 'file');
    assert.ok(filePart?.file?.filename, 'v1.0 uses file.filename');
    assert.ok(filePart.file.url?.includes('/a2a/artifacts/'), 'v1.0 uses file.url');
    assert.ok(!('name' in (filePart.file ?? {})), 'v1.0 has no legacy name field');
    assert.ok(!('uri' in (filePart.file ?? {})), 'v1.0 has no legacy uri field');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

test('a2a(P3#19): v0.3.0 remains the default wire version', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-v0-'));
  const { server, base } = await startServer(makeConfig(repo, stateDir), new Logger({ level: 'error', fileDir: stateDir }));
  try {
    const card = await (await fetch(`${base}/.well-known/agent.json`)).json();
    assert.equal(card.protocolVersion, '0.3.0', 'default card still v0.3.0');
    assert.equal(card.supportedInterfaces, undefined, 'v0.3.0 card has no supportedInterfaces');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});

/* ---------------------------------------------------- Phase 3 #18: skill extension point */

test('a2a(P3#18): extra skills are added and roots outside the allowlist are dropped', async () => {
  const { deriveSkills } = await import('../dist/a2a/skills.js');
  const roots = [mkdtempSync(path.join(os.tmpdir(), 'wbroot-skill-'))];
  const created = [];
  const log = {
    warn: (m, f) => created.push({ m, f }),
    child: () => log,
    info: () => {},
    debug: () => {},
    error: () => {},
  };
  const extra = [
    { id: 'review-root', root: roots[0], name: 'Review skill' },
    { id: 'outside', root: '/tmp/definitely-not-a-root', name: 'escaping skill' },
  ];
  const skills = deriveSkills(roots, 'execute', extra, log);
  const ids = skills.map((s) => s.id);
  assert.ok(ids.includes('review-root'), 'declared extra skill is present');
  assert.ok(!ids.includes('outside'), 'skill rooted outside the allowlist is dropped');
  assert.ok(created.some((c) => c.m?.includes('outside')), 'dropped skill is logged');
});

test('a2a(P3#18): configured extra skills surface on the Agent Card', async () => {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2a-skill-'));
  const { server, base } = await startServer(
    makeConfig(repo, stateDir, {
      a2aSkills: [{ id: 'review', root: repo, name: 'Code review skill' }],
    }),
    new Logger({ level: 'error', fileDir: stateDir }),
  );
  try {
    const card = await (await fetch(`${base}/.well-known/agent.json`)).json();
    const ids = card.skills.map((s) => s.id);
    assert.ok(ids.includes('review'), 'operator-declared skill appears on the card');
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
});
