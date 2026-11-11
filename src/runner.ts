/**
 * Job manager: the scheduling layer between the MCP tools and Cursor.
 *
 * Design invariant: `start()` returns as soon as the job is recorded. Nothing
 * in the tool path ever awaits a running task, because a real code task takes
 * minutes while the caller's tool timeout is measured in seconds.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { JobStore } from './store.js';
import { runCursor, type RunOutcome } from './cursor/cli.js';
import { assertWorkspaceAllowed } from './util/paths.js';
import { reclaimOrphan } from './util/processes.js';
import {
  createWorktree,
  captureDiff,
  changedFiles,
  currentHead,
  diffStat,
  removeWorktree,
  applyPatch,
  type Worktree,
} from './util/git.js';
import { concurrency, badArgument, isolationFailed } from './errors.js';
import { claimInstanceDir, currentInstanceId, worktreeRoot } from './util/instance.js';
import type { Config } from './config.js';
import type { Job, JobStatus, JobView, StartJobOptions, Tier } from './types.js';
import type { Logger } from './logger.js';
import { buildArtifacts } from './artifacts.js';
// Re-exported so the public surface (and existing importers) still resolve
// `buildArtifacts` from the runner module after the extraction into artifacts.ts.
export { buildArtifacts } from './artifacts.js';

/**
 * Metrics tracked by the job manager.
 */
export interface Metrics {
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  orphanedOnBoot: number;
  rejected: number;
  byTier: Record<string, number>;
  /**
   * Sum of wall-clock durations for finished jobs. This is a runtime counter
   * kept in memory; after months of continuous operation it may lose integer
   * precision. External monitoring should poll `/stats` periodically and, if
   * exact long-term accounting is required, restart the bridge after scraping.
   */
  totalDurationMs: number;
  maxDurationMs: number;
  /** Current in-flight count, for health checks. */
  active: number;
}

export class JobManager {
  readonly store: JobStore;
  /** Per-instance worktree container, so concurrent bridges sharing a stateDir never collide. */
  readonly worktreeDir: string;
  private cfg: Config;
  private log: Logger;
  private inflight = new Map<string, AbortController>();
  private healthCache?: { at: number; data: Record<string, unknown> };
  private metrics: Metrics = {
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    timedOut: 0,
    orphanedOnBoot: 0,
    rejected: 0,
    byTier: {},
    totalDurationMs: 0,
    maxDurationMs: 0,
    active: 0,
  };

  constructor(cfg: Config, log: Logger) {
    this.cfg = cfg;
    this.log = log.child('jobs');
    this.worktreeDir = this.resolveWorktreeDir();
    this.store = new JobStore(
      cfg.stateDir,
      {
        maxJobs: cfg.maxJobs,
        maxEventsPerJob: cfg.maxEventsPerJob,
        maxEventBytes: cfg.maxEventBytes,
      },
      this.log.child('store'),
      cfg.eventLogDir,
      currentInstanceId(),
    );
    const { orphaned } = this.store.load();
    this.startTtlSweeper();
    this.metrics.orphanedOnBoot = orphaned.length;
    if (orphaned.length > 0) {
      this.log.warn('marked orphaned jobs from previous run', {
        count: orphaned.length,
        ids: orphaned.slice(0, 5),
      });
      /**
       * Reclaim the workers those jobs left behind. Marking a job "orphaned"
       * only fixed the bookkeeping: the agent itself kept running, kept writing
       * to a worktree nobody would ever collect, and nobody had its pid because
       * it was never recorded. `reclaimOrphan` verifies /proc/<pid>/cmdline
       * first, so a recycled pid belonging to someone else is never signalled.
       */
      for (const id of orphaned) {
        const job = this.store.get(id);
        if (!job?.pid) continue;
        const childPid = job.pid;
        void reclaimOrphan(childPid, cfg.cursorBin)
          .then((outcome) => {
            this.log.info('orphaned worker reclaim attempted', {
              jobId: id,
              pid: childPid,
              ok: outcome.ok,
              detail: outcome.detail,
            });
            if (outcome.ok) {
              job.pid = undefined;
              this.store.touch();
            }
          })
          .catch((err) => this.log.warn('orphaned worker reclaim failed', { jobId: id, err: String(err) }));
      }
    }
  }

