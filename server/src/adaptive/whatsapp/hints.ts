/**
 * Meta's template webhooks as hints (PR W1). `routes/whatsappWebhook.ts` hands the three template
 * fields here (`message_template_status_update`, `template_category_update`,
 * `message_template_quality_update`). The webhook has no signature check (no app secret on the
 * server), so its body is never trusted: a hint only marks the template (`hint.at`) — or, for a
 * template we don't have, the account (`hintUnknownAt`) — and the next tick (≤ 2 minutes) re-reads
 * it from Meta. Never calls Meta, never alerts. A hint for another account is ignored.
 *
 * A notice moves the mark unless the mark is younger than HINT_COALESCE_MS (then a sync clears it only
 * once its list started that long after the mark, so a notice that comes while a sync runs is never
 * lost) — at most one write per template, and one on the account, in that time. The log line is
 * limited separately — at most one per template (`hintLoggedAt`) or for all unknown names
 * (`hintUnknownLoggedAt`) every 10 minutes — and says the notice is unverified, as anyone could have
 * sent it.
 */

import { db } from '../../firebase';
import { COL, WHATSAPP_DOC_ID } from '../store/collections';
import { tsMs } from '../store/time';
import { whatsappTemplateIdFor } from '../core/runtime/ids';
import { HINT_COALESCE_MS, SYSTEM, logInTx, readOps } from './store';

export const TEMPLATE_FIELDS = ['message_template_status_update', 'template_category_update', 'message_template_quality_update'] as const;

/** At most one log line per template (and one for all unknown names) in this time. */
const LOG_EVERY_MS = 10 * 60_000;

let wabaCache: { id: string | null; at: number } | null = null;

async function knownWaba(): Promise<string | null> {
  if (wabaCache && Date.now() - wabaCache.at < 60_000) return wabaCache.id;
  const ops = await readOps();
  wabaCache = { id: ops.wabaId, at: Date.now() };
  return ops.wabaId;
}

const short = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);

/** One template webhook change (the `value` of `entry[].changes[]`). Never throws to the caller's harm: run it through runAdaptiveHook. */
export async function noteTemplateHint(entryId: string, field: string, value: Record<string, unknown>): Promise<'marked' | 'unknown_template' | 'ignored'> {
  if (!(TEMPLATE_FIELDS as readonly string[]).includes(field)) return 'ignored';
  const waba = await knownWaba();
  if (!waba) return 'ignored'; // not connected yet: the first sync reads everything anyway
  // Meta always names the account (`entry.id`); one that doesn't name ours — or names none — is ignored.
  if (entryId !== waba) {
    console.warn('[WA TEMPLATES] webhook for another (or no) WhatsApp Business Account ignored');
    return 'ignored';
  }
  const rawName = short(value.message_template_name, 512);
  const rawLang = short(value.message_template_language, 16);
  // Only names and languages Meta could send: nothing else reaches a log row (the webhook isn't signed).
  const name = rawName && /^[a-z0-9_]{1,512}$/.test(rawName) ? rawName : null;
  const language = rawLang && /^[A-Za-z]{2,3}(_[A-Za-z]{2,4})?$/.test(rawLang) ? rawLang : null;
  const event = [value.event, value.new_category, value.new_quality_score].map((v) => (typeof v === 'string' && /^[A-Z_]{1,40}$/.test(v) ? v : null)).find(Boolean) ?? null;
  if (!name || !language) return 'ignored';

  const id = whatsappTemplateIdFor(name, language);
  const ref = db.collection(COL.whatsappTemplates).doc(id);
  const marked = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    // Only a template Meta has can be re-read (a draft or a deleted one never clears a mark: it isn't
    // in Meta's list) — anything else is treated like a template we don't have.
    const stage = snap.get('stage');
    const status = String(snap.get('meta.status') ?? '').toUpperCase();
    if ((stage !== 'submitted' && stage !== 'submitting') || status === 'DELETED') return false;
    const markedAt = tsMs(snap.get('hint.at'));
    if (markedAt !== null && Date.now() - markedAt < HINT_COALESCE_MS) return true; // already marked just now
    const loggedAt = tsMs(snap.get('hintLoggedAt'));
    const log = loggedAt === null || Date.now() - loggedAt >= LOG_EVERY_MS;
    tx.update(ref, { hint: { at: new Date(), field, event }, ...(log ? { hintLoggedAt: new Date() } : {}) });
    if (log) {
      logInTx(tx, {
        kind: 'webhook.hint',
        level: 'info',
        actor: SYSTEM,
        summary: `A webhook notice (unverified) named ${name} (${language})${event ? `: ${event.toLowerCase()}` : ''} — re-reading it from Meta`,
        detail: { field, event, verified: false },
      }, { templateId: id, name, language });
    }
    return true;
  });
  if (marked) return 'marked';

  // A template we don't have (made in WhatsApp Manager, or a race with a submit): sync soon. The
  // mark always moves; one log line (for all such names) every 10 minutes.
  await db.runTransaction(async (tx) => {
    const opsRef = db.collection(COL.config).doc(WHATSAPP_DOC_ID);
    const snap = await tx.get(opsRef);
    const markedAt = tsMs(snap.get('hintUnknownAt'));
    if (markedAt !== null && Date.now() - markedAt < HINT_COALESCE_MS) return; // already marked just now
    const loggedAt = tsMs(snap.get('hintUnknownLoggedAt'));
    const log = loggedAt === null || Date.now() - loggedAt >= LOG_EVERY_MS;
    tx.set(opsRef, { hintUnknownAt: new Date(), ...(log ? { hintUnknownLoggedAt: new Date() } : {}) }, { merge: true });
    if (log) {
      logInTx(tx, {
        kind: 'webhook.hint',
        level: 'info',
        actor: SYSTEM,
        summary: `A webhook notice (unverified) named ${name} (${language}), which isn’t one we can re-read yet — syncing`,
        detail: { field, event, verified: false },
      }, { name, language });
    }
  });
  return 'unknown_template';
}

export interface TemplateHintInput {
  entryId: string;
  field: string;
  value: Record<string, unknown>;
}

/** The most template notices one webhook body may act on (the rest are dropped: the sync reads them all anyway). */
export const MAX_HINTS_PER_BODY = 10;

/**
 * Every template notice of one webhook body, one after another: a notice repeated for the same
 * account, name and language counts once, and at most 10 are acted on — one body can't start a
 * burst of transactions. Returns how many were acted on. Never throws.
 */
export async function noteTemplateHints(items: TemplateHintInput[]): Promise<number> {
  const seen = new Set<string>();
  let n = 0;
  for (const it of items) {
    const v = it.value ?? {};
    const key = [it.entryId, v.message_template_name, v.message_template_language].map((x) => String(x ?? '').slice(0, 600)).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    if (n >= MAX_HINTS_PER_BODY) {
      console.warn('[WA TEMPLATES] webhook body named more templates than are acted on: the rest wait for the sync');
      break;
    }
    n += 1;
    try {
      await noteTemplateHint(it.entryId, it.field, v);
    } catch (err) {
      console.error('[WA TEMPLATES] webhook hint failed', (err as Error)?.name ?? 'Error');
    }
  }
  return n;
}

/** Tests only. */
export function __clearHintCache(): void {
  wabaCache = null;
}

