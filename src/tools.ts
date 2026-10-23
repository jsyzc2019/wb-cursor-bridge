/**
 * MCP tool surface.
 *
 * Nine tools, and that number is deliberate: every extra tool is a way for the
 * supervising model to make a mistake. Argument validation is hand-rolled
 * rather than schema-derived so the error messages the caller sees are written
 * for a model, not for a stack trace.
 */
import fs from 'node:fs';
import { badArgument } from './errors.js';
import type { JobManager } from './runner.js';
import type { JobStatus, Tier } from './types.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const ok = (payload: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

const fail = (message: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

const TIERS: Tier[] = ['consult', 'plan', 'execute'];

function str(args: Record<string, unknown>, key: string, required = true): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw badArgument(`missing required argument "${key}"`);
    return undefined;
  }
  if (typeof v !== 'string' || v.length === 0) {
    throw badArgument(`argument "${key}" must be a non-empty string`);
  }
  return v;
}

function num(args: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw badArgument(`argument "${key}" must be a number`);
  return n;
}

function tier(args: Record<string, unknown>, key = 'tier'): Tier {
  const v = str(args, key)!;
  if (!TIERS.includes(v as Tier)) {
    throw badArgument(
      `"${key}" must be one of ${TIERS.join(' | ')} (got "${v}")`,
    );
  }
  return v as Tier;
}

export const TOOL_DEFINITIONS = [
  {
    name: 'cursor_run',
    description:
      'Dispatch a task to the Cursor sub-agent and return a job id IMMEDIATELY. ' +
      'This tool never blocks: a real code task takes minutes, so poll with cursor_status. ' +
      'tier=consult is read-only Q&A, tier=plan is read-only planning, ' +
      'tier=execute may write files and is always isolated in a git worktree.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task for the Cursor agent' },
        workspace: {
          type: 'string',
          description: 'Absolute path, must be inside a configured workspace root',
        },
        tier: { type: 'string', enum: TIERS },
        model: { type: 'string', description: 'Optional Cursor model id' },
        timeoutSec: { type: 'number', description: 'Wall-clock ceiling for this job' },
      },
      required: ['prompt', 'workspace', 'tier'],
    },
  },
  {
    name: 'cursor_status',
    description:
      'Poll a job. Pass waitSeconds (max 55) to block briefly until it settles, ' +
      'and `since` to receive only new events.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        since: { type: 'number', description: 'Return only events after this cursor' },
        waitSeconds: { type: 'number', description: 'Seconds to wait, 0-55' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'cursor_reply',
    description:
      'Send input to a job. If the task is paused in the A2A `input-required` state, this ' +
      'RESUMES the SAME task (same job id, thread preserved) — input-required -> working -> ' +
      'completed. Otherwise it spawns a child follow-up job that resumes the Cursor thread. ' +
      'Cancel a running job before replying.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        prompt: { type: 'string' },
        tier: { type: 'string', enum: TIERS },
      },
      required: ['jobId', 'prompt'],
    },
  },
  {
    name: 'cursor_cancel',
    description: 'Cancel a running job and kill its entire process tree.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'cursor_list',
        description: 'List recent jobs with status, tier and duration.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['running', 'input-required', 'completed', 'failed', 'cancelled', 'timeout', 'orphaned'] },
        limit: { type: 'number', description: 'Max jobs to return, 1-1000' },
      },
    },
  },
  {
    name: 'cursor_diff',
    description:
      'Inspect what an execute job changed: changed file list, diffstat, ' +
      'and optionally the raw patch text. Use offset/limit to page through a large patch.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        includePatch: { type: 'boolean', description: 'Include the raw unified diff' },
        offset: { type: 'number' },
        limit: { type: 'number', description: 'Max characters of patch to return, 1-200000' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'bridge_health',
    description:
      'Preflight diagnostics: binary resolution, workspace allowlist, state directory ' +
      'writability, concurrency and metrics. Run this first when a task fails for unclear reasons.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bridge_stats',
    description: 'Counters for job outcomes, tier mix and duration, for capacity planning.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bridge_shutdown',
    description:
      'Cancel all in-flight jobs, flush state and exit. Use before restarting the bridge ' +
      'so no Cursor process is left orphaned.',
    inputSchema: {
      type: 'object',
      properties: { graceMs: { type: 'number' } },
    },
  },
] as const;

