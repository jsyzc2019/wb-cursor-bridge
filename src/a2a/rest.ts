/**
 * A2A v1.0 HTTP+JSON (REST) binding.
 *
 * The JSON-RPC surface stays at POST /a2a. This module serves the *same*
 * dispatch pipeline over the RESTful paths defined in the A2A spec §11, so a
 * client can pick either binding from `supportedInterfaces`. Responses are
 * bare ProtoJSON objects (no JSON-RPC envelope); errors are AIP-193 shaped and
 * carry the HTTP status mandated by the spec's error bindings.
 *
 * Zero dependencies: everything needed is in v1.ts (method/param/result
 * translation) and the existing dispatch pipeline, injected as callbacks so
 * this module never imports server.ts (no circular dependency).
 */
import type http from 'node:http';
import type { Logger } from '../logger.js';
import type { Job } from '../types.js';
import type { JsonRpcRequest, Task, TaskEvent } from './types.js';
import {
  fromV1Params, isV1Terminal, mapV1Method, resolveVersion,
  VersionNotSupportedError, toV1StreamResponse, toV1Task, wrapV1Result,
} from './v1.js';

const A2A_JSON = 'application/a2a+json';
const MAX_BODY = 1_048_576;

export interface RestDeps {
  dispatch(innerReq: JsonRpcRequest): Promise<unknown>;
  subscribe(taskId: string, signal?: AbortSignal): AsyncGenerator<TaskEvent>;
  getJob(taskId: string): Job | undefined;
  toTask(job: Job): Task;
  authOk(req: http.IncomingMessage): boolean;
  /** Reuse the JSON-RPC surface's v1.0 input validation (media types, context). */
  assertWireInput(params: Record<string, unknown>): void;
  isTerminal(job: Job): boolean;
  log: Logger;
}

interface ErrorBinding {
  http: number;
  status?: string;
  reason?: string;
}

/**
 * Bridge error code -> A2A HTTP+JSON error binding. Derived from the official
 * TCK's ERROR_BINDINGS (tck/requirements/base.py): the HTTP status, the
 * google.rpc.Code name, and the google.rpc.ErrorInfo.reason that the TCK's
 * validate_http_json_error() checks.
 */
const ERROR_MAP: Record<string, ErrorBinding> = {
  E_NOT_FOUND: { http: 404, status: 'NOT_FOUND', reason: 'TASK_NOT_FOUND' },
  E_CANCEL_NOT_ALLOWED: { http: 400, status: 'FAILED_PRECONDITION', reason: 'TASK_NOT_CANCELABLE' },
  E_UNSUPPORTED: { http: 400, status: 'FAILED_PRECONDITION', reason: 'UNSUPPORTED_OPERATION' },
  E_INCOMPATIBLE: { http: 400, status: 'INVALID_ARGUMENT', reason: 'CONTENT_TYPE_NOT_SUPPORTED' },
  E_PUSH_NOT_SUPPORTED: { http: 400, status: 'FAILED_PRECONDITION', reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED' },
  E_VERSION_NOT_SUPPORTED: { http: 400, status: 'FAILED_PRECONDITION', reason: 'VERSION_NOT_SUPPORTED' },
  E_METHOD_NOT_FOUND: { http: 404 },
  E_CONCURRENCY: { http: 400, status: 'RESOURCE_EXHAUSTED' },
  E_BAD_ARGUMENT: { http: 400, status: 'INVALID_ARGUMENT' },
  E_PATH_DENIED: { http: 400, status: 'INVALID_ARGUMENT' },
};

function sendJson(res: http.ServerResponse, status: number, body: unknown, contentType = A2A_JSON): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendError(res: http.ServerResponse, err: unknown, log: Logger): void {
  const code = (err as { code?: string })?.code ?? '';
  const binding: ErrorBinding = ERROR_MAP[code] ?? { http: 500, status: 'INTERNAL' };
  const message = err instanceof Error ? err.message : String(err);
  const details: Record<string, unknown>[] = [];
  if (binding.reason) {
    details.push({
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: binding.reason,
      domain: 'a2a-protocol.org',
      metadata: {},
    });
  }
  log.warn('a2a rest error', { binding: binding.http, code, message });
  // TCK HTTP_JSON-ERR-001 requires the literal "application/json" in the error
  // response Content-Type; "application/a2a+json" does not contain it.
  sendJson(res, binding.http, {
    error: {
      code: binding.http,
      ...(binding.status ? { status: binding.status } : {}),
      message,
      details,
    },
  }, 'application/json');
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(b);
  }
  if (size === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

const queryToParams = (u: URL): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of u.searchParams) {
    if (k === 'pageSize' || k === 'historyLength') {
      const n = Number(v);
      out[k] = Number.isNaN(n) ? v : n;
    } else if (k === 'includeArtifacts') out[k] = v === 'true';
    else out[k] = v;
  }
  return out;
};

