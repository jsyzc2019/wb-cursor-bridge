/**
 * Resolve a fake-agent entry point that the bridge can actually spawn.
 *
 * The bridge executes `CURSOR_BIN` directly (no shell), so on POSIX a script
 * path works thanks to the shebang + exec bit. Windows has neither: it cannot
 * exec a `.mjs`, and Node refuses to spawn `.cmd`/`.bat` without a shell
 * (CVE-2024-27980). So on Windows we point at the `.mjs` and let the bridge run
 * it through the current Node binary — no shell, no quoting hazards.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {'cursor'|'a2a'} kind which fake agent to resolve
 * @returns {string} absolute path to a spawnable entry point
 */
export function fakeBin(kind = 'cursor') {
  const base = kind === 'a2a' ? 'a2a-fake-agent' : 'fake-agent';
  const ext = kind === 'a2a' || process.platform === 'win32' ? '.mjs' : '.sh';
  return path.join(ROOT, 'test', base + ext);
}
