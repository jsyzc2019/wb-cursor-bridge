/**
 * A2A HTTP transport.
 *
 * This is the piece that turns the bridge from "an MCP bridge that borrows A2A
 * vocabulary" into "an A2A agent another agent can actually talk to". It serves
 * the Agent Card at the well-known location and implements the A2A JSON-RPC 2.0
 * method set over HTTP, including the SSE streaming methods (message/stream,
 * tasks/resubscribe) and optional bearer-token authentication.
 *
 * The execution engine (JobManager) is untouched: this module only translates
 * A2A requests into engine calls and A2A responses out of engine state. That
 * separation is what keeps the protocol surface easy to reason about and test.
 */
import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { JobManager } from '../runner.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Job, Tier } from '../types.js';
import { badArgument, concurrency, notFound } from '../errors.js';
import { buildAgentCard, AGENT_OUTPUT_MODES } from './card.js';
import { toV1Card, isV1, type A2AVersion } from './compat.js';
import { deriveSkills, resolveRoot, type SkillEntry } from './skills.js';
import {
  messageToPrompt,
  skillIdOf,
  tierOf,
  pushConfigOf,
  toTask,
  toTaskState,
} from './convert.js';
import { subscribeTask, watchAndPush, isFinalState } from './watch.js';
import {
  A2A_ERROR,
  JsonRpcVersion,
  type AgentCard,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type Message,
  type TaskEvent,
} from './types.js';

const MAX_BODY_BYTES = 1_048_576; // 1 MiB: a task payload should never approach this.
const PROVIDER = { organization: 'WorkBuddy', url: 'https://www.workbuddy.cn' };

/**
 * Default A2A POST token-bucket refill rate (requests/sec). The capacity equals
 * the refill rate, so sustained throughput is capped at this value while short
 * bursts up to it are allowed. A legitimate agent making a few requests per
 * second never trips it, while a flood (or an SSRF pivot loop) is bounded. The
 * bucket is per server instance, so horizontal replicas each enforce their own.
 */
const A2A_RATE_LIMIT_REFILL = 250; // tokens replenished per second

/** Fixed-capacity token bucket. `take()` returns false once drained. */
class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
  }
  take(n = 1): boolean {
    const now = Date.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerSec);
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}

/** A2A `message/send` / `message/stream` `configuration` object. */
interface A2AConfiguration {
  blocking?: boolean;
  historyLength?: number;
  acceptedOutputModes?: string[];
  pushNotificationConfig?: unknown;
}

/** Pull the optional `configuration` block from a send/stream request params. */
function configOf(params: Record<string, unknown>): A2AConfiguration | undefined {
  const c = params.configuration;
  if (c && typeof c === 'object' && !Array.isArray(c)) return c as A2AConfiguration;
  return undefined;
}

/**
 * Honour A2A content negotiation: a client lists the output MIME types it can
 * consume in `configuration.acceptedOutputModes`. If the bridge cannot produce
 * any of them, fail fast with INCOMPATIBLE_CONTENT_TYPES rather than emitting an
 * artifact the client cannot read. (We always emit text/plain, so this only
 * trips when a client excludes every mode we support.)
 */
function assertOutputModesAccepted(configuration?: A2AConfiguration): void {
  const requested = configuration?.acceptedOutputModes;
  if (!Array.isArray(requested) || requested.length === 0) return;
  const supported = AGENT_OUTPUT_MODES as readonly string[];
  const overlap = requested.some((m) => supported.includes(m));
  if (!overlap) {
    throw new BridgeIncompatible(
      `agent does not support any of the requested output modes: ${requested.join(', ')}`,
    );
  }
}

export interface A2AServerOptions {
  config: Config;
  version: string;
  log: Logger;
}

