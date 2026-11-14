/**
 * v1.0 push notification contract (src/a2a/push.ts) unit coverage.
 *
 * The official TCK exercises CRUD + webhook delivery end to end; these tests
 * lock the pieces that are easy to regress silently — the Authorization header
 * shape, the SSRF gate at both create and delivery time, and idempotent delete.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PushRegistry, pushAuthHeader } from '../dist/a2a/push.js';
import { unsafePushUrl } from '../dist/a2a/server.js';

const noopLog = { warn: () => {} };
const registry = (overrides = {}) => new PushRegistry({
  log: noopLog,
  allowlist: undefined,
  isSafeLiteral: unsafePushUrl,
  verifyTarget: async (url) => unsafePushUrl(url),
  deliveryEnabled: () => true,
  ...overrides,
});

test('push-v1: v1.0 scheme/credentials wins over the legacy token', () => {
  assert.equal(
    pushAuthHeader({ id: 'c', url: 'https://example.com', authentication: { scheme: 'Bearer', credentials: 'abc' } }),
    'Bearer abc',
  );
  assert.equal(
    pushAuthHeader({ id: 'c', url: 'https://example.com', token: 'legacy' }),
    'Bearer legacy',
  );
  assert.equal(pushAuthHeader({ id: 'c', url: 'https://example.com' }), undefined);
});

test('push-v1: CRUD round-trip and idempotent delete', () => {
  const r = registry();
  const cfg = r.create('task-1', {
    id: 'cfg-1', url: 'https://example.com/hook',
    authentication: { scheme: 'Bearer', credentials: 'secret' }, tenant: 't1',
  });
  assert.equal(cfg.id, 'cfg-1');
  assert.equal(cfg.taskId, 'task-1');
  assert.equal(cfg.authentication.scheme, 'Bearer');
  assert.equal(cfg.tenant, 't1');

  assert.equal(r.get('task-1', 'cfg-1').url, 'https://example.com/hook');
  assert.equal(r.list('task-1').configs.length, 1);
  assert.equal(r.list('task-1').nextPageToken, '');
  assert.throws(() => r.get('task-1', 'nope'));

  assert.deepEqual(r.delete('task-1', 'cfg-1'), {});
  assert.deepEqual(r.delete('task-1', 'cfg-1'), {}, 'second delete must not error');
  assert.equal(r.list('task-1').configs.length, 0);
});

test('push-v1: generated config ids and list pagination', () => {
  const r = registry();
  const a = r.create('task-2', { url: 'https://example.com/a' });
  assert.ok(a.id.length > 0);
  r.create('task-2', { id: 'b', url: 'https://example.com/b' });
  r.create('task-2', { id: 'c', url: 'https://example.com/c' });
  const first = r.list('task-2', 2);
  assert.equal(first.configs.length, 2);
  assert.equal(first.nextPageToken, '2');
  assert.equal(r.list('task-2', 2, first.nextPageToken).nextPageToken, '');
});

test('push-v1: SSRF gate rejects loopback/private targets at creation', () => {
  const r = registry();
  for (const url of [
    'http://127.0.0.1/hook',
    'http://169.254.169.254/latest/meta-data',
    'http://10.1.2.3/hook',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => r.create('task-3', { id: 'x', url }), `expected ${url} to be rejected`);
  }
  // An explicit operator allowlist is the documented escape hatch.
  const allowed = registry({ allowlist: ['127.0.0.1'] });
  assert.equal(allowed.create('task-3', { id: 'x', url: 'http://127.0.0.1/hook' }).url, 'http://127.0.0.1/hook');
});

test('push-v1: delivery sends a StreamResponse with the configured Authorization', async () => {
  const received = [];
  const webhook = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((r) => webhook.listen(0, '127.0.0.1', r));
  const port = webhook.address().port;

  try {
    const r = registry({
      allowlist: ['127.0.0.1'],
      verifyTarget: async () => null,
    });
    const cfg = r.create('task-4', {
      id: 'cfg-4',
      url: `http://127.0.0.1:${port}/webhook`,
      authentication: { scheme: 'Bearer', credentials: 'tck-test-token' },
    });
    const payload = {
      statusUpdate: {
        taskId: 'task-4',
        contextId: 'ctx-4',
        status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
      },
    };
    await r.deliver(cfg, payload);

    assert.equal(received.length, 1, 'exactly one delivery attempt');
    assert.equal(received[0].headers.authorization, 'Bearer tck-test-token');
    assert.equal(received[0].headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(received[0].body), payload);
  } finally {
    await new Promise((r) => webhook.close(r));
  }
});

test('push-v1: a blocked delivery target is never contacted', async () => {
  let hits = 0;
  const webhook = http.createServer((_req, res) => { hits += 1; res.writeHead(200); res.end('ok'); });
  await new Promise((r) => webhook.listen(0, '127.0.0.1', r));
  const port = webhook.address().port;
  try {
    const r = registry({
      allowlist: ['127.0.0.1'],
      verifyTarget: async () => 'blocked by test',
    });
    const cfg = r.create('task-5', { id: 'c', url: `http://127.0.0.1:${port}/webhook` });
    await r.deliver(cfg, { task: { id: 'task-5' } });
    assert.equal(hits, 0);
  } finally {
    await new Promise((r) => webhook.close(r));
  }
});
