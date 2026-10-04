/**
 * Keeping the registry equal to Meta (PR W1).
 *
 * `reconcile` — one paged list of every template of the account, matched by name + language:
 *  - a template we don't have is imported (OTP, legacy, or one of ours by its `hf_` name);
 *  - a change of status, category, quality or text is applied in one transaction that also writes
 *    the log row, the timeline entry and the alerts it brings;
 *  - a template is marked deleted only after a COMPLETE list without it AND a read that Meta no
 *    longer has it (a failed page never deletes anything);
 *  - the `hf_<pool>_<n>` counters move past every number Meta has.
 *
 * `runWhatsAppTemplateTick` — every 2 minutes in the API server (jobs/whatsappTemplates.ts), one
 * at a time (a lease on `AdaptiveConfig/whatsapp`, as deploys can overlap two containers), idle
 * until "Check connection" has found the account:
 *  1. stuck submits (no answer from Meta for 10 minutes) → looked up by name: adopted, or put back;
 *  2. a sync when due — at once after a webhook hint, every 15 minutes while anything is with Meta,
 *     else every 6 hours;
 *  3. alerts waiting on templates → emailed (each once: `raiseAlert` keys them);
 *  4. the 08:00 (Zurich) summary, once a day, skipped when there is nothing to tell.
 */

import { randomUUID } from 'crypto';
import { contentKey, parseMetaTemplate, parseOurName, type MetaTemplateFacts } from '../core/whatsapp/template';
import { alertsForChange, digestText, rejectionWords, type DigestItem } from '../core/whatsapp/status';
import { whatsappTemplateIdFor } from '../core/runtime/ids';
import { localParts } from '../core/runtime/time';
import { now as engineNow, refreshClock } from '../engine/clock';
import { dayKey, raiseAlert } from '../engine/alerts';
import { tsMs } from '../store/time';
import { OTP_WHATSAPP_APPROVED_LOCALES, OTP_WHATSAPP_TEMPLATE } from '../../services/otpMessages';
import { MetaError } from './metaError';
import { metaClient } from './source';
import { checkContext, displayOf, loadPools, reportFor } from './context';
import { decideDeleted, decideFromMeta, importedDoc, inferUse, viewOf } from './apply';
import { connectionAlert, metaErrorDetail, revert } from './submit';
import {
  alertRecorded,
  changeTemplate,
  claimLease,
  clearHintUnknownIfBefore,
  raiseNextNumbers,
  dropPendingAlerts,
  listTemplates,
  readOps,
  releaseLease,
  renewLease,
  SYSTEM,
  updateOps,
  writeLog,
  type StoredTemplate,
  type WaActor,
} from './store';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LEASE_MS = 5 * MINUTE;
const TICK_BUDGET_MS = 4 * MINUTE;
const STUCK_AFTER_MS = 10 * MINUTE;
const PENDING_EVERY_MS = 15 * MINUTE;
const IDLE_EVERY_MS = 6 * HOUR;
const DIGEST_HOUR = 8;
const TZ = 'Europe/Zurich';
const WITH_META = new Set(['PENDING', 'IN_REVIEW', 'PENDING_REVIEW', 'IN_APPEAL', 'APPEAL_REQUESTED']);

export interface SyncResult {
  ok: boolean;
  skipped?: 'not_connected' | 'not_configured';
  complete?: boolean;
  templates?: number;
  imported?: number;
  changes?: number;
  deleted?: number;
  error?: { kind: string; message: string } | null;
  ms?: number;
}

