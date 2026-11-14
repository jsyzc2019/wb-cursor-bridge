/**
 * Schema-derived argument validation, shared by MCP and A2A (P1).
 *
 * These helpers used to live inside `src/tools.ts` and had a hand-written twin
 * inside `src/a2a/server.ts` (`strParam` / `numParam`). Both surfaces now call
 * the same functions, so an invalid argument produces the same `E_BAD_ARGUMENT`
 * message regardless of which protocol delivered it.
 *
 * Error strings are written for a *model* reading a tool result, not for a
 * stack trace — that property is preserved from the original implementation.
 */
import { badArgument } from '../errors.js';

export function str(
  args: Record<string, unknown>,
  key: string,
  required = true,
): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw badArgument(`missing required argument "${key}"`);
    return undefined;
  }
  if (typeof v !== 'string' || v.length === 0) {
    throw badArgument(`argument "${key}" must be a non-empty string`);
  }
  return v;
}

export function num(
  args: Record<string, unknown>,
  key: string,
  fallback?: number,
): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  // `Number.isNaN` alone lets Infinity / 1e999 through, and an infinite
  // timeout is indistinguishable from a hang: the wait loop never reaches its
  // deadline. Reject anything that is not finite.
  if (!Number.isFinite(n)) throw badArgument(`argument "${key}" must be a finite number`);
  return n;
}

export function enumOf<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
  required = true,
): T | undefined {
  const v = str(args, key, required);
  if (v === undefined) return undefined;
  if (!values.includes(v as T)) {
    throw badArgument(`"${key}" must be one of ${values.join(' | ')} (got "${v}")`);
  }
  return v as T;
}

export function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  return Boolean(v);
}

/** Clamp a number into [min, max] after validation. */
export function clamp(n: number | undefined, min: number, max: number, fallback: number): number {
  return Math.min(Math.max(n ?? fallback, min), max);
}
