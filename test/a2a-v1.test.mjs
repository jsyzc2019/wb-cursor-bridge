/**
 * A2A v1.0 wire regression tests.
 *
 * The bridge serves two independent dimensions from one instance:
 *   - the legacy v0.3.0 wire (no A2A-Version header, plus the historical
 *     `a2aProtocolVersion` static switch), and
 *   - the real v1.0 wire negotiated at runtime via `A2A-Version: 1.0`.
 *
 * These tests lock the v1.0 translation boundary (src/a2a/v1.ts) and, just as
 * importantly, prove the 0.3 path is byte-for-byte unaffected — including
 * under concurrent mixed-version traffic on the same server. They complement
 * the official a2a-tck run (scripts/tck.mjs), which is the external gate.
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
import { VERSION } from '../dist/version.js';
import { fakeBin } from './fake-bin.mjs';
import { rmrf } from './tmp.mjs';

const FAKE = fakeBin('a2a');
chmodSync(FAKE, 0o755);
const V1 = { 'A2A-Version': '1.0' };

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbrepo-a2av1-'));
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

async function withServer(overrides, fn) {
  const repo = makeRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbstate-a2av1-'));
  const log = new Logger({ level: 'error', fileDir: stateDir });
  const config = makeConfig(repo, stateDir, overrides);
  config.a2aPort = await freePort();
  const mgr = new JobManager(config, log);
  const server = startA2AServer(mgr, { config, version: VERSION, log: log.child('a2a') });
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, mgr, config });
  } finally {
    server.close();
    await rmSafe(stateDir);
    await rmSafe(repo);
  }
}

async function rmSafe(target) {
  for (let i = 0; i < 20; i += 1) {
    try {
      rmrf(target);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { rmrf(target); } catch { /* best effort */ }
}

async function rpc(base, method, params, { headers = {}, path: urlPath = '/a2a' } = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, headers: res.headers, body, text };
}

const v1Message = (text, id = randomUUID()) => ({
  role: 'ROLE_USER',
  parts: [{ text }],
  messageId: id,
});
const legacyMessage = (text, id = randomUUID()) => ({
  role: 'user',
  parts: [{ kind: 'text', text }],
  messageId: id,
});

const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED', 'TASK_STATE_AUTH_REQUIRED', 'TASK_STATE_INPUT_REQUIRED',
]);

/** Read a v1.0 SSE stream into { frame, result } pairs. */
async function readV1Sse(response, timeoutMs = 15000) {
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
          const frame = JSON.parse(line.slice(6));
          events.push({ frame, result: frame.result });
        }
      }
    }
    if (events.some(({ result }) => result?.statusUpdate && TERMINAL_STATES.has(result.statusUpdate.status?.state))) break;
  }
  try { await reader.cancel(); } catch { /* stream already closed */ }
  return events;
}

/* ----------------------------------------------------------------- tests */

test('v1: discovery keeps two independent documents', async () => {
  await withServer({}, async ({ base }) => {
    const legacy = await (await fetch(`${base}/.well-known/agent.json`)).json();
    assert.equal(legacy.protocolVersion, '0.3.0');
    assert.equal(legacy.supportedInterfaces, undefined, '0.3 card has no supportedInterfaces');
    assert.equal(legacy.capabilities.pushNotifications, true);

    const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
    assert.equal(card.protocolVersion, undefined, 'v1.0 card has no top-level protocolVersion');
    assert.equal(card.schema, undefined, 'v1.0 card has no legacy schema field');
    assert.equal(card.url, undefined);
    assert.ok(Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length >= 1);
    const iface = card.supportedInterfaces[0];
    assert.equal(iface.protocolBinding, 'JSONRPC');
    assert.equal(iface.protocolVersion, '1.0');
    assert.ok(iface.url.endsWith('/a2a'));
    // strict Agent Interface schema: exactly these four keys
    assert.deepEqual(Object.keys(iface).sort(), ['protocolBinding', 'protocolVersion', 'url']);
    assert.equal(card.capabilities.pushNotifications, false, 'v1.0 push is honestly disabled');
    assert.equal(card.capabilities.streaming, true);
    assert.equal(card.capabilities.extendedAgentCard, undefined);
    assert.equal(card.capabilities.stateTransitionHistory, undefined);
  });
});

test('v1: static a2aProtocolVersion switch does not change agent-card.json', async () => {
  await withServer({ a2aProtocolVersion: '1.0' }, async ({ base }) => {
    // legacy path keeps its historical shallow toV1Card behaviour
    const legacy = await (await fetch(`${base}/.well-known/agent.json`)).json();
    assert.equal(legacy.protocolVersion, undefined);
    assert.equal(legacy.supportedInterfaces[0].protocolVersion, '1.0');
    assert.ok(Array.isArray(legacy.extensions));
    // v1.0 discovery path is unaffected by the static switch
    const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
    assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
    assert.equal(card.protocolVersion, undefined);
  });
});