/** One reconcile with Meta. Never throws for Meta's errors (they are logged and returned). */
export async function reconcile(opts: { by: WaActor; budgetMs: number; reason: 'tick' | 'manual' | 'hint' }): Promise<SyncResult> {
  const ops = await readOps();
  if (!ops.wabaId) return { ok: false, skipped: 'not_connected' };
  const client = metaClient();
  if (!client.ready()) return { ok: false, skipped: 'not_configured' };
  const started = Date.now();
  const listStartedAt = new Date(started);
  const engineAt = engineNow();

  let list: Awaited<ReturnType<typeof client.listTemplates>>;
  try {
    list = await client.listTemplates(ops.wabaId, { budgetMs: opts.budgetMs });
  } catch (err) {
    const e = err instanceof MetaError ? err : new MetaError('unavailable', 'Unexpected failure while listing templates');
    const failures = ops.syncFailures + 1;
    await updateOps({
      lastSync: { at: new Date(), engineAtMs: engineAt, ok: false, complete: false, changes: 0, imported: 0, error: { code: e.kind, message: e.userMsg }, ms: Date.now() - started, pages: 0 },
      syncFailures: failures,
      // Meta asked us to slow down: no sync or repair until it says we may (5 minutes when it doesn't say).
      ...(e.kind === 'rate_limited' ? { backoffUntilMs: Date.now() + (e.info.retryAfterMs ?? 5 * MINUTE) } : {}),
    });
    await writeLog({ kind: 'sync.failed', level: 'error', actor: opts.by, summary: `Sync with Meta failed: ${e.userMsg}`, detail: { ...metaErrorDetail(e), reason: opts.reason, failuresInARow: failures } });
    // The account itself is the problem (token, permission, account gone), or Meta keeps failing.
    if (ops.everWorked && (e.kind === 'setup' || e.kind === 'permission' || e.kind === 'not_found' || failures >= 3)) await connectionAlert(e);
    return { ok: false, error: { kind: e.kind, message: e.userMsg }, ms: Date.now() - started };
  }

  const facts = list.templates.map(parseMetaTemplate).filter((f): f is MetaTemplateFacts => Boolean(f));
  const fromMeta = { listStartedMs: started, wabaId: ops.wabaId, partial: Boolean(list.minimal) };
  /**
   * The list was read at `started`: a doc being submitted, or changed since (a submit finished, an
   * edit went in), is left to the next sync — an older list must never overwrite a newer state.
   */
  const apply = (f: MetaTemplateFacts) => (cur: StoredTemplate | null) => {
    if (!cur || cur.stage === 'submitting' || (tsMs(cur.updatedAt) ?? 0) >= started) return null;
    return decideFromMeta(cur, f, pools, nowDate, 'sync', fromMeta);
  };
  const [pools, docs] = await Promise.all([loadPools(), listTemplates()]);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const seen = new Set<string>();
  let imported = 0;
  let changes = 0;
  let deleted = 0;
  const nowDate = new Date();

  // The whole run stays within the budget (a manual "Sync now" answers inside the cms's 60 s): what's
  // left is done by the next run, and a cut-short run never deletes anything.
  const deadline = started + opts.budgetMs;
  let cutShort = false;
  for (const f of facts) {
    const id = whatsappTemplateIdFor(f.name, f.language);
    if (seen.has(id)) continue;
    if (Date.now() > deadline) {
      cutShort = true;
      break;
    }
    seen.add(id);
    const existing = byId.get(id);
    try {
      if (!existing) {
        const use = inferUse(f.name, pools, OTP_WHATSAPP_TEMPLATE.name);
        const change = importedDoc(f, use, nowDate, ops.wabaId);
        change.alerts = alertsForChange(null, viewOf({ ...change.create!, dismissed: false }, pools), `wa:${id}:1`);
        const res = await changeTemplate(id, (cur) => (cur ? null : change));
        if (res.changed) imported += 1;
      } else {
        const res = await changeTemplate(id, apply(f));
        if (res.changed && res.change?.log.level !== 'routine') changes += 1;
      }
    } catch (err) {
      console.error('[WA TEMPLATES] sync apply failed', (err as Error)?.name ?? 'Error');
    }
  }

  // Deletions: only after a complete list, and only once Meta confirms the template is gone.
  if (list.complete && !cutShort) {
    for (const d of docs) {
      if (Date.now() > deadline) {
        cutShort = true;
        break;
      }
      if (seen.has(d.id) || d.stage !== 'submitted' || !d.meta?.id) continue;
      if (String(d.meta.status ?? '').toUpperCase() === 'DELETED') continue;
      // Only this account's templates (one held under an account we no longer use is never "deleted").
      if ((d.wabaId ?? null) !== ops.wabaId) continue;
      const changedAt = tsMs(d.updatedAt) ?? 0;
      if (changedAt >= started) continue; // changed (say, submitted) after the list started
      try {
        // null: Meta says it doesn't exist. Anything that isn't a template threw (unavailable): nothing happens.
        const raw = await client.getTemplate(d.meta.id);
        const f = raw === null ? null : parseMetaTemplate(raw);
        if (raw !== null && !f) continue;
        const res = f ? await changeTemplate(d.id, apply(f)) : await changeTemplate(d.id, (cur) => (cur ? decideDeleted(cur, pools, nowDate, started) : null));
        if (res.changed && res.change?.log.level !== 'routine') {
          if (f) changes += 1;
          else deleted += 1;
        }
      } catch (err) {
        if (!(err instanceof MetaError)) console.error('[WA TEMPLATES] delete check failed', (err as Error)?.name ?? 'Error');
      }
    }
  }

  // A mark left on a template Meta's complete list doesn't hold (a draft, a deleted one) is cleared,
  // so a hint can never make every tick sync forever.
  if (list.complete && !cutShort) {
    for (const d of docs) {
      if (!d.hint || seen.has(d.id)) continue;
      await changeTemplate(d.id, (cur) => (cur && cur.hint && !seen.has(cur.id) && (tsMs(cur.hint.at) ?? 0) < started ? { set: { hint: null, updatedBy: 'meta' }, log: { kind: 'webhook.hint_checked', level: 'routine', actor: SYSTEM, summary: `Meta’s notice for ${cur.name} (${cur.language}) concerned nothing Meta holds now: cleared` } } : null)).catch(() => undefined);
    }
  }

  // The name counters move past every number Meta has (a deleted name is locked ~30 days) — only up.
  const nextNumber: Record<string, number> = {};
  for (const f of facts) {
    const ours = parseOurName(f.name);
    if (ours && ours.n + 1 > (nextNumber[ours.poolKey] ?? 0)) nextNumber[ours.poolKey] = ours.n + 1;
  }
  await raiseNextNumbers(nextNumber);
  if (list.complete && !cutShort) await clearHintUnknownIfBefore(started);

  const ms = Date.now() - started;
  await updateOps({
    lastSync: { at: new Date(), engineAtMs: engineAt, ok: true, complete: list.complete && !cutShort, changes, imported, deleted, error: null, ms, pages: list.pages, listStartedAt },
    ...(list.complete ? { templateCount: facts.length } : {}),
    ...(list.complete && !cutShort ? { lastFullSyncAtMs: engineAt } : {}),
    everWorked: true,
    syncFailures: 0,
    backoffUntilMs: null,
  });
  const any = changes + imported + deleted;
  await writeLog({
    kind: 'sync.run',
    level: any ? 'info' : 'routine',
    actor: opts.by,
    summary: `Synced with Meta: ${facts.length} template${facts.length === 1 ? '' : 's'}${!list.complete ? ' (incomplete list)' : cutShort ? ' (out of time — the next run finishes it)' : ''}${any ? ` — ${[imported ? `${imported} new` : '', changes ? `${changes} changed` : '', deleted ? `${deleted} deleted` : ''].filter(Boolean).join(', ')}` : ', nothing changed'}`,
    detail: { templates: facts.length, imported, changes, deleted, complete: list.complete, cutShort, pages: list.pages, ms, reason: opts.reason },
  });
  // Only a complete list can say the login code template is missing (a partial one would cry wolf).
  if (list.complete && !cutShort) await otpLocaleCheck(facts);
  return { ok: true, complete: list.complete && !cutShort, templates: facts.length, imported, changes, deleted, error: null, ms };
}

