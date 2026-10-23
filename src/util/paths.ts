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
 *  - 8.3 short names (C:\REPO~1) can alias a real directory, so short names
 *    are rejected outright rather than trusted
 *  - Reserved DOS device names must never be treated as directories
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathDenied, notFound } from '../errors.js';

const IS_WIN = process.platform === 'win32';

/** DOS device names that cannot be used as a directory component. */
const RESERVED =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** A 8.3 short-name component such as "REPO~1". */
const SHORT_NAME = /~[0-9]+$/i;

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

/** Hard-fail on inputs that are never acceptable, even if inside a root. */
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
    if (SHORT_NAME.test(seg)) {
      throw pathDenied(
        `path contains an 8.3 short name ("${seg}"); use the long name`,
      );
    }
  }
}

/**
 * Validate that `workspace` is an existing directory inside one of `roots`.
 * Returns the canonical directory path.
 *
 * Both the literal path and its resolved real path must be contained: that
 * blocks the case where an allowed path is later replaced by a junction.
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

  const abs = canonical(workspace);
  const literalOk = roots.some((r) => isInside(abs, r));
  if (!literalOk) {
    throw pathDenied(
      `workspace "${workspace}" is outside every configured root (${roots.join('; ')})`,
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw notFound(`workspace "${workspace}" does not exist`);
  }
  if (!stat.isDirectory()) {
    throw pathDenied(`workspace "${workspace}" is not a directory`);
  }

  // Second gate: the resolved location must also be contained.
  const real = realpathOrSelf(abs);
  const realOk = roots.some((r) => {
    const rootReal = fs.existsSync(r) ? realpathOrSelf(r) : canonical(r);
    return isInside(real, rootReal);
  });
  if (!realOk) {
    throw pathDenied(
      `workspace "${workspace}" resolves to "${real}", which escapes the configured roots`,
    );
  }

  return real;
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