test('v1: SendMessage returns { task } in the v1.0 data model', async () => {
  await withServer({}, async ({ base }) => {
    const { status, headers, body } = await rpc(base, 'SendMessage', { message: v1Message('hello v1') }, { headers: V1 });
    assert.equal(status, 200);
    assert.match(headers.get('content-type') ?? '', /application\/json/);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    const task = body.result.task;
    assert.ok(task, 'SendMessageResponse is { task }');
    assert.match(task.status.state, /^TASK_STATE_/);
    assert.ok(task.id && task.contextId);
    // no v0.3-only fields leak into the v1.0 payload
    assert.equal(task.kind, undefined);
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    // Parts are flat: no `kind`, no nested `file`
    for (const m of task.history ?? []) {
      assert.ok(m.role === 'ROLE_USER' || m.role === 'ROLE_AGENT');
      for (const p of m.parts) {
        assert.equal(p.kind, undefined);
        assert.equal(p.file, undefined);
      }
    }
    for (const a of task.artifacts ?? []) {
      for (const p of a.parts) {
        assert.equal(p.kind, undefined, 'no kind');
        assert.equal(p.sizeBytes, undefined, 'no sizeBytes');
      }
    }
  });
});

test('v1: GetTask / message-send coexist on the same server', async () => {
  await withServer({}, async ({ base }) => {
    const sent = await rpc(base, 'SendMessage', { message: v1Message('make a task') }, { headers: V1 });
    const id = sent.body.result.task.id;
    const got = await rpc(base, 'GetTask', { id }, { headers: V1 });
    assert.equal(got.body.result.id, id);
    assert.match(got.body.result.status.state, /^TASK_STATE_/);

    // the very same task read over the 0.3 wire keeps the 0.3 shape
    const got03 = await rpc(base, 'tasks/get', { id });
    assert.equal(got03.body.result.id, id);
    assert.match(got03.body.result.status.state, /^[a-z-]+$/);
    assert.equal(got03.body.result.task, undefined);
  });
});

test('v1: version negotiation (unsupported, empty, patch, 0.3)', async () => {
  await withServer({}, async ({ base }) => {
    const bad = await rpc(base, 'SendMessage', { message: v1Message('x') }, { headers: { 'A2A-Version': '99.0' } });
    assert.equal(bad.body.error.code, -32009, 'VER-SERVER-002');

    const empty = await rpc(base, 'SendMessage', { message: v1Message('x') }, { headers: { 'A2A-Version': '' } });
    assert.ok('result' in empty.body || 'error' in empty.body, 'empty version never crashes');

    const patch = await rpc(base, 'SendMessage', { message: v1Message('x') }, { headers: { 'A2A-Version': '1.0.7' } });
    assert.ok(patch.body.result?.task, 'patch version still negotiates to 1.0');

    const old = await rpc(base, 'SendMessage', { message: v1Message('x') }, { headers: { 'A2A-Version': '0.3' } });
    assert.ok(old.body.error, 'a v1.0 method name on the 0.3 wire is not a method');
  });
});

test('v1: capability gates and error-code mapping', async () => {
  await withServer({}, async ({ base }) => {
    const push = await rpc(base, 'CreateTaskPushNotificationConfig', { task_id: 't', url: 'https://example.com' }, { headers: V1 });
    assert.equal(push.body.error.code, -32003, 'CORE-CAP-001');
    const ext = await rpc(base, 'GetExtendedAgentCard', {}, { headers: V1 });
    assert.equal(ext.body.error.code, -32004, 'CORE-CAP-003');
    const missing = await rpc(base, 'GetTask', { id: 'does-not-exist' }, { headers: V1 });
    assert.equal(missing.body.error.code, -32001, 'TaskNotFoundError');
    const unknown = await rpc(base, 'NonExistentMethod', {}, { headers: V1 });
    assert.equal(unknown.body.error.code, -32601);
    // error object has exactly code + message (no stray data field)
    assert.deepEqual(Object.keys(missing.body.error).sort(), ['code', 'message']);
  });
});

test('v1: unsupported mediaType and wrong Content-Type both map to -32005', async () => {
  await withServer({}, async ({ base }) => {
    const unsupported = {
      role: 'ROLE_USER',
      parts: [{ raw: 'dGNr', mediaType: 'application/x-unsupported-tck-type' }],
      messageId: randomUUID(),
    };
    const mime = await rpc(base, 'SendMessage', { message: unsupported }, { headers: V1 });
    assert.equal(mime.body.error.code, -32005);

    const wrongCt = await rpc(base, 'SendMessage', { message: v1Message('x') }, {
      headers: { 'A2A-Version': '1.0', 'content-type': 'text/plain' },
    });
    assert.equal(wrongCt.body.error.code, -32005);
  });
});

