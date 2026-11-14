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
import { pipeline } from 'node:stream';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import dns from 'node:dns/promises';
import { privateAddressReason } from '../util/net.js';
import type { JobManager } from '../runner.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Job, Tier } from '../types.js';
import { badArgument, notFound } from '../errors.js';
import { buildAgentCard, buildV1AgentCard, AGENT_OUTPUT_MODES, type AgentCardOptions } from './card.js';
import { toV1Card, isV1, type A2AVersion } from './compat.js';
import {
  A2A_VERSION_HEADER,
  VersionNotSupportedError,
  resolveVersion,
  mapV1Method,
  fromV1Params,
  wrapV1Result,
  toV1StreamResponse,
  toV1Task as toWireV1Task,
  isV1Terminal,
  type WireVersion,
} from './v1.js';
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
  type Task,
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

/**
 * Per-client token bucket.
 *
 * A single shared bucket is not a rate limit, it is a global lock: one caller
 * draining it makes every other client 429 until it refills. Keying by peer
 * address means a noisy neighbour only starves itself. Buckets are swept once
 * the map grows large, so a spoofed-source flood cannot grow memory unbounded.
 */
class PerClientRateLimiter {
  private buckets = new Map<string, { tokens: number; last: number; seen: number }>();
  private readonly capacity: number;
  constructor(
    private readonly ratePerSec: number,
    capacity = 0,
  ) {
    this.capacity = Math.max(1, capacity || ratePerSec);
  }
  take(key: string, n = 1): boolean {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: now, seen: now };
      this.buckets.set(key, b);
    }
    const dt = (now - b.last) / 1000;
    b.last = now;
    b.seen = now;
    b.tokens = Math.min(this.capacity, b.tokens + dt * this.ratePerSec);
    if (b.tokens >= n) {
      b.tokens -= n;
      this.sweep(now);
      return true;
    }
    return false;
  }
  private sweep(now: number): void {
    if (this.buckets.size < 2048) return;
    for (const [key, b] of this.buckets) {
      if (now - b.seen > 600_000) this.buckets.delete(key);
    }
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
  /**
   * Two independent discovery documents, deliberately kept separate:
   *  - `/.well-known/agent.json` is the legacy v0.3.0 card (and the historical
   *    `a2aProtocolVersion:'1.0'` static switch). Existing clients/tests read
   *    this path, so its bytes never change.
   *  - `/.well-known/agent-card.json` is the wire-compliant v1.0 card the
   *    official A2A TCK discovers. It carries `supportedInterfaces[0]` with a
   *    standard `protocolBinding`, which is what lets the TCK build a JSON-RPC
   *    client at all (the 0.5.1 baseline had neither → 3 FAIL + 219 errors).
   */
  let card: AgentCard | null = null;
  let v1Card: Record<string, unknown> | null = null;
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

  /** Shared AgentCard inputs for both discovery documents. */
  const cardOptions = (): AgentCardOptions => ({
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

  let actualPort = config.a2aPort;
  const ratePerSec = config.a2aRateLimitPerSec ?? A2A_RATE_LIMIT_REFILL;
  const rateLimit = new PerClientRateLimiter(ratePerSec);

  const server = http.createServer((req, res) => {
    // Defence in depth: a synchronous throw anywhere below (e.g. a malformed
    // URI reaching decodeURIComponent) must never escape this listener - an
    // uncaught throw becomes an uncaughtException and shuts the whole bridge
    // down, turning one bad request into a remote DoS. Catch, log, and answer
    // 500 instead.
    try {
    const rawUrl = (req.url ?? '/').split('?')[0];
    /**
     * The A2A v1.0 TCK JSON-RPC client takes its base_url from
     * supportedInterfaces[0].url (e.g. http://host:port/a2a) and POSTs to "/",
     * which httpx resolves to the trailing-slash path "/a2a/". Normalise that
     * single alias to "/a2a" so auth, rate limiting and routing all behave
     * exactly as they do for the canonical path.
     */
    const url = rawUrl === '/a2a/' ? '/a2a' : rawUrl;

    // When CORS origins are configured (opt-in), reflect the requesting origin
    // on every response so a browser-based console can talk to the bridge.
    applyCors(req, res, config);

    /**
     * One gate for every dynamic route, GET included: a per-IP bucket limits a
     * single abuser without letting them starve everybody else. Discovery
     * (`/.well-known/agent.json`) is exempt so probes and load balancers can
     * always read the card.
     */
    const isDiscovery = url === '/.well-known/agent.json' || url === '/.well-known/agent-card.json';
    if (!isDiscovery) {
      const clientKey = req.socket.remoteAddress ?? 'unknown';
      if (!rateLimit.take(clientKey)) {
        res.setHeader('retry-after', '1');
        sendJson(res, 429, rpcError(A2A_ERROR.RATE_LIMITED, 'rate limit exceeded; retry later'));
        return;
      }
    }

    if (req.method === 'GET' && (url === '/.well-known/agent.json' || url === '/.well-known/agent-card.json')) {
      if (url === '/.well-known/agent-card.json') {
        // v1.0 TCK discovery path: always the strict, wire-compliant card.
        // It is independent of the legacy `a2aProtocolVersion` static switch.
        v1Card ??= buildV1AgentCard(cardOptions());
        return sendJson(res, 200, v1Card);
      }
      // Legacy v0.3.0 discovery path, byte-for-byte unchanged. The static
      // `a2aProtocolVersion:'1.0'` switch keeps its historical shallow
      // toV1Card() behaviour here for the existing tests/clients.
      if (!card) {
        const base = buildAgentCard(cardOptions());
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
      /**
       * `handlePost` is async; returning its promise from this synchronous
       * listener means a rejection never reaches the surrounding try/catch.
       * Attach the handler here so no single request can escalate into a
       * process-level unhandledRejection.
       */
      void handlePost(mgr, skills, config, log, req, res, artifactBaseUrl).catch((err) => {
        log.error('a2a request failed', { err: err instanceof Error ? err.stack : String(err) });
        if (!res.headersSent) {
          sendJson(res, 500, rpcError(A2A_ERROR.INTERNAL_ERROR, 'internal error'));
        } else if (!res.writableEnded) {
          res.destroy();
        }
      });
      return;
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
      /**
       * A hard-coded `{ok:true}` is worse than no health check: an orchestrator
       * keeps routing work to a bridge whose cursor binary is missing. Report
       * the real health, and use 503 so a probe can act on it.
       */
      const health = mgr.health() as { ok?: boolean; issues?: string[] };
      const ok = health.ok !== false;
      return sendJson(res, ok ? 200 : 503, {
        ok,
        status: ok ? 'healthy' : 'degraded',
        issues: health.issues ?? [],
      });
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
    } catch (err) {
      log.error('a2a request handler error', {
        err: err instanceof Error ? err.stack : String(err),
      });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal error' });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  /**
   * Node's defaults (60s headers / no request timeout) let one client hold
   * thousands of half-open connections: a slowloris never finishes the header
   * block, so the request handler is never reached and the rate limiter never
   * sees it. These limits apply to READING the request, so long-lived SSE
   * responses are unaffected.
   */
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 512;

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
  const wildcard = origins.includes('*');
  if (!wildcard && !origins.includes(origin)) return;
  // Reflect the specific origin (never '*') so that per-origin Vary caching
  // stays meaningful.
  res.setHeader('access-control-allow-origin', origin);
  // `allow-credentials` on a reflected origin means the browser will attach
  // cookies/authorization to cross-origin calls and let the calling script read
  // the response - for *every* origin when the list is a wildcard. It is
  // therefore opt-in only, and config load rejects the wildcard combo outright.
  if (config.a2aCorsAllowCredentials) {
    res.setHeader('access-control-allow-credentials', 'true');
  }
  // The body of the response now varies by request Origin; without this a
  // shared cache can serve one origin's response to another.
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization,x-a2a-token');
  res.setHeader('access-control-max-age', '600');
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  // A blocking caller may have disconnected while we held its request open.
  // Writing to a destroyed response is at best wasted work; guard so the bridge
  // never depends on the runtime quietly swallowing it.
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  try {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  } catch {
    /* client vanished between the check and the write */
  }
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

/** Constant-time string comparison for secrets (guards against timing oracles). */
function safeEqual(a: string, b: string): boolean {
  /**
   * Hash both sides to a fixed 32 bytes before comparing. The earlier version
   * compared lengths first, which leaks the secret's length and (measured) made
   * an early mismatch ~7x faster than a late one - a usable oracle for
   * recovering a token byte by byte over a long-lived connection.
   */
  const ab = createHash('sha256').update(a, 'utf8').digest();
  const bb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ab, bb);
}

function authOk(req: http.IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const header = req.headers['authorization'];
  const direct = req.headers['x-a2a-token'];
  const bearer = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : undefined;
  const directStr = typeof direct === 'string' ? direct : undefined;
  // Compare in constant time so a caller cannot recover the token byte-by-byte
  // from response timing on a long-lived, network-reachable endpoint.
  return (
    (bearer !== undefined && safeEqual(bearer, token)) ||
    (directStr !== undefined && safeEqual(directStr, token))
  );
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
    const decoded: unknown = JSON.parse(raw.toString('utf8'));
    /**
     * Shape guard before touching a single field. `JSON.parse('null')` is a
     * perfectly valid parse whose value is `null`, and `parsed.id` then throws
     * a TypeError inside an async handler. That rejection escaped the sync
     * try/catch around the request listener, counted against the
     * unhandledRejection budget, and 20 four-byte POSTs killed the process.
     * Arrays and primitives are equally invalid as a JSON-RPC *request object*.
     */
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      sendJson(res, 200, {
        jsonrpc: JsonRpcVersion,
        id: null,
        ...rpcError(A2A_ERROR.INVALID_REQUEST, 'invalid JSON-RPC 2.0 request'),
      });
      return;
    }
    parsed = decoded as JsonRpcRequest;
  } catch {
    sendJson(res, 200, { jsonrpc: JsonRpcVersion, id: null, ...rpcError(A2A_ERROR.PARSE_ERROR, 'parse error') });
    return;
  }

  const rawId: unknown = parsed.id;
  if (rawId !== undefined && rawId !== null && typeof rawId !== 'string' && typeof rawId !== 'number') {
    sendJson(res, 200, {
      jsonrpc: JsonRpcVersion,
      id: null,
      ...rpcError(A2A_ERROR.INVALID_REQUEST, 'id must be a string, number or null'),
    });
    return;
  }
  const id = (rawId ?? null) as string | number | null;
  if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
    sendJsonRpc(res, id, rpcError(A2A_ERROR.INVALID_REQUEST, 'invalid JSON-RPC 2.0 request'));
    return;
  }

  // ---- A2A-Version negotiation (v1.0 wire vs legacy v0.3.0) --------------
  // The official A2A TCK and real v1.0 clients send `A2A-Version: 1.0`
  // together with PascalCase methods and an entirely different data model.
  // Everything else keeps the legacy path byte-for-byte: no header, an empty
  // header, or `0.3` all fall through to the original handlers. The static
  // `a2aProtocolVersion` config switch is a separate, independent dimension —
  // it only affects the legacy card / task serialisation, never this wire.
  const wireParams = (parsed.params ?? {}) as Record<string, unknown>;
  let wireVersion: WireVersion;
  try {
    wireVersion = resolveVersion(req.headers[A2A_VERSION_HEADER], wireParams, '0.3.0');
  } catch (err) {
    // VER-SERVER-002: an unsupported version MUST answer -32009, not crash
    // and not silently process the request as 0.3.
    sendJsonRpc(res, id, rpcError(a2aErrorCode(err), (err as Error)?.message ?? 'unsupported A2A-Version'));
    return;
  }

  let innerReq: JsonRpcRequest = parsed;
  if (wireVersion === '1.0') {
    const innerMethod = mapV1Method(parsed.method);
    if (innerMethod === null) {
      // A v1.0 request carrying a non-spec method name gets a clean -32601.
      sendJsonRpc(res, id, rpcError(A2A_ERROR.METHOD_NOT_FOUND, `method not found: ${parsed.method}`));
      return;
    }
    innerReq = {
      ...parsed,
      method: innerMethod,
      params: fromV1Params(innerMethod, wireParams),
    };

    // Input checks that must run against the *wire* params, before translation
    // drops fields: CORE-SEND-003 (unsupported mediaType), wrong Content-Type,
    // and CORE-MULTI-006 (mismatching contextId/taskId).
    try {
      assertV1WireInput(wireParams, mgr, req.headers['content-type']);
    } catch (err) {
      sendJsonRpc(res, id, rpcError(a2aErrorCode(err), (err as Error)?.message ?? 'invalid request'));
      return;
    }
  }

  // A Request object with no `id` member is a JSON-RPC *notification*: the
  // server MUST NOT reply to it. Streaming methods cannot deliver anything to
  // a notification, so they are simply ignored.
  const isNotification = parsed.id === undefined;

  // Streaming methods speak SSE rather than a single JSON response. The method
  // is the *normalised* one, so v1.0 SendStreamingMessage / SubscribeToTask
  // route here too.
  const isStream = innerReq.method === 'message/stream' || innerReq.method === 'tasks/resubscribe';
  if (isStream) {
    if (isNotification) {
      // JSON-RPC says "do not reply", but HTTP still needs a terminated
      // response: returning without ending the socket left the connection open
      // until the client gave up.
      res.writeHead(202, { 'content-length': '0' });
      res.end();
      return;
    }
    return handleStream(mgr, skills, config, log, innerReq, req, res, artifactBase, wireVersion);
  }

  if (isNotification) {
    // Best-effort side effect, no JSON-RPC reply - but still an HTTP reply.
    await dispatchRequest(mgr, skills, config, log, innerReq, artifactBase, wireVersion).catch((err) =>
      log.warn('a2a notification error', { method: innerReq.method, err: String((err as Error)?.message) }),
    );
    if (!res.writableEnded) {
      res.writeHead(202, { 'content-length': '0' });
      res.end();
    }
    return;
  }

  // A blocking `message/send` can hold this connection for up to
  // `a2aBlockingMaxMs`. If the client hangs up we stop waiting (freeing the
  // request) but never cancel the task itself: the work is still wanted and a
  // caller may reconnect and poll / resubscribe.
  const disconnect = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) disconnect.abort();
  };
  res.once('close', onClose);

  try {
    const result = await dispatchRequest(
      mgr, skills, config, log, innerReq, artifactBase, wireVersion, disconnect.signal,
    );
    if (disconnect.signal.aborted) {
      log.info('a2a client disconnected during a blocking call; task keeps running', {
        method: innerReq.method,
      });
      return;
    }
    // The v1.0 response envelope differs from the internal model: SendMessage
    // becomes { task }, GetTask/CancelTask a v1.0 Task, ListTasks a
    // ListTasksResponse. Translation happens once, here at the boundary.
    const wireResult = wireVersion === '1.0' ? wrapV1Result(innerReq.method, result) : result;
    sendJsonRpc(res, id, { result: wireResult });
  } catch (err) {
    const code = a2aErrorCode(err);
    log.warn('a2a rpc error', { method: innerReq.method, code, message: String((err as Error)?.message) });
    sendJsonRpc(res, id, rpcError(code, (err as Error)?.message ?? 'internal error'));
  } finally {
    res.off('close', onClose);
  }
}

function a2aErrorCode(err: unknown): number {
  // Version negotiation happens before dispatch, so this is a belt-and-braces
  // mapping: an unsupported A2A-Version MUST map to -32009 (VER-SERVER-002).
  if (err instanceof VersionNotSupportedError) return A2A_ERROR.VERSION_NOT_SUPPORTED;
  const code = (err as { code?: string })?.code;
  if (code === 'E_PUSH_NOT_SUPPORTED') return A2A_ERROR.PUSH_NOT_SUPPORTED;
  if (code === 'E_NOT_FOUND') return A2A_ERROR.TASK_NOT_FOUND;
  // Capacity is a retryable condition with its own code, not an internal bug:
  // a client that sees -32603 has no way to know it should back off and retry.
  if (code === 'E_CONCURRENCY') return A2A_ERROR.TASK_REJECTED;
  if (code === 'E_BAD_ARGUMENT') return A2A_ERROR.INVALID_PARAMS;
  if (code === 'E_PATH_DENIED') return A2A_ERROR.INVALID_PARAMS;
  if (code === 'E_METHOD_NOT_FOUND') return A2A_ERROR.METHOD_NOT_FOUND;
  if (code === 'E_UNSUPPORTED') return A2A_ERROR.UNSUPPORTED_OPERATION;
  if (code === 'E_CANCEL_NOT_ALLOWED') return A2A_ERROR.TASK_NOT_CANCELABLE;
  if (code === 'E_INCOMPATIBLE') return A2A_ERROR.INCOMPATIBLE_CONTENT_TYPES;
  return A2A_ERROR.INTERNAL_ERROR;
}

/* ------------------------------------------------- v1.0 request dispatch */

/** Media types this agent can consume on a v1.0 wire (see the Agent Card's
 * defaultOutputModes; defaultInputModes is text/plain). A Part carrying any
 * other mediaType MUST be rejected with -32005 (CORE-SEND-003). */
const V1_SUPPORTED_MEDIA_TYPES = new Set<string>([...AGENT_OUTPUT_MODES]);

/**
 * Validate v1.0 wire-level input that has no v0.3.0 counterpart. This runs
 * against the *raw* params because fromV1Params() intentionally drops fields
 * the internal model cannot represent (mediaType lives inside a flat Part,
 * contextId/taskId live on the wire Message).
 */
function assertV1WireInput(
  params: Record<string, unknown>,
  mgr: JobManager,
  contentType: string | undefined,
): void {
  // JSONRPC-FMT-002 / JSONRPC-SSE-002: a JSON-RPC body sent with a different
  // Content-Type is a content negotiation failure, not a parse error.
  if (typeof contentType === 'string' && contentType.length > 0 &&
      !contentType.toLowerCase().includes('application/json')) {
    throw new BridgeIncompatible(`unsupported Content-Type "${contentType}"; expected application/json`);
  }
  const rawMsg = params.message;
  if (!rawMsg || typeof rawMsg !== 'object') return;
  const msg = rawMsg as Record<string, unknown>;
  for (const p of Array.isArray(msg.parts) ? msg.parts : []) {
    if (!p || typeof p !== 'object') continue;
    const mt = (p as Record<string, unknown>).mediaType;
    if (typeof mt === 'string' && !V1_SUPPORTED_MEDIA_TYPES.has(mt)) {
      throw new BridgeIncompatible(`unsupported media type "${mt}"`);
    }
  }
  // CORE-MULTI-006: a message referencing a task MUST NOT carry a conflicting
  // contextId.
  const taskId = typeof msg.taskId === 'string' ? msg.taskId : undefined;
  const contextId = typeof msg.contextId === 'string' ? msg.contextId : undefined;
  if (taskId && contextId) {
    const job = mgr.store.get(taskId);
    if (job && (job.contextId ?? job.id) !== contextId) {
      throw badArgument('contextId does not match the referenced task');
    }
  }
}

/**
 * Dispatch a normalised request. Operations that exist only on the v1.0 wire
 * (ListTasks, push-config CRUD, extended card) are answered here; the shared
 * operations go through the legacy `dispatch()` unchanged. `wireVersion` is
 * passed down so `toTask()` keeps the internal v0.3.0 model on the v1.0 path —
 * the single v1.0 translation is `wrapV1Result()` at the transport boundary.
 */
async function dispatchRequest(
  mgr: JobManager,
  skills: SkillEntry[],
  config: Config,
  log: Logger,
  req: JsonRpcRequest,
  artifactBase: () => string,
  wireVersion: WireVersion,
  signal?: AbortSignal,
): Promise<unknown> {
  if (wireVersion === '1.0') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    switch (req.method) {
      case 'tasks/list':
        return listTasksV1(mgr, params, artifactBase);
      case 'tasks/pushConfig/create':
      case 'tasks/pushConfig/get':
      case 'tasks/pushConfig/list':
      case 'tasks/pushConfig/delete':
        // CORE-CAP-001: the v1.0 card declares pushNotifications:false, so
        // every push-config operation MUST answer -32003.
        throw new BridgePushNotSupported();
      case 'agent/extendedCard':
        // CORE-CAP-003: no extendedAgentCard capability is declared.
        throw new BridgeUnsupported('GetExtendedAgentCard is not supported by this agent');
    }
  }
  return dispatch(mgr, skills, config, log, req, artifactBase, signal, wireVersion);
}

/**
 * ListTasks for the v1.0 wire. Cursor pagination uses a numeric offset token;
 * nextPageToken is an empty string on the final page (CORE-LIST-004). Tasks are
 * sorted by status timestamp descending (CORE-LIST-003) and artifacts are
 * omitted entirely unless includeArtifacts is true (CORE-LIST-005).
 */
function listTasksV1(
  mgr: JobManager,
  params: Record<string, unknown>,
  artifactBase: () => string,
): { tasks: Task[]; nextPageToken: string; pageSize: number; totalSize: number } {
  const contextId = typeof params.contextId === 'string' ? params.contextId : undefined;
  const status = typeof params.status === 'string' ? params.status : undefined;
  const after = typeof params.statusTimestampAfter === 'string' ? params.statusTimestampAfter : undefined;
  const includeArtifacts = params.includeArtifacts === true;
  const historyLength = typeof params.historyLength === 'number' ? params.historyLength : undefined;

  const stamp = (j: Job): string => j.inputRequiredAt ?? j.finishedAt ?? j.createdAt;
  let jobs = mgr.store.list({ limit: Number.MAX_SAFE_INTEGER });
  if (contextId) jobs = jobs.filter((j) => (j.contextId ?? j.id) === contextId);
  if (status) jobs = jobs.filter((j) => toTaskState(j.status) === status);
  jobs.sort((a, b) => (stamp(a) > stamp(b) ? -1 : stamp(a) < stamp(b) ? 1 : 0));
  if (after) jobs = jobs.filter((j) => stamp(j) > after);

  const totalSize = jobs.length;
  const pageSize = typeof params.pageSize === 'number' && params.pageSize > 0
    ? Math.min(Math.floor(params.pageSize), 1000)
    : 50;
  const token = typeof params.pageToken === 'string' ? params.pageToken : '';
  const start = token ? Math.max(0, Number.parseInt(token, 10) || 0) : 0;
  const page = jobs.slice(start, start + pageSize);
  const nextPageToken = start + page.length < totalSize ? String(start + page.length) : '';

  const base = artifactBase();
  const tasks: Task[] = page.map((j) => {
    const t = toTask(j, {
      withHistory: typeof historyLength === 'number' && historyLength > 0,
      historyLength,
      artifactBase: base,
      a2aVersion: '0.3.0',
    });
    if (!includeArtifacts) delete t.artifacts;
    return t;
  });
  return { tasks, nextPageToken, pageSize, totalSize };
}

/* ------------------------------------------------------------- dispatch */

async function dispatch(
  mgr: JobManager,
  skills: SkillEntry[],
  config: Config,
  log: Logger,
  req: JsonRpcRequest,
  artifactBase: () => string,
  signal?: AbortSignal,
  wireVersion: WireVersion = '0.3.0',
): Promise<unknown> {
  const params = (req.params ?? {}) as Record<string, unknown>;
  // On the v1.0 runtime path the engine must emit the *internal* 0.3 model:
  // wrapV1Result() performs the one and only v1.0 translation. Applying the
  // legacy static switch here too would double-translate the payload.
  const a2aVersion = wireVersion === '1.0' ? '0.3.0' : (config.a2aProtocolVersion ?? '0.3.0');

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
        const final = await awaitBlockingFinal(
          mgr,
          job.id,
          config.a2aBlockingMaxMs ?? 90_000,
          signal,
        );
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
  void verifyPushTarget(push.url, config.a2aPushUrlAllowlist)
    .then((blocked) => {
      if (blocked) {
        // Never log the raw URL: it can carry a secret in the query string.
        log.warn('push notification url rejected', {
          taskId: job.id,
          url: safeUrlForLog(push.url),
          reason: blocked,
        });
        return;
      }
      return watchAndPush(mgr, job.id, push, log.child('push'), signal);
    })
    .catch((err) => log.warn('push watcher error', { taskId: job.id, err: String(err) }));
}

/** Origin + path only: query strings routinely carry webhook secrets. */
export function safeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<unparseable url>';
  }
}

