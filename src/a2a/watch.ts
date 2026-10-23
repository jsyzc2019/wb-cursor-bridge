/**
 * Task observation: the bridge between the JobManager's poll-friendly store and
 * A2A's streaming / push-notification delivery.
 *
 * The core engine does not push events; it records them on the per-job store. So
 * the A2A adapter observes a task by polling the store at a short interval and
 * emitting an event whenever the task's state or event cursor advances. The same
 * loop powers both Server-Sent Events (message/stream, tasks/resubscribe) and
 * push notifications (F6). Polling keeps this module decoupled from the engine
 * and is fully correct: an event is never lost because the terminal state is
 * always re-observed and re-emitted as `final`.
 */
import type { JobManager } from '../runner.js';
import type { Logger } from '../logger.js';
import { toTask, toTaskState } from './convert.js';
import type { TaskEvent, TaskState, PushNotificationConfig } from './types.js';
import type { A2AVersion } from './compat.js';

const POLL_MS = 300;

/** A2A terminal states for which no further event will be delivered. */
export function isFinalState(state: TaskState): boolean {
  return (
    state === 'completed' ||
    state === 'failed' ||
    state === 'canceled' ||
    state === 'rejected' ||
    state === 'auth-required' ||
    state === 'input-required'
  );
}

interface Snapshot {
  task: ReturnType<typeof toTask>;
  state: TaskState;
  cursor: number;
  artifactCount: number;
}

function snapshot(
  mgr: JobManager,
  taskId: string,
  artifactBase?: string,
  a2aVersion?: A2AVersion,
): Snapshot | undefined {
  const job = mgr.store.get(taskId);
  if (!job) return undefined;
  const task = toTask(job, { withHistory: false, artifactBase, a2aVersion });
  return {
    task,
    state: toTaskState(job.status),
    cursor: job.cursor,
    artifactCount: task.artifacts?.length ?? 0,
  };
}

/**
 * Observe a task and yield A2A events as it progresses.
 *
 * Yields a status-update on every observed change (state transition or new
 * recorded event) and an artifact-update the first time artifacts appear. The
 * loop ends after the terminal / input-required event is emitted. An
 * AbortSignal lets the caller tear the stream down early (e.g. client abort).
 */
export async function* subscribeTask(
  mgr: JobManager,
  taskId: string,
  signal?: AbortSignal,
  artifactBase?: string,
  a2aVersion?: A2AVersion,
): AsyncGenerator<TaskEvent> {
  let lastState: TaskState | undefined;
  let lastCursor = -1;
  let lastArtifactCount = 0;
  let emittedArtifactFor: Set<string> = new Set();

  const done = () => signal?.aborted ?? false;

  // Prime with the current state so a resubscribe onto an already-final task
  // still delivers that final event immediately.
  let snap = snapshot(mgr, taskId, artifactBase, a2aVersion);
  if (snap) {
    lastState = snap.state;
    lastCursor = snap.cursor;
    lastArtifactCount = snap.artifactCount;
    yield statusEvent(snap, isFinalState(snap.state));
    for (const a of snap.task.artifacts ?? []) {
      emittedArtifactFor.add(a.artifactId);
      yield artifactEvent(snap, a, false, true);
    }
    if (isFinalState(snap.state)) return;
  }

  while (!done()) {
    await sleep(POLL_MS, signal);
    if (done()) break;
    snap = snapshot(mgr, taskId, artifactBase, a2aVersion);
    if (!snap) {
      // Task evicted from the in-memory store (LRU) but still on disk: report
      // it as failed so the client is not left hanging on an open stream.
      yield {
        kind: 'status-update',
        taskId,
        contextId: taskId,
        status: { state: 'failed', timestamp: new Date().toISOString() },
        final: true,
      };
      return;
    }

    const stateChanged = snap.state !== lastState;
    const progressed = snap.cursor > lastCursor;

    if (stateChanged || progressed) {
      yield statusEvent(snap, isFinalState(snap.state));
      lastState = snap.state;
      lastCursor = snap.cursor;
    }

    for (const a of snap.task.artifacts ?? []) {
      if (!emittedArtifactFor.has(a.artifactId)) {
        emittedArtifactFor.add(a.artifactId);
        yield artifactEvent(snap, a, false, true);
      }
    }
    lastArtifactCount = snap.artifactCount;

    if (isFinalState(snap.state)) return;
  }
}

/** Watch a task and POST updates to a push-notification webhook until final. */
export async function watchAndPush(
  mgr: JobManager,
  taskId: string,
  push: PushNotificationConfig,
  log: Logger,
  signal?: AbortSignal,
): Promise<void> {
  let lastState: TaskState | undefined;
  let lastCursor = -1;

  for (;;) {
    if (signal?.aborted) return; // client disconnected; stop watching
    const snap = snapshot(mgr, taskId);
    if (!snap) return; // evicted; nothing more to report

    const final = isFinalState(snap.state);
    if (snap.state !== lastState || snap.cursor > lastCursor) {
      await postPush(push, {
        kind: 'status-update',
        taskId,
        contextId: snap.task.contextId,
        status: snap.task.status,
        final,
      });
      lastState = snap.state;
      lastCursor = snap.cursor;
    }

    if (final) return;
    await sleep(POLL_MS, signal);
  }
}

async function postPush(push: PushNotificationConfig, body: unknown): Promise<void> {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-a2a-push': '1',
  };
  if (push.token) headers['authorization'] = `Bearer ${push.token}`;

  // Best-effort with a couple of retries so a transient webhook blip does not
  // lose the terminal notification.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(push.url, {
        method: 'POST',
        headers,
        body: payload,
      });
      if (res.ok) return;
      if (attempt === 3) {
        // non-2xx; give up after retries but do not throw into the watcher
      }
    } catch {
      /* network error, retry */
    }
    await sleep(200 * attempt);
  }
}

function statusEvent(snap: Snapshot, final: boolean): TaskEvent {
  return {
    kind: 'status-update',
    taskId: snap.task.id,
    contextId: snap.task.contextId,
    status: snap.task.status,
    final,
  };
}

function artifactEvent(
  snap: Snapshot,
  artifact: NonNullable<Snapshot['task']['artifacts']>[number],
  append: boolean,
  lastChunk: boolean,
): TaskEvent {
  return {
    kind: 'artifact-update',
    taskId: snap.task.id,
    contextId: snap.task.contextId,
    artifact,
    append,
    lastChunk,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      // Remove the abort listener on normal completion so long-lived streams
      // do not accumulate dead listeners across thousands of polls.
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
