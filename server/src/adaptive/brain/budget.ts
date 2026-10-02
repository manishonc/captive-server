/**
 * The AI spend rules (PR F2a, F-D5). Pure.
 *
 *  - One platform budget a month (`AdaptiveConfig/global.agents.monthlyBudgetUsd`, default $100):
 *    at 100 % every agent stops until the month ends or the budget goes up; sends never notice.
 *    An alert goes to HeidiFi at 80 % and at 100 %, once per month, budget and level (a raised
 *    budget alerts again).
 *  - Each agent has its own runs-per-day cap (its settings).
 *  - Months and days are UTC and real time (money is real, the sandbox clock is not).
 */

export type BudgetBlock = 'budget' | 'daily_limit';

export interface BudgetInput {
  /** Spent this month so far, micro-USD. */
  spentMicro: number;
  budgetUsd: number;
  /** This agent's runs today (skipped runs not counted). */
  runsToday: number;
  maxRunsPerDay: number;
}

/** Why a run may not start, or null when it may. */
export function budgetBlock(i: BudgetInput): BudgetBlock | null {
  if (!(i.budgetUsd > 0) || i.spentMicro >= i.budgetUsd * 1_000_000) return 'budget';
  if (i.runsToday >= i.maxRunsPerDay) return 'daily_limit';
  return null;
}

/** The alert levels (80, 100) a run's cost crossed: before < level ≤ after. */
export function crossedLevels(beforeMicro: number, afterMicro: number, budgetUsd: number): Array<80 | 100> {
  if (!(budgetUsd > 0)) return [];
  const out: Array<80 | 100> = [];
  for (const level of [80, 100] as const) {
    const at = (budgetUsd * 1_000_000 * level) / 100;
    if (beforeMicro < at && afterMicro >= at) out.push(level);
  }
  return out;
}

/** `yyyymm` of a real-time moment (UTC). */
export function monthKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `yyyymmdd` of a real-time moment (UTC). */
export function dayKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${monthKeyOf(ms)}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** A counter as read for the budget: missing is 0, one that can't be read is over any limit (fails closed). */
export function counterValue(raw: unknown): number {
  // Missing is 0; `null` only comes from a hand edit — damaged, like any other non-number.
  if (raw === undefined) return 0;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : Number.POSITIVE_INFINITY;
}
