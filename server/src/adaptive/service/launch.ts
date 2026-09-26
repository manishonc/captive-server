/**
 * The admin launch card (plan §2.3, §4.2, §5: `GET/PUT /admin/launch`; PR D). Until now the
 * switches in `CaptivePortal_AdaptiveConfig/global` were set by hand in the Firebase console.
 *
 *  - Named fields only, by FieldPath (tenant ids are map keys), never a whole-doc write; the
 *    pause keeps `killSwitch.reason` a string or null, so PR 1's rules parser never falls back
 *    to the paused seed.
 *  - Every change bumps the doc's `version` and writes `history/{version}` (what changed,
 *    before and after) in the same transaction — as the seed and BillingConfig do.
 *  - Loosening changes need the typed phrase and the `baseVersion` the card loaded (409 when
 *    someone else changed it). The brake (pause, off, test, lower limits) needs neither, so it
 *    can't fail when it matters.
 *  - Going live is refused while no worker runs this code with the same identity key: an old
 *    worker doesn't know Start sending, and would send and charge at every held venue at once.
 *  - `launch.liveSince` is stamped here (core/runtime/launch.ts). The sandbox's /dev/launch uses
 *    the same function, so local runs exercise it too.
 */

import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../../firebase';
import { COL, CONFIG_DOC_ID, HISTORY } from '../store/collections';
import { accountLiveSince, clearEngineSettingsCache, modeFor, parseEngineSettings, readEngineSettingsStrict, venueHeld, type EngineSettings } from '../store/engineSettings';
import type { AdaptiveVenueDoc } from '../store/types';
import type { Actor } from '../core/schemas';
import { ApiError, conflict } from '../api/errors';
import { HttpError } from '../api/http';
import { toJson } from '../store/serialize';
import { KNOWN_PHONE_COUNTRIES } from '../core/runtime/phoneCountry';
import { applyChange, nextLiveSince, summarizeChange, confirmMatches, type LaunchChange, type LaunchState } from '../core/runtime/launch';
import { venueHasSomethingOn } from '../core/runtime/hold';
import { now as engineNow, refreshClock } from '../engine/clock';
import { getEngineStatus } from './engine';
import { accountNameOf } from '../core/owner/accountName';

const modeSchema = z.enum(['off', 'test', 'live']);
const tenantKey = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'not a valid account id');

export const launchChangeSchema = z
  .object({
    default: modeSchema.optional(),
    accounts: z.record(tenantKey, modeSchema.nullable()).optional(),
    paused: z.boolean().optional(),
    safety: z
      .object({
        maxSendsPerVenuePerDay: z.number().int().min(1).max(100_000),
        maxSendsPlatformPerDay: z.number().int().min(1).max(1_000_000),
        maxNewContactsPerApPerHour: z.number().int().min(1).max(10_000),
        staleAfterHours: z.number().min(1).max(72),
      })
      .partial()
      .optional(),
    smsCountries: z
      .array(z.string().length(2).transform((c) => c.toUpperCase()))
      .max(60)
      .refine((cs) => cs.every((c) => KNOWN_PHONE_COUNTRIES.includes(c)), 'only countries the phone table knows')
      .optional(),
    alertsEmail: z.string().trim().email().max(254).nullable().optional(),
  })
  .strict();

export const launchInputSchema = z.object({
  change: launchChangeSchema,
  baseVersion: z.number().int().min(0).optional(),
  confirm: z.string().max(100).optional(),
  note: z.string().trim().max(500).optional(),
  pauseReason: z.string().trim().max(200).optional(),
});

function stateOf(s: EngineSettings): LaunchState {
  return {
    default: s.launch.default,
    accounts: s.launch.accounts,
    liveSince: s.launch.liveSince ?? { default: null, accounts: {} },
    paused: s.paused,
    safety: s.safety,
    smsCountries: s.sms.allowedCountries,
    alertsEmail: s.alerts.email,
  };
}

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Is a worker running this code with the API's identity key? (Else going live is refused.) */
/** For a go-live: the worker's readiness couldn't be read → 503 (reload and try again), never a 500. */
async function goLiveProblemsOr503(): Promise<string[]> {
  try {
    return await goLiveProblems();
  } catch {
    throw new HttpError(503, 'engine_status_unknown', 'Could not confirm the worker is ready — reload and try again');
  }
}

