/**
 * PR W2b — Auto, run by the WhatsApp template tick (whatsapp/sync.ts) while Auto is on: it sends the
 * AI templates Auto's rules allow (core/whatsapp/auto.ts) to Meta — the same transaction-safe
 * submit as the button (whatsapp/submit.ts), with the day's cap counted inside it — and asks the AI
 * to fix the AI templates Meta rejected (whatsapp/aiRequests.ts `planAutoFixes`).
 *
 *  - Never while the connection doesn't work (also: the last sync failed on the account), Meta
 *    asked us to slow down, Auto paused after Meta failed it, or the day's cap is reached; at most 5
 *    sends a tick, never past the tick's time, each with the lease renewed.
 *  - Meta failing it: an account error (the token, its permission) stops Auto for an hour, no answer
 *    or Meta unreachable for 10 minutes (the place in the day goes back: submit.ts revert). The
 *    hour's creates (80 for Auto) or the template limit stop only new drafts: fixes still go again.
 *  - What Auto leaves, and why, goes to the activity log once per template, version and reason a
 *    day (routine); the cap reached, once a day.
 *  - It ignores the guest-sending pause (it messages nobody; Manish, 2026-10-05).
 */

import { ACCOUNT_SUBMIT_ERRORS, AUTO_SENDS_PER_TICK, autoQueue, autoWaitWords, type AutoQueue } from '../core/whatsapp/auto';
import { HttpError } from '../api/http';
import { metaLanguageFor } from '../core/whatsapp/template';
import { autoViewsFor, wantedFor } from './autoViews';
import { planAutoFixes, snapshotOf } from './aiRequests';
import { loadPools } from './context';
import { metaClient } from './source';
import { submitTemplate } from './submit';
import { AUTO_ACTOR, autoDayOf, autoSubmitsToday, listTemplates, readOps, updateOps, writeLog, type WaOps } from './store';

export interface AutoRun {
  ran: boolean;
  /** Why Auto didn't run, or stopped early (null: it went through its list). */
  stopped: string | null;
  sent: number;
  /** Sends the submit refused (another tick decides again). */
  skipped: number;
  /** AI fix runs queued. */
  fixes: number;
  lostLease?: boolean;
}

const HOUR = 60 * 60_000;
/** After an account error Auto waits this long; after no answer or Meta unreachable, AUTO_PAUSE_SHORT_MS. */
export const AUTO_PAUSE_ACCOUNT_MS = HOUR;
export const AUTO_PAUSE_SHORT_MS = 10 * 60_000;

export type AutoBlock = 'not_connected' | 'not_configured' | 'meta_account' | 'meta_backoff' | 'meta_paused' | 'cap_zero' | 'cap_reached';

/** Why Auto can't act at all now (null: it can). */
export function autoBlocked(ops: WaOps, maxPerDay: number, realNow: number, clientReady: boolean): AutoBlock | null {
  if (!ops.wabaId || !ops.connection?.ok) return 'not_connected';
  if (!clientReady) return 'not_configured';
  // The last sync failed on the account (an expired token…): no send could get through.
  if (ops.lastSync && !ops.lastSync.ok && ops.lastSync.error && ACCOUNT_SUBMIT_ERRORS.has(ops.lastSync.error.code)) return 'meta_account';
  if (ops.backoffUntilMs !== null && ops.backoffUntilMs > realNow) return 'meta_backoff';
  if (ops.autoPauseUntilMs !== null && ops.autoPauseUntilMs > realNow) return 'meta_paused';
  if (maxPerDay <= 0) return 'cap_zero';
  if (autoSubmitsToday(ops, autoDayOf(realNow)) >= maxPerDay) return 'cap_reached';
  return null;
}

/** One log row a day per key (Auto's "left for now" and "cap reached" notes). */
async function noteOnce(ops: WaOps, day: string, notes: Array<{ key: string; write: () => Promise<void> }>): Promise<void> {
  const seen = ops.autoNoted.day === day ? new Set(ops.autoNoted.keys) : new Set<string>();
  const fresh = notes.filter((n) => !seen.has(n.key));
  if (!fresh.length) return;
  for (const n of fresh) {
    await n.write();
    seen.add(n.key);
  }
  const keys = [...seen].slice(-500);
  await updateOps({ autoNoted: { day, keys } });
  // A later note in the same run starts from what was just written.
  ops.autoNoted = { day, keys };
}

async function pauseAuto(ms: number): Promise<void> {
  await updateOps({ autoPauseUntilMs: Date.now() + ms });
}

const STOP_WORDS: Record<string, string> = {
  meta_account: 'Meta refused the account (the token or its permission): Auto waits an hour — check the connection',
  meta_no_answer: 'Meta gave no answer: Auto waits 10 minutes',
  meta_unavailable: 'Meta couldn’t be reached: Auto waits 10 minutes',
  meta_backoff: 'Meta asked us to slow down',
  creates_hour: 'Auto used its 80 new templates for this hour (the other 20 of Meta’s 100 stay for people): new drafts wait for the next hour',
  template_limit: 'Near Meta’s template limit (or the count is unknown until the next full sync): new drafts wait',
  rate_limited: 'Meta’s new templates for this hour are used',
};

