/**
 * Signals coming back (plan §3.9, hooks H3/H4 + the CMS ingest routes), API side.
 * Each hook runs after today's processing, inside runAdaptiveHook, and only turns
 * the signal into an event + a `signal` task (one batch, deterministic ids — a
 * duplicate webhook finds them already there). The worker does the rest.
 *
 *  - Non-Adaptive traffic costs nothing: Brevo events without our sendKey header
 *    are skipped without a read; Twilio statuses are only looked up while the
 *    engine may be sending (an account not off, or sending not paused).
 *  - Raw phone numbers / emails travel only in `payload.guest` (deleted once the
 *    task is done), never in the event log; the worker hashes them with its own
 *    identity key (so the key guard covers them).
 *  - Clicks come only from our short links (the CMS forwards human clicks);
 *    Brevo's click events are ignored (mail scanners make them).
 */

import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../../firebase';
import { COL } from '../store/collections';
import type { JourneySendDoc } from '../store/engineTypes';
import { eventIdFor, shardOf, taskIdFor } from '../core/runtime/ids';
import { retentionFrom } from '../store/time';
import { SCHEMA_VERSION } from '../core/constants';
import { TASK_SCHEMA_VERSION } from '../queue/firestoreQueue';
import { keyFingerprint } from '../identity/key';
import { anyAccountOn, cachedEngineSettings } from '../store/engineSettings';
import { now, refreshClock, sandboxEnabled } from '../engine/clock';
import { normalizeE164 } from '../../services/phone';

const SEND_KEY = /^js_[0-9a-f]{32}$/;

function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return e?.code === 6 || /ALREADY_EXISTS/i.test(String(e?.message));
}

interface SignalEvent {
  id: string;
  type: string;
  source: 'twilio' | 'brevo' | 'unsubscribe' | 'shortlink' | 'cms' | 'dev';
  tenantUserId?: string | null;
  venueId?: string | null;
  contactId?: string | null;
  instanceId?: string | null;
  journeyKey?: string | null;
  sendKey?: string | null;
  channel?: string | null;
  data?: Record<string, unknown>;
  /** Raw contact details / free text for the worker only. */
  guest?: Record<string, unknown>;
}

/** Event + task in one batch; a repeat of the same signal is a no-op. */
async function enqueue(e: SignalEvent): Promise<boolean> {
  await refreshClock();
  const at = now();
  const batch = db.batch();
  batch.create(db.collection(COL.journeyEvents).doc(e.id), {
    type: e.type,
    tenantUserId: e.tenantUserId ?? null,
    venueId: e.venueId ?? null,
    contactId: e.contactId ?? null,
    guestId: null,
    instanceId: e.instanceId ?? null,
    journeyKey: e.journeyKey ?? null,
    nodeId: null,
    sendKey: e.sendKey ?? null,
    variantId: null,
    channel: e.channel ?? null,
    slot: null,
    source: e.source,
    occurredAt: new Date(at),
    recordedAt: new Date(),
    data: { mode: 'live', ...(e.data ?? {}) },
    expireAt: retentionFrom(at),
    schemaVersion: SCHEMA_VERSION,
  });
  const taskId = taskIdFor(`signal:${e.id}`);
  batch.create(db.collection(COL.journeyTasks).doc(taskId), {
    kind: 'signal',
    shard: shardOf(taskId),
    status: 'queued',
    dueAt: new Date(at),
    leaseOwner: null,
    leaseUntil: null,
    attempts: 0,
    maxAttempts: 8,
    lastError: null,
    payload: { eventId: e.id, schemaVersion: TASK_SCHEMA_VERSION, keyFingerprint: keyFingerprint(), ...(e.guest ? { guest: e.guest } : {}) },
    tenantUserId: e.tenantUserId ?? null,
    venueId: e.venueId ?? null,
    createdAt: new Date(),
    doneAt: null,
    expireAt: new Date(Date.now() + 30 * 24 * 3600_000),
  });
  try {
    await batch.commit();
    return true;
  } catch (err) {
    if (isAlreadyExists(err)) return false;
    throw err;
  }
}

function fromSend(sendKey: string, s: JourneySendDoc): Pick<SignalEvent, 'tenantUserId' | 'venueId' | 'contactId' | 'instanceId' | 'journeyKey' | 'sendKey' | 'channel'> {
  return {
    tenantUserId: s.tenantUserId,
    venueId: s.venueId,
    contactId: s.contactId,
    instanceId: s.instanceId,
    journeyKey: s.journeyKey,
    sendKey,
    channel: s.channel,
  };
}

