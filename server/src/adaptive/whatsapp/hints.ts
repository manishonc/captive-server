/**
 * Meta's template webhooks as hints (PR W1). `routes/whatsappWebhook.ts` hands the three template
 * fields here (`message_template_status_update`, `template_category_update`,
 * `message_template_quality_update`). The webhook has no signature check (no app secret on the
 * server), so its body is never trusted: a hint only marks the template (`hint.at`) — or, for a
 * template we don't have, the account (`hintUnknownAt`) — and the next tick (≤ 2 minutes) re-reads
 * it from Meta. Never calls Meta, never alerts. A hint for another account is ignored.
 */

import { db } from '../../firebase';
import { COL, WHATSAPP_DOC_ID } from '../store/collections';
import { tsMs } from '../store/time';
import { whatsappTemplateIdFor } from '../core/runtime/ids';
import { META, logInTx, readOps, writeLog } from './store';

export const TEMPLATE_FIELDS = ['message_template_status_update', 'template_category_update', 'message_template_quality_update'] as const;

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
    const prev = snap.get('hint') as { at?: unknown; event?: string | null } | null | undefined;
    // A burst of notices costs one read each: the mark moves at most every 30 s (so a notice that
    // comes after a sync has read the list still marks it again), the log line at most every 10 min.
    const age = prev ? Date.now() - (tsMs(prev.at) ?? 0) : Infinity;
    if (age < 30_000) return true;
    tx.update(ref, { hint: { at: new Date(), field, event } });
    if (age >= 10 * 60_000) {
      logInTx(tx, {
        kind: 'webhook.hint',
        level: 'info',
        actor: META,
        summary: `Meta sent a notice for ${name} (${language})${event ? `: ${event.toLowerCase()}` : ''} — re-reading it from Meta`,
        detail: { field, event },
      }, { templateId: id, name, language });
    }
    return true;
  });
  if (marked) return 'marked';

  // A template we don't have (made in WhatsApp Manager, or a race with a submit): sync soon —
  // one mark (and one log line) at a time, decided in a transaction.
  const first = await db.runTransaction(async (tx) => {
    const opsRef = db.collection(COL.config).doc(WHATSAPP_DOC_ID);
    const at = tsMs((await tx.get(opsRef)).get('hintUnknownAt'));
    if (at !== null && Date.now() - at < 10 * 60_000) return false;
    tx.set(opsRef, { hintUnknownAt: new Date() }, { merge: true });
    return true;
  });
  if (first) {
    await writeLog({ kind: 'webhook.hint', level: 'info', actor: META, summary: `Meta sent a notice for ${name} (${language}), which isn’t one we can re-read yet — syncing`, detail: { field, event } }, { name, language });
  }
  return 'unknown_template';
}

/** Tests only. */
export function __clearHintCache(): void {
  wabaCache = null;
}