  /**
   * Claim this instance's worktree container. Falls back to the legacy shared
   * directory (with a warning) when the state directory is not writable:
   * degrading isolation beats refusing to boot, and in that case worktrees
   * cannot be created anyway.
   */
  private resolveWorktreeDir(): string {
    try {
      return claimInstanceDir(this.cfg.stateDir);
    } catch (err) {
      const fallback = worktreeRoot(this.cfg.stateDir);
      this.log.warn('could not claim per-instance worktree directory; using shared layout', {
        dir: fallback,
        err: String((err as Error)?.message ?? err),
      });
      return fallback;
    }
  }

  get activeCount(): number {
    return this.inflight.size;
  }

  /** Where patches and reports are written for post-hoc inspection. */
  artifactsDir(jobId: string): string {
    return path.join(this.cfg.stateDir, 'artifacts', jobId);
  }

  getMetrics(): Metrics {
    return {
      ...this.metrics,
      byTier: { ...this.metrics.byTier },
      active: this.inflight.size,
    };
  }

  /** Snapshot for a caller, optionally with only events after `since`. */
  view(job: Job, since = 0): JobView {
    return {
      jobId: job.id,
      status: job.status,
      tier: job.tier,
      workspace: job.workspace,
      threadId: job.threadId,
      parentJobId: job.parentJobId,
      exitCode: job.exitCode,
      durationMs: job.durationMs,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      result: job.result,
      truncated: job.truncated,
      isolation: job.isolation,
      changedFiles: job.changedFiles,
      diffStat: job.diffStat,
      patchFile: job.patchFile,
      artifacts: buildArtifacts(job),
      pendingInput: job.pendingInput,
      droppedEvents: job.droppedEvents ?? 0,
      events: this.store.eventsSince(job, since),
      cursor: job.cursor,
      next: job.status === 'running'
        ? `poll cursor_status with jobId=${job.id} and since=${job.cursor}`
        : job.status === 'input-required'
          ? `reply with cursor_reply jobId=${job.id} to resume the same task`
          : undefined,
    };
  }

