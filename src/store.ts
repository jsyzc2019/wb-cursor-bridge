/**
 * Job store with durable, restart-safe state.
 *
 * Responsibilities:
 *  - hold active and finished jobs
 *  - cap memory with an LRU eviction policy
 *  - survive a bridge crash: every mutation is mirrored into `index.json`, so a
 *    restart can mark jobs that were "running" as orphaned instead of leaking
 *    phantom work
 *
 * Events are kept in memory for fast tail-polling; the full event log lives on
 * disk as JSONL and is not re-read on boot (that would be unbounded I/O).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Job, JobEvent, JobStatus } from './types.js';
import { notFound } from './errors.js';
import type { Logger } from './logger.js';

export interface StoreLimits {
  maxJobs: number;
  maxEventsPerJob: number;
}

/**
 * Order by createdAt, newest first.
 *
 * Timestamps are ISO-8601, so they sort correctly as plain strings. Using
 * localeCompare here would make eviction and listing order depend on the
 * machine locale, which is exactly the kind of nondeterminism that makes a bug
 * unreproducible.
 */
function newestFirst(a: Job, b: Job): number {
  if (a.createdAt > b.createdAt) return -1;
  if (a.createdAt < b.createdAt) return 1;
  return 0;
}

function oldestFirst(a: Job, b: Job): number {
  return -newestFirst(a, b);
}

/**
 * A job is "live" (must not be evicted) while it is running or paused in the
 * A2A `input-required` state. The latter is NOT a finished task: it is a task
 * suspended awaiting caller input and is legally resumable. Evicting it would
 * break the input-required -> same-task-id resume contract, so both states are
 * protected from LRU reclamation.
 */
export function isLive(s: JobStatus): boolean {
  return s === 'running' || s === 'input-required';
}

interface PersistedIndex {
  version: 1;
  updatedAt: string;
  jobs: Array<
    Pick<
      Job,
      | 'id'
      | 'tier'
      | 'workspace'
      | 'prompt'
      | 'status'
      | 'createdAt'
      | 'finishedAt'
      | 'threadId'
      | 'contextId'
      | 'metadata'
      | 'parentJobId'
      | 'exitCode'
      | 'durationMs'
      | 'truncated'
      | 'pendingInput'
    >
  >;
}

export class JobStore {
  private jobs = new Map<string, Job>();
  private limits: StoreLimits;
  private indexFile: string;
  private flushTimer?: NodeJS.Timeout;
  private dirty = false;
  private log?: Logger;
  private persistFailures = 0;
  private eventLogDir?: string;
  /** Buffered JSONL lines waiting for the next async flush. */
  private pendingEvents = new Map<string, string[]>();
  /** In-flight flush promises, so flushNow() can await durability. */
  private flushing = new Set<Promise<void>>();
  private flushScheduled = false;

