#!/usr/bin/env node
/**
 * 端到端真跑实证（End-to-end real-run empirical validation）.
 *
 * 与 node --test 的「in-process 调用 startA2AServer」不同，本脚本：
 *   1. 真实编译产物 dist/index.js 作为独立进程拉起（即出货工件本身）；
 *   2. 用真实 fake-agent 作为 Cursor 替身（runner 真的 spawn 它）；
 *   3. 通过真实 HTTP（fetch）驱动 A2A 全生命周期，并断言可观测端点；
 *   4. 同时覆盖 v0.3.0 与 v1.0 两种序列化、以及本轮新增的协商/限流/CORS/生命周期硬化；
 *   5. 用真实 HTTP webhook 真跑 push 通知（正向投递 + SSRF allowlist 拒绝负向）；
 *   6. 用真实 hang 模式任务真跑 tasks/cancel（取消→canceled 且 worktree 清理）。
 *
 * 每个场景独立拉起/关闭一个 bridge 进程，互不干扰。失败项计入报告，
 * 任一失败即以非零退出码结束，便于 CI 门禁复用。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'index.js');
// 跨平台选择 fake-agent：Windows 用 .cmd shim，便于将来接入 Windows CI 真跑。
const FAKE = process.platform === 'win32'
  ? path.join(ROOT, 'test', 'fake-agent.cmd')
  : path.join(ROOT, 'test', 'fake-agent.sh');

// ---- 确保 dist 已构建 -----------------------------------------------------
if (!fs.existsSync(DIST)) {
  console.log('[empirical] dist/index.js 缺失，先构建…');
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
    cwd: ROOT, stdio: 'inherit',
  });
}

// ---- 报告收集 -------------------------------------------------------------
const report = [];
function check(scenario, name, ok, detail = '') {
  report.push({ scenario, name, ok: !!ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${scenario} :: ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---- 工具 -----------------------------------------------------------------
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=ci@wb', '-c', 'user.name=ci', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  execFileSync('git', ['-c', 'user.email=ci@wb', '-c', 'user.name=ci', 'add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=ci@wb', '-c', 'user.name=ci', 'commit', '-q', '-m', 'baseline'], { cwd: dir });
  return dir;
}

function rmSafe(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function rpc(base, method, params, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}/a2a`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body, res };
}

function userMessage(text, metadata) {
  return { role: 'user', parts: [{ kind: 'text', text }], ...(metadata ? { metadata } : {}) };
}

async function waitFinal(base, id, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await rpc(base, 'tasks/get', { id, historyLength: 20 });
    const state = body?.result?.status?.state;
    if (state === 'completed' || state === 'failed' || state === 'canceled') return body.result;
    if (Date.now() > deadline) throw new Error(`task ${id} 未在 ${timeoutMs}ms 内终态（卡在 ${state}）`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function readSse(res, timeoutMs = 15000) {
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) {
          try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
        }
      }
    }
    if (events.some((e) => e?.final)) break;
  }
  return events;
}

function timeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const p = addr && typeof addr === 'object' ? addr.port : 0;
      s.close(() => resolve(p));
    });
  });
}

async function startBridgeOnce(opts, port) {
  const { repo, stateDir, fakeMode, protocolVersion, rateLimit, cors, authToken, maxConcurrency, pushAllowlist } = opts;
  const cfgPath = path.join(stateDir, 'config.json');
  const cfg = {
    cursorBin: FAKE,
    workspaceRoots: [repo],
    stateDir,
    a2aPort: port,
    a2aHost: '127.0.0.1',
    logLevel: 'info',
    defaultTimeoutSec: 60,
    maxConcurrency: maxConcurrency ?? 4,
  };
  if (protocolVersion) cfg.a2aProtocolVersion = protocolVersion;
  if (rateLimit) cfg.a2aRateLimitPerSec = rateLimit;
  if (cors) cfg.a2aCorsOrigins = cors;
  if (authToken) cfg.a2aAuthToken = authToken;
  if (pushAllowlist) cfg.a2aPushUrlAllowlist = String(pushAllowlist).split(',').map((s) => s.trim()).filter(Boolean);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  const child = spawn(process.execPath, [DIST], {
    cwd: ROOT,
    env: {
      ...process.env,
      WB_CURSOR_BRIDGE_CONFIG: cfgPath,
      CURSOR_BIN: FAKE,
      WB_FAKE_MODE: fakeMode ?? 'ok',
      CURSOR_BRIDGE_LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', () => {});

  const base = `http://127.0.0.1:${port}`;
  const cardReady = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${base}/.well-known/agent.json`);
      if (r.status === 200) break;
    } catch { /* not yet */ }
    if (Date.now() > cardReady) {
      stopChild(child);
      throw new Error('agent card 未在 15s 内就绪（stderr 末尾：' + stderr.slice(-400) + '）');
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, base, port, stderr, stop: () => stopChild(child) };
}

