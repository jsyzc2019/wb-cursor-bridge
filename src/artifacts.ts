/**
 * A2A artifact derivation.
 *
 * This module is the single source of truth for turning a Job's flat deliverable
 * fields (changedFiles / diffStat / patchFile / reportFile) into the
 * A2A-conformant `Artifact[]` shape consumed by both the MCP `view()` and the
 * A2A `toTask()` converters. Lifting it out of `runner.ts` removes the reverse
 * dependency where `convert.ts` had to import the whole job manager, keeping the
 * conversion layer clean and the artifact logic independently testable.
 */
import fs from 'node:fs';
import type { Artifact, ArtifactPart, Job } from './types.js';

/**
 * Derive A2A-style artifacts from a job's deliverable fields.
 *
 * Pure and side-effect free: a missing file is simply omitted (and reported
 * with `bytes: undefined`) rather than throwing. The bridge keeps its flat
 * fields (changedFiles / diffStat / patchFile / reportFile) for backward
 * compatibility and derives this array from them, so an A2A adapter can
 * consume deliverables as standard `artifacts[]` without special casing.
 */
export function buildArtifacts(job: Job): Artifact[] {
  const out: Artifact[] = [];
  if (job.changedFiles && job.changedFiles.length > 0) {
    out.push({
      artifactId: `${job.id}-files`,
      name: 'changedFiles',
      parts: [{ kind: 'data', data: { files: job.changedFiles } }],
    });
  }
  if (job.diffStat) {
    out.push({
      artifactId: `${job.id}-diffstat`,
      name: 'diffStat',
      parts: [{ kind: 'text', text: job.diffStat }],
    });
  }
  if (job.patchFile) {
    out.push({
      artifactId: `${job.id}-patch`,
      name: 'changes.patch',
      parts: [filePart(job.patchFile, 'text/x-diff', 'changes.patch')],
    });
  }
  if (job.reportFile) {
    out.push({
      artifactId: `${job.id}-report`,
      name: 'report.md',
      parts: [filePart(job.reportFile, 'text/markdown', 'report.md')],
    });
  }
  return out;
}

/**
 * Build a file part, tolerating a path that does not (yet) exist on disk.
 *
 * Emits the A2A v0.3.0-standard `name` field (NOT `filename`). Small files are
 * inlined as base64 `bytes_inline` so a conformant client can read the content
 * directly without a second round-trip; larger files keep a `file://` URI that
 * the A2A HTTP layer rewrites into a reachable `/a2a/artifacts/...` endpoint.
 */
const ARTIFACT_INLINE_LIMIT = 64 * 1024; // 64 KiB
export function filePart(absPath: string, mimeType: string, filename: string): ArtifactPart {
  let bytes: number | undefined;
  let bytesInline: string | undefined;
  try {
    const size = fs.statSync(absPath).size;
    bytes = size;
    if (size > 0 && size <= ARTIFACT_INLINE_LIMIT) {
      bytesInline = fs.readFileSync(absPath).toString('base64');
    }
  } catch {
    /* file not present, e.g. not yet flushed to disk */
  }
  return {
    kind: 'file',
    file: { name: filename, mimeType, uri: `file://${absPath}`, bytes, bytes_inline: bytesInline },
  };
}

/* --------------------------------------------------------------------- P2 */

/**
 * Cost/usage summary for a task. Always derivable from fields the bridge
 * already persists; `usage` is populated when the worker reported token or
 * monetary usage (e.g. Cursor's result `usage` object) in metadata.
 */
export interface StructuredCost {
  durationMs?: number;
  model?: string;
  toolCallCount: number;
  transcriptEntryCount: number;
  eventCount: number;
  usage?: unknown;
}

export interface TranscriptEntry {
  semantic: 'thinking' | 'plan';
  seq: number;
  ts: string;
  text: string;
}

export interface ToolCallEntry {
  seq: number;
  ts: string;
  detail: unknown;
}

/** Heuristic plan marker. Deliberately conservative: everything else is thinking. */
const PLAN_HINT = /\b(?:plan|todo|steps?\s*\d|phase\s*\d|计划|方案|步骤)\b/i;

export function classifyTranscript(job: Job): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const ev of job.events ?? []) {
    if (ev.type !== 'assistant' || typeof ev.text !== 'string' || !ev.text.trim()) continue;
    out.push({
      semantic: PLAN_HINT.test(ev.text) ? 'plan' : 'thinking',
      seq: ev.seq,
      ts: ev.ts,
      text: ev.text,
    });
  }
  return out;
}

export function structuredCost(job: Job, transcriptCount: number, toolCount: number): StructuredCost {
  const cost: StructuredCost = {
    durationMs: job.durationMs,
    model: job.model,
    toolCallCount: toolCount,
    transcriptEntryCount: transcriptCount,
    eventCount: job.events?.length ?? 0,
  };
  if (job.metadata?.usage !== undefined) cost.usage = job.metadata.usage;
  return cost;
}

/**
 * P2: derive protocol-level structured artifacts from the job's event stream.
 *
 * The worker's raw stream is a flat event log; A2A clients need semantic units
 * (thinking/plan transcript, tool calls, cost, permission request) as named,
 * addressable artifacts. This is a pure derivation — `buildArtifacts()` (the
 * deliverable artefacts, whose shape and count are locked by unit tests) is
 * intentionally left untouched.
 *
 * Also deliberately does NOT introduce worker-initiated work: a permission
 * request is a *pause* (`input-required`) the caller answers, never an action
 * the worker schedules on its own.
 */
export function buildStructuredArtifacts(job: Job): Artifact[] {
  const out: Artifact[] = [];
  const transcript = classifyTranscript(job);
  const toolCalls: ToolCallEntry[] = (job.events ?? [])
    .filter((ev) => ev.type === 'tool')
    .map((ev) => ({ seq: ev.seq, ts: ev.ts, detail: ev.detail }));

  if (transcript.length > 0) {
    out.push({
      artifactId: `${job.id}-transcript`,
      name: 'transcript',
      parts: [{ kind: 'data', data: { entries: transcript } }],
    });
  }
  if (toolCalls.length > 0) {
    out.push({
      artifactId: `${job.id}-toolcalls`,
      name: 'toolCalls',
      parts: [{ kind: 'data', data: { calls: toolCalls } }],
    });
  }
  out.push({
    artifactId: `${job.id}-cost`,
    name: 'cost',
    parts: [{ kind: 'data', data: structuredCost(job, transcript.length, toolCalls.length) }],
  });
  if (job.status === 'input-required' && job.pendingInput) {
    out.push({
      artifactId: `${job.id}-permission`,
      name: 'permissionRequest',
      parts: [
        { kind: 'text', text: job.pendingInput },
        {
          kind: 'data',
          data: {
            state: 'input-required',
            question: job.pendingInput,
            at: job.inputRequiredAt,
            resumeWith: `message/send with taskId=${job.id} and the same contextId`,
          },
        },
      ],
    });
  }
  return out;
}
