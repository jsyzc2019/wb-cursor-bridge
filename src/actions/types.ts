/**
 * Shared Action layer (P1).
 *
 * Before P1, the MCP surface (`src/tools.ts`) and the A2A surface
 * (`src/a2a/server.ts`) each hand-rolled argument validation and each called
 * `JobManager` directly. That duplication already caused one drift incident:
 * when A2A gained an SSE envelope, the e2e harness kept reading bare events.
 *
 * An Action is the single definition of one capability: its JSON Schema (used
 * to generate the MCP tool list), its derived argument parser (shared by both
 * surfaces), and its implementation over `JobManager`. Both adapters consume
 * the same registry, so adding a parameter or a permission rule is a one-place
 * change and cannot silently diverge between MCP and A2A.
 *
 * Deliberately NOT part of an Action: protocol-specific response shaping.
 * MCP returns `ToolResult` text blocks, A2A returns `Task` / `Message` /
 * `StreamResponse`. Those are adapter concerns, not capability concerns.
 */
import type { JobManager } from '../runner.js';

export interface JsonObjectSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ActionContext {
  mgr: JobManager;
}

export interface Action<
  A extends Record<string, unknown> = Record<string, unknown>,
  R = unknown,
> {
  /** Stable identifier. For MCP actions this is also the tool name. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
  /** Schema-derived validation. Throws `BridgeError` with E_BAD_ARGUMENT. */
  parse(raw: Record<string, unknown>): A;
  /** The one implementation, shared by every adapter. */
  invoke(ctx: ActionContext, args: A): Promise<R> | R;
}

/** Type-erased action, used when holding heterogeneous actions in a registry. */
export type AnyAction = Action<Record<string, unknown>, unknown>;