/** While everything is off and paused nothing Adaptive can be in flight: skip lookups. */
async function engineMaySend(): Promise<boolean> {
  const s = await cachedEngineSettings();
  return anyAccountOn(s) || !s.paused;
}

// ── Twilio status callback (H4) ──────────────────────────────────────────────

export async function adaptiveOnTwilioStatus(p: { messageSid: string; status: string; errorCode: string | null }): Promise<void> {
  const status = p.status.toLowerCase();
  const type = status === 'delivered' || status === 'read' ? 'message.delivered' : ['undelivered', 'failed', 'canceled'].includes(status) ? 'message.failed' : null;
  if (!type || !p.messageSid || !(await engineMaySend())) return;
  const snap = await db.collection(COL.journeySends).where('providerMessageId', '==', p.messageSid).limit(1).get();
  const doc = snap.docs[0];
  if (!doc) return;
  const s = doc.data() as JourneySendDoc;
  if (s.mode !== 'live' || s.provider === 'brevo') return;
  await enqueue({
    id: eventIdFor('twilio', `${p.messageSid}:${type}`),
    type,
    source: 'twilio',
    ...fromSend(doc.id, s),
    data: { status, errorCode: p.errorCode },
  });
}

// ── Brevo events (H3 + H4) ───────────────────────────────────────────────────

const BREVO_MAP: Record<string, { type: string; data?: Record<string, unknown> }> = {
  delivered: { type: 'message.delivered' },
  opened: { type: 'message.opened' },
  unique_opened: { type: 'message.opened' },
  hard_bounce: { type: 'message.bounced', data: { hard: true } },
  invalid_email: { type: 'message.bounced', data: { invalid: true } },
  blocked: { type: 'message.failed', data: { blocked: true } },
  error: { type: 'message.failed' },
  spam: { type: 'consent.revoked', data: { source: 'brevo_spam' } },
  unsubscribed: { type: 'consent.revoked', data: { source: 'brevo_unsubscribed' } },
};

function headerValue(ev: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(ev)) if (k.toLowerCase() === 'x-mailin-custom' && typeof v === 'string') return v.trim();
  return null;
}

/** Bounce reasons can quote the address: keep them short and without it. */
function redact(reason: unknown): string | null {
  if (typeof reason !== 'string' || !reason) return null;
  return reason.replace(/[^\s@<>]+@[^\s@<>]+/g, '[address]').slice(0, 200);
}

export async function adaptiveOnBrevoEvents(events: unknown[]): Promise<void> {
  for (const raw of events) {
    const ev = (raw ?? {}) as Record<string, unknown>;
    const sendKey = headerValue(ev);
    if (!sendKey || !SEND_KEY.test(sendKey)) continue; // not ours: no reads at all
    const mapped = BREVO_MAP[String(ev.event ?? '').toLowerCase()];
    if (!mapped) continue; // proxy opens, clicks, soft bounces, deferrals…
    const snap = await db.collection(COL.journeySends).doc(sendKey).get();
    const s = snap.data() as JourneySendDoc | undefined;
    if (!s || s.mode !== 'live' || s.channel !== 'email') continue;
    const messageId = String(ev['message-id'] ?? ev.messageId ?? '');
    if (s.providerMessageId && messageId && s.providerMessageId !== messageId) continue; // not this send
    await enqueue({
      id: eventIdFor('brevo', `${sendKey}:${mapped.type}${mapped.data?.source ? `:${mapped.data.source}` : ''}`),
      type: mapped.type,
      source: 'brevo',
      ...fromSend(sendKey, s),
      // consent.* concern the person, not the journey: no instance delivery.
      ...(mapped.type.startsWith('consent.') ? { instanceId: null } : {}),
      data: { event: String(ev.event).toLowerCase(), ...(mapped.data ?? {}), reason: redact(ev.reason), messageId: messageId || null, channel: 'email' },
    });
  }
}

// ── Twilio inbound: STOP / START / replies (H3) ──────────────────────────────