async function goLiveProblems(): Promise<string[]> {
  const status = await getEngineStatus();
  const problems: string[] = [];
  const alive = status.workers.filter((w) => w.alive);
  if (!alive.length) problems.push('No adaptive-worker is running');
  if (alive.some((w) => !w.sameVersion)) problems.push('A worker runs different code than the server (deploy both from the same commit)');
  if (alive.some((w) => !w.sameKey)) problems.push("A worker's identity key differs from the server's (GUEST_OTP_PEPPER)");
  if (status.identity.apiMatchesPinned === false) problems.push("The server's identity key differs from the pinned one");
  const indexCheck = status.indexCheck as { ok?: boolean } | null;
  if (indexCheck && indexCheck.ok === false) problems.push('Firestore indexes are missing (see the index check)');
  return problems;
}

async function accountNames(ids: string[]): Promise<Record<string, { name: string | null; email: string | null }>> {
  const out: Record<string, { name: string | null; email: string | null }> = {};
  const unique = [...new Set(ids)].slice(0, 200);
  if (!unique.length) return out;
  const snaps = await db.getAll(...unique.map((id) => db.collection(COL.tenantUsers).doc(id)));
  for (const s of snaps) {
    out[s.id] = { name: accountNameOf((field) => s.get(field)), email: typeof s.get('email') === 'string' ? s.get('email') : null };
  }
  return out;
}

/** Per live account: how many venues still wait for their owner's Start sending. */
async function waitingVenues(settings: EngineSettings): Promise<Record<string, number>> {
  const anyLive = settings.launch.default === 'live' || Object.values(settings.launch.accounts).includes('live');
  if (!anyLive) return {};
  await refreshClock();
  const t = engineNow();
  const snap = await db.collection(COL.adaptiveVenues).get();
  const out: Record<string, number> = {};
  for (const d of snap.docs) {
    const av = d.data() as AdaptiveVenueDoc;
    if (!venueHasSomethingOn({ status: av.status, utility: { enabled: av.utility?.enabled === true } })) continue;
    if (venueHeld(settings, av, t)) out[av.tenantUserId] = (out[av.tenantUserId] ?? 0) + 1;
  }
  return out;
}

/** The last launch changes, read by id (`history/{version}`), so no query or index is involved. */
async function lastHistory(ref: FirebaseFirestore.DocumentReference, version: number, n = 10) {
  const ids: string[] = [];
  for (let v = version; v >= 1 && ids.length < n; v -= 1) ids.push(String(v));
  if (!ids.length) return [];
  const snaps = await db.getAll(...ids.map((id) => ref.collection(HISTORY).doc(id)));
  return snaps.filter((s) => s.exists);
}

export async function getLaunch() {
  const ref = db.collection(COL.config).doc(CONFIG_DOC_ID);
  // Only this read may fail the card: everything else degrades to a warning.
  const snap = await ref.get();
  const raw = (snap.data() ?? {}) as Record<string, any>;
  const settings = parseEngineSettings(snap.exists ? raw : undefined);
  const ls = settings.launch.liveSince ?? { default: null, accounts: {} };
  const warnings: string[] = [];
  const [history, waiting] = await Promise.all([
    lastHistory(ref, Number(raw.version) || 0).catch(() => {
      warnings.push('Could not read the launch history');
      return [];
    }),
    waitingVenues(settings).catch(() => {
      warnings.push('Could not count the venues waiting for Start sending');
      return {} as Record<string, number>;
    }),
  ]);
  // Names for every account the card shows: the overrides and the ones with venues waiting
  // (an account that follows a live default has no override).
  const names = await accountNames([...Object.keys(settings.launch.accounts), ...Object.keys(waiting)]).catch(() => {
    warnings.push('Could not read the account names');
    return {} as Record<string, { name: string | null; email: string | null }>;
  });
  const anyLive = settings.launch.default === 'live' || Object.values(settings.launch.accounts).includes('live');
  try {
    // The same checks as the go-live gate — shown before anything is live, too.
    const problems = await goLiveProblems();
    warnings.push(...(anyLive ? problems : problems.map((p) => `Going live would be refused: ${p}`)));
  } catch {
    warnings.push('Could not read the engine status');
  }
  if (!settings.alerts.email) warnings.push('No alert email is set: HeidiFi gets no Adaptive alerts');
  if (settings.launch.default === 'live' && ls.default === null) warnings.push('The default is live without a "live since" date (edited by hand?): every venue waits for Start sending');
  // Any live account whose date can't be read (no own entry and no default date, or a null/unreadable entry).
  for (const t of new Set([...Object.keys(settings.launch.accounts), ...Object.keys(ls.accounts)])) {
    if (modeFor(settings, t) === 'live' && accountLiveSince(settings, t) === null && !(settings.launch.default === 'live' && !(t in settings.launch.accounts) && ls.default === null)) {
      warnings.push(`${t} is live without a "live since" date: its venues wait for Start sending`);
    }
  }
  return {
    version: Number(raw.version) || 0,
    launch: {
      default: settings.launch.default,
      accounts: settings.launch.accounts,
      liveSince: { default: iso(ls.default), accounts: Object.fromEntries(Object.entries(ls.accounts).map(([t, ms]) => [t, iso(ms)])) },
      changedAt: toJson(raw.launch?.changedAt ?? null),
      changedBy: settings.launch.changedBy,
      note: typeof raw.launch?.note === 'string' ? raw.launch.note : null,
    },
    paused: settings.paused,
    pauseReason: typeof raw.killSwitch?.reason === 'string' ? raw.killSwitch.reason : null,
    safety: settings.safety,
    sms: { allowedCountries: settings.sms.allowedCountries, knownCountries: KNOWN_PHONE_COUNTRIES },
    alerts: { email: settings.alerts.email },
    accountNames: names,
    waitingForStartSending: waiting,
    warnings,
    history: history.map((d) => ({ version: Number(d.get('version')) || Number(d.id) || null, at: toJson(d.get('at') ?? d.get('updatedAt') ?? null), by: d.get('by') ?? d.get('updatedBy') ?? null, note: d.get('note') ?? null, lines: d.get('lines') ?? null })),
  };
}

