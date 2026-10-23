/**
 * Bidirectional mapping between the bridge's internal Job model and the A2A
 * Task / Message / Part model.
 *
 * The bridge keeps a deliberately small, transport-agnostic Job shape. This
 * module is the single place that turns a Job into a wire-conformant A2A Task
 * (with contextId, history, artifacts and a status message) and turns an A2A
 * Message back into a prompt string. Everything else in `src/a2a` relies on it,
 * so the conversion rules live in exactly one file.
 */
import { randomUUID } from 'node:crypto';
import { buildArtifacts } from '../artifacts.js';
import type { ArtifactPart, Job, JobEvent, Tier } from '../types.js';
import { toV1Task, type A2AVersion } from './compat.js';
import type {
  Artifact,
  Message,
  MessageRole,
  Part,
  Task,
  TaskState,
} from './types.js';

/** Map the bridge's JobStatus onto the A2A TaskState enum. */
export function toTaskState(status: Job['status']): TaskState {
  switch (status) {
    case 'running':
      return 'working';
    case 'input-required':
      return 'input-required';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    // The bridge has no wire-native "timeout"/"orphaned" state; both mean the
    // task did not reach a successful outcome, so A2A `failed` is the honest
    // mapping for a conformant client.
    case 'timeout':
    case 'orphaned':
      return 'failed';
  }
}

/** Extract the prompt text from an A2A Message's parts. */
export function messageToPrompt(message: Message): { prompt: string; hasText: boolean } {
  const texts: string[] = [];
  for (const part of message.parts) {
    if (part.kind === 'text' && part.text) texts.push(part.text);
  }
  return { prompt: texts.join('\n').trim(), hasText: texts.length > 0 };
}