export function createDispatcher(mgr: JobManager) {
  return async function dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      switch (name) {
        case 'cursor_run': {
          const job = mgr.start({
            prompt: str(args, 'prompt')!,
            workspace: str(args, 'workspace')!,
            tier: tier(args),
            model: str(args, 'model', false),
            timeoutSec: num(args, 'timeoutSec'),
          });
          return ok(mgr.view(job));
        }

        case 'cursor_status': {
          const jobId = str(args, 'jobId')!;
          // Clamp, do not trust: a negative `since` would silently replay the
          // whole event log and a negative wait would look like "no wait".
          const since = Math.max(num(args, 'since', 0)!, 0);
          const waitSeconds = Math.min(Math.max(num(args, 'waitSeconds', 0)!, 0), 55);
          const job = mgr.store.require(jobId);
          if (waitSeconds > 0 && job.status === 'running') {
            const deadline = Date.now() + waitSeconds * 1000;
            while (job.status === 'running' && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 250));
            }
          }
          return ok(mgr.view(job, since));
        }

        case 'cursor_reply': {
          const job = mgr.reply(
            str(args, 'jobId')!,
            str(args, 'prompt')!,
            args.tier ? tier(args) : undefined,
          );
          return ok(mgr.view(job));
        }

        case 'cursor_cancel':
          return ok(mgr.view(mgr.cancel(str(args, 'jobId')!)));

        case 'cursor_list': {
          const statusRaw = args.status;
          const status: JobStatus | undefined =
            typeof statusRaw === 'string' &&
            ['running', 'input-required', 'completed', 'failed', 'cancelled', 'timeout', 'orphaned'].includes(statusRaw)
              ? (statusRaw as JobStatus)
              : undefined;
          const jobs = mgr.store.list({
            status,
            limit: Math.min(Math.max(num(args, 'limit', 20)!, 1), 1000),
          });
          return ok(
            jobs.map((j) => ({
              jobId: j.id,
              status: j.status,
              tier: j.tier,
              workspace: j.workspace,
              isolation: j.isolation,
              createdAt: j.createdAt,
              finishedAt: j.finishedAt,
              durationMs: j.durationMs,
              changedFileCount: j.changedFiles?.length ?? 0,
              hasResult: Boolean(j.result),
            })),
          );
        }

        case 'cursor_diff': {
          const job = mgr.store.require(str(args, 'jobId')!);
          const offset = Math.max(num(args, 'offset', 0)!, 0);
          const limit = Math.min(Math.max(num(args, 'limit', 20000)!, 1), 200000);
          const payload: Record<string, unknown> = {
            jobId: job.id,
            status: job.status,
            isolation: job.isolation,
            changedFiles: job.changedFiles ?? [],
            diffStat: job.diffStat ?? '',
            patchFile: job.patchFile,
          };
          if (args.includePatch && job.patchFile && fs.existsSync(job.patchFile)) {
            const full = fs.readFileSync(job.patchFile, 'utf8');
            // Slice on UTF-8 byte boundaries so the JSON response is always valid.
            const buf = Buffer.from(full, 'utf8');
            const start = Math.min(offset, buf.length);
            const end = Math.min(start + limit, buf.length);
            const slice = buf.subarray(start, end).toString('utf8');
            payload.patchTotalBytes = buf.length;
            payload.patch = slice;
            payload.nextOffset = end < buf.length ? end : undefined;
          }
          return ok(payload);
        }

        case 'bridge_health': {
          const health = mgr.health();
          return health.ok ? ok(health) : { ...ok(health), isError: false };
        }

        case 'bridge_stats':
          return ok(mgr.getMetrics());

        case 'bridge_shutdown': {
          const graceMs = num(args, 'graceMs', 8000)!;
          // Defer the exit by a beat so the MCP transport has time to flush the
          // response we are returning; process.exit() would otherwise truncate
          // the stdout write and the caller would see a truncated JSON-RPC reply.
          void mgr.shutdown(graceMs).then(
            () => {
              setTimeout(() => process.exit(0), 100).unref?.();
            },
            (err) => {
              process.stderr.write(
                `[wb-cursor-bridge] shutdown error: ${err instanceof Error ? err.stack : String(err)}\n`,
              );
              setTimeout(() => process.exit(1), 100).unref?.();
            },
          );
          return ok({ ok: true, message: 'shutting down; in-flight jobs cancelled' });
        }

        default:
          return fail(
            `unknown tool "${name}". Available: ${TOOL_DEFINITIONS.map((t) => t.name).join(', ')}`,
          );
      }
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'E_INTERNAL';
      return fail(`${code}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}