async function startBridge(opts) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let port;
    try { port = await freePort(); } catch { port = 18800 + attempt; }
    try {
      return await startBridgeOnce(opts, port);
    } catch (err) {
      lastErr = err;
      // 端口偶发被占（bind race）则换端口重试
    }
  }
  throw lastErr;
}

// 跨平台 tree-kill：POSIX 用进程组(-pid)，Windows 用 taskkill /T 连带孙进程。
function killTree(child, sig) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref?.(); } catch { /* ignore */ }
  } else {
    try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* ignore */ } }
  }
}

function stopChild(child) {
  killTree(child, 'SIGTERM');
  const t = setTimeout(() => killTree(child, 'SIGKILL'), 2500);
  t.unref?.();
}

function countWorktrees(repo) {
  try {
    const out = execFileSync('git', ['-C', repo, 'worktree', 'list'], { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).length;
  } catch { return -1; }
}

// 真实 HTTP webhook：收集桥投递来的 push 事件，并记下请求头（验证 bridge 注入鉴权）。
function startPushServer() {
  const received = [];
  let lastHeaders = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastHeaders = req.headers;
      let ev = null;
      try { ev = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      if (ev) received.push(ev);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      resolve({
        server, port, received,
        url: `http://127.0.0.1:${port}/push`,
        lastHeaders: () => lastHeaders,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ---- 场景 -----------------------------------------------------------------
async function scenarioBaselineV03() {
  const scenario = 'S1-v0.3.0-baseline';
  const repo = makeRepo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-st-s1-'));
  let bridge;
  try {
    bridge = await startBridge({ repo, stateDir, fakeMode: 'ok' });
    const { base } = bridge;

    // 1) Agent Card（v0.3.0 形状）
    const cardRes = await fetch(`${base}/.well-known/agent.json`);
    const card = await cardRes.json();
    check(scenario, 'Agent Card 含 protocolVersion=0.3.0', card.protocolVersion === '0.3.0', `protocolVersion=${card.protocolVersion}`);
    check(scenario, 'Agent Card 含 skills[]', Array.isArray(card.skills) && card.skills.length >= 1, `skills=${card.skills?.length}`);
    check(scenario, 'Agent Card 含 capabilities', !!card.capabilities, '');

    // 2) message/send 异步 → 返回 task（非终态），再轮询至 completed
    const sent = await rpc(base, 'message/send', { message: userMessage('implement hello') });
    const id = sent.body?.result?.id;
    check(scenario, 'message/send 异步返回 task id', !!id, `id=${id}`);
    check(scenario, 'message/send 立即态非终态', ['submitted', 'working', 'completed'].includes(sent.body?.result?.status?.state), `state=${sent.body?.result?.status?.state}`);

    const done = await waitFinal(base, id);
    const text = (done?.status?.message?.parts ?? []).map((p) => p.text ?? '').join('');
    check(scenario, '任务终态 completed', done?.status?.state === 'completed', `state=${done?.status?.state}`);
    check(scenario, '结果文本含 FAKE_RESULT', text.includes('FAKE_RESULT'), `text=${text.slice(0, 60)}`);

    // 3) tasks/get 含 history
    const got = await rpc(base, 'tasks/get', { id, historyLength: 20 });
    check(scenario, 'tasks/get 返回 history[]', Array.isArray(got.body?.result?.history), `len=${got.body?.result?.history?.length}`);

    // 4) blocking message/send → 直接返回已 settled 的 completed
    const blk = await rpc(base, 'message/send', { message: userMessage('blocking task'), configuration: { blocking: true } });
    check(scenario, 'blocking 直返 completed', blk.body?.result?.status?.state === 'completed', `state=${blk.body?.result?.status?.state}`);

    // 5) acceptedOutputModes 无交集 → -32005
    const rej = await rpc(base, 'message/send', { message: userMessage('x'), configuration: { acceptedOutputModes: ['image/png'] } });
    check(scenario, 'acceptedOutputModes 无交集拒绝 -32005', rej.body?.error?.code === -32005, `code=${rej.body?.error?.code}`);

    // 6) acceptedOutputModes 有交集 → 200
    const acc = await rpc(base, 'message/send', { message: userMessage('y'), configuration: { acceptedOutputModes: ['text/plain'] } });
    check(scenario, 'acceptedOutputModes 有交集接受', !!acc.body?.result?.id, `id=${acc.body?.result?.id}`);

    // 7) message/stream SSE → final 事件
    const sres = await fetch(`${base}/a2a`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/stream', params: { message: userMessage('stream me') } }),
    });
    check(scenario, 'message/stream 返回 SSE', (sres.headers.get('content-type') || '').includes('text/event-stream'), sres.headers.get('content-type'));
    const evts = await readSse(sres);
    const finals = evts.filter((e) => e?.kind === 'status-update' && e.final);
    check(scenario, 'SSE 含 final 事件且 completed', finals.length === 1 && finals[0]?.status?.state === 'completed', `finals=${finals.length}`);

    // 8) /metrics 可观测端点
    const m = await fetch(`${base}/metrics`);
    const mBody = await m.json().catch(() => null);
    check(scenario, '/metrics 返回 200 且为对象', m.status === 200 && mBody && typeof mBody === 'object', `status=${m.status}`);

    // 9) 默认（无 CORS 配置）→ 响应无 Access-Control-Allow-Origin
    const corsCheck = await rpc(base, 'message/send', { message: userMessage('cors?') });
    check(scenario, '默认无 CORS 头', !corsCheck.res.headers.get('access-control-allow-origin'), `header=${corsCheck.res.headers.get('access-control-allow-origin')}`);

    // 10) worktree 在任务完成后被清理（真跑验证 try/finally 硬化）
    const wt = countWorktrees(repo);
    check(scenario, 'worktree 用完后已清理（仅剩主树）', wt === 1, `worktrees=${wt}`);
  } finally {
    bridge?.stop();
    rmSafe(repo); rmSafe(stateDir);
  }
}

async function scenarioV10() {
  const scenario = 'S2-v1.0-serialization';
  const repo = makeRepo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-st-s2-'));
  let bridge;
  try {
    bridge = await startBridge({ repo, stateDir, fakeMode: 'write', protocolVersion: '1.0' });
    const { base } = bridge;

    const cardRes = await fetch(`${base}/.well-known/agent.json`);
    const card = await cardRes.json();
    check(scenario, 'v1.0 Card 顶层无 protocolVersion', card.protocolVersion === undefined, `protocolVersion=${card.protocolVersion}`);
    check(scenario, 'v1.0 Card supportedInterfaces 含 a2a/v1.0', Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.some((s) => s.protocolVersion === '1.0'), JSON.stringify(card.supportedInterfaces));
    check(scenario, 'v1.0 Card extensions 为 []', Array.isArray(card.extensions) && card.extensions.length === 0, JSON.stringify(card.extensions));

    // 完成一个任务并取 Task，断言 FilePart 用 v1.0 字段名
    const sent = await rpc(base, 'message/send', { message: userMessage('v1 task'), configuration: { blocking: true } });
    const id = sent.body?.result?.id;
    const got = await rpc(base, 'tasks/get', { id });
    const task = got.body?.result;
    // 收集所有 artifact file part
    const files = [];
    for (const a of task?.artifacts ?? []) for (const p of a.parts ?? []) if (p.file) files.push(p.file);
    const allV1 = files.length === 0 || files.every((f) => f.filename !== undefined && f.mediaType !== undefined && f.url !== undefined && f.name === undefined && f.mimeType === undefined && f.uri === undefined);
    check(scenario, 'v1.0 Task FilePart 用 filename/mediaType/url', allV1, `files=${files.length}, sample=${files[0] ? JSON.stringify(Object.keys(files[0])) : 'none'}`);
  } finally {
    bridge?.stop();
    rmSafe(repo); rmSafe(stateDir);
  }
}

async function scenarioAuth() {
  const scenario = 'S3-auth';
  const repo = makeRepo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-st-s3-'));
  let bridge;
  try {
    bridge = await startBridge({ repo, stateDir, fakeMode: 'ok', authToken: 's3cr3t' });
    const { base } = bridge;

    const noToken = await rpc(base, 'message/send', { message: userMessage('no token') });
    check(scenario, '无 token → 401', noToken.status === 401, `status=${noToken.status}`);

    const withToken = await rpc(base, 'message/send', { message: userMessage('with token') }, 's3cr3t');
    check(scenario, 'Bearer token → 200', withToken.status === 200 && !!withToken.body?.result?.id, `status=${withToken.status}`);

    const hz = await fetch(`${base}/healthz`);
    check(scenario, '/healthz 无 token → 401', hz.status === 401, `status=${hz.status}`);
    const hzOk = await fetch(`${base}/healthz`, { headers: { authorization: 'Bearer s3cr3t' } });
    check(scenario, '/healthz 有 token → 200', hzOk.status === 200, `status=${hzOk.status}`);

    // Agent Card 端点保持公开
    const card = await fetch(`${base}/.well-known/agent.json`);
    check(scenario, 'Agent Card 公开（无需 token）', card.status === 200, `status=${card.status}`);
  } finally {
    bridge?.stop();
    rmSafe(repo); rmSafe(stateDir);
  }
}

async function scenarioRateLimit() {
  const scenario = 'S4-rate-limit';
  const repo = makeRepo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-st-s4-'));
  let bridge;
  try {
    bridge = await startBridge({ repo, stateDir, fakeMode: 'ok', rateLimit: 2, maxConcurrency: 50 });
    const { base } = bridge;

    // 突发的 15 个请求：令牌桶容量=2，其余应被 429
    const reqs = Array.from({ length: 15 }, () =>
      rpc(base, 'message/send', { message: userMessage('burst') }));
    const results = await Promise.all(reqs);
    const throttled = results.filter((r) => r.status === 429).length;
    const ok = results.filter((r) => r.status === 200).length;
    check(scenario, '令牌桶限流产生 429', throttled >= 5, `429=${throttled}, 200=${ok}`);
    check(scenario, '限流下仍有请求被放行', ok >= 1, `200=${ok}`);

    // 错误码为 RATE_LIMITED(-32050)
    const sample429 = results.find((r) => r.status === 429);
    check(scenario, '429 体含 RATE_LIMITED(-32050)', sample429?.body?.error?.code === -32050, `code=${sample429?.body?.error?.code}`);
  } finally {
    bridge?.stop();
    rmSafe(repo); rmSafe(stateDir);
  }
}

async function scenarioCors() {
  const scenario = 'S5-cors';
  const repo = makeRepo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-st-s5-'));
  let bridge;
  try {
    bridge = await startBridge({ repo, stateDir, fakeMode: 'ok', cors: ['http://example.com'] });
    const { base } = bridge;

    // OPTIONS 预检 → 204 + 反射 origin
    const preflight = await fetch(`${base}/a2a`, { method: 'OPTIONS', headers: { origin: 'http://example.com' } });
    check(scenario, 'CORS 预检 204', preflight.status === 204, `status=${preflight.status}`);
    check(scenario, '预检反射 Access-Control-Allow-Origin', preflight.headers.get('access-control-allow-origin') === 'http://example.com', preflight.headers.get('access-control-allow-origin'));

    // 实际 POST 带 Origin → 响应带 CORS 头
    const post = await fetch(`${base}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: userMessage('cors post') } }),
    });
    check(scenario, 'POST 响应带 CORS 头', post.headers.get('access-control-allow-origin') === 'http://example.com', post.headers.get('access-control-allow-origin'));

    // 非允许 origin 不反射
    const post2 = await fetch(`${base}/a2a`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: userMessage('x') } }),
    });
    check(scenario, '非允许 origin 不反射 CORS', post2.headers.get('access-control-allow-origin') !== 'http://evil.com', `header=${post2.headers.get('access-control-allow-origin')}`);
  } finally {
    bridge?.stop();
    rmSafe(repo); rmSafe(stateDir);
  }
}

async function scenarioInputRequired() {
  const scenario = 'S6-input-required';
  const repo = makeRepo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-st-s6-'));
  let bridge;
  try {
    bridge = await startBridge({ repo, stateDir, fakeMode: 'needinput' });
    const { base } = bridge;

    const first = await rpc(base, 'message/send', { message: userMessage('NEEDINPUT figure this out') });
    const id = first.body?.result?.id;
    // 轮询至 input-required
    const paused = await waitFinalOrState(base, id, 'input-required');
    check(scenario, '任务进入 input-required', paused?.status?.state === 'input-required', `state=${paused?.status?.state}`);
    const ptext = (paused?.status?.message?.parts ?? []).map((p) => p.text ?? '').join('');
    check(scenario, 'input-required 含追问内容', ptext.includes('which file'), `text=${ptext.slice(0, 50)}`);

    // 以同一 taskId 续跑
    const resumed = await rpc(base, 'message/send', { message: { role: 'user', parts: [{ kind: 'text', text: 'edit src/index.ts' }], taskId: id } });
    check(scenario, '续跑保持同一 taskId', resumed.body?.result?.id === id, `id=${resumed.body?.result?.id}`);
    const done = await waitFinal(base, id);
    const dtext = (done?.status?.message?.parts ?? []).map((p) => p.text ?? '').join('');
    check(scenario, '续跑后 completed 且带回 FAKE_RESULT:resumed', done?.status?.state === 'completed' && dtext.includes('FAKE_RESULT:resumed'), `state=${done?.status?.state}`);
  } finally {
    bridge?.stop();
    rmSafe(repo); rmSafe(stateDir);
  }
}

async function waitFinalOrState(base, id, target, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await rpc(base, 'tasks/get', { id, historyLength: 20 });
    const state = body?.result?.status?.state;
    if (state === target) return body.result;
    if (['completed', 'failed', 'canceled'].includes(state)) return body.result;
    if (Date.now() > deadline) throw new Error(`task ${id} 未到 ${target}（卡在 ${state}）`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function scenarioArtifacts() {
  const scenario = 'S7-artifacts';
  const repo = makeRepo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-st-s7-'));
  let bridge;
  try {
    bridge = await startBridge({ repo, stateDir, fakeMode: 'write' });
    const { base } = bridge;

    const sent = await rpc(base, 'message/send', { message: userMessage('write a file'), configuration: { blocking: true } });
    const id = sent.body?.result?.id;
    const got = await rpc(base, 'tasks/get', { id });
    const task = got.body?.result;
    const files = [];
    for (const a of task?.artifacts ?? []) for (const p of a.parts ?? []) if (p.file) files.push(p.file);
    check(scenario, 'Task 含可达 FilePart', files.length >= 1, `files=${files.length}`);

    // 真实 fetch 取回产物内容（远端 A2A 客户端路径）
    // v0.3.0 用 file.uri，v1.0 用 file.url —— 统一取优先 url 回退 uri
    let fetched = false;
    let content = '';
    for (const f of files) {
      const u = f.url ?? f.uri;
      if (!u) continue;
      const r = await fetch(u);
      if (r.status === 200) { fetched = true; content = await r.text(); break; }
    }
    check(scenario, '产物 URL 可远程 fetch(200)', fetched, `contentLen=${content.length}`);
    check(scenario, '产物内容含改动文件', content.includes('changed-by-fake'), `content=${content.slice(0, 80)}`);
  } finally {
    bridge?.stop();
    rmSafe(repo); rmSafe(stateDir);
  }
}

async function scenarioCrashCleanup() {
  const scenario = 'S8-crash-cleanup';
  const repo = makeRepo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-st-s8-'));
  let bridge;
  try {
    bridge = await startBridge({ repo, stateDir, fakeMode: 'crash' });
    const { base } = bridge;

    const sent = await rpc(base, 'message/send', { message: userMessage('boom') });
    const id = sent.body?.result?.id;
    const done = await waitFinal(base, id, 15000);
    check(scenario, 'agent 崩溃 → 任务 failed', done?.status?.state === 'failed', `state=${done?.status?.state}`);

    // 崩溃后仍清理 worktree（本轮 try/finally 硬化）
    const wt = countWorktrees(repo);
    check(scenario, '崩溃后 worktree 仍被清理', wt === 1, `worktrees=${wt}`);
  } finally {
    bridge?.stop();
    rmSafe(repo); rmSafe(stateDir);
  }
}

async function scenarioPush() {
  const scenario = 'S9-push-notification';
  const repo = makeRepo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-st-s9-'));
  const hook = await startPushServer();
  let bridge;
  try {
    // push 需 a2aAuthToken 开启 + allowlist 含 loopback host
    bridge = await startBridge({ repo, stateDir, fakeMode: 'ok', authToken: 'topsecret', pushAllowlist: '127.0.0.1' });
    const { base } = bridge;

    const sent = await rpc(base, 'message/send', {
      message: userMessage('notify me'),
      configuration: { pushNotificationConfig: { url: hook.url, token: 'sec' } },
    }, 'topsecret');
    const id = sent.body?.result?.id;
    check(scenario, 'message/send 返回 task id', !!id, `id=${id}`);

    // 等待 webhook 收到 final status-update
    const deadline = Date.now() + 15000;
    let finalEvent;
    while (Date.now() < deadline) {
      finalEvent = hook.received.find((e) => e.kind === 'status-update' && e.final);
      if (finalEvent) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    check(scenario, 'webhook 收到 final status-update', !!finalEvent, `received=${hook.received.length}`);
    check(scenario, 'final 事件 state=completed', finalEvent?.status?.state === 'completed', `state=${finalEvent?.status?.state}`);
    check(scenario, 'final 事件 taskId 匹配', finalEvent?.taskId === id, `taskId=${finalEvent?.taskId}, id=${id}`);
    // bridge 投递时注入 Bearer token 与 x-a2a-push 标记头
    const h = hook.lastHeaders() || {};
    check(scenario, 'webhook 收到 x-a2a-push 标记头', h['x-a2a-push'] === '1', `header=${h['x-a2a-push']}`);
    check(scenario, 'webhook 收到 Bearer sec', h['authorization'] === 'Bearer sec', `auth=${h['authorization']}`);
  } finally {
    bridge?.stop();
    await hook.close();
    rmSafe(repo); rmSafe(stateDir);
  }
}

async function scenarioPushSsrf() {
  const scenario = 'S10-push-ssrf-guard';
  const repo = makeRepo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-st-s10-'));
  const hook = await startPushServer();
  let bridge;
  try {
    // 有 auth 但无 allowlist：loopback webhook 应被 SSRF 守卫拒绝，不投递
    bridge = await startBridge({ repo, stateDir, fakeMode: 'ok', authToken: 'topsecret' });
    const { base } = bridge;

    const sent = await rpc(base, 'message/send', {
      message: userMessage('notify internal'),
      configuration: { pushNotificationConfig: { url: hook.url, token: 'sec' } },
    }, 'topsecret');
    check(scenario, '任务仍创建（webhook 仅被忽略）', !!sent.body?.result?.id, `id=${sent.body?.result?.id}`);

    // 等待后确认无任何投递
    await new Promise((r) => setTimeout(r, 4000));
    check(scenario, '无 allowlist → 不向 loopback 投递', hook.received.length === 0, `received=${hook.received.length}`);
  } finally {
    bridge?.stop();
    await hook.close();
    rmSafe(repo); rmSafe(stateDir);
  }
}

async function scenarioCancel() {
  const scenario = 'S11-tasks-cancel';
  const repo = makeRepo();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-st-s11-'));
  let bridge;
  try {
    // hang 模式永远不自行结束 → 任务恒定处于 running，必可被取消
    bridge = await startBridge({ repo, stateDir, fakeMode: 'hang' });
    const { base } = bridge;

    const sent = await rpc(base, 'message/send', { message: userMessage('long running') });
    const id = sent.body?.result?.id;
    check(scenario, 'message/send 返回 task id', !!id, `id=${id}`);

    // 等到任务进入 working（A2A 上报态；取消仅对 running/input-required 生效）
    const deadline = Date.now() + 12000;
    let working = false;
    while (Date.now() < deadline) {
      const g = await rpc(base, 'tasks/get', { id });
      const st = g.body?.result?.status?.state;
      if (st === 'working') { working = true; break; }
      if (['completed', 'failed', 'canceled'].includes(st)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    check(scenario, '任务进入 working 可被取消态', working, `working=${working}`);

    // 真实取消
    const canc = await rpc(base, 'tasks/cancel', { id });
    check(scenario, 'tasks/cancel 返回 200', canc.status === 200, `status=${canc.status}`);

    // 轮询至终态 canceled
    const fin = await waitFinal(base, id, 8000);
    check(scenario, '任务终态 canceled', fin?.status?.state === 'canceled', `state=${fin?.status?.state}`);

    // 取消后 worktree 仍清理（资源生命周期硬化在 cancel 路径的体现）。
    // 注意：cancel() 同步置 canceled，但 worktree 清理由 run body 的 finally
    // 在 runCursor 被 abort 落地后异步执行，故需轮询等待其真正删除。
    const wtDeadline = Date.now() + 6000;
    let wt = countWorktrees(repo);
    while (wt > 1 && Date.now() < wtDeadline) {
      await new Promise((r) => setTimeout(r, 200));
      wt = countWorktrees(repo);
    }
    check(scenario, '取消后 worktree 仍被清理', wt === 1, `worktrees=${wt}`);
  } finally {
    bridge?.stop();
    rmSafe(repo); rmSafe(stateDir);
  }
}

// ---- 主流程 ---------------------------------------------------------------
const scenarios = [
  scenarioBaselineV03,
  scenarioV10,
  scenarioAuth,
  scenarioRateLimit,
  scenarioCors,
  scenarioInputRequired,
  scenarioArtifacts,
  scenarioCrashCleanup,
  scenarioPush,
  scenarioPushSsrf,
  scenarioCancel,
];

async function main() {
  console.log('========================================================');
  console.log(' wb-cursor-bridge 端到端真跑实证（真实 dist 二进制 + 真实 fake-agent）');
  console.log('========================================================');
  let failed = 0;
  for (const sc of scenarios) {
    console.log(`\n--- ${sc.name} ---`);
    try {
      await sc();
    } catch (err) {
      check(sc.name, '场景未抛异常', false, String(err?.message ?? err));
    }
  }
  failed = report.filter((r) => !r.ok).length;
  console.log('\n========================================================');
  console.log(` 总计 ${report.length} 项检查，通过 ${report.length - failed}，失败 ${failed}`);
  console.log('========================================================');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[empirical] 致命错误:', err);
  process.exit(2);
});
