/**
 * The Action registry (P1).
 *
 * One entry per capability. `inputSchema` generates the MCP tool list;
 * `parse` is shared by MCP and A2A; `invoke` is the single implementation over
 * `JobManager`. Keep tool names, descriptions and schemas byte-for-byte
 * compatible with the pre-P1 `TOOL_DEFINITIONS` — MCP client configuration
 * depends on them.
 */
import fs from 'node:fs';
import type { Job, JobView } from '../types.js';
import type { Action, ActionContext, JsonObjectSchema } from './types.js';
import { bool, clamp, enumOf, num, str } from './validate.js';

const TIERS = ['consult', 'plan', 'execute'] as const;
type Tier = (typeof TIERS)[number];

const JOB_STATUSES = [
  'running', 'input-required', 'completed', 'failed', 'cancelled', 'timeout', 'orphaned',
] as const;
type JobStatus = (typeof JOB_STATUSES)[number];

const schema = (
  properties: Record<string, unknown>,
  required?: string[],
): JsonObjectSchema => ({ type: 'object', properties, ...(required ? { required } : {}) });

/* --------------------------------------------------------------------- run */

export interface RunArgs extends Record<string, unknown> {
  prompt: string;
  workspace: string;
  tier: Tier;
  model?: string;
  timeoutSec?: number;
  /** P3: client idempotency key; a repeat resolves to the same job. */
  requestKey?: string;
}

export const runAction: Action<RunArgs, Job> = {
  name: 'cursor_run',
  description:
    'Dispatch a task to the Cursor sub-agent and return a job id IMMEDIATELY. ' +
    'This tool never blocks: a real code task takes minutes, so poll with cursor_status. ' +
    'tier=consult is read-only Q&A, tier=plan is read-only planning, ' +
    'tier=execute may write files and is always isolated in a git worktree.',
  inputSchema: schema({
    prompt: { type: 'string', description: 'The task for the Cursor agent' },
    workspace: {
      type: 'string',
      description: 'Absolute path, must be inside a configured workspace root',
    },
    tier: { type: 'string', enum: TIERS },
    model: { type: 'string', description: 'Optional Cursor model id' },
    timeoutSec: { type: 'number', description: 'Wall-clock ceiling for this job' },
    requestKey: {
      type: 'string',
      description: 'Optional idempotency key; a repeat submission returns the same job',
    },
  }, ['prompt', 'workspace', 'tier']),
  parse(raw): RunArgs {
    return {
      prompt: str(raw, 'prompt')!,
      workspace: str(raw, 'workspace')!,
      tier: enumOf(raw, 'tier', TIERS)!,
      model: str(raw, 'model', false),
      timeoutSec: num(raw, 'timeoutSec'),
      requestKey: str(raw, 'requestKey', false),
    };
  },
  invoke(ctx: ActionContext, a: RunArgs): Job {
    return ctx.mgr.start({
      prompt: a.prompt,
      workspace: a.workspace,
      tier: a.tier,
      model: a.model,
      timeoutSec: a.timeoutSec,
      requestKey: a.requestKey,
    });
  },
};

/* ------------------------------------------------------------------ status */

export interface StatusArgs extends Record<string, unknown> {
  jobId: string;
  since?: number;
  waitSeconds?: number;
}

