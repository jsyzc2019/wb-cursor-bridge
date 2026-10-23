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