export async function runAuto(args: { maxPerDay: number; deadlineMs: number; renew: () => Promise<boolean> }): Promise<AutoRun> {
  const realNow = Date.now();
  const day = autoDayOf(realNow);
  const ops = await readOps();
  const out: AutoRun = { ran: true, stopped: null, sent: 0, skipped: 0, fixes: 0 };
  const [pools, docs] = await Promise.all([loadPools(), listTemplates()]);
  const views = autoViewsFor(docs, pools, ops);
  const queue: AutoQueue = autoQueue(views, wantedFor(pools));

  // What Auto leaves, once a day per template, version and reason.
  const versionOf = new Map(views.map((v) => [v.id, v.version]));
  await noteOnce(
    ops,
    day,
    queue.waiting.map((w) => ({
      key: `${w.id}:${versionOf.get(w.id) ?? 0}:${w.reason}`,
      write: () =>
        writeLog(
          { kind: 'auto.left', level: 'routine', actor: AUTO_ACTOR, summary: `Auto leaves ${w.name} (${w.lang ?? '—'}) for now: ${autoWaitWords(w.reason)}`, detail: { reason: w.reason } },
          { templateId: w.id, name: w.name, language: w.lang ? metaLanguageFor(w.lang) : null },
        ),
    })),
  );

  const blocked = autoBlocked(ops, args.maxPerDay, realNow, metaClient().ready());
  if (blocked) {
    out.stopped = blocked;
    if (blocked === 'cap_reached' && queue.send.length) {
      await noteOnce(ops, day, [
        {
          key: 'cap_reached',
          write: () =>
            writeLog({
              kind: 'auto.cap_reached',
              level: 'info',
              actor: AUTO_ACTOR,
              summary: `Auto sent its ${args.maxPerDay} templates for today: ${queue.send.length} more wait for tomorrow (UTC), or raise the cap on Launch & health`,
              detail: { maxPerDay: args.maxPerDay, waiting: queue.send.length },
            }),
        },
      ]);
    }
  } else {
    // The hour's creates or the template limit stop only creates: resends of AI fixes still go.
    let noCreates: string | null = null;
    let tried = 0;
    for (const v of queue.send) {
      if (tried >= AUTO_SENDS_PER_TICK) break;
      if (noCreates && v.stage === 'draft') continue;
      // One edit can take three Meta calls of up to 15 s each.
      if (Date.now() > args.deadlineMs - 60_000) {
        out.stopped = 'time';
        break;
      }
      if (!(await args.renew())) return { ...out, lostLease: true };
      tried += 1;
      try {
        const r = await submitTemplate(v.id, v.version, AUTO_ACTOR, { requireNoWarnings: true, auto: { day, maxPerDay: args.maxPerDay } });
        if (r.outcome === 'submitted' || r.outcome === 'adopted') out.sent += 1;
        else if (r.outcome === 'unknown') {
          // No answer from Meta: nothing more for a while (the repair looks it up).
          out.stopped = 'meta_no_answer';
          await pauseAuto(AUTO_PAUSE_SHORT_MS);
          break;
        } else if (r.error && ACCOUNT_SUBMIT_ERRORS.has(r.error.kind)) {
          // The account, not the template: stop at once (the submit gave the place back).
          out.stopped = 'meta_account';
          await pauseAuto(AUTO_PAUSE_ACCOUNT_MS);
          break;
        } else if (r.error?.kind === 'rate_limited' || r.error?.kind === 'unavailable') {
          out.stopped = r.error.kind === 'rate_limited' ? 'meta_backoff' : 'meta_unavailable';
          if (r.error.kind === 'unavailable') await pauseAuto(AUTO_PAUSE_SHORT_MS);
          break;
        } else out.skipped += 1; // refused or locked: the submit logged Meta's words; a person looks
      } catch (err) {
        if (err instanceof HttpError && err.status === 429) {
          if (err.code === 'creates_hour' || err.code === 'template_limit') {
            noCreates = err.code;
            out.stopped = err.code;
            continue;
          }
          out.stopped = err.code; // the day's cap, Meta's slow-down or its 100 an hour
          break;
        }
        // A 409 (changed meanwhile, another one with Meta) or a 422 (a check): the next tick decides again.
        out.skipped += 1;
      }
    }
    // Why Auto stopped short (not the cap: it has its own note) — once a day per reason.
    if (out.stopped && out.stopped !== 'auto_cap' && out.stopped !== 'time') {
      const why = out.stopped;
      await noteOnce(ops, day, [
        {
          key: `stopped:${why}`,
          write: () => writeLog({ kind: 'auto.stopped', level: 'info', actor: AUTO_ACTOR, summary: `Auto stopped: ${STOP_WORDS[why] ?? why}`, detail: { reason: why } }),
        },
      ]);
    }
    if (out.sent) {
      await writeLog({
        kind: 'auto.run',
        level: 'info',
        actor: AUTO_ACTOR,
        summary: `Auto sent ${out.sent} template${out.sent === 1 ? '' : 's'} to Meta for review${queue.send.length > out.sent + out.skipped ? ` (${queue.send.length - out.sent - out.skipped} more next time)` : ''}`,
        detail: { sent: out.sent, skipped: out.skipped, ready: queue.send.length, stopped: out.stopped, maxPerDay: args.maxPerDay },
      });
    }
  }

  // The AI fixes, on the registry read above (a template Auto just sent again isn't a candidate:
  // its fix was unsent until now).
  if (await args.renew()) out.fixes = await planAutoFixes(realNow, snapshotOf(docs, pools, ops));
  else out.lostLease = true;
  return out;
}
