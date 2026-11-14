#!/usr/bin/env node
/**
 * P5-style evaluation PoC: is a zero-dependency gRPC binding feasible?
 *
 * Scope: prove that Node's built-in `http2` plus a hand-written protobuf wire
 * codec can serve a real A2A gRPC client — no @grpc/grpc-js, no protobufjs,
 * no new runtime dependency. This is a TRANSPORT feasibility probe, NOT a
 * production binding and NOT a TCK compliance claim. See
 * docs/a2a-v1-multibinding.md for why 0.6.0 does not declare a GRPC
 * interface on the Agent Card.
 *
 * Verified two ways:
 *   1. a Node http2 client speaks the same gRPC wire (self-check);
 *   2. when the pinned official a2a-tck checkout is present, its Python
 *      grpcio A2AServiceStub calls GetTask and parses the protobuf response —
 *      i.e. a real third-party gRPC client, not just our own decoder.
 */
import http2 from 'node:http2';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TCK = process.env.A2A_TCK_DIR || '/tmp/a2a-tck';
const SERVICE = '/lf.a2a.v1.A2AService/GetTask';

/* ------------------------------------------------------------ protobuf wire */

const varint = (n) => {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  return Buffer.from(out);
};
const tag = (field, wire) => varint((field << 3) | wire);
const lenDelimited = (field, bytes) => Buffer.concat([tag(field, 2), varint(bytes.length), bytes]);
const str = (field, s) => lenDelimited(field, Buffer.from(s, 'utf8'));
const intField = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
const msg = (field, buf) => lenDelimited(field, buf);

const readVarint = (buf, at) => {
  let value = 0; let shift = 0; let i = at;
  for (;;) {
    const b = buf[i++];
    value += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [value, i];
    shift += 7;
    if (shift > 35) throw new Error('varint overflow');
  }
};
/** Minimal decoder: field number -> list of { wire, value }. */
function decode(buf) {
  const out = new Map();
  let i = 0;
  while (i < buf.length) {
    const [t, j] = readVarint(buf, i); i = j;
    const field = t >>> 3; const wire = t & 7;
    let value;
    if (wire === 0) { const [v, k] = readVarint(buf, i); value = v; i = k; }
    else if (wire === 2) {
      const [n, k] = readVarint(buf, i); i = k;
      value = buf.subarray(i, i + n); i += n;
    } else throw new Error(`unsupported wire type ${wire}`);
    if (!out.has(field)) out.set(field, []);
    out.get(field).push({ wire, value });
  }
  return out;
}

/** gRPC message frame: 1 compression byte + 4-byte big-endian length. */
const grpcFrame = (payload) => {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
};
const unframe = (buf) => buf.subarray(5, 5 + buf.readUInt32BE(1));

/* ------------------------------------------------------------- A2A messages */
// Field numbers taken verbatim from specification/a2a.proto (lf.a2a.v1):
//   GetTaskRequest { tenant=1, id=2, history_length=3 }
//   Task           { id=1, context_id=2, status=3(TaskStatus), ... }
//   TaskStatus     { state=1(TaskState), message=2, timestamp=3(Timestamp) }
//   TaskState.TASK_STATE_COMPLETED = 3
//   Timestamp      { seconds=1, nanos=2 }
const TASK_STATE_COMPLETED = 3;

function encodeGetTaskRequest(id) { return str(2, id); }

function encodeTask(id, contextId, nowSec) {
  const timestamp = Buffer.concat([intField(1, nowSec), intField(2, 0)]);
  const status = Buffer.concat([
    intField(1, TASK_STATE_COMPLETED),
    msg(3, timestamp),
  ]);
  return Buffer.concat([str(1, id), str(2, contextId), msg(3, status)]);
}

/* --------------------------------------------------------------- http2 server */

function startServer() {
  const server = http2.createServer();
  const seen = [];
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const req = decode(unframe(Buffer.concat(chunks)));
      const id = req.get(2)?.[0]?.value?.toString('utf8') ?? '';
      seen.push({ path: headers[':path'], id, contentType: headers['content-type'] });
      // grpcio looks for grpc-status in TRAILERS. Node http2 requires
      // { waitForTrailers: true } and sendTrailers() inside 'wantTrailers';
      // the data must be written with write() and the stream ended separately
      // (end(data) can flush END_STREAM before custom trailers are attached).
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc' },
        { waitForTrailers: true },
      );
      stream.on('wantTrailers', () => {
        stream.sendTrailers({ 'grpc-status': '0' });
        seen.push({ event: 'wantTrailers' });
      });
      stream.write(grpcFrame(encodeTask(id, `ctx-${id}`, Math.floor(Date.now() / 1000))));
      stream.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

