/**
 * Shared shapes of the AI foundation (PR F2a; from PR W2 a job may also apply its answer). Pure:
 * no Firestore, no model SDK, so the API process can import them without ever loading the model
 * client.
 */

import type { Transaction } from 'firebase-admin/firestore';
import type { ZodType } from 'zod';
import type { CheckResult } from './checks';

/** Every agent there is: the admin's "Test connection" and (PR W2) the WhatsApp template writer. */
export type AgentKey = 'ping' | 'wa_template_writer';

export type Effort = 'low' | 'medium' | 'high';

/**
 * Who asked for a run: the admin's Test connection, a schedule, a person (`manual`: one run an admin
 * asked for, e.g. "Suggest with AI" — it needs the AI switch, not the agent's scheduled switch),
 * the sandbox.
 */
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
  /**
   * What the job's checks and its `apply` need but the model must not see (PR W2: the check
   * context, the target template). Stored on the run as JSON (recovery applies from it).
   */
  local?: unknown;
}

/** What `apply` did with a passed answer (stamped on the run in the same transaction). */
export interface ApplyDecision {
  /** applied: used; superseded: no longer wanted (the registry moved on); failed: unusable for good. */
  state: 'applied' | 'superseded' | 'failed';
  code: string | null;
  detail: string | null;
  /** What it wrote (for the run log's link). */
  ref?: { templateId: string; name: string } | null;
}

export interface ApplyArgs<P, O> {
  runId: string;
  /** The task the run belongs to (null: a direct run). */
  taskId: string | null;
  out: O;
  pkg: P;
  local: unknown;
  trigger: RunTrigger;
  modelUsed: string | null;
  promptVersion: string | null;
}

/** A run's end, for the job's own log (never a passed answer: `apply` writes that one). */
export interface RunReport {
  runId: string;
  agentKey: AgentKey;
  trigger: RunTrigger;
  outcome: RunOutcome;
  reason: string | null;
  params: Record<string, unknown>;
  /** The first failed check's words (a rejected run). */
  detail: string | null;
  modelUsed: string | null;
  /** The task the run belongs to (null: a direct run). */
  taskId: string | null;
  /** The run's stored local part, when the task's params aren't at hand (a run closed or applied later). */
  local?: unknown;
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
  /** The job's own checks on an answer that parsed (`local`: the input's non-model part). */
  check(out: O, pkg: P, local?: unknown): CheckResult[];
  /** The answer's reasoning, for the "numbers in the input" check. */
  reasoningOf(out: O): string;
  /** A valid answer for the local fake model. */
  sandboxAnswer(pkg: P): O;
  /** Scheduled runs wait while guest sending is paused (none today: the writer messages nobody). */
  waitsOnSendingPause?: boolean;
  /**
   * Before anything is recorded: a run that is no longer needed is skipped without a run record
   * (the job logs it in its own log). Never throws to stop a run: a throw fails the task.
   */
  precheck?(ctx: { params: Record<string, unknown>; trigger: RunTrigger; realNow: number }): Promise<{ skip: string; detail?: string } | null>;
  /**
   * Uses a passed answer, exactly once: inside one transaction that also stamps the run's `apply`
   * (store/agents.ts `applyRunOnce`) — all reads before any write, no side effect outside the
   * transaction (Firestore may run it again). A permanent conflict is a decision, not a throw.
   */
  apply?(tx: Transaction, args: ApplyArgs<P, O>): Promise<ApplyDecision>;
  /** Every run that isn't applied (skipped, rejected, failed), for the job's own log. Never throws. */
  report?(r: RunReport): Promise<void>;
}