/**
 * Full SSRF gate: string-level classification PLUS a DNS resolution check.
 *
 * `unsafePushUrl` only inspects the literal host, so `https://attacker.example`
 * that resolves to 10.0.0.5 walked straight through. We now resolve every
 * address the name maps to and reject the target unless ALL of them are public.
 * Combined with `redirect: 'manual'` at send time this closes the practical
 * pivot; a determined rebinding attack (TTL 0, second resolution at connect)
 * still needs connection pinning, which is documented as a residual risk.
 */
export async function verifyPushTarget(url: string, allowlist?: string[]): Promise<string | null> {
  const blocked = unsafePushUrl(url, allowlist);
  if (blocked) return blocked;

  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return null; // already classified by unsafePushUrl
  if (isAllowlisted(u, allowlist)) return null;

  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return `push target "${host}" could not be resolved`;
  }
  if (addrs.length === 0) return `push target "${host}" has no addresses`;
  for (const a of addrs) {
    const literal = a.address.includes(':') ? `[${a.address}]` : a.address;
    const probe = unsafePushUrl(`${u.protocol}//${literal}/`);
    if (probe) return `push target "${host}" resolves to a blocked address ${a.address}`;
  }
  return null;
}

/** Allowlist entries may be a bare host, host:port, or scheme://host:port. */
function isAllowlisted(u: URL, allowlist?: string[]): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return allowlist.some((entry) => {
    const e = entry.trim();
    if (!e) return false;
    if (e === host || e === u.hostname || e === u.host) return true;
    return e === `${u.protocol}//${u.host}`;
  });
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
  signal?: AbortSignal,
): Promise<Job> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const job = mgr.store.get(taskId);
    if (!job) throw notFound(`unknown task ${taskId}`);
    if (isFinalState(toTaskState(job.status))) return job;
    // The caller is gone: hand back the current task and stop holding a
    // request slot. The job continues in the background.
    if (signal?.aborted) return job;
    if (Date.now() >= deadline) {
      // Cap reached: hand back the current (likely still working) task rather
      // than erroring, so the client can switch to polling / streaming.
      return job;
    }
    await sleepOrAbort(300, signal);
  }
}

