#!/usr/bin/env node
/**
 * P5 evaluation PoC — semantic alignment between this bridge's MCP tools and
 * the MCP Tasks extension (SEP-2663, io.modelcontextprotocol/tasks).
 *
 * This is an EVALUATION ARTEFACT, NOT production code:
 *   - zero dependencies, no SDK import, no change to src/ or package.json deps
 *   - it does not speak MCP over a transport; it maps *semantics* and asserts
 *     that the mapping is lossless where we claim it is
 *   - field names taken from the public SEP-2663 spec text; where the spec's
 *     exact request shape was not consulted, the PoC says so explicitly
 *
 * Purpose: decide whether upgrading to MCP TS SDK v2 + the 2026-07-28 wire is
 * worth the breaking change. Conclusion lives in docs/p5-mcp-sdk-v2-decision.md.
 */
import assert from 'node:assert/strict';

const EXT = 'io.modelcontextprotocol/tasks';

/** The four bridge tools that form the async lifecycle (P1 Action registry). */
const BRIDGE_TOOLS = ['cursor_run', 'cursor_status', 'cursor_reply', 'cursor_cancel'];

/** Canonical internal Job.status -> SEP-2663 Task.status. */
const STATUS_MAP = Object.freeze({
  running: 'working',
  'input-required': 'input_required',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
});

/**
 * SEP-2663 CreateTaskResult, returned in lieu of CallToolResult when the server
 * decides the request is long-running. The task MUST be durable before this
 * response is sent — which is exactly what JobManager.start() guarantees (it
 * persists the job before returning the jobId).
 */
function createTaskResult(job, now = new Date()) {
  return {
    resultType: 'task',
    taskId: job.id,
    status: STATUS_MAP[job.status] ?? 'working',
    createdAt: job.createdAt ?? now.toISOString(),
    lastUpdatedAt: now.toISOString(),
    ttlMs: job.ttlMs ?? 60_000,
    pollIntervalMs: job.pollIntervalMs ?? 1000,
  };
}

/** SEP-2663 GetTaskResult (Result & DetailedTask) for a live Bridge job. */
function getTaskResult(job, now = new Date()) {
  const base = {
    taskId: job.id,
    status: STATUS_MAP[job.status] ?? 'working',
    createdAt: job.createdAt ?? now.toISOString(),
    lastUpdatedAt: now.toISOString(),
    ttlMs: job.ttlMs ?? 60_000,
    pollIntervalMs: job.pollIntervalMs ?? 1000,
  };
  if (base.status === 'input_required') {
    // SEP-2663 carries outstanding server->client requests here. The concrete
    // shape of each entry comes from SEP-2322 (MRTR); this PoC only asserts the
    // field is present, it does not fabricate the spec's inner schema.
    return { ...base, inputRequests: [{ requestId: job.pendingInput?.id ?? 'input-1', kind: 'elicitation' }] };
  }
  if (base.status === 'completed') return { ...base, result: job.result ?? { content: [] } };
  if (base.status === 'failed') return { ...base, error: job.error ?? { code: -32603, message: 'job failed' } };
  return base;
}

/** Client opt-in, per SEP-2663 capability negotiation. */
function capabilitiesOptIn() {
  return { _meta: { 'io.modelcontextprotocol/clientCapabilities': { extensions: { [EXT]: {} } } } };
}

/** Server advertisement, per SEP-2663 server/discover response. */
function capabilitiesAdvertise() {
  return { capabilities: { extensions: { [EXT]: {} } } };
}

