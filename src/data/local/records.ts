/**
 * Pure record helpers for the LocalAdapter: undefined stripping and patch semantics (D-050),
 * base-field protection (D-048) and deterministic ordering.
 */
import type { BaseKeys } from '../types';

/** Keys a caller can never set through create/update: the data layer owns them (D-048, D-051). */
export const PROTECTED_KEYS: ReadonlySet<string> = new Set<BaseKeys | 'deletedAt'>([
  'id',
  'deviceId',
  'createdAt',
  'updatedAt',
  'deletedAt',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep copy of plain objects and arrays with every undefined-valued object key removed (D-050).
 * Other values (strings, numbers, booleans, null) are returned as they are.
 */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => stripUndefined(item)) as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = stripUndefined(item);
  }
  return out as T;
}

/** Copy of `input` (undefined keys stripped) without the given keys. */
export function withoutKeys(input: object, keys: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(stripUndefined(input))) {
    if (!keys.has(key)) out[key] = item;
  }
  return out;
}

/**
 * Applies an update patch (D-050): keys present are merged, a key present with value
 * undefined removes the field, and the keys in `ignored` are never touched.
 */
export function applyPatch<T extends object>(existing: T, patch: object, ignored: ReadonlySet<string>): T {
  const next: Record<string, unknown> = { ...(existing as Record<string, unknown>) };
  for (const [key, item] of Object.entries(patch)) {
    if (ignored.has(key)) continue;
    if (item === undefined) delete next[key];
    else next[key] = stripUndefined(item);
  }
  return next as T;
}

/** Sort key used for unordered listings: createdAt, then id (plain string comparison). */
export function byCreatedAtThenId(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  return compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id);
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