/** The login code must be approved in every language the portal sends it in (services/otpMessages.ts). */
async function otpLocaleCheck(facts: MetaTemplateFacts[]): Promise<void> {
  const approved = new Set(facts.filter((f) => f.name === OTP_WHATSAPP_TEMPLATE.name && String(f.status).toUpperCase() === 'APPROVED').map((f) => f.language));
  const missing = OTP_WHATSAPP_APPROVED_LOCALES.filter((l) => !approved.has(l));
  if (!missing.length) return;
  await raiseAlert({
    kind: 'whatsapp_template',
    dedupeKey: `wa_otp_locale:${missing.join(',')}:${dayKey(engineNow(), TZ)}`,
    audience: 'heidifi',
    subject: 'URGENT: WhatsApp login code template not approved',
    text: `The guest-login code template ${OTP_WHATSAPP_TEMPLATE.name} is not approved at Meta in: ${missing.join(', ')}. The portal sends it in these languages, so guests who choose WhatsApp can't get a code.\n\nOpen Adaptive Campaigns → WhatsApp in the admin.`,
  });
}

// ── The tick ─────────────────────────────────────────────────────────────────

export interface TickResult {
  ran: boolean;
  reason?: string;
  repaired?: number;
  synced?: boolean;
  alerts?: number;
  digest?: boolean;
}