/** Read the skill id a client wants to target (defaults to none). */
export function skillIdOf(message: Message): string | undefined {
  const v = message.metadata?.skillId;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Read an optional tier override carried in message metadata. */
export function tierOf(message: Message): Tier | undefined {
  const v = message.metadata?.tier;
  if (typeof v !== 'string') return undefined;
  return (['consult', 'plan', 'execute'] as Tier[]).includes(v as Tier)
    ? (v as Tier)
    : undefined;
}

/**
 * Read an optional push-notification config.
 *
 * Prefers the A2A-standard location `params.configuration.pushNotificationConfig`
 * (the wire-correct place for it), and falls back to a `pushNotification` block
 * in the message metadata for backward compatibility. Returns undefined when no
 * usable webhook URL is present.
 */
export function pushConfigOf(
  params: Record<string, unknown>,
): { url: string; token?: string; authentication?: { schemes: string[]; credentials?: string } } | undefined {
  const configuration = (params.configuration as { pushNotificationConfig?: unknown } | undefined)
    ?.pushNotificationConfig;
  const message = params.message as { metadata?: Record<string, unknown> } | undefined;
  const meta = message?.metadata?.pushNotification as
    | { url?: unknown; token?: unknown; authentication?: { schemes: string[]; credentials?: string } }
    | undefined;
  const pn = (configuration ?? meta) as
    | { url?: unknown; token?: unknown; authentication?: { schemes: string[]; credentials?: string } }
    | undefined;
  if (!pn || typeof pn.url !== 'string' || !pn.url) return undefined;
  return {
    url: pn.url,
    token: typeof pn.token === 'string' ? pn.token : undefined,
    authentication: pn.authentication,
  };
}

function makeMessage(
  role: MessageRole,
  text: string,
  contextId: string,
  taskId: string,
  messageId: string,
): Message {
  const parts: Part[] = [{ kind: 'text', text }];
  return { role, parts, messageId, contextId, taskId };
}

/**
 * Build a Task history Message[] from recorded job events. Only the
 * conversational turns are surfaced (user inputs and agent assistant/result
 * outputs); machinery events (start/tool/stderr/note/end) are intentionally
 * omitted so the history reads like a dialogue rather than a raw log.
 */
function buildHistory(job: Job, contextId: string): Message[] {
  const out: Message[] = [];
  out.push(makeMessage('user', job.prompt, contextId, job.id, `${job.id}-u0`));
  for (const ev of job.events) {
    if (!ev.text) continue;
    if (ev.type === 'input') {
      out.push(makeMessage('user', ev.text, contextId, job.id, `${job.id}-u${ev.seq}`));
    } else if (ev.type === 'assistant' || ev.type === 'result') {
      out.push(makeMessage('agent', ev.text, contextId, job.id, `${job.id}-a${ev.seq}`));
    }
  }
  return out;
}

export interface ToTaskOptions {
  /** Include conversational history in the Task. */
  withHistory?: boolean;
  /** Cap history length to the last N messages (A2A `historyLength`). */
  historyLength?: number;
  /**
   * Base URL of the bridge's artifact endpoint (e.g. `http://host:port/a2a/artifacts`).
   * When supplied, local `file://` URIs are rewritten to `<base>/<taskId>/<name>`
   * so a remote A2A client can actually fetch the deliverable. Without it, the
   * local `file://` URI is left as-is (fine for same-host callers).
   */
  artifactBase?: string;
  /**
   * Target A2A wire version. When '1.0', the produced Task is translated into the
   * v1.0 data model (FileContent `url`/`filename`/`mediaType`/`raw`) at the
   * serialisation boundary. Defaults to '0.3.0'.
   */
  a2aVersion?: A2AVersion;
}

/**
 * Convert a Job into a wire-conformant A2A Task.
 *
 * The bridge's internal artifacts (Artifacts[] from buildArtifacts) are already
 * structurally compatible with the A2A Artifact shape, so they are passed
 * through directly. contextId falls back to the job id when an A2A client never
 * supplied one, which keeps every Task self-consistent.
 */
export function toTask(job: Job, opts: ToTaskOptions = {}): Task {
  const contextId = job.contextId ?? job.id;
  const state = toTaskState(job.status);

  const statusMessage = buildStatusMessage(job, contextId);

  let history: Message[] | undefined;
  if (opts.withHistory) {
    history = buildHistory(job, contextId);
    if (opts.historyLength && opts.historyLength > 0 && history.length > opts.historyLength) {
      history = history.slice(-opts.historyLength);
    }
  }

  const artifacts: Artifact[] = buildArtifacts(job).map((a) => ({
    artifactId: a.artifactId,
    name: a.name,
    parts: a.parts.map((p) => rewriteFileUri(p, job.id, a.name, opts.artifactBase)) as Part[],
  }));

  const task: Task = {
    id: job.id,
    contextId,
    status: {
      state,
      timestamp: job.inputRequiredAt ?? job.finishedAt ?? job.createdAt,
      message: statusMessage,
    },
    metadata: {
      tier: job.tier,
      isolation: job.isolation,
      workspace: job.workspace,
      skillId: job.metadata?.skillId,
    },
  };
  if (artifacts.length > 0) task.artifacts = artifacts;
  if (history && history.length > 0) task.history = history;
  return opts.a2aVersion === '1.0' ? toV1Task(task) : task;
}

/** Status message surfaced on the Task - the input-required question or a short summary. */
function buildStatusMessage(job: Job, contextId: string): Message | undefined {
  if (job.status === 'input-required' && job.pendingInput) {
    return makeMessage(
      'agent',
      job.pendingInput,
      contextId,
      job.id,
      `${job.id}-need-input`,
    );
  }
  if (job.status === 'completed' && job.result) {
    const summary = job.result.length > 800 ? job.result.slice(0, 800) + '…' : job.result;
    return makeMessage('agent', summary, contextId, job.id, `${job.id}-done`);
  }
  return undefined;
}

/** Generate an A2A message id when a client omits it. */
export function newMessageId(): string {
  return randomUUID();
}

/**
 * Rewrite a local `file://` URI into the bridge's reachable artifact endpoint so
 * a remote A2A client can fetch the deliverable. Inlined files (bytes_inline)
 * keep their content untouched. When no `artifactBase` is provided the local URI
 * is left as-is for same-host callers.
 */
function rewriteFileUri(part: ArtifactPart, taskId: string, artifactName: string, artifactBase?: string): ArtifactPart {
  if (part.kind !== 'file' || !part.file?.uri?.startsWith('file://') || !artifactBase) {
    return part;
  }
  const name = part.file.name ?? artifactName;
  return {
    ...part,
    file: { ...part.file, uri: `${artifactBase}/${encodeURIComponent(taskId)}/${encodeURIComponent(name)}` },
  };
}