  start(opts: StartJobOptions): Job {
    /**
     * Two different ceilings. `maxConcurrency` bounds work happening *now*;
     * `maxLiveJobs` bounds tasks that still hold state (running + paused). The
     * latter used to be unbounded: eight paused tasks with `maxJobs = 5` stayed
     * resident forever, each with its own artefact directory and event log.
     */
    const liveLimit = Math.min(this.cfg.maxLiveJobs, this.cfg.maxJobs);
    if (this.store.liveCount() >= liveLimit) {
      this.metrics.rejected += 1;
      throw concurrency(
        `live job limit reached: ${this.store.liveCount()}/${liveLimit} tasks are still ` +
          'running or awaiting input; cancel or finish some before starting new work',
      );
    }
    if (this.inflight.size >= this.cfg.maxConcurrency) {
      this.metrics.rejected += 1;
      throw concurrency(
        `concurrency limit reached: ${this.inflight.size}/${this.cfg.maxConcurrency} running jobs; retry later or raise CURSOR_BRIDGE_MAX_CONCURRENCY`,
      );
    }
    if (!opts.prompt || !opts.prompt.trim()) {
      throw badArgument('prompt must not be empty');
    }

    const workspace = assertWorkspaceAllowed(
      opts.workspace,
      this.cfg.workspaceRoots,
    );

    const timeoutSec = Math.min(
      Math.max(opts.timeoutSec ?? this.cfg.defaultTimeoutSec, 10),
      this.cfg.maxTimeoutSec,
    );

    const job: Job = {
      id: randomUUID(),
      tier: opts.tier,
      model: opts.model ?? this.cfg.defaultModel,
      workspace,
      prompt: opts.prompt,
      status: 'running',
      createdAt: new Date().toISOString(),
      threadId: opts.resumeThreadId,
      parentJobId: opts.parentJobId,
      events: [],
      cursor: 0,
      // Isolation intent is decided synchronously so the very first response
      // already tells the caller how the work is contained. execute() may only
      // downgrade it to cursor-worktree if git turns out to be unavailable.
      isolation:
        this.cfg.forceWorktree || opts.tier === 'execute'
          ? 'bridge-worktree'
          : 'none',
    };

    this.store.create(job);
    this.metrics.started += 1;
    this.metrics.byTier[opts.tier] = (this.metrics.byTier[opts.tier] ?? 0) + 1;

    const controller = new AbortController();
    this.inflight.set(job.id, controller);

    // Fire and forget: the promise is tracked so shutdown can await it.
    void this.execute(job, controller, timeoutSec).catch((err) => {
      this.log.error('job crashed', { jobId: job.id, err: String(err) });
      this.finalise(job, 'failed', {
        exitCode: -1,
        result: String(err),
        durationMs: Date.now() - Date.parse(job.createdAt),
      });
    });

    this.log.info('job started', {
      jobId: job.id,
      tier: job.tier,
      workspace,
      timeoutSec,
    });
    return job;
  }

