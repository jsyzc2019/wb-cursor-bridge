/**
 * Per-instance state isolation.
 *
 * `CURSOR_BRIDGE_STATE_DIR` is shared between every bridge that runs under the
 * same user - which is the common case, not the exception: MCP clients such as
 * WorkBuddy spawn one stdio bridge per session, and every one of them resolves
 * the same default state directory. Historically each instance reclaimed
 * `<stateDir>/worktrees` wholesale on startup, so a second session would delete
 * the git worktrees a first session was actively running its worker inside -
 * the worker's `cwd` disappears mid-task and the job fails with an unrelated
 * error.
 *
 * Worktrees now live under a per-instance directory that carries an owner
 * record (pid + host). Startup reclaims only directories whose owner is
 * verifiably gone, on the same host, so concurrent instances coexist.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const OWNER_FILE = 'owner.json';

/** Directories without an owner record predate per-instance layout; only reclaim them once clearly abandoned. */
export const DEFAULT_UNKNOWN_STALE_MS = 6 * 60 * 60 * 1000;

export interface InstanceOwner {
  instanceId: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

let cachedInstanceId: string | undefined;

/** Stable id for this process: explicit override, else `<pid>-<random>`. */
export function currentInstanceId(): string {
  if (cachedInstanceId) return cachedInstanceId;
  const override = process.env.CURSOR_BRIDGE_INSTANCE_ID?.trim();
  cachedInstanceId = override && override !== '' ? override : `${process.pid}-${randomUUID().slice(0, 8)}`;
  return cachedInstanceId;
}

/** Root that holds one directory per instance. */
export function worktreeRoot(stateDir: string): string {
  return path.join(stateDir, 'worktrees');
}

export function instanceDir(stateDir: string, instanceId = currentInstanceId()): string {
  return path.join(worktreeRoot(stateDir), instanceId);
}

/**
 * Create this instance's worktree directory and stamp it with an owner record.
 * Throws if the state directory is not writable; callers that must degrade
 * gracefully (rather than refuse to boot) catch and fall back.
 */
export function claimInstanceDir(stateDir: string, instanceId = currentInstanceId()): string {
  const dir = instanceDir(stateDir, instanceId);
  fs.mkdirSync(dir, { recursive: true });
  const owner: InstanceOwner = {
    instanceId,
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
  return dir;
}

/** True when `pid` exists (EPERM means "alive but not ours"). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function readOwner(dir: string): InstanceOwner | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')) as Partial<InstanceOwner>;
    if (typeof raw.instanceId !== 'string' || typeof raw.pid !== 'number' || typeof raw.hostname !== 'string') {
      return null;
    }
    return {
      instanceId: raw.instanceId,
      pid: raw.pid,
      hostname: raw.hostname,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    };
  } catch {
    return null;
  }
}

/** Oldest mtime in a directory tree (best effort; used to age unattributed leftovers). */
function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (p: string, depth: number): void => {
    if (depth > 3) return;
    try {
      const st = fs.lstatSync(p);
      newest = Math.max(newest, st.mtimeMs);
      if (st.isDirectory()) {
        for (const entry of fs.readdirSync(p)) walk(path.join(p, entry), depth + 1);
      }
    } catch {
      /* entry vanished while walking */
    }
  };
  walk(dir, 0);
  return newest;
}

export interface PruneResult {
  /** Instance directories reclaimed (owner gone, or unattributed + stale). */
  removed: string[];
  /** Instance directories kept because their owner is still alive. */
  kept: string[];
  /** Unattributed directories younger than the staleness threshold; left alone. */
  unknown: string[];
  /** Live instances on this host that share the state directory (excluding us). */
  peers: InstanceOwner[];
}

/**
 * Reclaim worktree directories left behind by dead bridge instances.
 *
 * Deliberately conservative: a directory is removed only when its owner record
 * proves the pid is gone *on this host*. Cross-host shares (a network drive
 * mounted by two machines) never reclaim, because a foreign pid says nothing
 * about liveness and deleting a live worker's checkout is far worse than
 * leaving a stale one behind.
 */
export function pruneStaleInstanceDirs(
  stateDir: string,
  opts: {
    staleAfterMs?: number;
    now?: number;
    isAlive?: (pid: number) => boolean;
    hostname?: string;
    selfId?: string;
  } = {},
): PruneResult {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_UNKNOWN_STALE_MS;
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? pidAlive;
  const hostname = opts.hostname ?? os.hostname();
  const selfId = opts.selfId ?? currentInstanceId();

  const result: PruneResult = { removed: [], kept: [], unknown: [], peers: [] };
  const root = worktreeRoot(stateDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return result; // nothing to reclaim
  }

  for (const entry of entries) {
    const dir = path.join(root, entry);
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (entry === selfId) {
      // Our own directory, reused via CURSOR_BRIDGE_INSTANCE_ID: the leftovers
      // are from a previous life of this id. Keep the owner record - callers
      // may have already claimed it for this process.
      try {
        for (const child of fs.readdirSync(dir)) {
          if (child === OWNER_FILE) continue;
          fs.rmSync(path.join(dir, child), { recursive: true, force: true });
        }
      } catch {
        result.kept.push(dir);
      }
      result.kept.push(dir);
      continue;
    }

    const owner = readOwner(dir);
    if (!owner) {
      // No owner record: written by an older build (or by hand). Age is the only
      // signal available, so wait it out rather than risk killing a live worker
      // started by a bridge that only knows the flat layout.
      const age = now - newestMtime(dir);
      if (age > staleAfterMs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          result.removed.push(dir);
        } catch {
          result.kept.push(dir);
        }
      } else {
        result.unknown.push(dir);
      }
      continue;
    }

    if (owner.hostname !== hostname) {
      result.kept.push(dir); // cannot judge a foreign host's pid
      continue;
    }
    if (isAlive(owner.pid)) {
      result.kept.push(dir);
      result.peers.push(owner);
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      result.removed.push(dir);
    } catch {
      result.kept.push(dir);
    }
  }

  return result;
}