export async function runWhatsAppTemplateTick(opts: { owner?: string } = {}): Promise<TickResult> {
  await refreshClock();
  const ops0 = await readOps();
  if (!ops0.wabaId) return { ran: false, reason: 'not_connected' };
  const owner = opts.owner ?? `tick_${process.pid}_${randomUUID().slice(0, 8)}`;
  if (!(await claimLease(owner, LEASE_MS))) return { ran: false, reason: 'busy' };
  const started = Date.now();
  const out: TickResult = { ran: true, repaired: 0, synced: false, alerts: 0, digest: false };
  try {
    // Meta asked us to slow down: alerts and the summary still go out, Meta isn't called.
    const backoff = ops0.backoffUntilMs !== null && ops0.backoffUntilMs > Date.now();
    if (!backoff) out.repaired = await repairStuckSubmits(ops0.wabaId);

    const ops = await readOps();
    const docs = await listTemplates();
    const at = engineNow();
    const last = ops.lastSync?.engineAtMs ?? null;
    const hinted = docs.some((d) => d.hint) || ops.hintUnknownAtMs !== null;
    const withMeta = docs.some((d) => d.stage === 'submitting' || WITH_META.has(String(d.meta?.status ?? '').toUpperCase()));
    const due = !backoff && (last === null || hinted || (withMeta && at - last >= PENDING_EVERY_MS) || at - last >= IDLE_EVERY_MS);
    if (due && Date.now() - started < TICK_BUDGET_MS) {
      if (!(await renewLease(owner, LEASE_MS))) return { ...out, reason: 'lease_lost' };
      const res = await reconcile({ by: SYSTEM, budgetMs: Math.max(30_000, TICK_BUDGET_MS - (Date.now() - started) - 30_000), reason: hinted ? 'hint' : 'tick' });
      out.synced = res.ok;
    }

    if (!(await renewLease(owner, LEASE_MS))) return { ...out, reason: 'lease_lost' };
    out.alerts = await flushAlerts();
    out.digest = await maybeDigest();
  } catch (err) {
    await writeLog({ kind: 'tick.error', level: 'error', actor: SYSTEM, summary: `The template tick failed: ${(err as Error)?.name ?? 'Error'}`, detail: { name: (err as Error)?.name ?? null, code: (err as { code?: unknown })?.code ?? null } });
  } finally {
    await releaseLease(owner);
  }
  return out;
}

/** A submit Meta never answered (10 minutes): found at Meta → taken over; not found → put back. */
export async function repairStuckSubmits(wabaId: string): Promise<number> {
  const docs = (await listTemplates()).filter((d) => d.stage === 'submitting' && d.submit && engineNow() - d.submit.startedAtMs >= STUCK_AFTER_MS);
  if (!docs.length) return 0;
  const client = metaClient();
  if (!client.ready()) return 0;
  const pools = await loadPools();
  let n = 0;
  for (const d of docs) {
    try {
      const found = await client.findByName(wabaId, d.name);
      const f = found.map(parseMetaTemplate).find((x) => x && x.language === d.language) ?? null;
      // A lost edit: the template existed before, so "found" proves nothing — take it over only when
      // Meta has our new text or is reviewing it.
      const editArrived =
        d.submit?.kind !== 'edit' ||
        Boolean(f && (WITH_META.has(String(f.status ?? '').toUpperCase()) || (d.compiled && contentKey({ bodyText: d.compiled.bodyText, footerText: d.compiled.footerText, buttons: d.compiled.button ? [{ text: d.compiled.button.text, url: d.compiled.button.url }] : [] }) === contentKey(f))));
      if (f && editArrived) {
        const res = await changeTemplate(d.id, (cur) => (cur && cur.stage === 'submitting' ? decideFromMeta(cur, f, pools, new Date(), 'repair', { wabaId }) : null));
        if (res.changed) n += 1;
      } else {
        await revert(d.id, new MetaError('unknown', f ? 'Meta still holds the earlier version: send it again' : 'It isn’t at Meta: send it again'), SYSTEM, 'submit.reverted', 'unknown_outcome');
        n += 1;
      }
    } catch {
      // Meta unreachable: try again on the next tick.
    }
  }
  return n;
}