/** What a change would do, and the phrase it needs — nothing is written. */
export async function checkLaunch(body: unknown) {
  const input = launchInputSchema.parse(body ?? {});
  const settings = await readEngineSettingsStrict();
  const before = stateOf(settings);
  const after = applyChange(before, input.change as LaunchChange);
  const summary = summarizeChange(before, after);
  const goesLive = summary.loosening.includes('default_live') || summary.loosening.includes('account_live');
  return { summary, blockers: goesLive ? await goLiveProblemsOr503() : [] };
}

export interface ApplyOptions {
  actor: Actor;
  /** Sandbox /dev/launch: no phrase, no base version, no worker check (the local stack only). */
  sandbox?: boolean;
}

/** Applies a launch change in one transaction (see the file header). */
export async function applyLaunchChange(body: unknown, opts: ApplyOptions) {
  const input = launchInputSchema.parse(body ?? {});
  const ref = db.collection(COL.config).doc(CONFIG_DOC_ID);
  // The worker check reads other docs, so it runs before the transaction (it can only refuse).
  // A failed read here must not pass for "nothing goes live" — the brake doesn't need it.
  const current = await readEngineSettingsStrict().then(stateOf).catch(() => null);
  const firstLook = current ? summarizeChange(current, applyChange(current, input.change as LaunchChange)) : null;
  const goesLive = Boolean(firstLook && (firstLook.loosening.includes('default_live') || firstLook.loosening.includes('account_live')));
  const blockers = goesLive && !opts.sandbox ? await goLiveProblemsOr503() : [];
  if (blockers.length) throw new HttpError(409, 'engine_not_ready', `Going live is refused: ${blockers.join('; ')}`, { blockers });
  const gateChecked = goesLive && !opts.sandbox;

  const realNow = Date.now();
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw conflict('AdaptiveConfig/global is missing (the server creates it at start)');
    const raw = snap.data() as Record<string, any>;
    const version = Number(raw.version) || 0;
    const before = stateOf(parseEngineSettings(raw));
    const after = applyChange(before, input.change as LaunchChange);
    const summary = summarizeChange(before, after);
    if (summary.empty) return { changed: false as const, summary, version };
    const loosens = summary.loosening.length > 0;
    // The worker check ran on the first look; if the real doc makes this a move into live the
    // first look didn't see (e.g. that read failed), refuse rather than skip it.
    const txGoesLive = summary.loosening.includes('default_live') || summary.loosening.includes('account_live');
    if (txGoesLive && !opts.sandbox && !gateChecked) throw new HttpError(503, 'engine_status_unknown', 'Could not confirm the worker is ready — reload and try again');
    // Only the brake (pause, off, test, lower limits, fewer countries) goes through on a stale card.
    const brakeOnly = !loosens && before.alertsEmail === after.alertsEmail;
    if (!brakeOnly && !opts.sandbox) {
      if (input.baseVersion === undefined) throw new ApiError('bad_request', 'Say which version you changed (baseVersion)');
      if (input.baseVersion !== version) throw conflict('Someone else changed the launch settings meanwhile — reload and check');
    }
    if (loosens && !opts.sandbox) {
      if (!confirmMatches(input.confirm, summary.confirmPhrase)) {
        throw new HttpError(400, 'confirmation_required', `Type “${summary.confirmPhrase}” to confirm`, { confirmPhrase: summary.confirmPhrase, summary });
      }
    }
    const liveSince = nextLiveSince(before, after, realNow);
    const by = opts.actor.uid;
    const next = version + 1;
    const pairs: Array<[FieldPath, unknown]> = [];
    const set = (path: string[], value: unknown) => pairs.push([new FieldPath(...path), value]);
    if (after.default !== before.default) set(['launch', 'default'], after.default);
    for (const [t, m] of Object.entries(input.change.accounts ?? {})) set(['launch', 'accounts', t], m === null ? FieldValue.delete() : m);
    set(['launch', 'liveSince'], {
      default: liveSince.default === null ? null : new Date(liveSince.default),
      accounts: Object.fromEntries(Object.entries(liveSince.accounts).map(([t, ms]) => [t, ms === null ? null : new Date(ms)])),
    });
    set(['launch', 'changedAt'], new Date(realNow));
    set(['launch', 'changedBy'], by);
    if (input.note !== undefined) set(['launch', 'note'], input.note);
    if (after.paused !== before.paused) {
      set(['killSwitch', 'sendingPaused'], after.paused);
      set(['killSwitch', 'reason'], after.paused ? input.pauseReason || 'Paused by HeidiFi' : null);
    }
    if (input.change.safety) set(['safety'], after.safety);
    if (input.change.smsCountries) set(['sms', 'allowedCountries'], after.smsCountries);
    if (input.change.alertsEmail !== undefined) set(['alerts', 'email'], after.alertsEmail);
    set(['version'], next);
    set(['updatedAt'], new Date(realNow));
    set(['updatedBy'], by);
    const [first, ...rest] = pairs;
    tx.update(ref, first[0], first[1], ...rest.flat());
    tx.set(ref.collection(HISTORY).doc(String(next)), {
      version: next,
      kind: 'launch',
      at: new Date(realNow),
      by,
      byKind: opts.actor.kind,
      note: input.note ?? null,
      lines: summary.lines,
      loosening: summary.loosening,
      before: {
        default: before.default,
        accounts: before.accounts,
        liveSince: isoLiveSince(before.liveSince),
        paused: before.paused,
        pauseReason: typeof raw.killSwitch?.reason === 'string' ? raw.killSwitch.reason : null,
        safety: before.safety,
        smsCountries: before.smsCountries,
        alertsEmail: before.alertsEmail,
      },
      after: {
        default: after.default,
        accounts: after.accounts,
        // What this change wrote (not `after.liveSince`, which still holds the old dates).
        liveSince: isoLiveSince(liveSince),
        paused: after.paused,
        pauseReason: after.paused !== before.paused ? (after.paused ? input.pauseReason || 'Paused by HeidiFi' : null) : typeof raw.killSwitch?.reason === 'string' ? raw.killSwitch.reason : null,
        safety: after.safety,
        smsCountries: after.smsCountries,
        alertsEmail: after.alertsEmail,
      },
    });
    return { changed: true as const, summary, version: next };
  });
  // This API process sees it at once; the worker within ~10 s, other API processes within 60 s.
  clearEngineSettingsCache();
  // A committed change (the brake above all) always answers 200, even if re-reading the card fails.
  const view = await getLaunch().catch(() => null);
  return { changed: result.changed, summary: result.summary, ...(view ?? { version: result.version, warnings: ['Saved — reload the card to see the new state'] }) };
}

function isoLiveSince(ls: LaunchState['liveSince']) {
  return { default: iso(ls.default), accounts: Object.fromEntries(Object.entries(ls.accounts).map(([t, ms]) => [t, iso(ms)])) };
}

export function putLaunch(body: unknown, actor: Actor) {
  return applyLaunchChange(body, { actor });
}

