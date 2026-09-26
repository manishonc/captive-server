/**
 * The admin launch card (plan §2.3, §4.2, §5; PR D): what a change does, whether it needs a
 * typed confirmation, and the per-account "live since" dates Start sending relies on. Pure.
 *
 *  - Only changes that LOOSEN sending need a typed phrase (D-D5): an account or the default
 *    going live, releasing the pause, higher safety limits, more SMS countries. Pausing, going
 *    off or to a test run, lower limits: one click (the emergency brake can never fail on a
 *    typo). The server computes the phrase; the card shows it.
 *  - "Live since" moves every time the default or an account moves into live (fail closed: a
 *    venue turned on during an off gap waits for its owner's click too). An account that stays
 *    live keeps its date.
 */

export type Mode = 'off' | 'test' | 'live';

export interface SafetyLimits {
  maxSendsPerVenuePerDay: number;
  maxSendsPlatformPerDay: number;
  maxNewContactsPerApPerHour: number;
  staleAfterHours: number;
}

export interface LaunchState {
  default: Mode;
  accounts: Record<string, Mode>;
  liveSince: { default: number | null; accounts: Record<string, number | null> };
  paused: boolean;
  safety: SafetyLimits;
  smsCountries: string[];
  alertsEmail: string | null;
}

export interface LaunchChange {
  default?: Mode;
  /** `null` removes the account's override (it follows the default again). */
  accounts?: Record<string, Mode | null>;
  paused?: boolean;
  safety?: Partial<SafetyLimits>;
  smsCountries?: string[];
  alertsEmail?: string | null;
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function effectiveMode(s: Pick<LaunchState, 'default' | 'accounts'>, tenant: string): Mode {
  return has(s.accounts, tenant) ? s.accounts[tenant] : s.default;
}

export function accountLiveSinceOf(s: Pick<LaunchState, 'liveSince'>, tenant: string): number | null {
  return has(s.liveSince.accounts, tenant) ? s.liveSince.accounts[tenant] ?? null : s.liveSince.default ?? null;
}

/** The state after a change (modes, pause, limits, countries, alert address — not yet `liveSince`). */
export function applyChange(before: LaunchState, c: LaunchChange): LaunchState {
  const accounts = { ...before.accounts };
  for (const [t, m] of Object.entries(c.accounts ?? {})) {
    if (m === null) delete accounts[t];
    else accounts[t] = m;
  }
  return {
    default: c.default ?? before.default,
    accounts,
    liveSince: before.liveSince,
    paused: c.paused ?? before.paused,
    safety: { ...before.safety, ...(c.safety ?? {}) },
    smsCountries: c.smsCountries ?? before.smsCountries,
    alertsEmail: c.alertsEmail === undefined ? before.alertsEmail : c.alertsEmail,
  };
}

/** The new `liveSince` after a change, at real time `now` (see the file header). */
export function nextLiveSince(before: LaunchState, after: Pick<LaunchState, 'default' | 'accounts'>, now: number): LaunchState['liveSince'] {
  const ls = { default: before.liveSince.default ?? null, accounts: { ...before.liveSince.accounts } };
  const tenants = new Set([...Object.keys(before.accounts), ...Object.keys(after.accounts), ...Object.keys(ls.accounts)]);
  const defaultGoesLive = before.default !== 'live' && after.default === 'live';
  if (defaultGoesLive) {
    // An account that stays live (through its own override) keeps its date before the default's moves.
    for (const t of tenants) {
      // (Unknown before → `now`: it was live before now, so everything turned on until now stays held.)
      if (effectiveMode(before, t) === 'live' && effectiveMode(after, t) === 'live' && !has(ls.accounts, t)) ls.accounts[t] = accountLiveSinceOf(before, t) ?? now;
    }
    ls.default = now;
    // Accounts that follow the default again and weren't live: their own old date goes (they get the new one).
    for (const t of Object.keys(ls.accounts)) {
      if (!has(after.accounts, t) && effectiveMode(before, t) !== 'live') delete ls.accounts[t];
    }
  }
  for (const t of tenants) {
    const was = effectiveMode(before, t);
    const will = effectiveMode(after, t);
    if (was !== 'live' && will === 'live') {
      // Following the default that just went live: the default's date already says it.
      if (defaultGoesLive && !has(after.accounts, t)) continue;
      ls.accounts[t] = now;
    } else if (was === 'live' && will === 'live' && !has(ls.accounts, t) && accountLiveSinceOf(before, t) !== accountLiveSinceOf({ liveSince: ls }, t)) {
      // Still live, but its fallback date would move: keep the date it has been live since (unknown → now).
      ls.accounts[t] = accountLiveSinceOf(before, t) ?? now;
    }
  }
  return ls;
}

export type LooseningKind = 'default_live' | 'account_live' | 'release_pause' | 'loosen_limits';

export interface ChangeSummary {
  /** Plain lines for the card: "tenant_x: test run → live". */
  lines: string[];
  loosening: LooseningKind[];
  /** The phrase to type; null when nothing loosens sending (one click is enough). */
  confirmPhrase: string | null;
  /** Nothing would change. */
  empty: boolean;
}

const PHRASES: Record<LooseningKind, string> = {
  default_live: 'LIVE FOR EVERYONE',
  account_live: 'GO LIVE',
  release_pause: 'RELEASE PAUSE',
  loosen_limits: 'LOOSEN LIMITS',
};
const ORDER: LooseningKind[] = ['default_live', 'account_live', 'release_pause', 'loosen_limits'];
const MODE_WORDS: Record<Mode, string> = { off: 'off', test: 'test run', live: 'live' };

export function summarizeChange(before: LaunchState, after: LaunchState): ChangeSummary {
  const lines: string[] = [];
  const kinds = new Set<LooseningKind>();
  if (before.default !== after.default) {
    lines.push(`Default: ${MODE_WORDS[before.default]} → ${MODE_WORDS[after.default]}`);
    if (after.default === 'live') kinds.add('default_live');
  }
  const tenants = new Set([...Object.keys(before.accounts), ...Object.keys(after.accounts)]);
  for (const t of [...tenants].sort()) {
    const b = has(before.accounts, t) ? before.accounts[t] : null;
    const a = has(after.accounts, t) ? after.accounts[t] : null;
    if (b === a) continue;
    lines.push(`${t}: ${b ? MODE_WORDS[b] : `default (${MODE_WORDS[before.default]})`} → ${a ? MODE_WORDS[a] : `default (${MODE_WORDS[after.default]})`}`);
    if (effectiveMode(before, t) !== 'live' && effectiveMode(after, t) === 'live') kinds.add(a === null && after.default === 'live' && before.default !== 'live' ? 'default_live' : 'account_live');
  }
  if (before.paused !== after.paused) {
    lines.push(after.paused ? 'Pause all sending' : 'Release the pause (live accounts send again)');
    if (!after.paused) kinds.add('release_pause');
  }
  for (const k of Object.keys(after.safety) as Array<keyof SafetyLimits>) {
    if (before.safety[k] === after.safety[k]) continue;
    lines.push(`${k}: ${before.safety[k]} → ${after.safety[k]}`);
    if (after.safety[k] > before.safety[k]) kinds.add('loosen_limits');
  }
  const added = after.smsCountries.filter((c) => !before.smsCountries.includes(c));
  const removed = before.smsCountries.filter((c) => !after.smsCountries.includes(c));
  if (added.length) {
    lines.push(`SMS countries added: ${added.join(', ')}`);
    kinds.add('loosen_limits');
  }
  if (removed.length) lines.push(`SMS countries removed: ${removed.join(', ')}`);
  if (before.alertsEmail !== after.alertsEmail) lines.push(`Alert email: ${before.alertsEmail ?? '(none)'} → ${after.alertsEmail ?? '(none)'}`);
  const loosening = ORDER.filter((k) => kinds.has(k));
  return { lines, loosening, confirmPhrase: loosening.length ? loosening.map((k) => PHRASES[k]).join(' AND ') : null, empty: lines.length === 0 };
}

/** Typed the phrase (case and extra spaces don't matter). */
export function confirmMatches(typed: unknown, phrase: string | null): boolean {
  if (phrase === null) return true;
  return typeof typed === 'string' && typed.trim().replace(/\s+/g, ' ').toUpperCase() === phrase;
}