  constructor(
    stateDir: string,
    limits: StoreLimits,
    log?: Logger,
    eventLogDir?: string,
  ) {
    this.limits = limits;
    this.indexFile = path.join(stateDir, 'index.json');
    this.log = log;
    this.eventLogDir = eventLogDir;
    try {
      fs.mkdirSync(stateDir, { recursive: true });
    } catch (err) {
      this.persistFailures += 1;
      this.log?.error('state directory creation failed', {
        stateDir,
        attempt: this.persistFailures,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Reconcile persisted state with reality on startup. */
  load(): { orphaned: string[] } {
    let parsed: PersistedIndex;
    try {
      parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as PersistedIndex;
    } catch {
      return { orphaned: [] };
    }
    const orphaned: string[] = [];
    for (const meta of parsed.jobs ?? []) {
      const status: JobStatus =
        meta.status === 'running' ? 'orphaned' : meta.status;
      if (meta.status === 'running') orphaned.push(meta.id);
      this.jobs.set(meta.id, {
        ...meta,
        status,
        events: [],
        cursor: 0,
        result: undefined,
      });
    }
    // Note: `input-required` is a valid paused state (not a phantom running
    // process), so it is preserved across a restart rather than orphaned.
    if (orphaned.length > 0) this.persist();
    return { orphaned };
  }

  create(job: Job): Job {
    this.jobs.set(job.id, job);
    this.evict();
    // Persist immediately: if the process is hard-killed seconds from now, the
    // job must still be discoverable on the next boot and marked orphaned.
    this.persist();
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  require(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw notFound(`unknown job ${id}`);
    return job;
  }

  list(filter?: { status?: JobStatus; limit?: number }): Job[] {
    let all = [...this.jobs.values()];
    if (filter?.status) all = all.filter((j) => j.status === filter.status);
    all.sort(newestFirst);
    return all.slice(0, filter?.limit ?? 20);
  }

  appendEvent(job: Job, ev: Omit<JobEvent, 'seq'>): void {
    job.cursor += 1;
    const full: JobEvent = { ...ev, seq: job.cursor };
    job.events.push(full);
    if (job.events.length > this.limits.maxEventsPerJob) {
      const drop = job.events.length - this.limits.maxEventsPerJob;
      job.events.splice(0, drop);
      job.droppedEvents = (job.droppedEvents ?? 0) + drop;
    }
    if (this.eventLogDir) {
      const lines = this.pendingEvents.get(job.id);
      const line = JSON.stringify(full) + '\n';
      if (lines) {
        lines.push(line);
      } else {
        this.pendingEvents.set(job.id, [line]);
      }
      this.scheduleEventFlush();
    }
  }

  private scheduleEventFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => this.flushEvents());
  }

  private flushEvents(): void {
    this.flushScheduled = false;
    if (this.pendingEvents.size === 0) return;
    const batch = this.pendingEvents;
    this.pendingEvents = new Map();

    const promise = (async () => {
      for (const [jobId, lines] of batch) {
        try {
          const dir = path.join(this.eventLogDir!, jobId);
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, 'events.jsonl');
          await fs.promises.appendFile(file, lines.join(''), 'utf8');
        } catch (err) {
          this.log?.error('event persist failed', {
            jobId,
            lines: lines.length,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    this.flushing.add(promise);
    promise.catch(() => {}).finally(() => this.flushing.delete(promise));
  }

  /**
   * Events strictly after the given absolute sequence number.
   * A caller that already saw seq N receives N+1 onward, including across a
   * trim, so no event is ever delivered twice or skipped.
   */
  eventsSince(job: Job, since: number): JobEvent[] {
    if (!since || since < 0) return job.events;
    return job.events.filter((e) => e.seq > since);
  }

  /** Persisted index is the durable record; writes are batched. */
  touch(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.dirty) this.persist();
    }, 500);
    this.flushTimer.unref?.();
  }

  persist(): void {
    const payload: PersistedIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      jobs: [...this.jobs.values()].map((j) => ({
        id: j.id,
        tier: j.tier,
        workspace: j.workspace,
        prompt: j.prompt,
        status: j.status,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
        threadId: j.threadId,
        contextId: j.contextId,
        metadata: j.metadata,
        parentJobId: j.parentJobId,
        exitCode: j.exitCode,
        durationMs: j.durationMs,
        truncated: j.truncated,
        pendingInput: j.pendingInput,
      })),
    };
    try {
      // Atomic write: a crash mid-write must not corrupt the index.
      const tmp = this.indexFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, this.indexFile);
      this.dirty = false;
      this.persistFailures = 0;
    } catch (err) {
      this.persistFailures += 1;
      this.log?.error('index persist failed', {
        file: this.indexFile,
        attempt: this.persistFailures,
        err: err instanceof Error ? err.message : String(err),
      });
      /* the next touch will retry */
    }
  }

  /** Number of consecutive index persist failures since the last success. */
  getPersistFailures(): number {
    return this.persistFailures;
  }

  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flushEvents();
    if (this.flushing.size > 0) {
      await Promise.all([...this.flushing]);
    }
    if (this.dirty) this.persist();
  }

  /** Exposed for tests that need to ensure all async writes are durable. */
  async waitForEventFlush(): Promise<void> {
    this.flushEvents();
    if (this.flushing.size > 0) {
      await Promise.all([...this.flushing]);
    }
  }

  /** Evict oldest *finished* jobs once the cap is exceeded. */
  private evict(): void {
    if (this.jobs.size <= this.limits.maxJobs) return;
    const finished = [...this.jobs.values()]
      .filter((j) => !isLive(j.status))
      .sort(oldestFirst);
    while (this.jobs.size > this.limits.maxJobs && finished.length > 0) {
      const victim = finished.shift()!;
      this.jobs.delete(victim.id);
    }
  }
}