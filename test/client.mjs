/**
 * Minimal MCP client over stdio, used by the end-to-end tests.
 */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createClient(env = {}) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'dist', 'index.js')], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  let nextId = 0;
  const pending = new Map();
  const stderr = [];

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  proc.stderr.on('data', (d) => stderr.push(d.toString('utf8')));

  const send = (method, params) => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout calling ${method}`));
        }
      }, 30_000).unref?.();
    });
  };

  const notify = (method, params) =>
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  return {
    proc,
    stderr,
    async init() {
      await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '1' },
      });
      notify('notifications/initialized', {});
      return this;
    },
    async tools() {
      const r = await send('tools/list', {});
      return r.tools.map((t) => t.name);
    },
    async call(name, args = {}) {
      const r = await send('tools/call', { name, arguments: args });
      const text = r.content?.[0]?.text ?? '';
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { isError: Boolean(r.isError), data: parsed };
    },
    close() {
      return new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          rl.close();
          resolve();
          return;
        }
        const done = () => {
          rl.close();
          resolve();
        };
        proc.once('exit', done);
        proc.once('error', done);
        try {
          proc.stdin.end();
        } catch {
          /* ignore */
        }
        proc.kill();
        // Safety cap: if the process was already dead, 'exit' may have fired.
        setTimeout(done, 3000).unref?.();
      });
    },
  };
}

/** Poll until the job reaches a terminal state. */
export async function waitFor(client, jobId, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await client.call('cursor_status', { jobId });
    const status = last.data.status;
    if (status && status !== 'running') return last.data;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`job ${jobId} did not settle: ${JSON.stringify(last?.data)}`);
}