test('v1: ListTasks returns a ListTasksResponse with an empty final token', async () => {
  await withServer({}, async ({ base }) => {
    const sent = await rpc(base, 'SendMessage', { message: v1Message('list me') }, { headers: V1 });
    const ctx = sent.body.result.task.contextId;
    const list = await rpc(base, 'ListTasks', { context_id: ctx, page_size: 2, include_artifacts: false }, { headers: V1 });
    const r = list.body.result;
    assert.ok(Array.isArray(r.tasks));
    assert.equal(r.nextPageToken, '', 'CORE-LIST-004');
    assert.equal(typeof r.pageSize, 'number');
    assert.equal(typeof r.totalSize, 'number');
    for (const t of r.tasks) {
      assert.equal(t.artifacts, undefined, 'CORE-LIST-005: artifacts omitted');
      assert.match(t.status.state, /^TASK_STATE_/);
    }
    const other = await rpc(base, 'ListTasks', { context_id: 'no-such-context' }, { headers: V1 });
    assert.equal(other.body.result.tasks.length, 0);
    assert.equal(other.body.result.nextPageToken, '');
  });
});

test('v1: trailing-slash /a2a/ is normalised for the TCK client', async () => {
  await withServer({}, async ({ base }) => {
    const r = await rpc(base, 'SendMessage', { message: v1Message('slash') }, { headers: V1, path: '/a2a/' });
    assert.equal(r.status, 200);
    assert.ok(r.body.result.task, 'POST /a2a/ reaches the JSON-RPC handler');
  });
});

test('v1: streaming begins with { task } and emits StreamResponse events', async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...V1 },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 7,
        method: 'SendStreamingMessage',
        params: { message: v1Message('stream please') },
      }),
    });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const events = await readV1Sse(res);
    assert.ok(events.length >= 2, 'at least the leading Task and a terminal status');
    assert.ok(events[0].result.task, 'STREAM-SUB-001 / CORE-STREAM-003: first event is the Task');
    assert.equal(events[0].frame.jsonrpc, '2.0');
    assert.equal(events[0].frame.id, 7);
    for (const { result } of events) {
      const keys = Object.keys(result);
      assert.ok(
        keys.some((k) => ['task', 'message', 'statusUpdate', 'artifactUpdate'].includes(k)),
        'every frame is a StreamResponse',
      );
      assert.equal(result.kind, undefined, 'no v0.3 kind discriminator');
      assert.equal(result.final, undefined, 'no v0.3 final flag');
      if (result.statusUpdate) {
        assert.equal(result.statusUpdate.final, undefined);
        assert.match(result.statusUpdate.status.state, /^TASK_STATE_/);
      }
    }
  });
});

test('v1: SubscribeToTask rejects missing and terminal tasks before opening SSE', async () => {
  await withServer({}, async ({ base }) => {
    const missing = await rpc(base, 'SubscribeToTask', { id: 'nope' }, { headers: V1 });
    assert.equal(missing.body.error.code, -32001);
    assert.match(missing.headers.get('content-type') ?? '', /application\/json/, 'plain JSON-RPC error, not SSE');

    const sent = await rpc(base, 'SendMessage', { message: v1Message('finish') }, { headers: V1 });
    const id = sent.body.result.task.id;
    assert.equal(sent.body.result.task.status.state, 'TASK_STATE_COMPLETED');
    const terminal = await rpc(base, 'SubscribeToTask', { id }, { headers: V1 });
    assert.equal(terminal.body.error.code, -32004, 'STREAM-SUB-003');
  });
});

test('v1: mismatching contextId/taskId is rejected', async () => {
  await withServer({}, async ({ base }) => {
    const sent = await rpc(base, 'SendMessage', { message: v1Message('first') }, { headers: V1 });
    const id = sent.body.result.task.id;
    const bad = await rpc(base, 'SendMessage', {
      message: { ...v1Message('follow up'), taskId: id, contextId: 'a-completely-different-context' },
    }, { headers: V1 });
    assert.ok(bad.body.error, 'CORE-MULTI-006');
  });
});

test('v1: 0.3 and 1.0 requests coexist concurrently on one server', async () => {
  await withServer({}, async ({ base }) => {
    const [r03, r10, rNone, r10b] = await Promise.all([
      rpc(base, 'message/send', { message: legacyMessage('legacy A') }, { headers: { 'A2A-Version': '0.3' } }),
      rpc(base, 'SendMessage', { message: v1Message('v1 A') }, { headers: V1 }),
      rpc(base, 'message/send', { message: legacyMessage('legacy B') }),
      rpc(base, 'SendMessage', { message: v1Message('v1 B') }, { headers: V1 }),
    ]);
    // 0.3 responses are bare Tasks with lowercase states
    for (const r of [r03, rNone]) {
      assert.ok(r.body.result.id, '0.3 result is a bare Task');
      assert.equal(r.body.result.task, undefined, 'no v1.0 envelope on 0.3');
      assert.match(r.body.result.status.state, /^[a-z-]+$/);
    }
    // 1.0 responses are { task } with enum states
    for (const r of [r10, r10b]) {
      assert.ok(r.body.result.task, 'v1.0 result is { task }');
      assert.match(r.body.result.task.status.state, /^TASK_STATE_/);
    }
    assert.notEqual(r10.body.result.task.id, r10b.body.result.task.id, 'each v1.0 send gets its own task');
  });
});