export const statusAction: Action<StatusArgs, JobView> = {
  name: 'cursor_status',
  description:
    'Poll a job. Pass waitSeconds (max 55) to block briefly until it settles, ' +
    'and `since` to receive only new events.',
  inputSchema: schema({
    jobId: { type: 'string' },
    since: { type: 'number', description: 'Return only events after this cursor' },
    waitSeconds: { type: 'number', description: 'Seconds to wait, 0-55' },
  }, ['jobId']),
  parse(raw): StatusArgs {
    return {
      jobId: str(raw, 'jobId')!,
      since: clamp(num(raw, 'since', 0), 0, Number.MAX_SAFE_INTEGER, 0),
      waitSeconds: clamp(num(raw, 'waitSeconds', 0), 0, 55, 0),
    };
  },
  async invoke(ctx: ActionContext, a: StatusArgs): Promise<JobView> {
    // Clamp, do not trust: a negative `since` would silently replay the whole
    // event log and a negative wait would look like "no wait".
    const job = ctx.mgr.store.require(a.jobId);
    const waitSeconds = a.waitSeconds ?? 0;
    if (waitSeconds > 0 && job.status === 'running') {
      const deadline = Date.now() + waitSeconds * 1000;
      while (job.status === 'running' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    return ctx.mgr.view(job, a.since ?? 0);
  },
};

/* ------------------------------------------------------------------- reply */

export interface ReplyArgs extends Record<string, unknown> {
  jobId: string;
  prompt: string;
  tier?: Tier;
}

export const replyAction: Action<ReplyArgs, Job> = {
  name: 'cursor_reply',
  description:
    'Send input to a job. If the task is paused in the A2A `input-required` state, this ' +
    'RESUMES the SAME task (same job id, thread preserved) — input-required -> working -> ' +
    'completed. Otherwise it spawns a child follow-up job that resumes the Cursor thread. ' +
    'Cancel a running job before replying.',
  inputSchema: schema({
    jobId: { type: 'string' },
    prompt: { type: 'string' },
    tier: { type: 'string', enum: TIERS },
  }, ['jobId', 'prompt']),
  parse(raw): ReplyArgs {
    return {
      jobId: str(raw, 'jobId')!,
      prompt: str(raw, 'prompt')!,
      tier: raw.tier ? enumOf(raw, 'tier', TIERS) : undefined,
    };
  },
  invoke(ctx: ActionContext, a: ReplyArgs): Job {
    return ctx.mgr.reply(a.jobId, a.prompt, a.tier);
  },
};

/* ------------------------------------------------------------------ cancel */

export interface CancelArgs extends Record<string, unknown> {
  jobId: string;
}

export const cancelAction: Action<CancelArgs, Job> = {
  name: 'cursor_cancel',
  description: 'Cancel a running job and kill its entire process tree.',
  inputSchema: schema({ jobId: { type: 'string' } }, ['jobId']),
  parse(raw): CancelArgs {
    return { jobId: str(raw, 'jobId')! };
  },
  invoke(ctx: ActionContext, a: CancelArgs): Job {
    return ctx.mgr.cancel(a.jobId);
  },
};

/* -------------------------------------------------------------------- list */

export interface ListArgs extends Record<string, unknown> {
  status?: JobStatus;
  limit?: number;
}

export const listAction: Action<ListArgs, Job[]> = {
  name: 'cursor_list',
  description: 'List recent jobs with status, tier and duration.',
  inputSchema: schema({
    status: { type: 'string', enum: JOB_STATUSES },
    limit: { type: 'number', description: 'Max jobs to return, 1-1000' },
  }),
  parse(raw): ListArgs {
    const statusRaw = raw.status;
    const status: JobStatus | undefined =
      typeof statusRaw === 'string' && JOB_STATUSES.includes(statusRaw as JobStatus)
        ? (statusRaw as JobStatus)
        : undefined;
    return { status, limit: clamp(num(raw, 'limit', 20), 1, 1000, 20) };
  },
  invoke(ctx: ActionContext, a: ListArgs): Job[] {
    return ctx.mgr.store.list({ status: a.status, limit: a.limit });
  },
};

/* -------------------------------------------------------------------- diff */

export interface DiffArgs extends Record<string, unknown> {
  jobId: string;
  includePatch?: boolean;
  offset?: number;
  limit?: number;
}

export type DiffPayload = Record<string, unknown>;

export const diffAction: Action<DiffArgs, DiffPayload> = {
  name: 'cursor_diff',
  description:
    'Inspect what an execute job changed: changed file list, diffstat, ' +
    'and optionally the raw patch text. Use offset/limit to page through a large patch.',
  inputSchema: schema({
    jobId: { type: 'string' },
    includePatch: { type: 'boolean', description: 'Include the raw unified diff' },
    offset: { type: 'number' },
    limit: { type: 'number', description: 'Max characters of patch to return, 1-200000' },
  }, ['jobId']),
  parse(raw): DiffArgs {
    return {
      jobId: str(raw, 'jobId')!,
      includePatch: bool(raw, 'includePatch'),
      offset: clamp(num(raw, 'offset', 0), 0, Number.MAX_SAFE_INTEGER, 0),
      limit: clamp(num(raw, 'limit', 20000), 1, 200000, 20000),
    };
  },
  invoke(ctx: ActionContext, a: DiffArgs): DiffPayload {
    const job = ctx.mgr.store.require(a.jobId);
    const payload: DiffPayload = {
      jobId: job.id,
      status: job.status,
      isolation: job.isolation,
      changedFiles: job.changedFiles ?? [],
      diffStat: job.diffStat ?? '',
      patchFile: job.patchFile,
    };
    if (a.includePatch && job.patchFile && fs.existsSync(job.patchFile)) {
      const full = fs.readFileSync(job.patchFile, 'utf8');
      // Slice on UTF-8 byte boundaries so the JSON response is always valid.
      const buf = Buffer.from(full, 'utf8');
      const start = Math.min(a.offset ?? 0, buf.length);
      const end = Math.min(start + (a.limit ?? 20000), buf.length);
      payload.patchTotalBytes = buf.length;
      payload.patch = buf.subarray(start, end).toString('utf8');
      payload.nextOffset = end < buf.length ? end : undefined;
    }
    return payload;
  },
};

/* --------------------------------------------------------------- admin/io */

export const healthAction: Action<Record<string, unknown>, Record<string, unknown>> = {
  name: 'bridge_health',
  description:
    'Preflight diagnostics: binary resolution, workspace allowlist, state directory ' +
    'writability, concurrency and metrics. Run this first when a task fails for unclear reasons.',
  inputSchema: schema({}),
  parse(): Record<string, unknown> {
    return {};
  },
  invoke(ctx): Record<string, unknown> {
    return ctx.mgr.health();
  },
};

export const statsAction: Action<Record<string, unknown>, unknown> = {
  name: 'bridge_stats',
  description: 'Counters for job outcomes, tier mix and duration, for capacity planning.',
  inputSchema: schema({}),
  parse(): Record<string, unknown> {
    return {};
  },
  invoke(ctx): unknown {
    return ctx.mgr.getMetrics();
  },
};

export interface ShutdownArgs extends Record<string, unknown> {
  graceMs?: number;
}

export const shutdownAction: Action<ShutdownArgs, { ok: boolean; message: string }> = {
  name: 'bridge_shutdown',
  description:
    'Cancel all in-flight jobs, flush state and exit. Use before restarting the bridge ' +
    'so no Cursor process is left orphaned.',
  inputSchema: schema({ graceMs: { type: 'number' } }),
  parse(raw): ShutdownArgs {
    return { graceMs: num(raw, 'graceMs', 8000) };
  },
  invoke(ctx: ActionContext, a: ShutdownArgs): { ok: boolean; message: string } {
    // Defer the exit by a beat so the MCP transport has time to flush the
    // response we are returning; process.exit() would otherwise truncate the
    // stdout write and the caller would see a truncated JSON-RPC reply.
    void ctx.mgr.shutdown(a.graceMs ?? 8000).then(
      () => {
        setTimeout(() => process.exit(0), 100).unref?.();
      },
      (err: unknown) => {
        process.stderr.write(
          `[wb-cursor-bridge] shutdown error: ${err instanceof Error ? err.stack : String(err)}\n`,
        );
        setTimeout(() => process.exit(1), 100).unref?.();
      },
    );
    return { ok: true, message: 'shutting down; in-flight jobs cancelled' };
  },
};

/* ----------------------------------------------------------------- registry */

/**
 * Type-erased form kept in the registry. Each concrete action retains its own
 * argument/result generics; `erase()` performs the one safe widening at the
 * boundary so the registry can hold heterogeneous actions without `any`.
 */
export interface ErasedAction {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
  parse(raw: Record<string, unknown>): Record<string, unknown>;
  invoke(ctx: ActionContext, args: Record<string, unknown>): Promise<unknown> | unknown;
}

function erase<A extends Record<string, unknown>, R>(a: Action<A, R>): ErasedAction {
  return {
    name: a.name,
    description: a.description,
    inputSchema: a.inputSchema,
    parse: (raw) => a.parse(raw),
    invoke: (ctx, args) => a.invoke(ctx, args as A),
  };
}

export const ACTIONS: readonly ErasedAction[] = [
  erase(runAction),
  erase(statusAction),
  erase(replyAction),
  erase(cancelAction),
  erase(listAction),
  erase(diffAction),
  erase(healthAction),
  erase(statsAction),
  erase(shutdownAction),
];

const BY_NAME = new Map<string, ErasedAction>(ACTIONS.map((a) => [a.name, a]));

export function getAction(name: string): ErasedAction | undefined {
  return BY_NAME.get(name);
}

export function actionNames(): string[] {
  return [...BY_NAME.keys()];
}

/** MCP tool definitions, generated from the registry. */
export function toolDefinitions(): Array<{
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
}> {
  return ACTIONS.map((a) => ({
    name: a.name,
    description: a.description,
    inputSchema: a.inputSchema,
  }));
}

export type { JobView };
