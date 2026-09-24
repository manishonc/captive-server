/**
 * The tiny JSON condition language (03-playbook-format §5): no code, no eval.
 *
 * `{ all: [...] }`, `{ any: [...] }`, `{ not: … }` and leaves like
 * `{ fact: 'stay.nights', gte: 4 }`. Facts are read through a getter, so the
 * same evaluator works on journey facts, event data and replayed decisions.
 */

import type { Condition } from '../schemas';

export type FactGetter = (path: string) => unknown;

/** Reads a dotted path from a plain object: `get({a:{b:1}}, 'a.b')` → 1. */
export function getPath(source: unknown, path: string): unknown {
  let value: unknown = source;
  for (const part of path.split('.')) {
    if (value === null || value === undefined || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function factsFrom(source: Record<string, unknown>): FactGetter {
  return (path) => getPath(source, path);
}

function toComparable(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return value;
  return null;
}

function compare(value: unknown, op: 'gt' | 'gte' | 'lt' | 'lte', target: number): boolean {
  const v = toComparable(value);
  if (typeof v !== 'number') return false;
  if (op === 'gt') return v > target;
  if (op === 'gte') return v >= target;
  if (op === 'lt') return v < target;
  return v <= target;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** A leaf's operators all have to hold (a leaf with none only checks the fact exists). */
function evalLeaf(leaf: Extract<Condition, { fact: string }>, value: unknown): boolean {
  let checked = false;
  if ('exists' in leaf && leaf.exists !== undefined) {
    checked = true;
    if ((value !== undefined && value !== null) !== leaf.exists) return false;
  }
  if ('eq' in leaf && leaf.eq !== undefined) {
    checked = true;
    if (!sameValue(value, leaf.eq)) return false;
  }
  if ('ne' in leaf && leaf.ne !== undefined) {
    checked = true;
    if (sameValue(value, leaf.ne)) return false;
  }
  for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
    const target = leaf[op];
    if (target !== undefined) {
      checked = true;
      if (!compare(value, op, target)) return false;
    }
  }
  if (leaf.in !== undefined) {
    checked = true;
    if (!leaf.in.some((x) => sameValue(value, x))) return false;
  }
  return checked ? true : value !== undefined && value !== null;
}

export function evaluateCondition(condition: Condition, facts: FactGetter): boolean {
  if ('all' in condition) return condition.all.every((c) => evaluateCondition(c, facts));
  if ('any' in condition) return condition.any.some((c) => evaluateCondition(c, facts));
  if ('not' in condition) return !evaluateCondition(condition.not, facts);
  return evalLeaf(condition, facts(condition.fact));
}

/**
 * The `where` of a `wait_for` / `exitOn` entry: `{ 'data.stars': { lte: 2 } }`
 * or `{ 'data.channel': 'sms' }` (a plain value means equals).
 */
export function matchesWhere(where: Record<string, unknown> | undefined, subject: unknown): boolean {
  if (!where) return true;
  for (const [path, expected] of Object.entries(where)) {
    const value = getPath(subject, path);
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
      if (!evalLeaf({ fact: path, ...(expected as Record<string, unknown>) } as Extract<Condition, { fact: string }>, value)) {
        return false;
      }
    } else if (!sameValue(value, expected)) {
      return false;
    }
  }
  return true;
}