export async function adaptiveOnInboundSms(p: {
  from: string;
  body: string;
  legacyKind: 'stop' | 'start' | 'help' | null;
  messageSid: string;
  optOutType: string | null;
  /** Whether Twilio's signature was checked for this request (START re-grants consent). */
  signatureChecked: boolean;
}): Promise<void> {
  const phone = normalizeE164('', p.from);
  if (!phone) return;
  const kind = p.legacyKind === 'stop' || p.optOutType === 'STOP' ? 'stop' : p.legacyKind === 'start' || p.optOutType === 'START' ? 'start' : p.legacyKind === 'help' ? 'help' : 'reply';
  if (kind === 'help') return;
  // Anyone could post an unsigned START: only a verified one may re-grant consent.
  if (kind === 'start' && !p.signatureChecked && !sandboxEnabled()) return;
  if (kind === 'reply' && (!p.body.trim() || !(await engineMaySend()))) return;
  const key = p.messageSid || `${phone}:${Math.floor(Date.now() / 60_000)}:${p.body.slice(0, 40)}`;
  await enqueue({
    id: eventIdFor('twilio', `in:${key}`),
    type: kind === 'stop' ? 'consent.revoked' : kind === 'start' ? 'consent.granted' : 'message.replied',
    source: 'twilio',
    channel: 'sms',
    data: { source: 'sms_keyword', kind },
    guest: { phone },
  });
}

// ── The unsubscribe page (H3) ────────────────────────────────────────────────

export async function adaptiveOnUnsubscribe(p: { g: string; v?: string; c?: string }): Promise<void> {
  if (p.c && SEND_KEY.test(p.c)) {
    const snap = await db.collection(COL.journeySends).doc(p.c).get();
    const s = snap.data() as JourneySendDoc | undefined;
    if (!s || (p.v && s.venueId !== p.v)) return;
    await enqueue({
      id: eventIdFor('unsubscribe', p.c),
      type: 'consent.revoked',
      source: 'unsubscribe',
      ...fromSend(p.c, s),
      instanceId: null,
      data: { source: 'unsubscribe_page', channel: 'email' },
    });
    return;
  }
  // An unsubscribe from a Marketing-tab or Campaign Manager email also ends
  // Adaptive email for that person at that venue — even while sending is paused,
  // so a journey that resumes later doesn't email them (unsubscribes are rare).
  if (!p.v || !p.g) return;
  await enqueue({
    id: eventIdFor('unsubscribe', `${p.g}:${p.v}`),
    type: 'consent.revoked',
    source: 'unsubscribe',
    venueId: p.v,
    channel: 'email',
    data: { source: 'unsubscribe_page', channel: 'email', legacy: true },
    guest: { guestId: p.g },
  });
}

// ── The CMS: clicks on our short links, ratings ──────────────────────────────

async function journeyLink(shortCode: string): Promise<{ link: Record<string, any>; send: JourneySendDoc; sendKey: string } | null> {
  if (!/^[a-z0-9_]{1,64}$/i.test(shortCode)) return null;
  const linkSnap = await db.collection('CaptivePortal_ShortLinks').doc(shortCode).get();
  const link = linkSnap.data();
  if (!link || link.sendKind !== 'journey' || typeof link.sendKey !== 'string' || !SEND_KEY.test(link.sendKey)) return null;
  const sendSnap = await db.collection(COL.journeySends).doc(link.sendKey).get();
  const send = sendSnap.data() as JourneySendDoc | undefined;
  if (!send || send.mode !== 'live') return null;
  return { link, send, sendKey: link.sendKey };
}

/** A counted (non-bot) click the CMS resolver forwarded. Ids come from our docs, never from the caller. */
export async function ingestClick(p: { shortCode: string }): Promise<{ ignored: boolean }> {
  const found = await journeyLink(p.shortCode);
  if (!found) return { ignored: true };
  await db.collection(COL.journeySends).doc(found.sendKey).update({ 'engagement.clicks': FieldValue.increment(1), updatedAt: new Date() });
  // One "clicked" per message for the journey (its click cap counts messages clicked).
  await enqueue({
    id: eventIdFor('shortlink', `${found.sendKey}:clicked`),
    type: 'message.clicked',
    source: 'shortlink',
    ...fromSend(found.sendKey, found.send),
    data: { shortCode: p.shortCode, link: found.link.journeyLink ?? null },
  });
  return { ignored: false };
}

/** A rating submitted on the rating page opened from a journey link. */
export async function ingestRating(p: { shortCode: string; stars: number; feedback?: string | null }): Promise<{ ignored: boolean }> {
  const found = await journeyLink(p.shortCode);
  if (!found || found.link.venueId !== found.send.venueId) return { ignored: true };
  const feedback = typeof p.feedback === 'string' ? p.feedback.trim().slice(0, 1000) : '';
  await enqueue({
    id: eventIdFor('cms', `rating:${p.shortCode}`),
    type: 'rating.submitted',
    source: 'cms',
    ...fromSend(found.sendKey, found.send),
    data: { stars: p.stars, hasFeedback: Boolean(feedback) },
    // Private feedback reaches the owner's alert email only — never the 25-month log.
    ...(feedback ? { guest: { feedback } } : {}),
  });
  return { ignored: false };
}
