/**
 * Cleanup helper for tests that spawn real processes.
 *
 * On Windows a directory cannot be removed while any process still has a handle
 * on it, and several suites deliberately create exactly that situation (a
 * grandchild holding stdout, a cancelled job's leftover child). `fs.rmSync`
 * retries EBUSY for a bounded time, but when a *live* process holds the tree the
 * retry budget just expires — and then the test fails in `finally`, masking the
 * assertion it actually made.
 *
 * So: retry, then tolerate the lock. A leftover temp tree is the runner's
 * problem; a cleanup error is not a product signal. Anything that is *not* a
 * Windows lock error is still thrown, because that would be a real bug
 * (wrong path, permissions, ENOTDIR…).
 */
import { rmSync } from 'node:fs';

const WINDOWS_LOCK_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

export function rmrf(target, { quiet = true } = {}) {
  try {
    rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    });
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : undefined;
    if (typeof code !== 'string' || !WINDOWS_LOCK_CODES.has(code)) throw err;
    if (!quiet) {
      console.warn(`[cleanup] ${code} left ${target} behind (a child still holds it)`);
    }
  }
}
