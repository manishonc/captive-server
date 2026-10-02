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
 *  - PR F1: the bandit switch (global + per account) lives here too. Turning it on is a loosening
 *    ("BANDIT ON"); off is the brake (one click).
 *  - PR F2a: the AI agents' switch (global + per account) and the monthly AI budget, the same way:
 *    on is "AI ON", a higher budget is a loosened limit ("LOOSEN LIMITS"); off and a lower budget
 *    are one click.
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
  /** PR F1: the bandit (missing = off everywhere). */
  bandit?: { mode: BanditSwitch; accounts: Record<string, BanditSwitch> };
  /** PR F2a: the AI agents (missing = off everywhere) and the monthly budget in USD. */
  agents?: { mode: BanditSwitch; accounts: Record<string, BanditSwitch>; monthlyBudgetUsd: number };
}

export type BanditSwitch = 'off' | 'on';

export interface LaunchChange {
  default?: Mode;
  /** `null` removes the account's override (it follows the default again). */
  accounts?: Record<string, Mode | null>;
  paused?: boolean;
  safety?: Partial<SafetyLimits>;
  smsCountries?: string[];
  alertsEmail?: string | null;
  /** PR F1: `null` removes an account's bandit override. */
  bandit?: { mode?: BanditSwitch; accounts?: Record<string, BanditSwitch | null> };
  /** PR F2a: `null` removes an account's AI override. */
  agents?: { mode?: BanditSwitch; accounts?: Record<string, BanditSwitch | null>; monthlyBudgetUsd?: number };
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
    bandit: applyBandit(before.bandit, c.bandit),
    ...(before.agents || c.agents ? { agents: applyAgents(before.agents, c.agents) } : {}),
  };
}

function applyAgents(before: LaunchState['agents'], c: LaunchChange['agents']): NonNullable<LaunchState['agents']> {
  const a = before ?? { mode: 'off' as BanditSwitch, accounts: {}, monthlyBudgetUsd: 0 };
  const accounts = { ...a.accounts };
  for (const [t, m] of Object.entries(c?.accounts ?? {})) {
    if (m === null) delete accounts[t];
    else accounts[t] = m;
  }
  return { mode: c?.mode ?? a.mode, accounts, monthlyBudgetUsd: c?.monthlyBudgetUsd ?? a.monthlyBudgetUsd };
}

/** PR F2a: the AI agents for one account: its override, else the global switch. */
export function agentsFor(s: Pick<LaunchState, 'agents'>, tenant: string): BanditSwitch {
  const a = s.agents ?? { mode: 'off', accounts: {}, monthlyBudgetUsd: 0 };
  return has(a.accounts, tenant) ? a.accounts[tenant] : a.mode;
}

function applyBandit(before: LaunchState['bandit'], c: LaunchChange['bandit']): NonNullable<LaunchState['bandit']> {
  const b = before ?? { mode: 'off' as BanditSwitch, accounts: {} };
  const accounts = { ...b.accounts };
  for (const [t, m] of Object.entries(c?.accounts ?? {})) {
    if (m === null) delete accounts[t];
    else accounts[t] = m;
  }
  return { mode: c?.mode ?? b.mode, accounts };
}

/** The bandit for one account: its override, else the global switch. */
export function banditFor(s: Pick<LaunchState, 'bandit'>, tenant: string): BanditSwitch {
  const b = s.bandit ?? { mode: 'off', accounts: {} };
  return has(b.accounts, tenant) ? b.accounts[tenant] : b.mode;
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

export type LooseningKind = 'default_live' | 'account_live' | 'release_pause' | 'loosen_limits' | 'bandit_on' | 'agents_on';

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
  bandit_on: 'BANDIT ON',
  agents_on: 'AI ON',
};
const ORDER: LooseningKind[] = ['default_live', 'account_live', 'release_pause', 'loosen_limits', 'bandit_on', 'agents_on'];
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
  // PR F1: the bandit switch.
  const bb = before.bandit ?? { mode: 'off' as BanditSwitch, accounts: {} };
  const ab = after.bandit ?? bb;
  // The admin card calls it "Learning" (the bandit, in the code).
  if (bb.mode !== ab.mode) lines.push(`Learning (default): ${bb.mode} → ${ab.mode}`);
  for (const t of [...new Set([...Object.keys(bb.accounts), ...Object.keys(ab.accounts)])].sort()) {
    const was = has(bb.accounts, t) ? bb.accounts[t] : null;
    const will = has(ab.accounts, t) ? ab.accounts[t] : null;
    // `<account>: …` like the launch lines, so the admin card shows the account's name.
    if (was !== will) lines.push(`${t}: learning ${was ?? `default (${bb.mode})`} → ${will ?? `default (${ab.mode})`}`);
  }
  const tenantsB = new Set([...Object.keys(bb.accounts), ...Object.keys(ab.accounts)]);
  if ((bb.mode === 'off' && ab.mode === 'on') || [...tenantsB].some((t) => banditFor(before, t) === 'off' && banditFor(after, t) === 'on')) kinds.add('bandit_on');
  // PR F2a: the AI agents' switch and budget ("AI agents" on the admin card).
  if (before.agents || after.agents) {
    const ba = before.agents ?? { mode: 'off' as BanditSwitch, accounts: {}, monthlyBudgetUsd: 0 };
    const aa = after.agents ?? ba;
    if (ba.mode !== aa.mode) lines.push(`AI agents (default): ${ba.mode} → ${aa.mode}`);
    const tenantsA = [...new Set([...Object.keys(ba.accounts), ...Object.keys(aa.accounts)])].sort();
    for (const t of tenantsA) {
      const was = has(ba.accounts, t) ? ba.accounts[t] : null;
      const will = has(aa.accounts, t) ? aa.accounts[t] : null;
      if (was !== will) lines.push(`${t}: AI agents ${was ?? `default (${ba.mode})`} → ${will ?? `default (${aa.mode})`}`);
    }
    // Writing an account's own "on" asks for the phrase even while the default is on: that account
    // then stays on through a later "off by default".
    const ownOn = tenantsA.some((t) => aa.accounts[t] === 'on' && ba.accounts[t] !== 'on');
    if ((ba.mode === 'off' && aa.mode === 'on') || ownOn || tenantsA.some((t) => agentsFor(before, t) === 'off' && agentsFor(after, t) === 'on')) kinds.add('agents_on');
    if (ba.monthlyBudgetUsd !== aa.monthlyBudgetUsd) {
      lines.push(`AI budget: $${ba.monthlyBudgetUsd} → $${aa.monthlyBudgetUsd} a month`);
      if (aa.monthlyBudgetUsd > ba.monthlyBudgetUsd) kinds.add('loosen_limits');
    }
  }
  const loosening = ORDER.filter((k) => kinds.has(k));
  return { lines, loosening, confirmPhrase: loosening.length ? loosening.map((k) => PHRASES[k]).join(' AND ') : null, empty: lines.length === 0 };
}

/** Typed the phrase (case and extra spaces don't matter). */
export function confirmMatches(typed: unknown, phrase: string | null): boolean {
  if (phrase === null) return true;
  return typeof typed === 'string' && typed.trim().replace(/\s+/g, ' ').toUpperCase() === phrase;
}