/** Start the A2A HTTP server, or return null when the port is disabled (0). */
export function startA2AServer(
  mgr: JobManager,
  opts: A2AServerOptions,
): http.Server | null {
  const { config, version, log } = opts;
  if (!config.a2aPort) return null;

  const skills: SkillEntry[] = deriveSkills(config.workspaceRoots, 'execute', config.a2aSkills ?? [], log);
  let card: AgentCard | null = null;
  const a2aVersion: A2AVersion = config.a2aProtocolVersion ?? '0.3.0';

  const cardUrl = (): string => {
    const host =
      config.a2aPublicUrl ??
      `http://${
        config.a2aHost === '0.0.0.0' ? '127.0.0.1' : config.a2aHost
      }:${actualPort}/a2a`;
    return host;
  };

  /** Base URL for the artifact-fetch endpoint, used to make FileParts reachable. */
  const artifactBaseUrl = (): string => `${cardUrl()}/artifacts`;

  let actualPort = config.a2aPort;
  const ratePerSec = config.a2aRateLimitPerSec ?? A2A_RATE_LIMIT_REFILL;
  const rateLimit = new TokenBucket(ratePerSec, ratePerSec);

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    // When CORS origins are configured (opt-in), reflect the requesting origin
    // on every response so a browser-based console can talk to the bridge.
    applyCors(req, res, config);

    if (req.method === 'GET' && (url === '/.well-known/agent.json' || url === '/.well-known/agent-card.json')) {
      if (!card) {
        const base = buildAgentCard({
          name: 'wb-cursor-bridge',
          description:
            'WorkBuddy ↔ Cursor interoperability bridge. Exposes the Cursor coding ' +
            'sub-agent as an A2A agent: dispatch coding tasks, stream progress, and ' +
            'receive artifacts (patches, reports) over the Agent2Agent protocol.',
          version,
          endpointUrl: cardUrl(),
          skills,
          authEnabled: Boolean(config.a2aAuthToken),
          provider: PROVIDER,
          documentationUrl: 'https://www.workbuddy.cn',
        });
        // v1.0 moves protocolVersion off the card top level into
        // supportedInterfaces; the rest of the card is unchanged.
        card = isV1(a2aVersion) ? toV1Card(base, cardUrl()) : base;
      }
      return sendJson(res, 200, card);
    }

    if (url === '/a2a' && req.method === 'OPTIONS') {
      // CORS preflight. Only meaningful when CORS is configured; otherwise the
      // bridge does not advertise cross-origin support, so 405 is honest.
      if (config.a2aCorsOrigins && config.a2aCorsOrigins.length > 0) {
        res.writeHead(204, { 'content-length': '0' });
        return res.end();
      }
      res.writeHead(405, { allow: 'POST' });
      return res.end();
    }

    if (url === '/a2a' && req.method === 'POST') {
      // Token-bucket gate: a drained bucket returns 429 rather than letting a
      // flood of requests pile up against maxConcurrency or an SSRF pivot loop.
      if (!rateLimit.take(1)) {
        sendJson(res, 429, rpcError(A2A_ERROR.RATE_LIMITED, 'rate limit exceeded; retry later'));
        return;
      }
      return handlePost(mgr, skills, config, log, req, res, artifactBaseUrl);
    }

    // Artifact fetch endpoint: serves captured patch / report files so a remote
    // A2A client can retrieve deliverables whose FilePart URI points here.
    const artMatch = url.match(/^\/a2a\/artifacts\/([^/]+)\/([^/]+)$/);
    if (artMatch && req.method === 'GET') {
      return serveArtifact(mgr, config, log, req, res, artMatch[1], artMatch[2]);
    }

    if (url === '/a2a' && req.method === 'GET') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed; POST JSON-RPC to /a2a' }));
      return;
    }

    // Lightweight observability endpoints for orchestrators / probes. Guarded by
    // the same auth as the RPC surface so they don't leak operational detail.
    if (url === '/healthz' && req.method === 'GET') {
      if (!authOk(req, config.a2aAuthToken)) {
        sendJson(res, 401, rpcError(A2A_ERROR.AUTH_REQUIRED, 'unauthorized'));
        return;
      }
      return sendJson(res, 200, { ok: true, status: 'healthy' });
    }
    if (url === '/metrics' && req.method === 'GET') {
      if (!authOk(req, config.a2aAuthToken)) {
        sendJson(res, 401, rpcError(A2A_ERROR.AUTH_REQUIRED, 'unauthorized'));
        return;
      }
      return sendJson(res, 200, mgr.getMetrics());
    }
    if (url === '/version' && req.method === 'GET') {
      if (!authOk(req, config.a2aAuthToken)) {
        sendJson(res, 401, rpcError(A2A_ERROR.AUTH_REQUIRED, 'unauthorized'));
        return;
      }
      return sendJson(res, 200, { name: 'wb-cursor-bridge', version });
    }

    return sendJson(res, 404, {
      error: 'not found',
      agentCard: '/.well-known/agent.json',
      rpc: 'POST /a2a',
    });
  });

  server.on('error', (err) => {
    log.error('a2a server failed', { err: String(err) });
  });

  server.listen(config.a2aPort, config.a2aHost, () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') actualPort = addr.port;
    if (config.a2aHost === '0.0.0.0' && !config.a2aAuthToken) {
      log.warn(
        'a2a server exposed on 0.0.0.0 without an auth token; the control plane ' +
          'is reachable from any network. Set CURSOR_BRIDGE_A2A_AUTH_TOKEN to secure it.',
      );
    }
    log.info('a2a server listening', {
      url: `http://${config.a2aHost}:${actualPort}/a2a`,
      agentCard: `http://${config.a2aHost}:${actualPort}/.well-known/agent.json`,
      skills: skills.length,
      auth: Boolean(config.a2aAuthToken),
    });
  });

  return server;
}

