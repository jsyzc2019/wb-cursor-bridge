/**
 * A2A v1.0 wire adapter — the *real* v1.0 protocol, not a field rename.
 *
 * `compat.ts` (shipped in 0.4.x/0.5.x) only translated FileContent field names
 * and the Agent Card. That was enough for a hand-written client to see "v1.0"
 * but it is NOT what the A2A v1.0 specification defines. Running the official
 * `a2a-tck` against the bridge exposed the full gap:
 *
 *   JSON-RPC methods   SendMessage / GetTask / ListTasks / CancelTask /
 *                      SendStreamingMessage / SubscribeToTask / *PushNotificationConfig
 *                      (PascalCase), NOT message/send / tasks/get / ...
 *   Message.role       ROLE_USER / ROLE_AGENT, NOT user / agent
 *   Part               flat { text } / { raw, mediaType, filename } / { url } /
 *                      { data } — NO `kind` discriminator, NO nested `file`
 *   TaskState          TASK_STATE_*, NOT completed / working / ...
 *   SendMessageResponse  { task | message }, NOT a bare Task
 *   ListTasksResponse    { tasks, nextPageToken, pageSize, totalSize }
 *   StreamResponse       { task | message | statusUpdate | artifactUpdate },
 *                        NOT a bare event; TaskStatusUpdateEvent has NO `final`
 *   AgentCard            supportedInterfaces[].protocolBinding (JSONRPC),
 *                        first entry preferred; NO top-level protocolVersion
 *   A2A-Version header  empty => 0.3, unsupported => VersionNotSupportedError
 *
 * This module is a pure translation boundary. The engine (JobManager, store,
 * runner) and the internal v0.3.0 model are untouched: a v1.0 request is
 * translated into the internal shape, dispatched by the existing handlers, and
 * the result is translated back on the way out. That keeps BOTH legacy paths
 * byte-for-byte unchanged — (1) requests with no A2A-Version header, and
 * (2) the static `a2aProtocolVersion` config switch — while the same instance
 * serves real v1.0 clients via runtime negotiation.
 *
 * Spec: https://a2a-protocol.org/latest/specification/ (v1.0, §3.6, §4, §5.3)
 * TCK:  https://github.com/a2aproject/a2a-tck (pinned in scripts/tck.mjs)
 */
import type {
  Message,
  Part,
  Task,
  TaskEvent,
  TaskState,
  Artifact,
} from './types.js';

/* -------------------------------------------------------------- versioning */

export const A2A_VERSION_HEADER = 'a2a-version';
export type WireVersion = '0.3.0' | '1.0';

/** Unsupported A2A-Version. Mapped to -32009 by the transport layer. */
export class VersionNotSupportedError extends Error {
  constructor(public readonly requested: string) {
    super(`unsupported A2A-Version "${requested}"`);
    this.name = 'VersionNotSupportedError';
  }
}

/**
 * Resolve the wire version for one request.
 *
 * Header wins over a request parameter (spec §3.2.6 service parameters MAY be
 * sent as a request parameter instead). Only Major.Minor is significant;
 * patch versions MUST NOT affect negotiation (§3.6). An absent or empty value
 * resolves to the configured fallback (the transport passes '0.3.0', so a
 * request without a version header keeps the legacy/static-switch behaviour).
 */
export function resolveVersion(
  headerValue: string | string[] | undefined,
  params: Record<string, unknown>,
  fallback: WireVersion,
): WireVersion {
  let raw: string | undefined;
  if (Array.isArray(headerValue)) raw = headerValue[0];
  else if (typeof headerValue === 'string') raw = headerValue;
  if (raw === undefined) {
    const p = params[A2A_VERSION_HEADER] ?? params['A2A-Version'];
    if (typeof p === 'string') raw = p;
  }
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim();
  // Major.Minor only: 0.3 / 0.3.0 / 0.3.9 -> 0.3.0; 1.0 / 1.0.1 -> 1.0.
  if (/^0\.3(?:\.\d+)?$/.test(v)) return '0.3.0';
  if (/^1\.0(?:\.\d+)?$/.test(v)) return '1.0';
  throw new VersionNotSupportedError(v);
}

/* ------------------------------------------------------------ method names */