  private async execute(
    job: Job,
    controller: AbortController,
    timeoutSec: number,
    /**
     * When resuming an `input-required` task, this is the caller's reply — the
     * instruction the worker actually runs this pass. Omitted on a fresh start,
     * where `job.prompt` is authoritative. The original prompt is preserved on
     * `job.prompt` so the task history keeps the first turn intact.
     */
    promptOverride?: string,
  ): Promise<void> {
    // --- isolation decision -------------------------------------------------
    // execute jobs must never touch the caller's checkout. The bridge creates
    // the worktree itself so it can snapshot the diff before cleaning up.
    const needIsolation = this.cfg.forceWorktree || job.tier === 'execute';
    let worktree: Worktree | null = null;
    /** Where inside the worktree the worker should run (subdir-aware). */
    let isolatedWorkspace: string | undefined;
    if (needIsolation) {
      try {
        /**
         * Unique per attempt, not per job. A paused task is resumed while the
         * previous pass may still be tearing its worktree down; a name derived
         * only from the job id collided, `git worktree add` failed, and the
         * bridge silently fell back to running `--force` in the caller's
         * checkout. A time+random suffix makes every attempt a new directory.
         */
        const name = `wb-${job.id.slice(0, 8)}-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
        const wt = await createWorktree(job.workspace, name, this.worktreeDir);
        if (!wt) {
          throw isolationFailed(
            `workspace ${job.workspace} is not a git repository; an execute task cannot be ` +
              `isolated in a worktree and will not be run in the caller's checkout`,
          );
        }
        /**
         * The caller may have picked a sub-directory of the repo. Running the
         * agent at the worktree ROOT would give it the whole repository, which
         * defeats a whitelist that names one directory. Map the same relative
         * path inside the worktree and refuse anything that escapes it.
         */
        const rel = path.relative(wt.repo, job.workspace);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          throw isolationFailed(`workspace ${job.workspace} is outside its repository root`);
        }
        isolatedWorkspace = rel ? path.join(wt.path, rel) : wt.path;
        fs.mkdirSync(isolatedWorkspace, { recursive: true });
        worktree = wt;
        job.isolation = 'bridge-worktree';
      } catch (err) {
        /**
         * Fail closed. The old behaviour - warn and hand `--force` to Cursor at
         * the caller's directory - turned every isolation problem into an
         * uncontained write with no patch and no rollback. Refusing the task is
         * the only honest outcome: the caller can then decide to commit their
         * work, or ask for `tier: "consult"` which needs no isolation.
         */
        job.isolation = 'none';
        this.log.error('isolation could not be established; refusing the task', {
          jobId: job.id,
          err: String(err),
        });
        this.finalise(job, 'failed', {
          exitCode: -1,
          result:
            'isolation required for an execute task could not be established, so the task was ' +
            `refused rather than run in the caller's checkout: ${(err as Error).message}`,
          durationMs: Date.now() - Date.parse(job.createdAt),
        });
        this.store.appendEvent(job, {
          ts: new Date().toISOString(),
          type: 'note',
          text: 'task refused: no worktree isolation available',
        });
        await this.store.flushNow();
        return;
      }
    } else {
      job.isolation = 'none';
    }

    // --- resume continuity ---------------------------------------------------
    // A paused task's worktree was removed when the previous pass ended, so this
    // pass starts from a clean HEAD. Re-apply the patch captured before the
    // pause; otherwise the files the worker already wrote vanish and the resumed
    // thread talks about a tree that no longer exists.
    //
    // Fail closed: if the saved work cannot be restored (the base moved, the
    // patch was pruned), drop back to `input-required` with an explicit event
    // instead of running the worker on a tree missing its own earlier output.
    if (worktree && job.patchFile) {
      const restored = await applyPatch(worktree.path, job.patchFile);
      if (!restored.ok) {
        this.log.error('failed to restore paused worktree changes', {
          jobId: job.id,
          patchFile: job.patchFile,
          reason: restored.reason,
        });
        job.status = 'input-required';
        job.inputRequiredAt = job.inputRequiredAt ?? new Date().toISOString();
        this.inflight.delete(job.id);
        this.store.appendEvent(job, {
          ts: new Date().toISOString(),
          type: 'note',
          text:
            'resume blocked: the changes saved before the pause could not be restored ' +
            `(${restored.reason}); the task is still input-required and the saved patch is intact`,
        });
        this.store.touch();
        await this.store.flushNow();
        return;
      }
      this.store.appendEvent(job, {
        ts: new Date().toISOString(),
        type: 'note',
        text: `restored ${job.changedFiles?.length ?? 0} changed file(s) saved before the pause`,
      });
    }

    // From here on the task is genuinely executing: the open question no longer
    // describes its state. Cleared late so a failed restore can keep it.
    job.pendingInput = undefined;
    job.inputRequiredAt = undefined;

    const runWorkspace = isolatedWorkspace ?? job.workspace;

    // The whole run — including the worktree-dependent artefact capture — lives
    // inside one try, and the worktree is torn down in the `finally`. This is
    // the deliberate fix for the resource leak where a `runCursor` rejection
    // (e.g. the agent binary blowing up) skipped the capture block entirely and
    // left the git worktree on disk forever.
    try {
      const outcome = await runCursor(
        this.cfg,
        {
          prompt: promptOverride ?? job.prompt,
          workspace: runWorkspace,
          tier: job.tier,
          model: job.model,
          timeoutSec,
          worktree: needIsolation,
          managedWorktree: worktree?.path,
          resumeThreadId: job.threadId,
        },
        {
          onEvent: (ev) => {
            if (ev.type === 'note' && ev.text?.startsWith('kill failed')) {
              this.log.warn('failed to kill Cursor process tree', {
                jobId: job.id,
                detail: ev.detail,
              });
            }
            this.store.appendEvent(job, { ts: new Date().toISOString(), ...ev });
            this.store.touch();
          },
          onThreadId: (id) => {
            job.threadId = id;
            this.store.touch();
          },
          onSpawn: (childPid) => {
            job.pid = childPid;
            // Persist immediately: the window we care about is a crash in the
            // next few seconds, before any timer would fire.
            this.store.persist();
          },
        },
        controller.signal,
      );

      // --- artefact capture, before the worktree is removed ------------------
      if (worktree) {
        try {
          // Anchor every artefact to the commit the worktree was created from,
          // so work the agent COMMITTED itself is part of the deliverables.
          const base = worktree.head;
          job.changedFiles = await changedFiles(worktree.path, base);
          job.diffStat = await diffStat(worktree.path, base);
          const patch = await captureDiff(
            worktree.path,
            path.join(this.artifactsDir(job.id), 'changes.patch'),
            base,
          );
          if (patch) {
            job.patchFile = patch.file;
            this.store.appendEvent(job, {
              ts: new Date().toISOString(),
              type: 'note',
              text: `patch captured (${patch.bytes} bytes)`,
            });
          }
          if (worktree.head !== (await currentHead(worktree.path))) {
            // Useful signal for the caller: a commit was made, and the patch
            // above is what carries it out of the worktree.
            this.store.appendEvent(job, {
              ts: new Date().toISOString(),
              type: 'note',
              text: 'the worker committed inside its worktree; the patch includes those commits',
            });
          }
          /**
           * The report is written from the RUN's result, not from `job.result`:
           * at this point `finalise()` has not run yet, so `job.result` is still
           * undefined and every fresh task ended up with no report at all.
           */
          if (outcome.result) {
            const report = path.join(this.artifactsDir(job.id), 'report.md');
            fs.mkdirSync(path.dirname(report), { recursive: true });
            fs.writeFileSync(report, outcome.result, 'utf8');
            job.reportFile = report;
          }
        } catch (err) {
          this.log.warn('artefact capture failed', { jobId: job.id, err: String(err) });
        }
      }

      // --- terminal / interrupt state ---------------------------------------
      // cancel() may already have settled the job while this run was still
      // winding down. Never overwrite that decision; only fill in the result.
      if (job.status !== 'running') {
        if (!job.result && outcome.result) job.result = outcome.result;
        job.durationMs = outcome.durationMs;
        this.inflight.delete(job.id);
        this.store.touch();
        return;
      }

      // A2A input-required: pause THIS task and await caller input instead of
      // treating the run as completed. The same task id is resumed later by
      // reply(), preserving continuity (the A2A contract) rather than spawning
      // a follow-up job.
      if (outcome.needInput !== undefined) {
        this.pauseForInput(job, outcome);
        return;
      }

      if (outcome.exitCode === 124) {
        this.finalise(job, 'timeout', outcome);
      } else if (outcome.exitCode === 0) {
        this.finalise(job, 'completed', outcome);
      } else {
        this.finalise(job, 'failed', outcome);
      }
    } finally {
      // Always remove the worktree, even when runCursor rejected and the run
      // body above was skipped. removeWorktree() never throws, so this is safe.
      if (worktree) {
        await removeWorktree(worktree);
      }
    }
  }

  /**
   * Pause a running job into the A2A `input-required` state.
   *
   * The worker's partial answer is kept as `result` (context for the eventual
   * reply), the open question is recorded on `pendingInput`, and the job is
   * removed from the in-flight set because no process is running. A later
   * reply() on this same job id resumes it.
   */
  private pauseForInput(job: Job, outcome: RunOutcome): void {
    job.status = 'input-required';
    job.pendingInput = outcome.needInput;
    job.inputRequiredAt = new Date().toISOString();
    if (outcome.result) job.result = outcome.result;
    if (outcome.threadId) job.threadId = outcome.threadId;
    // A paused task must not silently drop the truncation flag: a caller that
    // sees a short result has to know it was capped rather than complete.
    job.truncated = job.truncated || outcome.truncated || false;
    job.durationMs = outcome.durationMs;
    this.inflight.delete(job.id);
    this.store.appendEvent(job, {
      ts: new Date().toISOString(),
      type: 'note',
      text: `input-required: ${outcome.needInput}`,
    });
    this.store.evictNow();
    this.store.touch();
    void this.store.flushNow();
    this.log.info('job paused for input', { jobId: job.id, pendingInput: outcome.needInput });
  }

  /**
   * Resume an `input-required` task in place: the SAME job id re-enters
   * `running` and re-runs the worker on the preserved thread, carrying the
   * caller's reply forward. This is the faithful A2A mapping of
   * input-required -> working -> completed on one task id.
   */
  private resumeFromInput(job: Job, prompt: string, tier?: Tier): Job {
    // CAS guard: only a task genuinely paused in input-required may be resumed.
    // A concurrent reply or a cancel() that landed first will have changed the
    // status, and we must not resurrect a cancelled/terminal task.
    if (job.status !== 'input-required') {
      throw badArgument(
        `task ${job.id} is in state '${job.status}', not 'input-required'; cannot resume`,
      );
    }
    // The tier is fixed when the task is created. Silently accepting a different
    // tier here would let a caller believe it downgraded (or upgraded) a task
    // that keeps running under its original permissions.
    if (tier && tier !== job.tier) {
      throw badArgument(
        `task ${job.id} was created with tier '${job.tier}'; an input-required resume cannot ` +
          `change it to '${tier}' - start a new task instead`,
      );
    }
    /**
     * Resuming is another way to start work, so it must pay the same admission
     * fee as start(). It used to bypass the check entirely: with
     * `maxConcurrency = 1` a caller could pause A, start B, then reply to A and
     * end up with `active = 2`. The check runs before any mutation, so a
     * rejected reply leaves the task exactly where it was: input-required.
     */
    if (this.inflight.size >= this.cfg.maxConcurrency) {
      this.metrics.rejected += 1;
      throw concurrency(
        `concurrency limit reached: ${this.inflight.size}/${this.cfg.maxConcurrency} running jobs; ` +
          `task ${job.id} stays input-required, retry later`,
      );
    }
    job.status = 'running';
    // Keep `pendingInput` until execute() actually gets past the worktree
    // restore: if that restore fails the task drops back to input-required and
    // the caller must still see the original question.
    this.store.appendEvent(job, {
      ts: new Date().toISOString(),
      type: 'input',
      text: prompt,
    });
    this.store.touch();

    const timeoutSec = Math.min(
      Math.max(this.cfg.defaultTimeoutSec, 10),
      this.cfg.maxTimeoutSec,
    );
    const controller = new AbortController();
    this.inflight.set(job.id, controller);

    void this.execute(job, controller, timeoutSec, prompt).catch((err) => {
      this.log.error('resumed job crashed', { jobId: job.id, err: String(err) });
      this.finalise(job, 'failed', {
        exitCode: -1,
        result: String(err),
        durationMs: Date.now() - Date.parse(job.createdAt),
      });
    });

    this.log.info('job resumed from input-required', { jobId: job.id, tier: tier ?? job.tier });
    return job;
  }

  private finalise(
    job: Job,
    status: JobStatus,
    outcome: { exitCode: number; result: string; truncated?: boolean; threadId?: string; durationMs: number },
  ): void {
    if (job.status !== 'running' && status !== 'cancelled') {
      // Already finalised by cancel(); only cancel may overwrite.
      this.inflight.delete(job.id);
      return;
    }
    job.status = status;
    job.finishedAt = new Date().toISOString();
    job.exitCode = outcome.exitCode;
    job.result = outcome.result;
    job.durationMs = outcome.durationMs;
    job.truncated = job.truncated || outcome.truncated || false;
    if (outcome.threadId) job.threadId = outcome.threadId;

    this.inflight.delete(job.id);
    this.metrics.totalDurationMs += outcome.durationMs;
    this.metrics.maxDurationMs = Math.max(
      this.metrics.maxDurationMs,
      outcome.durationMs,
    );
    if (status === 'completed') this.metrics.completed += 1;
    else if (status === 'failed') this.metrics.failed += 1;
    else if (status === 'cancelled') this.metrics.cancelled += 1;
    else if (status === 'timeout') this.metrics.timedOut += 1;

    // A finished job can push the store over `maxJobs`; eviction is what
    // deletes its artefacts and event log, so it has to run on this edge and
    // not only when a NEW job is created.
    this.store.evictNow();
    this.store.appendEvent(job, {
      ts: new Date().toISOString(),
      type: 'end',
      text: `status=${status} exit=${outcome.exitCode} durationMs=${outcome.durationMs}`,
    });
    this.store.touch();
    void this.store.flushNow();

    this.log.info('job finished', {
      jobId: job.id,
      status,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
    });
  }

  cancel(jobId: string): Job {
    const job = this.store.require(jobId);
    // A running task and an input-required (paused, awaiting caller input) task
    // are both cancelable. A terminal task is not.
    if (job.status !== 'running' && job.status !== 'input-required') return job;
    // Mark synchronously so the very next poll already reports cancelled,
    // rather than racing the kill. execute() completes the bookkeeping later.
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    this.store.appendEvent(job, {
      ts: new Date().toISOString(),
      type: 'end',
      text: 'cancelled by caller',
    });
    this.store.touch();
    void this.store.flushNow();

    const controller = this.inflight.get(jobId);
    if (controller) {
      // A live worker is running: request an abort; finalise() will record the
      // cancellation once the process winds down. Count it now so metrics stay
      // accurate even if the bookkeeping settles asynchronously.
      controller.abort();
      this.metrics.cancelled += 1;
    } else {
      // No controller: an input-required (paused) task being cancelled. It is
      // already out of the in-flight set, so record the outcome directly.
      this.inflight.delete(jobId);
      this.metrics.cancelled += 1;
    }
    this.log.info('job cancelled', { jobId });
    return job;
  }

  /**
   * Send input to a job.
   *
   * - An `input-required` task is resumed IN PLACE (same job id, same thread):
   *   the A2A interrupt round-trip, where input-required -> working -> completed
   *   all happen on one task id.
   * - Any other settled task keeps the original behaviour of spawning a child
   *   follow-up job that resumes the Cursor thread, preserving backward
   *   compatibility.
   */
  reply(jobId: string, prompt: string, tier?: Tier): Job {
    const parent = this.store.require(jobId);
    if (parent.status === 'running') {
      throw badArgument(`job ${jobId} is still running; cancel it before replying`);
    }
    if (parent.status === 'input-required') {
      return this.resumeFromInput(parent, prompt, tier);
    }
    return this.start({
      prompt,
      workspace: parent.workspace,
      tier: tier ?? parent.tier,
      resumeThreadId: parent.threadId,
      parentJobId: parent.id,
    });
  }

  /**
   * Expire tasks that have been waiting for caller input past the configured
   * TTL, releasing their state and their artefact directory.
   *
   * Without this, `input-required` is a one-way door: the caller may never
   * answer, and the task (plus its patch) sits in the store and on disk forever.
   */
  private startTtlSweeper(): void {
    const configured = this.cfg.inputRequiredTtlSec;
    // Never degrade to "expire everything": a missing/invalid value means the
    // sweeper is simply not armed.
    const ttlMs = Number.isFinite(configured) && configured > 0 ? configured * 1000 : 0;
    if (ttlMs === 0) return;
    const tick = Math.min(60_000, Math.max(5_000, Math.floor(ttlMs / 4)));
    const timer = setInterval(() => {
      const now = Date.now();
      for (const job of this.store.list({ limit: 10_000 })) {
        if (job.status !== 'input-required' || !job.inputRequiredAt) continue;
        const pausedFor = now - Date.parse(job.inputRequiredAt);
        if (!Number.isFinite(pausedFor) || pausedFor < ttlMs) continue;
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
        job.pendingInput = undefined;
        this.store.appendEvent(job, {
          ts: new Date().toISOString(),
          type: 'end',
          text: `input-required expired after ${Math.round(pausedFor / 1000)}s`,
        });
        this.store.discardFiles(job.id);
        this.log.info('expired input-required task', { jobId: job.id, pausedFor });
      }
      this.store.touch();
    }, tick);
    timer.unref?.();
  }

  /** Cancel everything in flight; used on shutdown. */
  async shutdown(graceMs = 8000): Promise<void> {
    /**
     * Never trust the caller's grace. `0` used to exit before the kill signal
     * had landed (the agent survived the bridge), and `Infinity` made the wait
     * loop below spin forever, so `flushNow()` and `process.exit` were never
     * reached. Clamp into a range where "cancel then persist" can actually
     * complete.
     */
    /**
     * Lower bound is 3s, not 0: `cancel` only *requests* an abort, and the run
     * settles ~2s later (drain window + kill). Exiting at 100ms left the agent
     * alive - the caller believed the bridge had stopped the work it abandoned.
     * `cancel` on a paused task is instant, so this bound only affects running
     * work, which is exactly the case that must not be abandoned.
     */
    const grace = Number.isFinite(graceMs) ? Math.min(Math.max(graceMs, 3000), 60_000) : 8000;
    const ids = [...this.inflight.keys()];
    if (ids.length === 0) {
      await this.store.flushNow();
      return;
    }
    this.log.info('cancelling in-flight jobs on shutdown', { count: ids.length, graceMs: grace });
    for (const id of ids) {
      try {
        this.cancel(id);
      } catch {
        /* ignore */
      }
    }
    const deadline = Date.now() + grace;
    while (this.inflight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.inflight.size > 0) {
      this.log.warn('shutdown grace expired with jobs still in flight', {
        remaining: this.inflight.size,
      });
    }
    await this.store.flushNow();
  }

  /**
   * Preflight diagnostics, surfaced by the bridge_health tool.
   *
   * The check is cached for 5 seconds to avoid repeated fs.existsSync/accessSync
   * calls when a monitoring probe or the model polls aggressively.
   */
  health(): Record<string, unknown> {
    const now = Date.now();
    if (this.healthCache && now - this.healthCache.at < 5000) {
      return { ...this.healthCache.data, cached: true };
    }

    const bin = this.cfg.cursorBin;
    let binFound = false;
    try {
      binFound = fs.existsSync(bin);
    } catch {
      binFound = false;
    }
    const issues: string[] = [];
    if (!binFound) {
      issues.push(
        `cursor binary not found at "${bin}"; set CURSOR_BIN to the full path of agent.exe`,
      );
    }
    if (this.cfg.workspaceRoots.length === 0) {
      issues.push('no workspace roots configured; set CURSOR_BRIDGE_WORKSPACE_ROOTS');
    }
    const missing = this.cfg.workspaceRoots.filter(
      (r) => !fs.existsSync(r),
    );
    if (missing.length > 0) {
      issues.push(`workspace roots do not exist: ${missing.join('; ')}`);
    }
    let stateDirWritable = false;
    try {
      fs.mkdirSync(this.cfg.stateDir, { recursive: true });
      fs.accessSync(this.cfg.stateDir, fs.constants.W_OK);
      stateDirWritable = true;
    } catch {
      issues.push(`state directory is not writable: ${this.cfg.stateDir}`);
    }
    const data = {
      ok: issues.length === 0,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cursorBin: bin,
      cursorBinFound: binFound,
      workspaceRoots: this.cfg.workspaceRoots,
      stateDir: this.cfg.stateDir,
      activeJobs: this.inflight.size,
      maxConcurrency: this.cfg.maxConcurrency,
      defaultTimeoutSec: this.cfg.defaultTimeoutSec,
      worktreeByDefault: this.cfg.forceWorktree,
      metrics: this.getMetrics(),
      issues,
      stateDirWritable,
      cached: false,
    };
    this.healthCache = { at: now, data };
    return data;
  }
}