/* --------------------------------------------------------------- transport */

/**
 * Reflect a configured CORS origin onto the response. `res.setHeader` merges
 * with the headers supplied by the later `writeHead`, so calling this once at the
 * top of the handler is enough for every downstream response (success, error,
 * SSE, artifact). Disabled unless `a2aCorsOrigins` is set, preserving the
 * default closed-by-default posture.
 */
function applyCors(req: http.IncomingMessage, res: http.ServerResponse, config: Config): void {
  const origins = config.a2aCorsOrigins;
  if (!origins || origins.length === 0) return;
  const origin = req.headers['origin'];
  if (!origin || typeof origin !== 'string') return;
  if (origins.includes('*') || origins.includes(origin)) {
    // Reflect the specific origin (never '*') so credentials remain permitted.
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,authorization,x-a2a-token');
    res.setHeader('access-control-max-age', '600');
  }
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendJsonRpc(res: http.ServerResponse, id: string | number | null, body: Partial<JsonRpcResponse>): void {
  sendJson(res, 200, { jsonrpc: JsonRpcVersion, id, ...body });
}

function rpcError(
  code: number,
  message: string,
  data?: unknown,
): { error: { code: number; message: string; data?: unknown } } {
  return { error: { code, message, data } };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authOk(req: http.IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const header = req.headers['authorization'];
  const direct = req.headers['x-a2a-token'];
  const bearer = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : undefined;
  return bearer === token || direct === token;
}

async function handlePost(
  mgr: JobManager,
  skills: SkillEntry[],
  config: Config,
  log: Logger,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  artifactBase: () => string,
): Promise<void> {
  if (!authOk(req, config.a2aAuthToken)) {
    sendJson(res, 401, rpcError(A2A_ERROR.AUTH_REQUIRED, 'unauthorized: missing or invalid A2A token'));
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 413, rpcError(A2A_ERROR.INVALID_REQUEST, 'payload too large'));
    return;
  }

  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as JsonRpcRequest;
  } catch {
    sendJson(res, 200, { jsonrpc: JsonRpcVersion, id: null, ...rpcError(A2A_ERROR.PARSE_ERROR, 'parse error') });
    return;
  }

  const id = parsed.id ?? null;
  if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
    sendJsonRpc(res, id, rpcError(A2A_ERROR.INVALID_REQUEST, 'invalid JSON-RPC 2.0 request'));
    return;
  }

  // A Request object with no `id` member is a JSON-RPC *notification*: the
  // server MUST NOT reply to it. We still execute the side effect (e.g. a
  // fire-and-forget message/send) but emit no response. Streaming methods
  // cannot deliver anything to a notification, so they are simply ignored.
  const isNotification = parsed.id === undefined;

  // Streaming methods speak SSE rather than a single JSON response.
  const isStream = parsed.method === 'message/stream' || parsed.method === 'tasks/resubscribe';
  if (isStream) {
    if (isNotification) return;
    return handleStream(mgr, skills, config, log, parsed, req, res, artifactBase);
  }

  if (isNotification) {
    // Best-effort side effect, no wire response.
    await dispatch(mgr, skills, config, log, parsed, artifactBase).catch((err) =>
      log.warn('a2a notification error', { method: parsed.method, err: String((err as Error)?.message) }),
    );
    return;
  }

  try {
    const result = await dispatch(mgr, skills, config, log, parsed, artifactBase);
    sendJsonRpc(res, id, { result });
  } catch (err) {
    const code = a2aErrorCode(err);
    log.warn('a2a rpc error', { method: parsed.method, code, message: String((err as Error)?.message) });
    sendJsonRpc(res, id, rpcError(code, (err as Error)?.message ?? 'internal error'));
  }
}

