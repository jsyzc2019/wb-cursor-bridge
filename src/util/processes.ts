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
  graceMs = 5000,
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
      const code = (err as NodeJS.ErrnoException).code;
      // The process is already gone - that is a success, not a failure.
      if (code === '128' || code === '1') {
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

  await new Promise((r) => setTimeout(r, graceMs));
  try {
    process.kill(-pid, 0);
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* already dead - the normal path */
  }
  return { method: 'signal', ok: true };
}