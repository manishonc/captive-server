/**
 * Shared shapes of the AI foundation (PR F2a). Pure: no Firestore, no model SDK, so the API
 * process can import them without ever loading the model client.
 */

import type { ZodType } from 'zod';
import type { CheckResult } from './checks';

/** Every agent there is. F2a has one: the admin's "Test connection". */
export type AgentKey = 'ping';

export type Effort = 'low' | 'medium' | 'high';

/** Who asked for a run: the admin's Test connection, a schedule (from F2b), a person, the sandbox. */
export type RunTrigger = 'test' | 'schedule' | 'manual' | 'dev';

/**
 *  - ok: the answer passed every check;
 *  - rejected: the model answered, the answer failed a check (it is logged, never used);
 *  - failed: no usable answer (the model couldn't be reached, the privacy scan stopped it…);
 *  - skipped: the run never called the model (a switch is off, the budget is used up…).
 */
export type RunOutcome = 'ok' | 'rejected' | 'failed' | 'skipped';

export interface AgentSettings {
  agentKey: AgentKey;
  /** Scheduled runs only (the admin's Test connection runs either way). */
  enabled: boolean;
  model: string;
  /** Tried once when the first model is busy, down or too slow; null = no second try. */
  fallbackModel: string | null;
  effort: Effort;
  maxRunsPerDay: number;
  maxOutputTokens: number;
  promptVersion: string;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type AgentDefaults = Omit<AgentSettings, 'agentKey' | 'version' | 'updatedAt' | 'updatedBy'>;

export interface PromptText {
  /** The stable part (cached when long enough). */
  system: string;
  /** What to do with the package, sent before it in the user turn. */
  instructions: string;
}

export interface BuildContext {
  runId: string;
  /** Real time (dates in packages are real dates). */
  realNow: number;
  tenantUserId: string | null;
  venueId: string | null;
  params: Record<string, unknown>;
}

export interface BuiltInput<P> {
  /** Allowed fields only, copied by name; the only thing the model sees besides the prompt. */
  pkg: P;
  /** Values the privacy scan must not find in the package (a venue's secrets, staff name…). */
  secrets: string[];
  /** One line for the run log. */
  summary: string;
}

export interface AgentJob<P = unknown, O = unknown> {
  key: AgentKey;
  label: string;
  description: string;
  /** `platform` runs aren't tied to an account (the Test connection); `venue` runs are (from F2b). */
  scope: 'platform' | 'venue';
  defaults: AgentDefaults;
  prompts: Readonly<Record<string, PromptText>>;
  outputSchema: ZodType<O>;
  /** Cache the system prompt: only worth it above the model's minimum (about 1k tokens). */
  cacheSystem: boolean;
  buildInput(ctx: BuildContext): Promise<BuiltInput<P>> | BuiltInput<P>;
  /** The job's own checks on an answer that parsed. */
  check(out: O, pkg: P): CheckResult[];
  /** The answer's reasoning, for the "numbers in the input" check. */
  reasoningOf(out: O): string;
  /** A valid answer for the local fake model. */
  sandboxAnswer(pkg: P): O;
}
