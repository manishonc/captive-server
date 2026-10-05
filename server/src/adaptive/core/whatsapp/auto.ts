/**
 * PR W2b — Auto's rules, pure: which AI templates the 2-minute tick sends to Meta by itself, which
 * wait and why, and which rejected AI templates it asks the AI to fix. The tick
 * (whatsapp/auto.ts), the submit's own re-check (whatsapp/submit.ts) and the tab's overview call
 * these, so they never disagree.
 *
 * Auto sends a template only when a person could have sent it as it is and nothing about it needs
 * a person's choice (Manish, 2026-10-04/05):
 *  - written by the AI (`origin: 'ai'`) and not edited by hand since (`ai.appliedVersion`);
 *  - never one the AI wrote as an "alternative" (a person asked for it to compare: they send it);
 *  - every check passes with no warning, and its category is the message's rule;
 *  - a translation only once its English (the same name) is approved or in review;
 *  - one at a time per message × language (nothing else of the cell with Meta), and a new draft
 *    never next to an approved template (that would be an alternative);
 *  - a draft, or an AI fix of a rejected template not sent yet;
 *  - never again a version Auto already sent (unless Meta was only unreachable — at most 3 tries —
 *    or the account failed), never one Meta refused for a reason a person has to read;
 *  - never an AI fix from before W2b whose first kind is unknown (it may have been an alternative).
 * It ignores the guest-sending pause (it messages nobody).
 *
 * AI fixes: a rejected AI template (not an alternative, not edited by hand, under the AI-fix
 * limit) whose rejection came after the AI's last text gets one fix run per rejection.
 */

import type { Lang } from '../constants';
import { LANGS } from '../constants';
import type { WaDisplay } from './status';
import { ACCOUNT_SUBMIT_ERRORS, aiFixUnsentOf, MAX_AI_FIXES, TRANSIENT_SUBMIT_ERRORS } from './aiBrief';

export { ACCOUNT_SUBMIT_ERRORS, TRANSIENT_SUBMIT_ERRORS };

/** Auto sends at most this many templates in one tick (each submit reads the whole registry). */
export const AUTO_SENDS_PER_TICK = 5;
/** Of Meta's 100 new templates an hour, Auto uses at most this many (the rest stay for people). */
export const AUTO_CREATES_PER_HOUR = 80;
/** Auto's tries of one version while Meta only was unreachable (then a person looks). */
export const MAX_AUTO_ATTEMPTS = 3;
/** Auto's fix requests for one rejection while the runs ended for a passing reason (a deploy, the gate). */
export const MAX_AUTO_FIX_TRIES = 3;

export type AiKind = 'new' | 'translation' | 'alternative' | 'fix';

/** A template as Auto's rules see it (built by whatsapp/auto.ts from the registry). */
export interface AutoView {
  id: string;
  name: string;
  lang: Lang | null;
  /** The Adaptive message (null: not one of ours). */
  use: { journeyKey: string; poolKey: string } | null;
  origin: 'imported' | 'manual' | 'ai';
  dismissed: boolean;
  version: number;
  stage: 'draft' | 'submitting' | 'submitted';
  display: WaDisplay;
  metaStatus: string | null;
  requestedCategory: string | null;
  checks: { errors: number; warnings: number };
  /** The code of the last submit's error (null: none). */
  lastSubmitErrorCode: string | null;
  /** Approved and used for its message. */
  usable: boolean;
  ai: {
    kind: AiKind;
    /** What the AI first wrote it as (a fix keeps it): an "alternative" is never Auto's. */
    writtenAs: AiKind | null;
    appliedVersion: number;
    fixes: number;
    /** When the AI wrote this text (real ms; null: unreadable). */
    atMs: number | null;
    autoSubmittedVersion: number | null;
    /** Auto's tries of `autoSubmittedVersion`. */
    autoAttempts?: number | null;
    /** The version Meta last saw (absent: a template from before W2b). */
    sentVersion?: number | null;
  } | null;
  /** Meta's last change of it (real ms; null: never at Meta). */
  metaChangedAtMs: number | null;
  /** Sort order (oldest first). */
  orderMs: number;
}