/** v1.0 JSON-RPC method -> internal v0.3.0 method (spec §5.3). */
const V1_METHODS: Record<string, string> = {
  SendMessage: 'message/send',
  SendStreamingMessage: 'message/stream',
  GetTask: 'tasks/get',
  ListTasks: 'tasks/list',
  CancelTask: 'tasks/cancel',
  SubscribeToTask: 'tasks/resubscribe',
  CreateTaskPushNotificationConfig: 'tasks/pushConfig/create',
  GetTaskPushNotificationConfig: 'tasks/pushConfig/get',
  ListTaskPushNotificationConfigs: 'tasks/pushConfig/list',
  DeleteTaskPushNotificationConfig: 'tasks/pushConfig/delete',
  GetExtendedAgentCard: 'agent/extendedCard',
};

/** Translate a v1.0 method name; returns null when it is not a v1.0 name. */
export function mapV1Method(method: string): string | null {
  return V1_METHODS[method] ?? null;
}

/** True when a method name is the v1.0 (PascalCase) spelling. */
export function isV1Method(method: string): boolean {
  return method in V1_METHODS;
}

/* ------------------------------------------------------------------- states */

const STATE_TO_V1: Record<TaskState, string> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  'input-required': 'TASK_STATE_INPUT_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  canceled: 'TASK_STATE_CANCELED',
  failed: 'TASK_STATE_FAILED',
  'auth-required': 'TASK_STATE_AUTH_REQUIRED',
  rejected: 'TASK_STATE_REJECTED',
};

const STATE_FROM_V1: Record<string, TaskState> = Object.fromEntries(
  Object.entries(STATE_TO_V1).map(([k, v]) => [v, k as TaskState]),
) as Record<string, TaskState>;

export function toV1State(state: TaskState): string {
  return STATE_TO_V1[state] ?? 'TASK_STATE_UNSPECIFIED';
}

/** Accept both v1.0 enum names and v0.3 lowercase values for filters. */
export function fromV1State(state: unknown): TaskState | undefined {
  if (typeof state !== 'string') return undefined;
  return STATE_FROM_V1[state] ?? (isTaskState(state) ? state : undefined);
}

function isTaskState(v: string): v is TaskState {
  return v in STATE_TO_V1;
}

/* --------------------------------------------------------------------- parts */

type V1Part = Record<string, unknown>;

/** v1.0 flat Part -> internal v0.3.0 discriminated Part. */
export function fromV1Part(part: V1Part): Part {
  if (typeof part.text === 'string') {
    return { kind: 'text', text: part.text, ...metaOf(part) };
  }
  if (part.data !== undefined) {
    return { kind: 'data', data: part.data as Record<string, unknown>, ...metaOf(part) };
  }
  // file: raw (inline base64), url (remote), or both. filename/mediaType are
  // siblings in v1.0, not nested under `file`.
  const file: {
    name?: string;
    mimeType?: string;
    uri?: string;
    bytes?: number;
    bytes_inline?: string;
  } = {};
  if (typeof part.filename === 'string') file.name = part.filename;
  if (typeof part.mediaType === 'string') file.mimeType = part.mediaType;
  if (typeof part.url === 'string') file.uri = part.url;
  if (typeof part.raw === 'string') file.bytes_inline = part.raw;
  return { kind: 'file', file, ...metaOf(part) };
}

/** internal v0.3.0 Part -> v1.0 flat Part (no `kind`, no nested `file`). */
export function toV1Part(part: Part): V1Part {
  const out: V1Part = {};
  if (part.metadata) out.metadata = part.metadata;
  if (part.kind === 'text') {
    out.text = part.text;
  } else if (part.kind === 'data') {
    out.data = part.data;
  } else {
    const f = part.file ?? {};
    const rec = f as unknown as Record<string, unknown>;
    if (rec.name !== undefined) out.filename = rec.name;
    if (rec.mimeType !== undefined) out.mediaType = rec.mimeType;
    if (rec.uri !== undefined) out.url = rec.uri;
    if (rec.bytes_inline !== undefined) out.raw = rec.bytes_inline;
    // v1.0 Part has no size field. The internal `bytes` (file size) has no
    // wire counterpart and MUST be dropped: response schema validation is
    // strict (additionalProperties:false) and would reject an extra key.
  }
  return out;
}

function metaOf(part: V1Part): { metadata?: Record<string, unknown> } {
  return part.metadata && typeof part.metadata === 'object'
    ? { metadata: part.metadata as Record<string, unknown> }
    : {};
}

/* ------------------------------------------------------------------ messages */

