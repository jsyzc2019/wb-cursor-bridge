/**
 * Cursor CLI adapter.
 *
 * Owns argument construction, process spawning, stream consumption and
 * result assembly. Everything platform-specific about killing Cursor lives in
 * util/processes.ts; everything about argument order lives here, so the policy
 * question "what is this agent allowed to do" stays answerable by reading one
 * function.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { NdjsonReader } from '../util/ndjson.js';
import { parseStreamLine, describeTool, type ParsedEvent } from './parse.js';
import { killTreeGracefully } from '../util/processes.js';
import type { Config } from '../config.js';
import type { JobEvent, Tier } from '../types.js';

export interface RunCallbacks {
  /** `seq` and `ts` are assigned by the store, not by the caller. */
  onEvent(ev: Omit<JobEvent, 'seq' | 'ts'>): void;
  onThreadId(threadId: string): void;
}

export interface RunOptions {
  prompt: string;
  workspace: string;
  tier: Tier;
  /** Optional per-job model override. */
  model?: string;
  timeoutSec: number;
  worktree: boolean;
  /**
   * Path to a worktree the bridge already created. When present, Cursor is
   * pointed straight at it and does not create its own - this is what makes
   * diff artefacts and deterministic cleanup possible.
   */
  managedWorktree?: string;
  resumeThreadId?: string;
}

export interface RunOutcome {
  exitCode: number;
  result: string;
  truncated: boolean;
  threadId?: string;
  durationMs: number;
  /**
   * Present (non-undefined) when the worker signalled A2A `input-required` by
   * ending its message with a `NEED_INPUT:` line. The question text is stripped
   * from `result` and carried here so the runner can pause the SAME task.
   */
  needInput?: string;
}

/** Map a permission tier onto Cursor CLI flags. */
export function tierArgs(tier: Tier): string[] {
  switch (tier) {
    case 'consult':
      return ['--mode', 'ask'];
    case 'plan':
      return ['--mode', 'plan'];
    case 'execute':
      // print mode requires --force before it will touch the filesystem
      return ['--force'];
  }
}

/** Full argv for a run. Exported so tests can assert on it. */
export function buildArgs(cfg: Config, opts: RunOptions, worktreeName: string): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--workspace',
    opts.workspace,
    ...tierArgs(opts.tier),
  ];
  const model = opts.model ?? cfg.defaultModel;
  if (model && opts.tier !== 'consult') {
    args.push('--model', model);
  }
  // Only ask Cursor to manage a worktree when the bridge did not make one.
  if (opts.worktree && !opts.managedWorktree) {
    args.push('--worktree', worktreeName);
  }
  if (opts.resumeThreadId) {
    args.push('--resume', opts.resumeThreadId);
  }
  args.push(...cfg.extraArgs);
  args.push(opts.prompt);
  return args;
}

/** Exported so tests can assert on truncation behaviour. */
export function capText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  // Back off over any trailing continuation bytes so the cut never lands in
  // the middle of a multi-byte character (which would emit U+FFFD).
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  const sliced = buf.subarray(0, end).toString('utf8');
  return { text: `${sliced}\n...[truncated]`, truncated: true };
}

/**
 * Marker the worker appends to its final result to request A2A `input-required`.
 *
 * The marker must be the LAST LINE of the message (e.g.
 * "...partial answer\nNEED_INPUT: which file should I edit?"). Requiring it on
 * the final line keeps routine prose that merely mentions the words, or a
 * `NEED_INPUT:` that appears earlier with content after it, from being mistaken
 * for a pause signal. A real A2A agent adapter would raise this via the Task
 * status instead of a sentinel; the bridge accepts the sentinel so the same
 * code path serves both the MCP surface and a future A2A adapter.
 */
export const NEED_INPUT_MARKER = 'NEED_INPUT:';

/** Split a worker result into its answer and an optional A2A input request. */
export function extractNeedInput(text: string): { result: string; needInput?: string } {
  // The marker is only honoured when it begins the final line of the message.
  const m = text.match(/(?:^|\n)NEED_INPUT:[ \t]*([^\n]*?)[ \t]*\r?$/);
  if (!m) return { result: text };
  const question = m[1].trim();
  if (!question) return { result: text };
  const before = text.slice(0, m.index ?? 0).replace(/\s*$/, '');
  return { result: before, needInput: question };
}