export type AutoWait =
  | 'alternative'
  | 'edited_by_hand'
  | 'checks'
  | 'warnings'
  | 'category'
  | 'english'
  | 'cell_busy'
  | 'cell_has_approved'
  | 'meta_refused'
  | 'no_answer'
  | 'unknown_origin'
  | 'tried';

const kindOf = (k: AiKind | null | undefined): AiKind | null => k ?? null;

/** What the AI first wrote a template as (an older fix without `writtenAs`: unknown, so not an alternative). */
export function writtenAsOf(ai: AutoView['ai']): AiKind | null {
  if (!ai) return null;
  return kindOf(ai.writtenAs) ?? (ai.kind === 'fix' ? null : ai.kind);
}

/**
 * The AI fixed it and the fix hasn't been to Meta yet: Meta's last word is older than the fix (a
 * second fix would answer the same rejection). The cms has the same rule (whatsapp-words.ts).
 */
export function aiFixUnsent(v: Pick<AutoView, 'ai' | 'version' | 'metaChangedAtMs'>): boolean {
  return aiFixUnsentOf(v.ai, v.version, v.metaChangedAtMs);
}

const cellOf = (v: AutoView) => (v.use && v.lang ? `${v.use.journeyKey}:${v.use.poolKey}:${v.lang}` : null);
const withMeta = (v: AutoView) => v.stage === 'submitting' || v.display === 'in_review';

export interface AutoQueue {
  /** In the order to send (English first, then the oldest). */
  send: AutoView[];
  /** The AI templates Auto leaves for now, and why. */
  waiting: Array<{ id: string; name: string; lang: Lang | null; reason: AutoWait }>;
}

/**
 * The AI templates Auto would send now, and the ones it leaves (with why). `wanted` is the
 * category a message's templates must have (its rule).
 */
export function autoQueue(views: AutoView[], wanted: (use: { journeyKey: string; poolKey: string }) => string | null): AutoQueue {
  const live = views.filter((v) => !v.dismissed);
  const send: AutoView[] = [];
  const waiting: AutoQueue['waiting'] = [];
  const wait = (v: AutoView, reason: AutoWait) => waiting.push({ id: v.id, name: v.name, lang: v.lang, reason });
  const candidates = live
    .filter((v) => v.origin === 'ai' && v.ai && v.use && v.lang)
    .filter((v) => v.stage === 'draft' || (v.stage === 'submitted' && String(v.metaStatus ?? '').toUpperCase() === 'REJECTED' && aiFixUnsent(v)))
    .sort((a, b) => Number(b.lang === 'en') - Number(a.lang === 'en') || a.orderMs - b.orderMs);
  const taken = new Set<string>();
  for (const v of candidates) {
    const ai = v.ai!;
    const resend = v.stage === 'submitted';
    const code = v.lastSubmitErrorCode;
    const triedThis = ai.autoSubmittedVersion === v.version;
    if (writtenAsOf(ai) === 'alternative') wait(v, 'alternative');
    else if (ai.kind === 'fix' && writtenAsOf(ai) === null) wait(v, 'unknown_origin');
    else if (ai.appliedVersion !== v.version) wait(v, 'edited_by_hand');
    else if (v.checks.errors > 0) wait(v, 'checks');
    else if (v.checks.warnings > 0) wait(v, 'warnings');
    else if (v.requestedCategory !== wanted(v.use!)) wait(v, 'category');
    // Meta judged the text (a person reads why); an account error or Meta unreachable isn't that.
    else if (code && !TRANSIENT_SUBMIT_ERRORS.has(code) && !ACCOUNT_SUBMIT_ERRORS.has(code)) wait(v, 'meta_refused');
    else if (code && TRANSIENT_SUBMIT_ERRORS.has(code) && triedThis && (ai.autoAttempts ?? 1) >= MAX_AUTO_ATTEMPTS) wait(v, 'no_answer');
    else if (triedThis && !code) wait(v, 'tried');
    else {
      const cell = cellOf(v)!;
      const others = live.filter((x) => x.id !== v.id && cellOf(x) === cell);
      const english = v.lang === 'en' ? null : live.find((x) => x.name === v.name && x.lang === 'en') ?? null;
      if (english && !(english.display === 'approved' || english.display === 'in_review' || english.display === 'submitting')) wait(v, 'english');
      else if (!english && v.lang !== 'en') wait(v, 'english');
      else if (taken.has(cell) || others.some(withMeta)) wait(v, 'cell_busy');
      // Approved, used or paused by a person (a pause is a person's choice for the cell too).
      else if (!resend && others.some((x) => x.display === 'approved')) wait(v, 'cell_has_approved');
      else {
        send.push(v);
        taken.add(cell);
      }
    }
  }
  return { send, waiting };
}

