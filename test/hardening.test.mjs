/**
 * Hardening regression tests added during the production-grade audit.
 *
 * These lock in the fixes for two real defects found by auditing the repo:
 *  1. `unsafePushUrl` misclassified hosts in BOTH directions - it failed to
 *     block genuine IPv6 loopback/ULA/link-local literals (`[::1]`, `[fd00::1]`,
 *     `[fe80::1]` are bracketed by WHATWG URL) while wrongly rejecting normal
 *     domain names like fc2.com / fdic.gov / feather.com.
 *  2. A malformed percent-escape in the artifact path (`/a2a/artifacts/%zz/x`)
 *     made `decodeURIComponent` throw inside the HTTP request listener, which
 *     escalated to an uncaughtException and took the whole bridge down (remote
 *     DoS on the default, token-less A2A surface). It must now answer 400 and
 *     keep running.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JobManager } from '../dist/runner.js';
import { Logger } from '../dist/logger.js';
import { startA2AServer, unsafePushUrl } from '../dist/a2a/server.js';
import { VERSION } from '../dist/version.js';

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  await new Promise((r) => srv.close(r));
  return port;
}

function makeConfig(stateDir) {
  return {
    cursorBin: 'agent',
    workspaceRoots: [stateDir],
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
  };
}

function get(base, rawPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.get(
      { hostname: u.hostname, port: u.port, path: rawPath },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
  });
}

test('unsafePushUrl: genuine IPv6 loopback/ULA/link-local are blocked', () => {
  assert.equal(unsafePushUrl('http://[::1]/hook'), 'IPv6 loopback/unspecified is not an allowed push target');
  assert.ok(unsafePushUrl('http://[fd00::1]/hook'));
  assert.ok(unsafePushUrl('http://[fe80::1]/hook'));
});

test('unsafePushUrl: legitimate public domain names are NOT falsely blocked', () => {
  // These all begin with fc/fd/fe[89ab] and were wrongly rejected before.
  for (const url of [
    'https://fc2.com/hook',
    'https://fdic.gov/cb',
    'https://feather.com/x',
    'https://fcc.gov/x',
    'https://example.com/ok',
  ]) {
    assert.equal(unsafePushUrl(url), null, `expected ${url} to be allowed`);
  }
});

test('unsafePushUrl: IPv4 private / metadata targets are blocked', () => {
  assert.ok(unsafePushUrl('http://127.0.0.1/x'));
  assert.ok(unsafePushUrl('http://10.1.2.3/x'));
  assert.ok(unsafePushUrl('http://192.168.1.1/x'));
  assert.ok(unsafePushUrl('http://172.20.0.1/x'));
  assert.ok(unsafePushUrl('http://169.254.169.254/latest/meta-data'));
});

test('unsafePushUrl: allowlist overrides the private-host block', () => {
  assert.equal(unsafePushUrl('http://10.0.0.5/hook', ['10.0.0.5']), null);
});

test('A2A: malformed artifact path returns 400 and does NOT crash the bridge', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbcb-hard-'));
  const config = makeConfig(stateDir);
  config.a2aPort = await freePort();
  const log = new Logger({ level: 'error', fileDir: undefined });
  const mgr = new JobManager(config, log);
  const server = startA2AServer(mgr, { config, version: VERSION, log: log.child('a2a') });
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const bad = await get(base, '/a2a/artifacts/%zz/changes.patch');
    assert.equal(bad.status, 400, 'malformed path must be a client error, not a crash');

    // Server must still be alive and answering after the bad request.
    const card = await get(base, '/.well-known/agent.json');
    assert.equal(card.status, 200);
    assert.ok(card.body.includes('wb-cursor-bridge'));

    const rpc = await get(base, '/a2a'); // GET on /a2a is 405, but proves liveness
    assert.equal(rpc.status, 405);
  } finally {
    await mgr.shutdown(500);
    server.close();
  }
});