function a2aErrorCode(err: unknown): number {
  const code = (err as { code?: string })?.code;
  if (code === 'E_NOT_FOUND') return A2A_ERROR.TASK_NOT_FOUND;
  if (code === 'E_CONCURRENCY') return A2A_ERROR.INTERNAL_ERROR;
  if (code === 'E_BAD_ARGUMENT') return A2A_ERROR.INVALID_PARAMS;
  if (code === 'E_PATH_DENIED') return A2A_ERROR.INVALID_PARAMS;
  if (code === 'E_METHOD_NOT_FOUND') return A2A_ERROR.METHOD_NOT_FOUND;
  if (code === 'E_UNSUPPORTED') return A2A_ERROR.UNSUPPORTED_OPERATION;
  if (code === 'E_CANCEL_NOT_ALLOWED') return A2A_ERROR.TASK_NOT_CANCELABLE;
  if (code === 'E_INCOMPATIBLE') return A2A_ERROR.INCOMPATIBLE_CONTENT_TYPES;
  return A2A_ERROR.INTERNAL_ERROR;
}

/* ------------------------------------------------------------- dispatch */

async function dispatch(
  mgr: JobManager,
  skills: SkillEntry[],
  config: Config,
  log: Logger,
  req: JsonRpcRequest,
  artifactBase: () => string,
): Promise<unknown> {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const a2aVersion = config.a2aProtocolVersion ?? '0.3.0';

  switch (req.method) {
    case 'message/send': {
      const message = requireMessage(params);
      const configuration = configOf(params);
      // Content negotiation: reject early if the client asked for output modes
      // the bridge cannot produce.
      assertOutputModesAccepted(configuration);

      const job = await createOrResume(mgr, skills, message);
      maybePush(mgr, job, params, config, log);

      const historyLength = configuration?.historyLength;
      const withHistory = historyLength !== undefined;
      const taskOpts = {
        withHistory,
        historyLength,
        artifactBase: artifactBase(),
        a2aVersion,
      };

      // A2A `blocking`: hold the response until the task reaches a final /
      // input-required state (or the cap), so a synchronous caller gets a settled
      // task without a second round-trip. The cap prevents a long-running job
      // from pinning the HTTP connection indefinitely.
      if (configuration?.blocking) {
        const final = await awaitBlockingFinal(mgr, job.id, config.a2aBlockingMaxMs ?? 90_000);
        return toTask(final, taskOpts);
      }
      return toTask(job, taskOpts);
    }

    case 'tasks/get': {
      const id = strParam(params, 'id', 'tasks/get.id');
      const job = mgr.store.get(id);
      if (!job) throw notFound(`unknown task ${id}`);
      const historyLength = numParam(params, 'historyLength');
      return toTask(job, {
        withHistory: true,
        historyLength: historyLength === undefined ? 20 : historyLength,
        artifactBase: artifactBase(),
        a2aVersion,
      });
    }

    case 'tasks/cancel': {
      const id = strParam(params, 'id', 'tasks/cancel.id');
      const job = mgr.store.get(id);
      if (!job) throw notFound(`unknown task ${id}`);
      // A2A: only submitted/working/input-required tasks are cancelable.
      if (job.status !== 'running' && job.status !== 'input-required') {
        throw new BridgeCancelError();
      }
      const cancelled = mgr.cancel(id);
      return toTask(cancelled, { withHistory: false, a2aVersion });
    }

    case 'tasks/resubscribe':
      // Non-streaming resubscribe is not meaningful; A2A clients use the SSE
      // variant. Reject explicitly so the error is clear.
      throw new BridgeUnsupported('tasks/resubscribe must be called over SSE');

    default:
      throw new BridgeMethodNotFound(req.method);
  }
}