/** Emails the alerts waiting on templates (each key once — `raiseAlert` records it before sending). */
export async function flushAlerts(): Promise<number> {
  const docs = (await listTemplates()).filter((d) => (d.pendingAlerts ?? []).length);
  let n = 0;
  for (const d of docs) {
    const sent: string[] = [];
    for (const a of d.pendingAlerts) {
      await raiseAlert({ kind: 'whatsapp_template', dedupeKey: a.key, audience: 'heidifi', subject: a.subject, text: a.text });
      // raiseAlert never throws: kept for the next tick unless it was really recorded.
      if (!(await alertRecorded(a.key))) continue;
      sent.push(a.key);
      n += 1;
      await writeLog(
        { kind: 'alert.sent', level: a.urgent ? 'warn' : 'info', actor: SYSTEM, summary: `Alert emailed: ${a.subject}`, detail: { key: a.key, urgent: a.urgent } },
        { templateId: d.id, name: d.name, language: d.language },
      );
    }
    await dropPendingAlerts(d.id, sent);
  }
  return n;
}

/** The 08:00 (Zurich) summary: once a day, only when there is something to tell. */
export async function maybeDigest(): Promise<boolean> {
  const at = engineNow();
  const day = dayKey(at, TZ);
  const ops = await readOps();
  if (ops.digest.lastDay === day || localParts(new Date(at), TZ).hour < DIGEST_HOUR) return false;
  const [docs, pools] = await Promise.all([listTemplates(), loadPools()]);
  const ctxBase = (d: StoredTemplate) => checkContext(pools, docs, ops, d.use);
  const since = ops.digest.lastAtMs ?? 0;
  const label = (d: StoredTemplate) => `${d.name} (${d.language})`;
  const approved: DigestItem[] = [];
  const waiting: DigestItem[] = [];
  const inReview: DigestItem[] = [];
  const problems: DigestItem[] = [];
  for (const d of docs) {
    if (d.dismissed) continue;
    const report = reportFor(d, ctxBase(d));
    const display = displayOf(d, report, pools);
    const approvedAt = tsMs(d.meta?.approvedAt) ?? 0;
    if (display === 'approved' && approvedAt > since) approved.push({ label: label(d), note: d.meta?.category ?? undefined });
    else if (display === 'ready' || display === 'needs_fix') waiting.push({ label: label(d), note: display === 'ready' ? 'ready to send to Meta' : `${report.errors} check${report.errors === 1 ? '' : 's'} to fix` });
    else if (display === 'in_review' || display === 'submitting') {
      const since48 = tsMs(d.meta?.lastChangedAt) ?? 0;
      inReview.push({ label: label(d), note: since48 && Date.now() - since48 > 48 * HOUR ? 'over 48 hours' : undefined });
    } else if (['rejected', 'paused', 'disabled', 'blocked', 'attention'].includes(display)) {
      problems.push({ label: label(d), note: display === 'rejected' ? rejectionWords(d.meta?.rejectedReason) : display });
    }
  }
  const digest = digestText({ approved, waiting, inReview, problems });
  if (digest) {
    await raiseAlert({ kind: 'whatsapp_digest', dedupeKey: `wa_digest:${day}`, audience: 'heidifi', subject: digest.subject, text: digest.text });
    if (!(await alertRecorded(`wa_digest:${day}`))) return false; // the next tick tries again
    await writeLog({ kind: 'digest.sent', level: 'info', actor: SYSTEM, summary: `Daily summary emailed: ${digest.subject.replace(/^WhatsApp templates: /, '')}`, detail: { approved: approved.length, waiting: waiting.length, inReview: inReview.length, problems: problems.length } });
  }
  await updateOps({ digest: { lastDay: day, lastAtMs: Date.now() } });
  return Boolean(digest);
}
