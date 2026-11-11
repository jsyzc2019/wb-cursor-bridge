/**
 * Git worktree supervision.
 *
 * Letting Cursor create its own worktree (`--worktree`) hides the directory
 * from us, which means no diff artefact and no reliable cleanup. The bridge
 * therefore owns the worktree lifecycle: it creates a detached worktree with
 * `git worktree add --detach`, points Cursor at that path, snapshots the diff
 * before removing it. Branch refs are never created, so parallel jobs cannot
 * collide on branch names.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], timeout = 20_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ['rev-parse', '--is-inside-work-tree'], 8000);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the repository root containing `dir`. */
export async function repoRoot(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
}

export async function currentHead(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

export interface Worktree {
  path: string;
  repo: string;
  head: string;
}

/**
 * Create a detached worktree under `containerDir`.
 * Returns null when git is unavailable or the workspace is not a repository -
 * the caller then falls back to Cursor-managed isolation.
 */
export async function createWorktree(
  workspace: string,
  name: string,
  containerDir: string,
): Promise<Worktree | null> {
  if (!(await isGitRepo(workspace))) return null;
  const repo = await repoRoot(workspace);
  const head = await currentHead(workspace);
  const target = path.join(containerDir, name);
  fs.mkdirSync(containerDir, { recursive: true });
  await git(repo, ['worktree', 'add', '--detach', target, head], 60_000);
  return { path: target, repo, head };
}

/** Capture the diff produced inside a worktree, as a patch file. */
export async function captureDiff(
  worktreePath: string,
  outFile: string,
): Promise<{ file: string; bytes: number } | null> {
  try {
    // Stage everything first so newly created files appear in the patch.
    await git(worktreePath, ['add', '-A'], 30_000);
    // `--binary` embeds binary blobs as base64. Without it git emits
    // "Binary files differ", which cannot be re-applied when a paused task is
    // resumed - images and other assets would silently block the restore.
    const patch = await git(worktreePath, ['diff', '--cached', '--binary', 'HEAD'], 30_000);
    if (!patch.trim()) return null;
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, patch, 'utf8');
    return { file: outFile, bytes: Buffer.byteLength(patch, 'utf8') };
  } catch {
    return null;
  }
}

/**
 * Re-apply a patch captured during an earlier pass into a fresh worktree.
 *
 * A paused (`input-required`) task holds no live worktree: the worktree is torn
 * down when the pass ends and the next pass starts from a clean checkout of
 * HEAD. Without this step every file the worker wrote before asking its
 * question would silently disappear, and the resumed thread would reason about
 * code that no longer exists.
 *
 * Returns a structured failure instead of throwing so the caller can decide to
 * fail closed rather than run the worker on a half-restored tree.
 */
export async function applyPatch(
  worktreePath: string,
  patchFile: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!fs.existsSync(patchFile)) {
    return { ok: false, reason: `saved patch is missing: ${patchFile}` };
  }
  try {
    await git(worktreePath, ['apply', '--index', '--whitespace=nowarn', patchFile], 60_000);
    return { ok: true };
  } catch (direct) {
    // The base may have moved while the task was paused (the caller committed).
    // A three-way merge recovers the common case; the blob objects are still in
    // the shared object store because `captureDiff` staged them before diffing.
    try {
      await git(
        worktreePath,
        ['apply', '--index', '--3way', '--whitespace=nowarn', patchFile],
        60_000,
      );
      return { ok: true };
    } catch {
      const raw = direct instanceof Error ? direct.message : String(direct);
      return { ok: false, reason: raw.split('\n').filter(Boolean).slice(0, 3).join(' ').trim() };
    }
  }
}

/** Short diffstat, useful as a cheap summary in a polling response. */
export async function diffStat(worktreePath: string): Promise<string> {
  try {
    return (await git(worktreePath, ['diff', '--cached', '--stat', 'HEAD'], 20_000)).trim();
  } catch {
    return '';
  }
}

/** Files changed in the worktree relative to HEAD, including new ones. */
export async function changedFiles(worktreePath: string): Promise<string[]> {
  try {
    // `git diff HEAD` alone omits untracked files, which is exactly what an
    // agent creates most often. Stage first so new files are visible.
    await git(worktreePath, ['add', '-A'], 30_000);
    const out = await git(
      worktreePath,
      ['diff', '--cached', '--name-only', 'HEAD'],
      20_000,
    );
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Remove a worktree, pruning metadata and tolerating a dirty tree.
 * Never throws: cleanup must not mask a job result.
 */
export async function removeWorktree(wt: Worktree): Promise<void> {
  try {
    await git(wt.repo, ['worktree', 'remove', '--force', wt.path], 30_000);
  } catch {
    try {
      await git(wt.repo, ['worktree', 'prune'], 15_000);
    } catch {
      /* give up quietly */
    }
  }
  try {
    fs.rmSync(wt.path, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Drop stale git worktree *metadata* for a repo.
 *
 * This only removes bookkeeping entries whose checkout directory is already
 * gone - it never deletes a live checkout. Reclaiming actual directories is
 * the job of `pruneStaleInstanceDirs`, which knows which owner still exists;
 * the previous version deleted every directory under the shared
 * `<stateDir>/worktrees`, so a second bridge starting up would wipe the
 * worktrees a first, still-running bridge was executing inside.
 */
export async function pruneWorktreeMetadata(repo: string): Promise<void> {
  try {
    await git(repo, ['worktree', 'prune'], 15_000);
  } catch {
    /* ignore */
  }
}