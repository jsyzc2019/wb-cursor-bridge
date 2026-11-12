/**
 * Cross-platform process-tree termination.
 *
 * On POSIX a detached child becomes a process-group leader, so a negative pid
 * signals the whole tree. Windows has no such thing: `detached: true` only
 * creates a new console process group, and negative-pid signals are not
 * supported. There the only reliable way to kill Cursor and everything it
 * spawned (compilers, test runners, language servers) is `taskkill /T /F`.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';

export interface KillOutcome {
  method: 'taskkill' | 'signal' | 'none';
  ok: boolean;
  detail?: string;
}

/** SIGTERM first so the child can flush state, then SIGKILL as a backstop. */
export async function killTreeGracefully(
  pid: number,
  /**
   * 2s, not 5s: a worker that ignores SIGTERM must still be gone before the
   * supervisor's own shutdown deadline (3s), otherwise the bridge exits while
   * the agent it "cancelled" keeps running.
   */
  graceMs = 2000,
): Promise<KillOutcome> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { method: 'none', ok: false, detail: `invalid pid ${pid}` };
  }

  if (IS_WIN) {
    try {
      await execFileAsync(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, timeout: graceMs },
      );
      return { method: 'taskkill', ok: true };
    } catch (err) {
      // `code` is typed as string | undefined on ErrnoException but execFile
      // surfaces taskkill's numeric exit code, so keep it untyped for the
      // comparison rather than trusting the declaration.
      const code: unknown = (err as { code?: unknown }).code;
      // The process is already gone - that is a success, not a failure.
      // `code` is a NUMBER on current Node (128 = no such process); older
      // releases surfaced the same value as a string. Compare both, otherwise
      // every already-exited child is reported as a kill failure.
      if (isAlreadyGone(code)) {
        return { method: 'taskkill', ok: true, detail: 'already exited' };
      }
      return {
        method: 'taskkill',
        ok: false,
        detail: (err as Error).message,
      };
    }
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { method: 'signal', ok: true, detail: 'already exited' };
    return { method: 'signal', ok: false, detail: (err as Error).message };
  }

  /**
   * Poll instead of sleeping the full grace period: a well-behaved agent exits
   * in a few milliseconds, and making every cancel wait 5s was a large part of
   * why a killed task looked "stuck" to the caller.
   */
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (!groupAlive(pid)) return { method: 'signal', ok: true, detail: 'terminated' };
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* already dead - the normal path */
  }
  return { method: 'signal', ok: !groupAlive(pid), detail: 'sigkill sent' };
}

/** True while the process group still has at least one member. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
/**
 * Kill a worker left behind by a previous bridge process.
 *
 * A recorded pid is not proof of ownership: pids are recycled. Before signalling
 * we read `/proc/<pid>/cmdline` and require it to mention the configured agent
 * binary, so a recycled pid belonging to an unrelated process is left alone.
 * On platforms without /proc we decline rather than guess - an operator can
 * always kill it by hand, but we cannot un-kill the wrong process.
 */
/**
 * True when a kill attempt failed only because the process was already gone.
 *
 * Pure and exported so it can be unit-tested on any platform: `taskkill`
 * reports 128 (no such process) as a NUMBER on current Node, while older
 * releases and shells surfaced the same value as a string. The previous inline
 * comparison used the string form only, so every already-exited child was
 * logged as a kill failure.
 */
export function isAlreadyGone(code: unknown): boolean {
  if (code === null || code === undefined) return false;
  const n = typeof code === 'number' ? code : Number(code);
  return n === 128 || n === 1;
}

export async function reclaimOrphan(pid: number, agentBin: string): Promise<KillOutcome> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { method: 'none', ok: false, detail: `invalid pid ${pid}` };
  }
  if (process.platform !== 'linux') {
    return { method: 'none', ok: false, detail: 'automatic reclaim is only implemented on linux' };
  }
  let cmdline: string;
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return { method: 'none', ok: true, detail: 'process already gone' };
  }
  const marker = agentBin.split(/[\\/]/).pop() ?? agentBin;
  if (!cmdline.includes(marker)) {
    return { method: 'none', ok: false, detail: `pid ${pid} is not our agent (recycled pid?)` };
  }
  return killTreeGracefully(pid, 1500);
}
