/**
 * Shared type contracts for the bridge.
 *
 * Kept in one place so the process runner, the job store and the MCP tool
 * layer all agree on the exact same shapes.
 */

/** Permission tier. The caller picks a tier and never passes CLI flags. */
export type Tier = 'consult' | 'plan' | 'execute';

/**
 * Terminal and non-terminal job states.
 *
 * `input-required` is the A2A interrupt state: the task is paused awaiting
 * caller input and is NOT terminal. Replying resumes the SAME task (same id)
 * rather than spawning a follow-up, which is exactly the A2A contract where a
 * Task stays identified by its id across an input-required -> working -> completed
 * round-trip.
 */
export type JobStatus =
  | 'running'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'orphaned';

/** How the job was isolated from the caller's checkout. */
export type Isolation =
  | 'none'
  | 'bridge-worktree'
  | 'cursor-worktree';

export interface JobEvent {
  /**
   * Absolute sequence number within the job. Trimming the in-memory ring does
   * not renumber events, so a caller polling with `since=<last seq it saw>`
   * never silently skips or repeats an event.
   */
  seq: number;
  /** ISO-8601 timestamp. */
  ts: string;
  type: 'start' | 'assistant' | 'tool' | 'result' | 'stderr' | 'end' | 'note' | 'input';
  text?: string;
  detail?: unknown;
}

export interface Job {
  id: string;
  tier: Tier;
  workspace: string;
  prompt: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  /** Cursor model id used for this job. */
  model?: string;
  /** Cursor thread id, used to resume context on follow-ups. */
  threadId?: string;
  /**
   * A2A conversation context id. Groups related tasks into one conversation so
   * an A2A client can track a multi-turn exchange. Falls back to the job id
   * when a non-A2A caller creates the task.
   */
  contextId?: string;
  /** Arbitrary caller-supplied metadata, surfaced on the A2A Task. */
  metadata?: Record<string, unknown>;
  /** Job this one continues, if any. */
  parentJobId?: string;
  exitCode?: number;
  result?: string;
  /** Result was truncated at the configured cap. */
  truncated?: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
  events: JobEvent[];
  /** Monotonic sequence used for incremental polling. */
  cursor: number;
  /** Number of events dropped from the in-memory ring, if any. */
  droppedEvents?: number;
  /** Isolation actually applied to this job. */
  isolation?: Isolation;
  /** Files changed by the job, relative to the repository HEAD. */
  changedFiles?: string[];
  /** Short diffstat line summary. */
  diffStat?: string;
  /** Absolute path of the captured patch, when there is one. */
  patchFile?: string;
  /** Absolute path of the captured report, when one was written. */
  reportFile?: string;
  /**
   * Set when the task is paused in the A2A `input-required` state. Holds the
   * question/request the worker is waiting for input on.
   */
  pendingInput?: string;
  /** ISO-8601 timestamp of when the task entered `input-required`. */
  inputRequiredAt?: string;
}

/**
 * A2A-aligned deliverable. Mirrors A2A v1.0 `Artifact`: a named, addressable
 * unit of output composed of typed `parts`. The bridge keeps its flat fields
 * (changedFiles / diffStat / patchFile / reportFile) for backward compatibility
 * and derives this array from them, so older callers are unaffected while an
 * A2A adapter can consume deliverables as standard `artifacts[]`.
 */
export interface ArtifactPart {
  /** One of the A2A part kinds. */
  kind: 'text' | 'file' | 'data';
  /** Present when kind === 'text'. */
  text?: string;
  /** Present when kind === 'file': a reference to an on-disk file. */
  file?: { name?: string; mimeType?: string; uri?: string; bytes?: number; bytes_inline?: string };
  /** Present when kind === 'data': arbitrary structured payload. */
  data?: unknown;
}

export interface Artifact {
  /** Stable id, unique within a job: `<jobId>-<name>`. */
  artifactId: string;
  name: string;
  parts: ArtifactPart[];
}

export interface StartJobOptions {
  prompt: string;
  workspace: string;
  tier: Tier;
  /** Cursor model id; overrides the bridge default for this job only. */
  model?: string;
  timeoutSec?: number;
  /** Resume an existing Cursor thread id. */
  resumeThreadId?: string;
  parentJobId?: string;
}

/** Result payload handed back to the MCP caller. */
export interface JobView {
  jobId: string;
  status: JobStatus;
  tier: Tier;
  workspace: string;
  threadId?: string;
  /** A2A conversation context id, grouped with sibling tasks. */
  contextId?: string;
  /** Arbitrary caller-supplied metadata, surfaced on the A2A Task. */
  metadata?: Record<string, unknown>;
  parentJobId?: string;
  exitCode?: number;
  durationMs?: number;
  createdAt: string;
  finishedAt?: string;
  result?: string;
  truncated?: boolean;
  isolation?: Isolation;
  changedFiles?: string[];
  diffStat?: string;
  patchFile?: string;
  /** A2A-aligned deliverables, derived from the flat fields above. */
  artifacts?: Artifact[];
  /** The open question when the task is paused in A2A `input-required`. */
  pendingInput?: string;
  droppedEvents?: number;
  events: JobEvent[];
  /** Next `since` value to pass back for incremental polling. */
  cursor: number;
  /** Convenience hint for the caller. */
  next?: string;
}