function nodeClient(port, id) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`http://127.0.0.1:${port}`);
    const req = client.request({
      ':method': 'POST', ':path': SERVICE,
      'content-type': 'application/grpc', te: 'trailers',
    });
    const chunks = [];
    let grpcStatus = null;
    req.on('response', (h) => { grpcStatus = h['grpc-status'] ?? null; });
    req.on('data', (c) => chunks.push(c));
    req.on('trailers', (h) => { grpcStatus = h['grpc-status'] ?? grpcStatus; });
    req.on('end', () => {
      client.close();
      try {
        const task = decode(unframe(Buffer.concat(chunks)));
        resolve({
          grpcStatus,
          id: task.get(1)?.[0]?.value?.toString('utf8'),
          contextId: task.get(2)?.[0]?.value?.toString('utf8'),
          state: decode(task.get(3)[0].value).get(1)?.[0]?.value,
        });
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
    req.end(grpcFrame(encodeGetTaskRequest(id)));
  });
}

/** Real third-party client: the official TCK's generated grpcio stub. */
function pythonClient(port) {
  const py = path.join(TCK, '.venv/bin/python');
  if (!fs.existsSync(py) || !fs.existsSync(path.join(TCK, 'specification/generated/a2a_pb2_grpc.py'))) {
    return { available: false };
  }
  const script = [
    'import sys, grpc',
    `sys.path.insert(0, ${JSON.stringify(TCK)})`,
    'from specification.generated import a2a_pb2, a2a_pb2_grpc',
    `ch = grpc.insecure_channel("127.0.0.1:${port}")`,
    'stub = a2a_pb2_grpc.A2AServiceStub(ch)',
    'r = stub.GetTask(a2a_pb2.GetTaskRequest(id="poc-python"), timeout=5)',
    'assert r.id == "poc-python", r.id',
    'assert r.status.state == a2a_pb2.TASK_STATE_COMPLETED, r.status.state',
    'print("PYTHON_GRPC_OK", r.id, r.context_id, a2a_pb2.TaskState.Name(r.status.state))',
  ].join('\n');
  // MUST be asynchronous: spawnSync would block Node's event loop, so this
  // very http2 server could never answer the Python client's request.
  return new Promise((resolve) => {
    const child = spawn(py, ['-c', script], { cwd: TCK });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        available: true,
        ok: code === 0,
        output: stdout.trim(),
        error: stderr.trim().slice(-400),
      });
    });
  });
}

const { server, seen, port } = await startServer();
const checks = [];
try {
  const node = await nodeClient(port, 'poc-node');
  checks.push({
    name: 'Node http2 client round-trips a protobuf Task over gRPC wire',
    ok: node.id === 'poc-node' && node.contextId === 'ctx-poc-node' &&
        node.state === TASK_STATE_COMPLETED && node.grpcStatus === '0',
    detail: node,
  });
  checks.push({
    name: 'server received the correct :path and content-type',
    ok: seen.some((s) => s.path === SERVICE && s.contentType === 'application/grpc'),
  });
  const py = await pythonClient(port);
  checks.push(py.available
    ? { name: 'official TCK Python grpcio A2AServiceStub parses the response', ok: py.ok, detail: py }
    : { name: 'official TCK Python grpcio stub', ok: true, skipped: true, detail: 'A2A_TCK_DIR not available' });
} finally {
  server.close();
}

const report = {
  tool: 'poc-a2a-grpc',
  scope: 'transport feasibility only — NOT a production binding, NOT TCK compliance',
  dependencies: 'node:http2 + hand-written protobuf wire; zero new runtime dependencies',
  proto: 'specification/a2a.proto (lf.a2a.v1) field numbers',
  checks,
  seen,
  ok: checks.every((c) => c.ok),
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.stdout.write(report.ok
  ? `[poc-a2a-grpc] ${checks.length} checks passed\n`
  : `[poc-a2a-grpc] FAILED: ${checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}\n`);
if (!report.ok) process.exit(1);
