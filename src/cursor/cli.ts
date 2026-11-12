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
import { badArgument } from '../errors.js';
import type { Config } from '../config.js';
import type { JobEvent, Tier } from '../types.js';

export interface RunCallbacks {
  /** `seq` and `ts` are assigned by the store, not by the caller. */
  onEvent(ev: Omit<JobEvent, 'seq' | 'ts'>): void;
  onThreadId(threadId: string): void;
  /**
   * Called once the worker has a pid. The runner persists it so a bridge that
   * is SIGKILLed mid-task can reclaim the still-running agent on the next boot;
   * without this the orphan is invisible (no pid anywhere) and runs forever.
   */
  onSpawn?(pid: number): void;
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
    // A model id starting with `-` would be parsed as a flag, letting a caller
    // smuggle `--force` (or `--mode`) past the tier policy.
    if (model.startsWith('-')) {
      throw badArgument(`model "${model}" must not start with "-"`);
    }
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
  /**
   * `--` terminates option parsing. Without it the prompt is just the next
   * positional token, so a prompt of `--force` became a `--force` FLAG: a
   * consult-tier job (whose whole promise is "read-only") would then run with
   * write permission. One separator closes that class of injection for good,
   * because everything after it is data - including anything the prompt or a
   * caller-supplied model string contains.
   */
  args.push('--');
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

/**
 * Decide what to actually spawn for `cfg.cursorBin`.
 *
 * Windows cannot execute a JS file directly, and Node refuses to spawn a
 * `.cmd`/`.bat` without `shell: true` (CVE-2024-27980). Enabling a shell here is
 * not an option: the prompt travels as an argv and a shell would re-parse it,
 * turning `&` or `^` into command injection. Running a JS entry through the
 * current Node binary keeps the no-shell guarantee, and is what lets a
 * script-based fake agent stand in for `agent.exe` on Windows.
 */
export function resolveSpawnTarget(
  bin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'win32' && /\.(?:mjs|cjs|js)$/i.test(bin)) {
    return { command: process.execPath, args: [bin, ...args] };
  }
  return { command: bin, args };
}

/**
 * Environment variables a worker is allowed to inherit.
 *
 * The bridge used to spawn Cursor with `{...process.env}`, so every secret in
 * the supervisor's environment - API keys, cloud credentials, CI tokens - was
 * readable by the coding agent (and printed in any transcript that ran `env`).
 * A worker needs very little to do its job: a PATH to find tools, a HOME for
 * caches, locale and proxy settings. Everything else is opt-in by exact name.
 */
const ENV_ALLOW_EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'TMPDIR',
  'TMP',
  'TEMP',
  // Windows
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'PROGRAMFILES',
  'PROGRAMDATA',
  // proxies (both cases are used in the wild)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
]);

/** Prefixes a worker may inherit (locale, bridge/agent knobs, XDG layout). */
const ENV_ALLOW_PREFIX = ['LC_', 'XDG_', 'CURSOR_', 'WB_'];

/** Anything matching this is dropped even if a prefix would have allowed it. */
const ENV_SENSITIVE = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_KEY|_AUTH)/i;