/** setTimeout that resolves immediately when the signal aborts. */
function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
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
  wireVersion: WireVersion = '0.3.0',
): Promise<void> {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const a2aVersion = wireVersion === '1.0' ? '0.3.0' : (config.a2aProtocolVersion ?? '0.3.0');
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
      // tasks/resubscribe (v1.0 SubscribeToTask)
      const id = strParam(params, 'id', 'tasks/resubscribe.id');
      const existing = mgr.store.get(id);
      if (!existing) throw notFound(`unknown task ${id}`);
      // STREAM-SUB-003: v1.0 MUST refuse a terminal task with -32004, answered
      // as a plain JSON-RPC error *before* the SSE stream is opened — a
      // streaming client treats an opened stream as a successful call.
      if (wireVersion === '1.0' && isFinalState(toTaskState(existing.status))) {
        throw new BridgeUnsupported('cannot subscribe to a task in a terminal state');
      }
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
    const id = req.id ?? null;
    // CORE-STREAM-003 / STREAM-SUB-001: a v1.0 task lifecycle stream MUST
    // begin with a StreamResponse carrying the Task itself.
    if (wireVersion === '1.0') {
      const initial = toTask(job, {
        withHistory: false,
        artifactBase: artifactBase(),
        a2aVersion: '0.3.0',
      });
      writeEvent(res, { task: toWireV1Task(initial) }, id);
    }
    for await (const ev of subscribeTask(mgr, job.id, controller.signal, artifactBase(), a2aVersion)) {
      if (controller.signal.aborted) break;
      // v1.0 wraps each event in a StreamResponse ({ statusUpdate |
      // artifactUpdate }) and drops `kind` / `final`, which the strict v1.0
      // schema does not allow.
      const payload = wireVersion === '1.0' ? toV1StreamResponse(ev) : ev;
      writeEvent(res, payload, id);
      // The generator emits artifacts before the terminal status, so breaking
      // here no longer truncates the deliverables.
      const terminal = wireVersion === '1.0'
        ? isV1Terminal(ev)
        : (ev.kind === 'status-update' && ev.final);
      if (terminal) break;
    }
  } catch (err) {
    log.warn('a2a stream error', { taskId: job.id, err: String(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/**
 * A2A streams SSE frames that are JSON-RPC *responses*, not bare events: the
 * event travels in `result` and the response echoes the request id. Emitting
 * the bare event meant a spec-compliant client saw `undefined.result` and
 * silently dropped every update. On the v1.0 wire `result` is a StreamResponse
 * (or the leading `{ task }` envelope); on 0.3 it is the raw TaskEvent.
 */
function writeEvent(res: http.ServerResponse, result: unknown, id: string | number | null): void {
  res.write(`data: ${JSON.stringify({ jsonrpc: JsonRpcVersion, id, result })}\n\n`);
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
  // Decode defensively: a malformed percent-escape (e.g. /a2a/artifacts/%zz/x)
  // makes decodeURIComponent throw a URIError. Letting it escape would crash the
  // listener; answer 400 instead.
  let taskId: string;
  let name: string;
  try {
    taskId = decodeURIComponent(taskIdRaw);
    name = decodeURIComponent(nameRaw);
  } catch {
    sendJson(res, 400, { error: 'malformed artifact path' });
    return;
  }
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
  if (!filePath) {
    sendJson(res, 404, { error: 'artifact not found' });
    return;
  }
  /**
   * `existsSync` is not a type check: an artifact path can point at a directory
   * (someone replaced the file, a partial extraction, a hostile symlink). A raw
   * `createReadStream().pipe(res)` on a directory emits EISDIR asynchronously,
   * which is an *uncaught* exception and takes the whole bridge down - a remote
   * crash reachable from an unauthenticated GET in the default configuration.
   * Stat first, refuse anything that is not a regular file, and route the stream
   * through `pipeline` so every error lands on the response instead of the
   * process.
   */
  let size: number;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) {
      sendJson(res, 404, { error: 'artifact not found' });
      return;
    }
    size = st.size;
  } catch {
    sendJson(res, 404, { error: 'artifact not found' });
    return;
  }
  res.writeHead(200, {
    'content-type': mime,
    'content-length': size,
    'cache-control': 'no-store',
  });
  pipeline(fs.createReadStream(filePath), res, (err) => {
    if (!err) return;
    log.warn('artifact stream failed', { taskId, name, err: String(err) });
    // Headers are already out; the honest signal left is to break the response
    // so the client sees a truncated body rather than a silently short file.
    if (!res.writableEnded) res.destroy();
  });
}

/**
 * Reject push-notification URLs that would let an authenticated caller pivot the
 * bridge into a Server-Side Request Forgery: only public http(s) endpoints are
 * allowed, and private / loopback / link-local hosts are blocked.
 */
export function unsafePushUrl(url: string, allowlist?: string[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'invalid URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `unsupported scheme "${u.protocol}" (only http/https allowed)`;
  }
  // WHATWG URL keeps IPv6 literals bracketed in `hostname` ("[::1]"), so strip
  // the brackets before classifying. Treat only genuine IP literals with the IP
  // rules below; domain names must NOT be matched by IPv6 prefix heuristics (an
  // earlier version rejected legitimate hosts like fc2.com / fdic.gov).
  const rawHost = u.hostname;
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost;

  if (allowlist && (allowlist.includes(rawHost) || allowlist.includes(host) || allowlist.includes(u.host) || allowlist.includes(`${u.protocol}//${u.host}`))) {
    return null; // explicitly trusted target
  }

  // One shared classifier for literals, so `hostname` and DNS-resolved
  // addresses can never drift apart in what they consider private.
  const literalReason = privateAddressReason(host);
  if (literalReason) return literalReason;
  if (isIP(host) !== 0) return null; // a public IP literal; nothing else to check
  // Remaining risk (documented, not silently ignored): a public hostname that
  // resolves to a private IP via DNS rebinding still passes this string-level
  // check. Closing that fully requires resolving DNS and re-checking the IP at
  // connect time; operators who need it should set a2aPushUrlAllowlist.
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

/** CORE-CAP-001: the v1.0 card declares pushNotifications:false, so push-config
 * operations MUST answer -32003 rather than pretending to store a webhook. */
class BridgePushNotSupported extends Error {
  constructor() {
    super('push notifications are not supported by this agent');
    this.name = 'BridgePushNotSupported';
  }
  code = 'E_PUSH_NOT_SUPPORTED' as const;
}