/** Would Auto send this one template now (the submit's own re-check, on fresh reads)? */
export function autoMaySend(id: string, views: AutoView[], wanted: (use: { journeyKey: string; poolKey: string }) => string | null): { ok: true } | { ok: false; reason: AutoWait | 'not_eligible' } {
  const q = autoQueue(views, wanted);
  if (q.send.some((v) => v.id === id)) return { ok: true };
  return { ok: false, reason: q.waiting.find((w) => w.id === id)?.reason ?? 'not_eligible' };
}

/** Auto's fix request for one template (store.ts AutoFixStamp, pure). */
export interface AutoFixAsked {
  /** The rejection (Meta's change, real ms) it was asked for. */
  at: number | null;
  tries: number;
  /** The run ended for a passing reason: Auto may ask again for the same rejection. */
  retry: boolean;
}

/**
 * The rejected AI templates Auto asks the AI to fix: Meta rejected the AI's current text (no fix
 * waits to be sent), not edited by hand, not an alternative (nor a fix from before W2b of unknown
 * first kind), under the AI-fix limit — once per rejection (`asked`: each template's last request),
 * again only when that run ended for a passing reason, at most 3 tries.
 */
export function autoFixCandidates(views: AutoView[], asked: Record<string, AutoFixAsked>): AutoView[] {
  return views
    .filter((v) => !v.dismissed && v.origin === 'ai' && v.ai && v.use && v.lang && LANGS.includes(v.lang))
    .filter((v) => v.stage === 'submitted' && String(v.metaStatus ?? '').toUpperCase() === 'REJECTED')
    .filter((v) => writtenAsOf(v.ai) !== 'alternative' && !(v.ai!.kind === 'fix' && writtenAsOf(v.ai) === null))
    .filter((v) => v.ai!.appliedVersion === v.version && v.ai!.fixes < MAX_AI_FIXES)
    .filter((v) => !aiFixUnsent(v) && v.metaChangedAtMs !== null)
    .filter((v) => {
      const a = asked[v.id];
      return !a || a.at !== v.metaChangedAtMs || (a.retry && a.tries < MAX_AUTO_FIX_TRIES);
    })
    .sort((a, b) => Number(b.lang === 'en') - Number(a.lang === 'en') || a.orderMs - b.orderMs);
}

const WAIT_WORDS: Record<AutoWait, string> = {
  alternative: 'An alternative the AI wrote on request: send it yourself if you want it',
  edited_by_hand: 'Edited by hand since the AI wrote it: send it yourself',
  checks: 'A check fails',
  warnings: 'A check warns: Auto sends only templates without warnings',
  category: 'Its category isn’t the message’s rule',
  english: 'Waits for its English template to be approved or in review',
  cell_busy: 'Another template of this message and language is with Meta',
  cell_has_approved: 'This message and language already has an approved template: send it yourself if you want it',
  meta_refused: 'Meta refused it: a person looks first',
  no_answer: 'Meta didn’t take it after 3 tries (unreachable or no answer): send it yourself',
  unknown_origin: 'Fixed by the AI before Auto existed: send it yourself',
  tried: 'Auto sent this version already',
};

export function autoWaitWords(reason: AutoWait | string): string {
  return WAIT_WORDS[reason as AutoWait] ?? reason;
}
