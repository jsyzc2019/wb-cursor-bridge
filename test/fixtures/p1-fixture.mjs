/**
 * Frozen inputs for the P1 compact-status golden comparison.
 *
 * These values are deliberately fixed (no Date.now(), no random ids) so the
 * JSON text produced by `JSON.stringify(view, null, 2)` is byte-stable. The
 * companion golden file `p1-v060-jobview.golden.json` was generated from the
 * unmodified v0.6.0 `dist/` using exactly these inputs — never edit either
 * without regenerating both.
 */
export function fixedJob() {
  return {
    id: 'p1-golden-job',
    tier: 'consult',
    workspace: '/srv/repo',
    prompt: 'golden',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    exitCode: 0,
    durationMs: 1000,
    result: 'FAKE_RESULT:ok',
    truncated: false,
    isolation: 'none',
    changedFiles: ['src/index.ts'],
    diffStat: ' 1 file changed, 1 insertion(+)',
    events: [
      { seq: 1, ts: '2026-01-01T00:00:00.100Z', type: 'start', text: 'started' },
      { seq: 2, ts: '2026-01-01T00:00:00.900Z', type: 'assistant', text: 'done' },
    ],
    cursor: 2,
  };
}

/** Minimal Config accepted by JobManager's constructor. */
export function baseConfig(stateDir, overrides = {}) {
  return {
    cursorBin: 'agent',
    workspaceRoots: [],
    stateDir,
    defaultTimeoutSec: 900,
    maxTimeoutSec: 3600,
    maxConcurrency: 4,
    forceWorktree: false,
    maxResultBytes: 2 * 1024 * 1024,
    maxEventsPerJob: 2000,
    maxJobs: 100,
    logLevel: 'error',
    adminPort: 0,
    extraArgs: [],
    ...overrides,
  };
}