/** Run one Cursor invocation to completion. */
export async function runCursor(
  cfg: Config,
  opts: RunOptions,
  cb: RunCallbacks,
  signal?: AbortSignal,
): Promise<RunOutcome> {
  const started = Date.now();
  const worktreeName = `wb-${randomUUID().slice(0, 8)}`;
  const args = buildArgs(cfg, opts, worktreeName);

  cb.onEvent({ type: 'start', text: cfg.cursorBin, detail: { args, timeoutSec: opts.timeoutSec, tier: opts.tier } });

  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn(
    cfg.cursorBin,
    args,
    {
      cwd: opts.workspace,
      windowsHide: true,
      // A new process group lets us signal the whole tree on POSIX. On Windows
      // taskkill /T does the equivalent, so a console window is never shown.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        CURSOR_DISABLE_TELEMETRY: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let pid: number | undefined = proc.pid;
  let result = '';
  let truncated = false;
  let threadId: string | undefined;
  let settled = false;

  const logKillResult = async (killPid: number): Promise<void> => {
    const outcome = await killTreeGracefully(killPid);
    if (!outcome.ok) {
      cb.onEvent({
        type: 'note',
        text: `kill failed: ${outcome.detail ?? 'unknown'}`,
        detail: outcome,
      });
    }
  };

  const reader = new NdjsonReader();

  proc.stdout.on('data', (chunk: Buffer) => {
    for (const line of reader.push(chunk)) {
      const ev: ParsedEvent | null = parseStreamLine(line);
      if (!ev) continue;
      if (ev.threadId && ev.threadId !== threadId) {
        threadId = ev.threadId;
        cb.onThreadId(ev.threadId);
      }
      switch (ev.kind) {
        case 'text':
          if (ev.text) {
            result += ev.text;
            cb.onEvent({ type: 'assistant', text: ev.text });
          }
          break;
        case 'tool':
          cb.onEvent({ type: 'tool', detail: describeTool(ev) });
          break;
        case 'result':
          if (ev.text) result = ev.text;
          break;
        case 'error':
          cb.onEvent({ type: 'stderr', text: ev.text ?? 'unknown error' });
          break;
        default:
          break;
      }
    }
  });

  let stderrTail = '';
  let spawnError: string | undefined;
  proc.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    stderrTail = (stderrTail + s).slice(-4000);
    cb.onEvent({ type: 'stderr', text: s.slice(0, 2000) });
  });

  let settledExitCode: number | undefined;

  const finish = async (exitCode: number): Promise<RunOutcome> => {
    if (settled) {
      return {
        exitCode: settledExitCode ?? exitCode,
        result,
        truncated,
        threadId,
        durationMs: Date.now() - started,
      };
    }
    settled = true;
    settledExitCode = exitCode;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);

    // Flush any trailing partial line and capture a final result event.
    for (const line of reader.end()) {
      const ev = parseStreamLine(line);
      if (ev?.kind === 'result' && ev.text) result = ev.text;
    }

    let exit = exitCode;
    if (signal?.aborted && exit === 0) exit = 130;
    if (!result && stderrTail) result = stderrTail;
    // A binary that cannot even be spawned produces no stdout and no stderr,
    // so surface the spawn error itself rather than an empty result.
    if (!result && spawnError) {
      result = `failed to start the Cursor CLI (${cfg.cursorBin}): ${spawnError}`;
    }

    // Detect an A2A input-required signal before capping, so the question is
    // never truncated out of the result.
    const extracted = extractNeedInput(result);
    const capped = capText(extracted.result, cfg.maxResultBytes);
    return {
      exitCode: exit,
      result: capped.text,
      truncated: capped.truncated,
      threadId,
      durationMs: Date.now() - started,
      needInput: extracted.needInput,
    };
  };

  let onAbort: () => void = () => {};
  const timer = setTimeout(() => {
    cb.onEvent({ type: 'note', text: `timeout after ${opts.timeoutSec}s, killing tree` });
    void finish(124);
    if (pid) void logKillResult(pid);
  }, opts.timeoutSec * 1000);
  timer.unref?.();

  if (signal) {
    onAbort = () => {
      cb.onEvent({ type: 'note', text: 'cancelled by caller' });
      void finish(130);
      if (pid) void logKillResult(pid);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return new Promise<RunOutcome>((resolve) => {
    proc.on('error', (err) => {
      spawnError = err.message;
      cb.onEvent({ type: 'stderr', text: `spawn error: ${String(err)}` });
      void finish(127).then(resolve);
    });
    proc.on('close', (code) => {
      void finish(code ?? 0).then(resolve);
    });
  });
}