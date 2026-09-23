/**
 * Check results shared by every validator, the API and the CMS "Check" dialog.
 *
 * A rule is identified by a stable code (P01, V09, S03, …) so the CMS, the MCP
 * tools and the tests all talk about the same thing. Errors block the action
 * (publish, save, turn on); warnings and info never do.
 */

import type { ZodError } from 'zod';
import { VALIDATOR_VERSION } from './constants';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  /** Where the problem is, e.g. `journeys.welcome_second_visit.slots.offer_days`. */
  path?: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: number;
  warnings: number;
  issues: Issue[];
  validatorVersion: string;
}

export function makeReport(issues: Issue[]): ValidationReport {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  return { ok: errors === 0, errors, warnings, issues, validatorVersion: VALIDATOR_VERSION };
}

export function error(code: string, message: string, path?: string): Issue {
  return { code, severity: 'error', message, ...(path ? { path } : {}) };
}

export function warning(code: string, message: string, path?: string): Issue {
  return { code, severity: 'warning', message, ...(path ? { path } : {}) };
}

export function info(code: string, message: string, path?: string): Issue {
  return { code, severity: 'info', message, ...(path ? { path } : {}) };
}

/** Shape errors from Zod become K01 issues with a dotted path. */
export function zodIssues(err: ZodError, prefix?: string): Issue[] {
  return err.issues.map((issue) => {
    const path = [prefix, ...issue.path.map(String)].filter(Boolean).join('.');
    return error('K01', `${path ? `${path}: ` : ''}${issue.message}`, path || undefined);
  });
}

/** "15m" / "48h" / "3d" → minutes. Returns null for anything else. */
export function durationToMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,4})(m|h|d)$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'm' ? n : m[2] === 'h' ? n * 60 : n * 60 * 24;
}

/** Plain-words version of a duration for descriptions: "15 minutes", "48 hours", "3 days". */
export function describeDuration(value: unknown): string {
  if (typeof value !== 'string') return String(value ?? '');
  const m = /^(\d{1,4})(m|h|d)$/.exec(value);
  if (!m) return value;
  const n = Number(m[1]);
  const unit = m[2] === 'm' ? 'minute' : m[2] === 'h' ? 'hour' : 'day';
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}