/** Build the child environment. Exported so tests can assert it directly. */
export function buildChildEnv(
  cfg: Pick<Config, 'envPassthrough'>,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const passthrough = new Set((cfg.envPassthrough ?? []).map((n) => n.trim()).filter(Boolean));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const allowed =
      passthrough.has(key) ||
      ENV_ALLOW_EXACT.has(key) ||
      ENV_ALLOW_PREFIX.some((p) => key.startsWith(p));
    if (!allowed) continue;
    // An explicit passthrough wins over the sensitive-name heuristic: the
    // operator asked for this exact variable by name.
    if (!passthrough.has(key) && ENV_SENSITIVE.test(key)) continue;
    out[key] = value;
  }
  out.CURSOR_DISABLE_TELEMETRY = '1';
  out.FORCE_COLOR = '0';
  out.NO_COLOR = '1';
  return out;
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
  const target = resolveSpawnTarget(cfg.cursorBin, args);

  cb.onEvent({ type: 'start', text: cfg.cursorBin, detail: { args, timeoutSec: opts.timeoutSec, tier: opts.tier } });

  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn(
    target.command,
    target.args,
    {
      cwd: opts.workspace,
      windowsHide: true,
      // A new process group lets us signal the whole tree on POSIX. On Windows
      // taskkill /T does the equivalent, so a console window is never shown.
      detached: process.platform !== 'win32',
      env: buildChildEnv(cfg),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const pid: number | undefined = proc.pid;
  if (pid) cb.onSpawn?.(pid);
  let result = '';
  let resultChars = 0;
  let truncated = false;
  let threadId: string | undefined;
  let settled = false;

  /**
   * Hard cap applied while streaming, not just at the end.
   *
   * `capText()` used to run only when the process exited, so a worker that kept
   * emitting assistant text grew `result` for minutes - an OOM vector on a
   * long-running task. We now stop appending once the budget is spent.
   * Chars are a safe over-approximation of UTF-8 bytes for this purpose; the
   * exact byte cut still happens in `capText()` at the end.
   */
  const maxResultChars = Math.max(1024, cfg.maxResultBytes);
  /**
   * Bounded tail of everything the worker emitted. The `NEED_INPUT:` marker
   * must be the last line, so once the answer is capped it may no longer be in
   * `result`; keeping a small tail window lets the pause signal still be
   * detected without reopening the unbounded-memory hole.
   */
  const TAIL_CHARS = 16 * 1024;
  let markerTail = '';

  const appendText = (text: string): void => {
    if (!text) return;
    markerTail = (markerTail + text).slice(-TAIL_CHARS);
    if (resultChars >= maxResultChars) {
      truncated = true;
      return;
    }
    const room = maxResultChars - resultChars;
    if (text.length <= room) {
      result += text;
      resultChars += text.length;
    } else {
      result += text.slice(0, room);
      resultChars = maxResultChars;
      truncated = true;
    }
  };

  /** A `result` event carries the whole answer: it replaces, not appends. */
  const setResult = (text: string): void => {
    result = '';
    resultChars = 0;
    appendText(text);
  };

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
  let droppedSeen = 0;

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
            appendText(ev.text);
            cb.onEvent({ type: 'assistant', text: ev.text });
          }
          break;
        case 'tool':
          cb.onEvent({ type: 'tool', detail: describeTool(ev) });
          break;
        case 'result':
          if (ev.text) setResult(ev.text);
          break;
        case 'error':
          cb.onEvent({ type: 'stderr', text: ev.text ?? 'unknown error' });
          break;
        default:
          break;
      }
    }
    // An oversized line cannot be a valid event; say so instead of silently
    // pretending the worker produced nothing.
    if (reader.droppedLines > droppedSeen) {
      const delta = reader.droppedLines - droppedSeen;
      droppedSeen = reader.droppedLines;
      cb.onEvent({
        type: 'note',
        text: `dropped ${delta} oversized stream line(s) totalling ${reader.droppedBytes} chars`,
      });
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
  /**
   * Resolves the promise returned to the caller, and is the ONLY place that
   * does so. Keeping it separate from `finish()` is what fixes the permanent
   * concurrency-slot leak: `finish()` computes the outcome, but the outer
   * promise used to be resolved exclusively from the child's `close` event.
   * A grandchild that inherits stdout keeps the pipe open, so `close` never
   * fires - `cancel`, the per-job timeout and `bridge_shutdown` all waited on
   * a promise that could never settle, and the slot was lost for good.
   */
  let resolveRun: ((outcome: RunOutcome) => void) | undefined;
  let resolved = false;
  let drainTimer: NodeJS.Timeout | undefined;
  /**
   * Set when WE decided the run is over (timeout / cancel). The child may then
   * die from SIGTERM and report `code === null`, which used to be coalesced to
   * 0 - a timed-out task was recorded as a successful completion.
   */
  let abortExitCode: number | undefined;

  /**
   * Settle exactly once: flush whatever is buffered, then release the pipes.
   * Destroying the streams after `finish()` is deliberate - it lets the child's
   * process group die even when a detached grandchild still holds the write end.
   */
  const finalise = (code: number): void => {
    if (resolved) return;
    resolved = true;
    if (drainTimer) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
    void finish(code).then((outcome) => {
      try {
        proc.stdout?.destroy();
      } catch {
        /* already gone */
      }
      try {
        proc.stderr?.destroy();
      } catch {
        /* already gone */
      }
      resolveRun?.(outcome);
    });
  };

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
      if (ev?.kind === 'result' && ev.text) setResult(ev.text);
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
    let needInput = extracted.needInput;
    if (!needInput && truncated) {
      // The answer was capped mid-stream, so the marker's final line may not be
      // in `result` any more; the preserved tail still has it.
      const fromTail = extractNeedInput(markerTail);
      if (fromTail.needInput) needInput = fromTail.needInput;
    }
    const capped = capText(extracted.result, cfg.maxResultBytes);
    return {
      exitCode: exit,
      result: capped.text,
      truncated: capped.truncated || truncated,
      threadId,
      durationMs: Date.now() - started,
      needInput,
    };
  };

  /**
   * How long to wait for the last stdout bytes after `exit` before giving up on
   * `close`. 1.5s is enough for the pipe buffer to drain on a local agent and
   * short enough that a hijacked pipe does not turn into a hung task.
   */
  const DRAIN_MS = 1500;
  /**
   * After a kill we still give the tree a moment to produce its final words,
   * but we never wait on `close`: that is exactly the state a detached
   * grandchild can pin forever.
   */
  const KILL_SETTLE_MS = 2000;

  const abortRun = (code: number, note: string): void => {
    abortExitCode = code;
    cb.onEvent({ type: 'note', text: note });
    if (resolved) return;
    /**
     * Stay unsettled until the kill actually finished. Resolving on a fixed
     * timer meant `bridge_shutdown` returned (and the process exited) while the
     * SIGTERM was still in flight, so the agent outlived the bridge that had
     * just "cancelled" it. The fallback timer only exists so a wedged kill
     * cannot hang the task forever.
     */
    if (!pid) {
      drainTimer = setTimeout(() => finalise(code), KILL_SETTLE_MS);
      drainTimer.unref?.();
      return;
    }
    const kill = logKillResult(pid);
    const fallback = setTimeout(() => finalise(code), KILL_SETTLE_MS + 4000);
    fallback.unref?.();
    void kill.finally(() => {
      clearTimeout(fallback);
      finalise(code);
    });
  };

  let onAbort: () => void = () => {};
  const timer = setTimeout(() => {
    abortRun(124, `timeout after ${opts.timeoutSec}s, killing tree`);
  }, opts.timeoutSec * 1000);
  timer.unref?.();

  if (signal) {
    onAbort = () => abortRun(130, 'cancelled by caller');
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return new Promise<RunOutcome>((resolve) => {
    resolveRun = resolve;
    proc.on('error', (err) => {
      spawnError = err.message;
      cb.onEvent({ type: 'stderr', text: `spawn error: ${String(err)}` });
      finalise(127);
    });
    /**
     * `exit` fires when the direct child is gone; `close` waits for every pipe
     * holder. We treat `exit` as the primary signal and use `close` only to
     * finish earlier.
     */
    proc.on('exit', (code, sig) => {
      if (resolved) return;
      const exitCode = abortExitCode ?? code ?? (sig ? 128 : 0);
      drainTimer = setTimeout(() => finalise(exitCode), DRAIN_MS);
      drainTimer.unref?.();
    });
    proc.on('close', (code) => {
      finalise(abortExitCode ?? code ?? settledExitCode ?? 0);
    });
  });
}