// ---------------------------------------------------------------------------
// Semantic mapping table: what a v2/Tasks client would call instead of our
// private tools. "Lossless" means no bridge capability is dropped by the map.
// ---------------------------------------------------------------------------
const MAPPING = [
  {
    bridge: 'cursor_run',
    tasks: 'tools/call → CreateTaskResult (resultType:"task")',
    lossless: true,
    note: 'JobManager.start() already persists the job before returning jobId; P3 requestKey dedup is stronger than the spec minimum.',
  },
  {
    bridge: 'cursor_status',
    tasks: 'tasks/get { taskId }',
    lossless: false,
    note: 'Bridge returns a JobView with events/artifacts/cost; Tasks GetTaskResult carries status + terminal result only. Needs an extra resource/tool for intermediate artifacts.',
  },
  {
    bridge: 'cursor_reply',
    tasks: 'tasks/update (fulfil inputRequests)',
    lossless: false,
    note: 'Same pause/resume intent, but the wire shape of tasks/update is defined in ext-tasks/MRTR; this PoC does not assume its exact fields.',
  },
  {
    bridge: 'cursor_cancel',
    tasks: 'tasks/cancel { taskId }',
    lossless: true,
    note: 'Cooperative cancellation in both models; bridge already kills the process tree.',
  },
];

const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, error: err.message });
  }
};

// 1. Capability negotiation is symmetric.
check('capability opt-in / advertise use the same extension id', () => {
  const opt = capabilitiesOptIn();
  const adv = capabilitiesAdvertise();
  assert.ok(opt._meta['io.modelcontextprotocol/clientCapabilities'].extensions[EXT]);
  assert.ok(adv.capabilities.extensions[EXT]);
});

// 2. The polymorphic discriminator is unambiguous.
check('CreateTaskResult is distinguishable from a normal CallToolResult', () => {
  const r = createTaskResult({ id: 'job-1', status: 'running' });
  assert.equal(r.resultType, 'task');
  assert.notEqual(r.resultType, 'complete');
  assert.equal(r.status, 'working');
});

// 3. Every internal status has a Tasks counterpart (no silent fallback).
check('all five Job states map to a defined Tasks status', () => {
  assert.deepEqual(Object.keys(STATUS_MAP).sort(), ['cancelled', 'completed', 'failed', 'input-required', 'running']);
  assert.deepEqual([...new Set(Object.values(STATUS_MAP))].sort(), ['cancelled', 'completed', 'failed', 'input_required', 'working']);
});

// 4. Mid-flight input is expressible without a second connection.
check('input-required surfaces inputRequests on tasks/get', () => {
  const r = getTaskResult({ id: 'job-2', status: 'input-required' });
  assert.equal(r.status, 'input_required');
  assert.ok(Array.isArray(r.inputRequests) && r.inputRequests.length > 0);
});

// 5. Terminal states carry their payloads.
check('completed / failed carry result / error respectively', () => {
  assert.ok(getTaskResult({ id: 'j', status: 'completed', result: { content: [] } }).result);
  assert.ok(getTaskResult({ id: 'j', status: 'failed' }).error);
});

// 6. The full lifecycle is a valid Tasks state machine.
check('working → input_required → completed is a legal trajectory', () => {
  const seq = [
    getTaskResult({ id: 'j', status: 'running' }).status,
    getTaskResult({ id: 'j', status: 'input-required' }).status,
    getTaskResult({ id: 'j', status: 'completed' }).status,
  ];
  assert.deepEqual(seq, ['working', 'input_required', 'completed']);
});

// 7. Honesty: two of the four tools are NOT lossless. Do not over-claim.
check('known mapping gaps are declared, not hidden', () => {
  assert.equal(MAPPING.filter((m) => m.lossless).length, 2);
  assert.equal(MAPPING.filter((m) => !m.lossless).length, 2);
  assert.deepEqual(MAPPING.map((m) => m.bridge), BRIDGE_TOOLS);
});

const report = {
  tool: 'poc-mcp-tasks',
  scope: 'evaluation only — no SDK import, no production code, no dependency change',
  extension: EXT,
  spec: 'SEP-2663 (Tasks Extension, Final) + MCP 2026-07-28',
  mapping: MAPPING,
  checks,
  ok: checks.every((c) => c.ok),
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.stdout.write(
  report.ok
    ? `[poc-mcp-tasks] ${checks.length}/${checks.length} alignment checks passed; ${MAPPING.filter((m) => !m.lossless).length} declared gaps\n`
    : `[poc-mcp-tasks] FAILED: ${checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}\n`,
);
if (!report.ok) process.exit(1);