/** Resolve the skill/root, extract the prompt, then start or resume a task. */
async function createOrResume(
  mgr: JobManager,
  skills: SkillEntry[],
  message: Message,
): Promise<Job> {
  if (message.messageId === undefined) message.messageId = randomUUID();

  const { prompt, hasText } = messageToPrompt(message);
  if (!hasText) throw badArgument('message must contain at least one text part');

  const tier: Tier = tierOf(message) ?? 'execute';

  // A provided taskId means the client is continuing an existing task.
  if (message.taskId) {
    const existing = mgr.store.get(message.taskId);
    if (!existing) throw notFound(`unknown task ${message.taskId}`);
    if (existing.status === 'running') {
      throw badArgument(`task ${message.taskId} is still running; cannot send input yet`);
    }
    if (existing.status === 'input-required') {
      // Resume the SAME task (input-required -> working -> completed on one id).
      const resumed = mgr.reply(message.taskId, prompt, tier);
      resumed.contextId = existing.contextId ?? resumed.contextId ?? randomUUID();
      mgr.store.touch();
      return resumed;
    }
    // Terminal task: never spawn a non-idempotent follow-up on a repeated
    // message/send (network retries would create duplicate tasks). The caller
    // must open a fresh task without taskId. Reply-on-terminal is an MCP-only
    // convenience and is intentionally not available over A2A.
    throw badArgument(
      `task ${message.taskId} is in terminal state '${existing.status}'; ` +
        `send a new message without taskId to start a fresh task`,
    );
  }

  // New task: resolve the skill/root.
  const skillId = skillIdOf(message);
  let root = resolveRoot(skills, skillId);
  if (!root) {
    if (skills.length === 1 && !skillId) {
      root = skills[0].root;
    } else {
      throw badArgument(
        `no workspace selected; pass metadata.skillId (one of: ${skills
          .map((s) => s.id)
          .join(', ')})${skills.length === 0 ? ' — configure CURSOR_BRIDGE_WORKSPACE_ROOTS' : ''}`,
      );
    }
  }

  const contextId = message.contextId ?? randomUUID();
  const job = mgr.start({ prompt, workspace: root, tier });
  job.contextId = contextId;
  const skill = skills.find((s) => s.root === root);
  (job.metadata ??= {}).skillId = skill?.id;
  mgr.store.touch();
  return job;
}

/**
 * Fire-and-forget push notifications when the client supplied a webhook.
 *
 * Hardened: webhooks are only honoured when the A2A surface is authenticated,
 * and the target URL must be a public http(s) endpoint — private / loopback /
 * link-local addresses are rejected to prevent SSRF against internal services
 * or cloud metadata (169.254.169.254).
 */
