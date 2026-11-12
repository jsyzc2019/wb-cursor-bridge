/**
 * Windows-aware path containment.
 *
 * Containment checks are the single security boundary of this bridge, so they
 * are written defensively for win-x64 specifically:
 *
 *  - Windows paths are case-insensitive:  C:\Repo  ==  c:\REPO
 *  - Trailing separators must not change the answer
 *  - Junctions and symlinks can point outside an allowed root, so the *real*
 *    path is compared, not the literal one
 *  - 8.3 short names (C:\Users\RUNNER~1) are *expanded*, not rejected: they
 *    are a legitimate spelling of the same directory, and rejecting them
 *    failed every GitHub Windows runner (whose %TEMP% is the short form)
 *  - Reserved DOS device names must never be treated as directories
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathDenied, notFound } from '../errors.js';

const IS_WIN = process.platform === 'win32';

/** DOS device names that cannot be used as a directory component. */
const RESERVED =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Canonical form used for comparisons.
 * Lower-cased on Windows, separator-normalised everywhere.
 */
export function canonical(p: string): string {
  const resolved = path.resolve(p);
  let out = IS_WIN ? resolved.toLowerCase() : resolved;
  // Strip a trailing separator, except for a bare root such as "C:\".
  if (out.length > 1 && (out.endsWith(path.sep) || out.endsWith('/'))) {
    const root = path.parse(out).root;
    if (out !== root.toLowerCase() && out !== root) out = out.slice(0, -1);
  }
  return path.normalize(out);
}

/**
 * Resolve symlinks/junctions when the path exists.
 * Falls back to the literal path when the target does not exist yet, which is
 * fine because containment is still checked against the literal form first.
 */
function realpathOrSelf(p: string): string {
  try {
    return canonical(fs.realpathSync.native(p));
  } catch {
    return canonical(p);
  }
}

/** True when `child` is `parent` itself or lives beneath it. */
export function isInside(child: string, parent: string): boolean {
  const c = canonical(child);
  const p = canonical(parent);
  if (c === p) return true;
  const sep = path.sep;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Hard-fail on inputs that are never acceptable, even if inside a root.
 *
 * Note: an 8.3-shaped component (`REPO~1`) is deliberately NOT rejected here.
 * The earlier revision did reject it, and that single line failed all 11
 * Windows CI e2e cases: GitHub's Windows runners have
 * `%TEMP% = C:\Users\RUNNER~1\AppData\Local\Temp`, so *every* temp repo was
 * refused. A short name is not a traversal primitive — it always aliases an
 * entry in the same parent, and `realpathSync.native` expands it, so the
 * containment gate below sees the real directory either way.
 */
function assertSaneShape(target: string): void {
  if (!target || target.trim() !== target) {
    throw pathDenied(`path contains leading/trailing whitespace: "${target}"`);
  }
  if (target.includes('\0')) {
    throw pathDenied('path contains a NUL byte');
  }
  for (const seg of target.split(/[\\/]/)) {
    if (RESERVED.test(seg)) {
      throw pathDenied(`path contains reserved device name "${seg}"`);
    }
  }
}

/**
 * Validate that `workspace` is an existing directory inside one of `roots`.
 * Returns the resolved (real) directory path — the one the job will actually use.
 *
 * Containment is decided on the *resolved* path for both sides. Comparing the
 * literal string instead is what produced the `RUNNER~1` false positive: the
 * root was configured in long form, the caller passed the short form, the
 * strings differed, and a legitimate directory was denied. The security
 * property is unchanged — a junction or symlink still resolves outside the
 * root and is still rejected, because `realpath` is what we compare.
 */
export function assertWorkspaceAllowed(
  workspace: string,
  roots: string[],
): string {
  if (roots.length === 0) {
    throw pathDenied(
      'no workspace roots are configured; refusing to run (set CURSOR_BRIDGE_WORKSPACE_ROOTS)',
    );
  }
  assertSaneShape(workspace);

  // Resolve once; `realpathOrSelf` falls back to the literal form for paths
  // that do not exist yet, so a missing workspace still reports `not found`
  // rather than `outside every root`.
  const target = realpathOrSelf(workspace);
  const inside = roots.some((r) => isInside(target, realpathOrSelf(r)));
  if (!inside) {
    // Distinguish the two failure modes for the operator: "you pointed outside"
    // versus "this path used to be inside but resolves elsewhere now" (a
    // junction/symlink swap). The second one is the security-relevant one.
    const literal = canonical(workspace);
    const lookedInside = roots.some((r) => isInside(literal, canonical(r)));
    if (lookedInside && target !== literal) {
      throw pathDenied(
        `workspace "${workspace}" resolves to "${target}", which escapes the configured roots`,
      );
    }
    throw pathDenied(
      `workspace "${workspace}" is outside every configured root (${roots.join('; ')})`,
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw notFound(`workspace "${workspace}" does not exist`);
  }
  if (!stat.isDirectory()) {
    throw pathDenied(`workspace "${workspace}" is not a directory`);
  }

  return target;
}

/** Expand `%VAR%` and `~` without letting user input reach a shell. */
export function expandPath(input: string): string {
  let out = input.trim();
  if (out.startsWith('~')) {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    out = path.join(home, out.slice(1));
  }
  out = out.replace(/%([^%]+)%/g, (m, name: string) => {
    const v = process.env[name];
    return v === undefined ? m : v;
  });
  return canonical(out);
}

/** Split a `;`-separated Windows path list, also tolerating `:` on POSIX. */
export function splitRoots(raw: string): string[] {
  if (!raw) return [];
  const parts = IS_WIN ? raw.split(';') : raw.split(/[:;]/);
  return parts.map((s) => s.trim()).filter(Boolean);
}