function fromV1Role(role: unknown): 'user' | 'agent' | undefined {
  if (role === 'ROLE_USER' || role === 'user') return 'user';
  if (role === 'ROLE_AGENT' || role === 'agent') return 'agent';
  return undefined;
}

function toV1Role(role: 'user' | 'agent'): string {
  return role === 'user' ? 'ROLE_USER' : 'ROLE_AGENT';
}

/** v1.0 Message -> internal Message. */
export function fromV1Message(raw: Record<string, unknown>): Message {
  const parts = Array.isArray(raw.parts) ? raw.parts : [];
  return {
    role: fromV1Role(raw.role) ?? 'user',
    parts: parts.map((p) =>
      p && typeof p === 'object' ? fromV1Part(p as V1Part) : { kind: 'text', text: '' },
    ),
    messageId: typeof raw.messageId === 'string' ? raw.messageId : '',
    ...(typeof raw.contextId === 'string' ? { contextId: raw.contextId } : {}),
    ...(typeof raw.taskId === 'string' ? { taskId: raw.taskId } : {}),
    ...(raw.metadata && typeof raw.metadata === 'object'
      ? { metadata: raw.metadata as Record<string, unknown> }
      : {}),
  };
}

/** internal Message -> v1.0 Message. */
export function toV1Message(msg: Message): V1Part {
  return {
    messageId: msg.messageId,
    role: toV1Role(msg.role),
    parts: msg.parts.map(toV1Part),
    ...(msg.contextId ? { contextId: msg.contextId } : {}),
    ...(msg.taskId ? { taskId: msg.taskId } : {}),
    ...(msg.metadata ? { metadata: msg.metadata } : {}),
  };
}

/* --------------------------------------------------------------------- tasks */

function toV1Artifact(a: Artifact): V1Part {
  return {
    artifactId: a.artifactId,
    ...(a.name ? { name: a.name } : {}),
    ...(a.description ? { description: a.description } : {}),
    parts: a.parts.map(toV1Part),
    ...(a.metadata ? { metadata: a.metadata } : {}),
  };
}

/** internal Task -> v1.0 Task (state enum, flat parts, v1 messages). */
export function toV1Task(task: Task): V1Part {
  const status: V1Part = {
    state: toV1State(task.status.state),
    timestamp: task.status.timestamp,
  };
  if (task.status.message) status.message = toV1Message(task.status.message);
  return {
    id: task.id,
    contextId: task.contextId,
    status,
    ...(task.artifacts && task.artifacts.length > 0
      ? { artifacts: task.artifacts.map(toV1Artifact) }
      : {}),
    ...(task.history && task.history.length > 0
      ? { history: task.history.map(toV1Message) }
      : {}),
    ...(task.metadata ? { metadata: task.metadata } : {}),
  };
}

/* --------------------------------------------------------------- parameters */

/**
 * Translate a v1.0 request's params into the internal v0.3.0 shape.
 * Both camelCase (spec §5.5) and the TCK's snake_case spellings are accepted.
 */