function maybePush(
  mgr: JobManager,
  job: Job,
  params: Record<string, unknown>,
  config: Config,
  log: Logger,
  signal?: AbortSignal,
): void {
  const push = pushConfigOf(params);
  if (!push) return;
  if (!config.a2aAuthToken) {
    log.warn('push notifications ignored: A2A auth token is required to enable webhooks', {
      taskId: job.id,
    });
    return;
  }
  const blocked = unsafePushUrl(push.url, config.a2aPushUrlAllowlist);
  if (blocked) {
    log.warn('push notification url rejected', { taskId: job.id, url: push.url, reason: blocked });
    return;
  }
  void watchAndPush(mgr, job.id, push, log.child('push'), signal).catch((err) =>
    log.warn('push watcher error', { taskId: job.id, err: String(err) }),
  );
}

/**
 * Poll a task until it reaches a terminal / input-required state, or until the
 * blocking cap elapses. Returns the job at that point so a blocking
 * `message/send` can return a settled Task. Input-required counts as "settled"
 * for blocking because the server is paused awaiting caller input and cannot
 * progress without it.
 */
async function awaitBlockingFinal(
  mgr: JobManager,
  taskId: string,
  maxMs: number,
): Promise<Job> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const job = mgr.store.get(taskId);
    if (!job) throw notFound(`unknown task ${taskId}`);
    if (isFinalState(toTaskState(job.status))) return job;
    if (Date.now() >= deadline) {
      // Cap reached: hand back the current (likely still working) task rather
      // than erroring, so the client can switch to polling / streaming.
      return job;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/* --------------------------------------------------------------- streaming */

async function handleStream(
  mgr: JobManager,
  skills: SkillEntry[],
  config: Config,
  log: Logger,
  req: JsonRpcRequest,
  httpReq: http.IncomingMessage,
  res: http.ServerResponse,
  artifactBase: () => string,
): Promise<void> {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const a2aVersion = config.a2aProtocolVersion ?? '0.3.0';
  const controller = new AbortController();
  httpReq.on('close', () => controller.abort());

  let job: Job;
  try {
    if (req.method === 'message/stream') {
      const message = requireMessage(params);
      assertOutputModesAccepted(configOf(params));
      job = await createOrResume(mgr, skills, message);
      maybePush(mgr, job, params, config, log, controller.signal);
    } else {
      // tasks/resubscribe
      const id = strParam(params, 'id', 'tasks/resubscribe.id');
      const existing = mgr.store.get(id);
      if (!existing) throw notFound(`unknown task ${id}`);
      job = existing;
    }
  } catch (err) {
    const code = a2aErrorCode(err);
    sendJsonRpc(res, req.id ?? null, rpcError(code, (err as Error)?.message ?? 'internal error'));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(`retry: 2000\n\n`);

  try {
    for await (const ev of subscribeTask(mgr, job.id, controller.signal, artifactBase(), a2aVersion)) {
      if (controller.signal.aborted) break;
      writeEvent(res, ev);
      if (ev.kind === 'status-update' && ev.final) break;
    }
  } catch (err) {
    log.warn('a2a stream error', { taskId: job.id, err: String(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

function writeEvent(res: http.ServerResponse, ev: TaskEvent): void {
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

/** Serve a captured artifact (patch / report) file for a task. */
function serveArtifact(
  mgr: JobManager,
  config: Config,
  log: Logger,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  taskIdRaw: string,
  nameRaw: string,
): void {
  if (!authOk(req, config.a2aAuthToken)) {
    sendJson(res, 401, rpcError(A2A_ERROR.AUTH_REQUIRED, 'unauthorized: missing or invalid A2A token'));
    return;
  }
  const taskId = decodeURIComponent(taskIdRaw);
  const name = decodeURIComponent(nameRaw);
  const job = mgr.store.get(taskId);
  if (!job) {
    sendJson(res, 404, { error: 'unknown task' });
    return;
  }
  // Only the known, bridge-produced artifacts are addressable. Both paths are
  // absolute and under the job's state directory, so there is no traversal
  // surface here.
  let filePath: string | undefined;
  let mime = 'application/octet-stream';
  if (name === 'changes.patch') {
    filePath = job.patchFile;
    mime = 'text/x-diff; charset=utf-8';
  } else if (name === 'report.md') {
    filePath = job.reportFile;
    mime = 'text/markdown; charset=utf-8';
  }
  if (!filePath || !fs.existsSync(filePath)) {
    sendJson(res, 404, { error: 'artifact not found' });
    return;
  }
  try {
    const size = fs.statSync(filePath).size;
    res.writeHead(200, {
      'content-type': mime,
      'content-length': size,
      'cache-control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    log.warn('artifact serve failed', { taskId, name, err: String(err) });
    if (!res.headersSent) sendJson(res, 500, { error: 'artifact serve failed' });
  }
}

/**
 * Reject push-notification URLs that would let an authenticated caller pivot the
 * bridge into a Server-Side Request Forgery: only public http(s) endpoints are
 * allowed, and private / loopback / link-local hosts are blocked.
 */
function unsafePushUrl(url: string, allowlist?: string[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'invalid URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `unsupported scheme "${u.protocol}" (only http/https allowed)`;
  }
  const host = u.hostname;
  if (allowlist && (allowlist.includes(host) || allowlist.includes(u.host))) {
    return null; // explicitly trusted target
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    return 'localhost is not an allowed push target';
  }
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/i.test(host)) {
    return 'IPv6 loopback / unique-local / link-local is not an allowed push target';
  }
  const octets = host.split('.');
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o))) {
    const a = Number(octets[0]);
    const b = Number(octets[1]);
    if (a === 10) return 'RFC1918 private (10/8) is not an allowed push target';
    if (a === 127) return 'loopback (127/8) is not an allowed push target';
    if (a === 169 && b === 254) return 'link-local (169.254/16) is not an allowed push target';
    if (a === 172 && b >= 16 && b <= 31) return 'RFC1918 private (172.16/12) is not an allowed push target';
    if (a === 192 && b === 168) return 'RFC1918 private (192.168/16) is not an allowed push target';
  }
  return null;
}

/* ----------------------------------------------------------------- helpers */

function requireMessage(params: Record<string, unknown>): Message {
  const m = params.message;
  if (!m || typeof m !== 'object') throw badArgument('params.message is required');
  const msg = m as Message;
  if (!Array.isArray(msg.parts) || msg.parts.length === 0) {
    throw badArgument('message.parts must be a non-empty array');
  }
  if (msg.role !== 'user' && msg.role !== 'agent') {
    throw badArgument('message.role must be "user" or "agent"');
  }
  // A2A `message/send` is a request FROM the client TO this agent, so the
  // initiating role is always the user. An `agent` role here is a protocol
  // error and would mislabel a continuation as the agent talking to itself.
  if (msg.role !== 'user') {
    throw badArgument('message/send requires role "user" (continuations are user input)');
  }
  return msg;
}

function strParam(params: Record<string, unknown>, key: string, label: string): string {
  const v = params[key];
  if (typeof v !== 'string' || v.length === 0) throw badArgument(`params.${label} must be a string`);
  return v;
}

function numParam(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (Number.isNaN(n)) throw badArgument(`params.${key} must be a number`);
  return n;
}

/* Typed error helpers mapped to A2A error codes. */

class BridgeMethodNotFound extends Error {
  constructor(method: string) {
    super(`method not found: ${method}`);
    this.name = 'BridgeMethodNotFound';
  }
  code = 'E_METHOD_NOT_FOUND' as const;
}

class BridgeUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeUnsupported';
  }
  code = 'E_UNSUPPORTED' as const;
}

class BridgeCancelError extends Error {
  constructor() {
    super('task is in a state that cannot be cancelled');
    this.name = 'BridgeCancelError';
  }
  code = 'E_CANCEL_NOT_ALLOWED' as const;
}

class BridgeIncompatible extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeIncompatible';
  }
  code = 'E_INCOMPATIBLE' as const;
}
