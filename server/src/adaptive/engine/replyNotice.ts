/**
 * The "this inbox isn't monitored" notice (plan §3.4 what-ifs, §3.9): a guest who
 * answers a journey SMS with plain text gets one short service SMS — at most once
 * per `replyNoticeCooldownDays` (30) — through the same exactly-once path as a
 * journey send, outside any journey (its record has no instance). Never charged.
 * Not sent while sending is paused, or to a number that said STOP.
 */

import { db } from '../../firebase';
import { COL } from '../store/collections';
import type { ContactDoc, ContactPointDoc, JourneySendDoc } from '../store/engineTypes';
import type { Lang } from '../core/constants';
import { ENGINE_VERSION, SCHEMA_VERSION } from '../core/constants';
import { hashId } from '../core/checksum';
import { DAY_MS } from '../core/runtime/time';
import type { DecisionRecord } from '../core/runtime/decision';
import { retentionFrom, tsMs } from '../store/time';
import { maskDestination } from '../../services/phone';
import { smsSegments } from '../../services/smsBilling';
import { getCreditConfig, providerCostForMessage } from '../../services/credits';
import { loadCatalogue } from '../service/catalogue';
import { channelAdapters } from './sendPath';
import { callProvider, dispatchLease } from '../send/dispatch';
import type { EngineSettings } from '../store/engineSettings';

// No venue name: the number is shared, and the reply may answer another venue's
// (or a Marketing-tab) message sent after the last Adaptive one.
const TEXT: Record<Lang, string> = {
  en: "Thanks for your message! Replies to this number aren't read. Please contact the venue directly. Reply STOP to unsubscribe.",
  de: 'Danke für deine Nachricht! Antworten an diese Nummer werden nicht gelesen. Bitte kontaktiere den Betrieb direkt. Antworte STOP zum Abmelden.',
  fr: "Merci pour votre message ! Les réponses à ce numéro ne sont pas lues. Contactez l'établissement directement. Répondez STOP pour vous désabonner.",
  it: 'Grazie per il messaggio! Le risposte a questo numero non vengono lette. Contatta direttamente il locale. Rispondi STOP per disiscriverti.',
};

export async function sendReplyNotice(args: {
  inboundId: string;
  contactId: string;
  pointId: string;
  tenantUserId: string;
  venueId: string;
  venueName: string;
  now: number;
  settings: EngineSettings;
  workerId: string;
}): Promise<'sent' | 'skipped'> {
  const adapter = channelAdapters.sms;
  if (!adapter?.ready() || args.settings.paused) return 'skipped';
  const cooldownDays = (await loadCatalogue()).config.replyNoticeCooldownDays ?? 30;
  const sendKey = hashId('js', `reply_notice:${args.inboundId}`);
  const ref = db.collection(COL.journeySends).doc(sendKey);
  const creditConfig = await getCreditConfig();

  const claimed = await db.runTransaction(async (tx) => {
    const [contactSnap, cpSnap, sendSnap] = await Promise.all([
      tx.get(db.collection(COL.contacts).doc(args.contactId)),
      tx.get(db.collection(COL.contactPoints).doc(args.pointId)),
      tx.get(ref),
    ]);
    if (sendSnap.exists || !contactSnap.exists) return null;
    const contact = contactSnap.data() as ContactDoc;
    const point = (cpSnap.data() ?? null) as ContactPointDoc | null;
    if (!contact.phoneE164 || point?.suppression?.sms) return null;
    const last = tsMs(contact.replyNoticeSentAt);
    if (last !== null && args.now - last < cooldownDays * DAY_MS) return null;
    const lang = (contact.lang ?? 'en') as Lang;
    const body = TEXT[lang] ?? TEXT.en;
    const decision: DecisionRecord = {
      v: 1,
      at: args.now,
      mode: 'live',
      result: 'allow',
      rule: null,
      reason: null,
      until: null,
      poolKey: 'reply_notice',
      purpose: 'service',
      checks: [{ rule: 'system', ok: true, fact: `plain reply — notice at most once per ${cooldownDays} days` }],
      channel: { picked: 'sms', rule: 'reply', rejected: [] },
      variant: { picked: null, method: 'fixed' },
      slot: { picked: 'now', rule: 'now', plannedAt: args.now },
      credits: null,
      versions: { template: 0, config: 0, playbook: null, engine: ENGINE_VERSION },
    };
    const doc: JourneySendDoc = {
      tenantUserId: args.tenantUserId,
      venueId: args.venueId,
      contactId: args.contactId,
      instanceId: null,
      journeyKey: null,
      nodeId: null,
      templateVersion: null,
      configVersion: null,
      mode: 'live',
      purpose: 'service',
      channel: 'sms',
      toPointId: args.pointId,
      toMasked: maskDestination('sms', contact.phoneE164),
      variantId: null,
      locale: lang,
      slot: 'now',
      status: 'dispatching',
      provider: adapter.provider,
      providerMessageId: null,
      errorCode: null,
      errorMessage: null,
      credits: null,
      providerCostMinor: providerCostForMessage(creditConfig, 'sms', body),
      smsSegments: smsSegments(body),
      shortCodes: [],
      content: { preview: body.slice(0, 280), bodyHash: hashId('b', body).slice(2, 34) },
      engagement: { deliveredAt: null, openedAt: null, firstClickAt: null, clicks: 0, repliedAt: null },
      attribution: null,
      decision,
      dispatchLease: dispatchLease(args.workerId),
      createdAt: new Date(args.now),
      sentAt: null,
      updatedAt: new Date(args.now),
      expireAt: retentionFrom(args.now),
      schemaVersion: SCHEMA_VERSION,
      kind: 'reply_notice',
    };
    tx.create(ref, doc);
    tx.update(db.collection(COL.contacts).doc(args.contactId), { replyNoticeSentAt: new Date(args.now), updatedAt: new Date() });
    return { to: contact.phoneE164, body };
  });
  if (!claimed) return 'skipped';

  const result = await callProvider(adapter, { kind: 'sms', to: claimed.to, body: claimed.body, sendKey });
  const update: Record<string, unknown> =
    result.kind === 'accepted'
      ? { status: 'sent', providerMessageId: result.providerMessageId, sentAt: new Date(args.now) }
      : result.kind === 'unknown'
        ? { status: 'unknown', errorMessage: result.reason.slice(0, 300) }
        : { status: 'failed', errorCode: result.kind === 'rejected' ? result.code.slice(0, 60) : 'retry', errorMessage: (result.kind === 'rejected' ? result.message : result.reason).slice(0, 300) };
  await ref.update({ ...update, provider: result.provider, dispatchLease: null, updatedAt: new Date() });
  return result.kind === 'accepted' ? 'sent' : 'skipped';
}