export function fromV1Params(method: string, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (params.message && typeof params.message === 'object') {
    out.message = fromV1Message(params.message as Record<string, unknown>);
  }

  // SendMessageConfiguration: returnImmediately (v1.0) is the inverse of
  // blocking (v0.3.0); taskPushNotificationConfig replaces pushNotificationConfig.
  if (params.configuration && typeof params.configuration === 'object') {
    const c = { ...(params.configuration as Record<string, unknown>) };
    const config: Record<string, unknown> = {};
    if (typeof c.returnImmediately === 'boolean') config.blocking = !c.returnImmediately;
    if (typeof c.blocking === 'boolean') config.blocking = c.blocking;
    if (c.historyLength !== undefined) config.historyLength = c.historyLength;
    if (c.acceptedOutputModes !== undefined) config.acceptedOutputModes = c.acceptedOutputModes;
    const pn = c.taskPushNotificationConfig ?? c.pushNotificationConfig;
    if (pn) config.pushNotificationConfig = pn;
    out.configuration = config;
  }
  // v1.0 SendMessage is blocking by default (returnImmediately=false means
  // "wait for a terminal/interrupted state"). When the client sends no
  // configuration — as the TCK's SendMessage tests do — we still want a
  // settled Task rather than an immediately-returned `working` snapshot.
  if (method === 'message/send') {
    const cfg = (out.configuration ?? {}) as Record<string, unknown>;
    if (typeof cfg.blocking !== 'boolean') cfg.blocking = true;
    out.configuration = cfg;
  }

  const id = params.id;
  if (typeof id === 'string') out.id = id;

  const scalar = (camel: string, snake: string): unknown => params[camel] ?? params[snake];
  const setScalar = (camel: string, snake: string): void => {
    const v = scalar(camel, snake);
    if (v !== undefined) out[camel] = v;
  };
  setScalar('contextId', 'context_id');
  setScalar('pageSize', 'page_size');
  setScalar('pageToken', 'page_token');
  setScalar('historyLength', 'history_length');
  setScalar('statusTimestampAfter', 'status_timestamp_after');
  setScalar('includeArtifacts', 'include_artifacts');
  if (params.status !== undefined) {
    const s = fromV1State(params.status);
    out.status = s ?? params.status;
  }

  // push-config CRUD: the TCK flattens the config into the top-level params
  // ({ task_id, id, url, authentication }) rather than nesting it under
  // `config`, so collect those fields into an internal config object.
  if (method.startsWith('tasks/pushConfig')) {
    const taskId = params.taskId ?? params.task_id;
    if (typeof taskId === 'string') out.taskId = taskId;
    const cid = params.configId ?? params.id;
    if (typeof cid === 'string') out.configId = cid;
    if (method === 'tasks/pushConfig/create') {
      const cfg: Record<string, unknown> = {};
      for (const k of ['id', 'url', 'token', 'authentication', 'tenant']) {
        if (params[k] !== undefined) cfg[k] = params[k];
      }
      if (params.config && typeof params.config === 'object') {
        Object.assign(cfg, params.config as Record<string, unknown>);
      }
      out.config = cfg;
    }
  } else {
    const taskId = params.taskId ?? params.task_id;
    if (typeof taskId === 'string') out.taskId = taskId;
    if (params.config !== undefined) out.config = params.config;
    if (params.configId !== undefined) out.configId = params.configId;
  }

  return out;
}

/* ---------------------------------------------------------------- responses */

/** Wrap an internal dispatch result into the v1.0 response object. */
export function wrapV1Result(internalMethod: string, result: unknown): unknown {
  switch (internalMethod) {
    case 'message/send':
      // SendMessageResponse is a oneof { task | message }.
      return { task: toV1Task(result as Task) };
    case 'tasks/get':
    case 'tasks/cancel':
      return toV1Task(result as Task);
    case 'tasks/list': {
      const r = (result ?? {}) as Record<string, unknown>;
      const tasks = Array.isArray(r.tasks) ? (r.tasks as Task[]).map(toV1Task) : [];
      return {
        tasks,
        nextPageToken: typeof r.nextPageToken === 'string' ? r.nextPageToken : '',
        pageSize: typeof r.pageSize === 'number' ? r.pageSize : 0,
        totalSize: typeof r.totalSize === 'number' ? r.totalSize : tasks.length,
      };
    }
    default:
      // push-config CRUD and extended-card results are already v1.0-shaped.
      return result;
  }
}

/**
 * Wrap a streaming event into a v1.0 StreamResponse. `final` and `kind` are
 * removed (the v1.0 TaskStatusUpdateEvent schema has neither), and the nested
 * status/artifact are converted to the v1.0 data model.
 */
export function toV1StreamResponse(ev: TaskEvent): V1Part {
  if (ev.kind === 'status-update') {
    const status: V1Part = {
      state: toV1State(ev.status.state),
      timestamp: ev.status.timestamp,
    };
    if (ev.status.message) status.message = toV1Message(ev.status.message);
    return {
      statusUpdate: {
        taskId: ev.taskId,
        contextId: ev.contextId,
        status,
        ...(ev.metadata ? { metadata: ev.metadata } : {}),
      },
    };
  }
  return {
    artifactUpdate: {
      taskId: ev.taskId,
      contextId: ev.contextId,
      artifact: toV1Artifact(ev.artifact),
      ...(ev.append !== undefined ? { append: ev.append } : {}),
      ...(ev.lastChunk !== undefined ? { lastChunk: ev.lastChunk } : {}),
      ...(ev.metadata ? { metadata: ev.metadata } : {}),
    },
  };
}

/** True when the event terminates a stream (used to close the SSE response). */
export function isV1Terminal(ev: TaskEvent): boolean {
  if (ev.kind !== 'status-update') return false;
  const s = ev.status.state;
  return (
    s === 'completed' || s === 'failed' || s === 'canceled' ||
    s === 'rejected' || s === 'auth-required' || s === 'input-required'
  );
}
