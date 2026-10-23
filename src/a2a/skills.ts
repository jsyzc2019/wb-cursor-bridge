/**
 * Derive A2A skills from the bridge's configured workspace roots.
 *
 * The bridge isolates every task to a workspace root allowlist. For real A2A
 * interoperability a client must discover *which* roots it may target and pick
 * one explicitly (the bridge never lets a prompt escape its root). So each root
 * becomes one skill whose `id` selects that root. This keeps the security model
 * intact while giving A2A clients a familiar, declarative surface.
 */
import path from 'node:path';
import type { Tier } from '../types.js';
import type { AgentSkill } from './types.js';
import { assertWorkspaceAllowed } from '../util/paths.js';
import type { Logger } from '../logger.js';

export interface SkillEntry {
  /** Stable A2A skill id; passed back by clients as metadata.skillId. */
  id: string;
  /** The workspace root this skill dispatches into. */
  root: string;
  /** Default permission tier for tasks on this skill. */
  defaultTier: Tier;
  /** The public AgentCard skill descriptor. */
  card: AgentSkill;
}

/**
 * Operator-declared extra skill. Lets one configured root expose several named
 * skills (e.g. "review" vs "implement") or pin a skill to a specific subfolder,
 * without spinning up a second workspace root. The `root` MUST resolve to one of
 * the configured `workspaceRoots` — otherwise it is rejected at load time, so an
 * attacker cannot steer tasks outside the allowlist via the Agent Card.
 */
export interface ExtraSkill {
  id: string;
  root: string;
  name?: string;
  description?: string;
  tags?: string[];
  examples?: string[];
}

function slug(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '');
  const base = path.basename(trimmed) || 'workspace';
  const s = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return s || 'workspace';
}

/**
 * Build the skill set: one skill per workspace root, plus any operator-declared
 * extra skills (the extension point for "same root, multiple skills" or pinning
 * a skill to a subfolder). Extra skills whose `root` does not resolve inside a
 * configured workspace root are dropped with a warning — never silently trusted.
 *
 * Skill ids are derived from the root's basename and de-duplicated with a
 * numeric suffix, so two roots named `web` and `web/clone` both get stable,
 * distinct ids.
 */
export function deriveSkills(
  roots: string[],
  defaultTier: Tier = 'execute',
  extra: ExtraSkill[] = [],
  log?: Logger,
): SkillEntry[] {
  const used = new Set<string>();
  const out: SkillEntry[] = [];
  const push = (id: string, root: string, card: AgentSkill): void => {
    out.push({ id, root, defaultTier, card });
    used.add(id);
  };

  roots.forEach((root) => {
    let id = slug(root);
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    const card: AgentSkill = {
      id,
      name: `Cursor coding agent · ${path.basename(root.replace(/[\\/]+$/, '')) || 'workspace'}`,
      description:
        `Delegate coding tasks to the Cursor sub-agent inside ${root}. ` +
        `Tiers: consult (read-only Q&A), plan (read-only planning), ` +
        `execute (writes inside an isolated git worktree).`,
      tags: ['coding', 'cursor', 'code-generation', 'refactor', 'review'],
      examples: [
        `Implement a new feature in ${root}`,
        `Review the pending changes under ${root}`,
        `Write tests for an existing module in ${root}`,
      ],
      inputModes: ['text/plain'],
      outputModes: ['text/plain', 'text/markdown', 'application/json'],
    };
    push(id, root, card);
  });

  for (const ex of extra) {
    let resolved: string;
    try {
      resolved = assertWorkspaceAllowed(ex.root, roots);
    } catch {
      log?.warn('dropping a2aSkill with root outside workspaceRoots', { id: ex.id, root: ex.root });
      continue;
    }
    let id = ex.id && /^[a-z0-9-]+$/.test(ex.id) ? ex.id : slug(resolved);
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    const card: AgentSkill = {
      id,
      name: ex.name ?? `Cursor coding agent · ${path.basename(resolved.replace(/[\\/]+$/, '')) || 'workspace'}`,
      description:
        ex.description ??
        `Delegate coding tasks to the Cursor sub-agent inside ${resolved}. ` +
          `Tiers: consult (read-only Q&A), plan (read-only planning), ` +
          `execute (writes inside an isolated git worktree).`,
      tags: ex.tags ?? ['coding', 'cursor', 'code-generation', 'refactor', 'review'],
      examples:
        ex.examples ??
        [
          `Implement a new feature in ${resolved}`,
          `Review the pending changes under ${resolved}`,
          `Write tests for an existing module in ${resolved}`,
        ],
      inputModes: ['text/plain'],
      outputModes: ['text/plain', 'text/markdown', 'application/json'],
    };
    push(id, resolved, card);
  }
  return out;
}

/** Resolve a skill id to its workspace root, or undefined if unknown. */
export function resolveRoot(
  skills: SkillEntry[],
  skillId: string | undefined,
): string | undefined {
  if (!skillId) return undefined;
  return skills.find((s) => s.id === skillId)?.root;
}

/** Strip the private fields, returning the public AgentSkill[] for the card. */
export function toAgentSkills(skills: SkillEntry[]): AgentSkill[] {
  return skills.map((s) => s.card);
}
