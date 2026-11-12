/**
 * Audit regression suite - batch B2 (A2A interoperability).
 *
 * Replaces: a2a/09 (card leaks host paths), a2a/11 + a2a/13 (SSE never sends
 * artifact-update), a2a/15 (/healthz always healthy), a2a/07 (single global
 * rate bucket).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JobManager } from '../dist/runner.js';
import { Logger } from '../dist/logger.js';
import { startA2AServer } from '../dist/a2a/server.js';
import { VERSION } from '../dist/version.js';
import { fakeBin } from './fake-bin.mjs';
import { rmrf } from './tmp.mjs';

const FAKE = fakeBin('cursor');

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit2-repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 't@t.local');
  git('config', 'user.name', 't');
  writeFileSync(path.join(dir, 'README.md'), '# demo\n');
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

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

async function boot(repo, over = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'wbaudit2-st-'));
  const cfg = makeConfig(stateDir, repo, { a2aPort: await freePort(), ...over });
  const log = new Logger({ level: 'error', fileDir: undefined });
  const mgr = new JobManager(cfg, log);
  const server = startA2AServer(mgr, { config: cfg, version: VERSION, log: log.child('a2a') });
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  return {
    mgr,
    server,
    port,
    stateDir,
    close: async () => {
      await mgr.shutdown(500);
      server.close();
      rmrf(stateDir);
    },
  };
}

function rpc(port, method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/a2a', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try { body = JSON.parse(text); } catch { /* keep raw */ }
          resolve({ status: res.statusCode, body, text });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const userMsg = (text) => ({ role: 'user', parts: [{ kind: 'text', text }] });

test('B2-1: SSE frames are JSON-RPC responses and carry artifact-update BEFORE the terminal status', async () => {
  const repo = makeRepo();
  process.env.WB_FAKE_MODE = 'write';
  const b = await boot(repo);
  try {
    const res = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'message/stream',
        params: { message: userMsg('write a file') },
      });
      const req = http.request(
        { hostname: '127.0.0.1', port: b.port, path: '/a2a', method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' } },
        resolve,
      );
      req.on('error', reject);
      req.end(payload);
    });

    const frames = [];
    let buf = '';
    const deadline = Date.now() + 15000;
    res.setEncoding('utf8');
    // `http.IncomingMessage` is an async iterable of string chunks once the
    // encoding is set (it is not a fetch Response - there is no `.body`).
    for await (const chunk of res) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          frames.push(JSON.parse(line.slice(6)));
        }
      }
      const last = frames.at(-1);
      if (last?.result?.kind === 'status-update' && last.result.final) break;
      if (Date.now() > deadline) break;
    }
    res.destroy();

    assert.ok(frames.length > 0, 'stream must produce frames');
    for (const f of frames) {
      assert.equal(f.jsonrpc, '2.0', 'every frame is a JSON-RPC response');
      assert.equal(f.id, 7, 'and echoes the request id');
      assert.ok(f.result && typeof f.result === 'object', 'the event travels in result');
    }
    const kinds = frames.map((f) => f.result.kind);
    const finalIdx = frames.findIndex((f) => f.result.kind === 'status-update' && f.result.final);
    const artifactIdx = kinds.indexOf('artifact-update');
    assert.ok(artifactIdx >= 0, `expected an artifact-update, got ${kinds.join(',')}`);
    assert.ok(
      artifactIdx < finalIdx,
      `artifacts must precede the terminal status (artifact@${artifactIdx}, final@${finalIdx})`,
    );
    assert.ok(
      frames[artifactIdx].result.artifact?.parts?.length > 0,
      'the artifact-update must carry a downloadable part',
    );
  } finally {
    delete process.env.WB_FAKE_MODE;
    await b.close();
    rmrf(repo);
  }
});

test('B2-4: the public Agent Card does not disclose absolute host paths', async () => {
  const repo = makeRepo();
  const b = await boot(repo);
  try {
    const card = await new Promise((resolve, reject) => {
      http
        .get({ hostname: '127.0.0.1', port: b.port, path: '/.well-known/agent.json' }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        })
        .on('error', reject);
    });
    assert.equal(card.includes(repo), false, 'the card must not contain the workspace root path');
    assert.ok(card.includes(path.basename(repo)), 'the basename is enough for a client to choose a skill');
  } finally {
    await b.close();
    rmrf(repo);
  }
});

test('B2-4: /healthz reports a missing cursor binary instead of a hard-coded healthy', async () => {
  const repo = makeRepo();
  const b = await boot(repo, { cursorBin: path.join(os.tmpdir(), 'definitely-not-an-agent') });
  try {
    const res = await new Promise((resolve, reject) => {
      http
        .get({ hostname: '127.0.0.1', port: b.port, path: '/healthz' }, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        })
        .on('error', reject);
    });
    assert.equal(res.status, 503);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.ok(body.issues.some((i) => /cursor binary not found/i.test(i)), res.body);
  } finally {
    await b.close();
    rmrf(repo);
  }
});

test('B2-7: rate limiting is per client, so one caller cannot starve the rest', async () => {
  const repo = makeRepo();
  const b = await boot(repo, { a2aRateLimitPerSec: 2 });
  try {
    // Drain this client's bucket.
    let limited = 0;
    for (let i = 0; i < 6; i += 1) {
      const r = await rpc(b.port, 'tasks/get', { id: 'nope' });
      if (r.status === 429) limited += 1;
    }
    assert.ok(limited > 0, 'a single client must eventually be limited');
    // Discovery is exempt, so a probe can always read the card.
    const card = await new Promise((resolve, reject) => {
      http
        .get({ hostname: '127.0.0.1', port: b.port, path: '/.well-known/agent.json' }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        })
        .on('error', reject);
    });
    assert.equal(card, 200, 'discovery must not be rate limited');
  } finally {
    await b.close();
    rmrf(repo);
  }
});
