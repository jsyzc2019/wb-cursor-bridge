/**
 * MCP tool surface — now a thin adapter over the shared Action registry (P1).
 *
 * The nine tool definitions, their argument validation and their JobManager
 * calls live in `src/actions/`. This file only converts the canonical action
 * result into the MCP `ToolResult` text-block shape. A2A consumes the same
 * actions from `src/a2a/server.ts`, so the two faces cannot drift.
 *
 * Tool names, descriptions and input schemas are generated from the registry
 * and remain byte-for-byte compatible with pre-P1 clients.
 */
import type { Job } from './types.js';
import type { JobManager } from './runner.js';
import {
  actionNames,
  getAction,
  toolDefinitions,
} from './actions/index.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const ok = (payload: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

const fail = (message: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

/** MCP tool list is generated, not hand-maintained. */
export const TOOL_DEFINITIONS = toolDefinitions();

/**
 * Protocol-specific shaping. Actions return canonical results (Job / JobView /
 * Job[] / payload); MCP serialises them here. Kept deliberately small — any
 * logic that belongs to the capability itself lives in the Action.
 */
function mcpResult(name: string, result: unknown, mgr: JobManager): unknown {
  switch (name) {
    case 'cursor_run':
    case 'cursor_reply':
    case 'cursor_cancel':
      return mgr.view(result as Job);
    case 'cursor_list': {
      const jobs = result as Job[];
      return jobs.map((j) => ({
        jobId: j.id,
        status: j.status,
        tier: j.tier,
        workspace: j.workspace,
        isolation: j.isolation,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
        durationMs: j.durationMs,
        changedFileCount: j.changedFiles?.length ?? 0,
        hasResult: Boolean(j.result),
      }));
    }
    default:
      return result;
  }
}

export function createDispatcher(mgr: JobManager) {
  return async function dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const action = getAction(name);
    if (!action) {
      return fail(`unknown tool "${name}". Available: ${actionNames().join(', ')}`);
    }
    try {
      const parsed = action.parse(args ?? {});
      const result = await action.invoke({ mgr }, parsed);
      if (name === 'bridge_health') {
        // Preserve the historical shape exactly: healthy responses have no
        // isError key, unhealthy ones carry an explicit false.
        const health = result as { ok?: boolean };
        return health.ok ? ok(health) : { ...ok(health), isError: false };
      }
      return ok(mcpResult(name, result, mgr));
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'E_INTERNAL';
      return fail(`${code}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