/** Translate a REST path+verb into a v1.0 method and its params. */
function route(
  method: string,
  path: string,
  u: URL,
  body: Record<string, unknown>,
): { v1Method: string; params: Record<string, unknown> } | null {
  if (path === '/a2a/message:send' && method === 'POST') return { v1Method: 'SendMessage', params: body };
  if (path === '/a2a/message:stream' && method === 'POST') return { v1Method: 'SendStreamingMessage', params: body };
  if (path === '/a2a/extendedAgentCard' && method === 'GET') return { v1Method: 'GetExtendedAgentCard', params: {} };
  if (path === '/a2a/tasks' && method === 'GET') return { v1Method: 'ListTasks', params: queryToParams(u) };

  let m = path.match(/^\/a2a\/tasks\/([^/]+):cancel$/);
  if (m && method === 'POST') {
    return { v1Method: 'CancelTask', params: { ...queryToParams(u), id: decodeURIComponent(m[1]) } };
  }
  m = path.match(/^\/a2a\/tasks\/([^/]+):subscribe$/);
  if (m && method === 'POST') {
    return { v1Method: 'SubscribeToTask', params: { ...queryToParams(u), id: decodeURIComponent(m[1]) } };
  }
  m = path.match(/^\/a2a\/tasks\/([^/]+)\/pushNotificationConfigs\/([^/]+)$/);
  if (m) {
    const taskId = decodeURIComponent(m[1]);
    const id = decodeURIComponent(m[2]);
    if (method === 'GET') return { v1Method: 'GetTaskPushNotificationConfig', params: { taskId, id } };
    if (method === 'DELETE') return { v1Method: 'DeleteTaskPushNotificationConfig', params: { taskId, id } };
    return null;
  }
  m = path.match(/^\/a2a\/tasks\/([^/]+)\/pushNotificationConfigs$/);
  if (m) {
    const taskId = decodeURIComponent(m[1]);
    if (method === 'POST') {
      return { v1Method: 'CreateTaskPushNotificationConfig', params: { ...body, taskId } };
    }
    if (method === 'GET') {
      return { v1Method: 'ListTaskPushNotificationConfigs', params: { ...queryToParams(u), taskId } };
    }
    return null;
  }
  m = path.match(/^\/a2a\/tasks\/([^/]+)$/);
  if (m && method === 'GET') {
    return { v1Method: 'GetTask', params: { ...queryToParams(u), id: decodeURIComponent(m[1]) } };
  }
  return null;
}

/** Emit a bare-StreamResponse SSE stream (no JSON-RPC envelope on REST). */
async function handleStream(
  res: http.ServerResponse,
  deps: RestDeps,
  taskId: string,
  firstTask?: Task,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const write = (payload: unknown): void => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  if (firstTask) write({ task: toV1Task(firstTask) });
  try {
    for await (const ev of deps.subscribe(taskId)) {
      write(toV1StreamResponse(ev));
      if (isV1Terminal(ev)) break;
    }
  } catch (err) {
    deps.log.warn('a2a rest stream error', { taskId, err: String(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/** Handle one REST request. Returns false when the path is not a REST route. */
export async function handleRest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawUrl: string,
  deps: RestDeps,
): Promise<boolean> {
  const u = new URL(rawUrl, 'http://localhost');
  const path = u.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith('/a2a/')) return false;
  // The artifact endpoint is a JSON-RPC-era GET route, not a REST operation.
  if (path.startsWith('/a2a/artifacts/')) return false;

  const matched = route(method, path, u, {});
  if (!matched) return false;

  if (!deps.authOk(req)) {
    sendJson(res, 401, {
      error: { code: 401, status: 'UNAUTHENTICATED', message: 'unauthorized: missing or invalid A2A token', details: [] },
    });
    return true;
  }

  let body: Record<string, unknown> = {};
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 400, {
      error: { code: 400, status: 'INVALID_ARGUMENT', message: String(err), details: [] },
    });
    return true;
  }
  const found = route(method, path, u, body);
  if (!found) return false;

  const { v1Method, params } = found;
  const innerMethod = mapV1Method(v1Method) ?? v1Method;
  const innerParams = fromV1Params(innerMethod, params);

  try {
    // VER-SERVER-002: the REST binding must reject an unsupported
    // A2A-Version with a 400 VersionNotSupportedError, not process the call.
    try {
      resolveVersion(req.headers['a2a-version'], params, '1.0');
    } catch (err) {
      if (err instanceof VersionNotSupportedError) {
        throw Object.assign(new Error(err.message), { code: 'E_VERSION_NOT_SUPPORTED' });
      }
      throw err;
    }

    if (v1Method === 'SendMessage' || v1Method === 'SendStreamingMessage') {
      // Same content-negotiation gate as the JSON-RPC surface: an unsupported
      // part mediaType is a 400 ContentTypeNotSupportedError (CORE-SEND-003),
      // not a confusing "no text part" bad-argument error.
      deps.assertWireInput(params);
    }

    if (v1Method === 'SendStreamingMessage') {
      // `dispatch` returns the INTERNAL 0.3 Task; handleStream() performs the
      // single v1.0 translation via toV1Task(). Wrapping here would translate
      // twice and produce an invalid StreamResponse.
      const task = await deps.dispatch({
        jsonrpc: '2.0', id: 1, method: 'message/send', params: fromV1Params('message/send', params),
      }) as Task;
      if (!task?.id) throw new Error('streaming task was not created');
      await handleStream(res, deps, task.id, task);
      return true;
    }
    if (v1Method === 'SubscribeToTask') {
      const id = String(params.id ?? '');
      const job = deps.getJob(id);
      if (!job) throw Object.assign(new Error(`unknown task ${id}`), { code: 'E_NOT_FOUND' });
      // STREAM-SUB-003: a terminal task MUST be refused *before* the SSE
      // stream opens — a successfully opened stream counts as success.
      if (deps.isTerminal(job)) {
        throw Object.assign(new Error('GetExtendedAgentCard/SubscribeToTask: task is terminal'), {
          code: 'E_UNSUPPORTED',
        });
      }
      await handleStream(res, deps, id);
      return true;
    }

    const result = await deps.dispatch({
      jsonrpc: '2.0', id: 1, method: innerMethod, params: innerParams,
    });
    const wire = wrapV1Result(innerMethod, result);
    sendJson(res, 200, wire ?? {});
    return true;
  } catch (err) {
    if (!res.headersSent) sendError(res, err, deps.log);
    else if (!res.writableEnded) res.end();
    return true;
  }
}
