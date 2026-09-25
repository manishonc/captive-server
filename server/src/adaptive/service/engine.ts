/**
 * Engine status and the sandbox helpers behind `/internal/adaptive/admin/engine`
 * and `/internal/adaptive/dev/*`.
 *
 * The status is read-only. The dev helpers (fake clock, launch switch, guest log)
 * exist only when the sandbox is on — the local emulator stack — and are not
 * mounted in production. The real admin launch switch comes with PR D.
 */

import { db } from '../../firebase';
import { COL, CONFIG_DOC_ID, ENGINE_STATUS_DOC_ID } from '../store/collections';
import { readEngineSettings, clearEngineSettingsCache, type LaunchMode } from '../store/engineSettings';
import { toJson } from '../store/serialize';
import { tsMs } from '../store/time';
import { ENGINE_RUNTIME_VERSION } from '../core/runtime/version';
import { contactPointId, identityReady, keyFingerprint } from '../identity/key';
import { advanceSandboxClock, now, refreshClock, resetSandboxClock, sandboxEnabled } from '../engine/clock';
import { durationMs } from '../core/runtime/time';
import { explainDecision, type DecisionRecord } from '../core/runtime/decision';
import { normalizeE164, normalizeEmail } from '../../services/phone';
import { ApiError } from '../api/errors';
import type { Lang } from '../core/constants';
import { z } from 'zod';
import type { ContactDoc, JourneySendDoc } from '../store/engineTypes';
import { adaptiveOnBrevoEvents, adaptiveOnInboundSms, adaptiveOnTwilioStatus, adaptiveOnUnsubscribe, ingestClick, ingestRating } from '../ingest/signals';

async function countWhere(status: string): Promise<number> {
  const snap = await db.collection(COL.journeyTasks).where('status', '==', status).count().get();
  return snap.data().count;
}

export async function getEngineStatus() {
  const [statusSnap, settings, queued, leased, dead, oldest] = await Promise.all([
    db.collection(COL.config).doc(ENGINE_STATUS_DOC_ID).get(),
    readEngineSettings(),
    countWhere('queued'),
    countWhere('leased'),
    countWhere('dead'),
    // Needs the hand-made (status, dueAt) index: if it is missing or still building,
    // report that here instead of failing the whole status (which shows indexCheck).
    db.collection(COL.journeyTasks)
      .where('status', '==', 'queued')
      .where('dueAt', '<=', new Date(now()))
      .orderBy('dueAt')
      .limit(1)
      .get()
      .then((snap) => ({ snap, error: null as string | null }))
      .catch((err: unknown) => ({ snap: null, error: String((err as Error)?.message ?? err).slice(0, 300) })),
  ]);
  const apiFingerprint = keyFingerprint();
  const workers = Object.entries((statusSnap.get('workers') ?? {}) as Record<string, Record<string, unknown>>).map(([id, w]) => {
    const lastBeat = tsMs(w.lastBeatAt);
    return {
      id,
      ...toJson(w),
      alive: lastBeat !== null && Date.now() - lastBeat < 3 * 60_000,
      sameVersion: w.version === ENGINE_RUNTIME_VERSION,
      sameKey: Boolean(apiFingerprint) && w.keyFingerprint === apiFingerprint,
    };
  });
  const oldestDue = oldest.snap?.docs[0] ? tsMs(oldest.snap.docs[0].get('dueAt')) : null;
  const pinned = statusSnap.get('identity.keyFingerprint');
  return {
    api: { version: ENGINE_RUNTIME_VERSION, identityReady: identityReady(), keyFingerprint: apiFingerprint, sandbox: sandboxEnabled() },
    launch: settings.launch,
    paused: settings.paused,
    safety: settings.safety,
    workers,
    identity: { pinnedFingerprint: typeof pinned === 'string' ? pinned : null, apiMatchesPinned: typeof pinned === 'string' ? pinned === apiFingerprint : null },
    queue: {
      queued,
      leased,
      dead,
      lagSeconds: oldest.error ? null : oldestDue !== null ? Math.max(0, Math.round((now() - oldestDue) / 1000)) : 0,
      ...(oldest.error ? { lagError: oldest.error } : {}),
    },
    indexCheck: toJson(statusSnap.get('indexCheck') ?? null),
  };
}

// ── Sandbox only ─────────────────────────────────────────────────────────────

function requireSandbox(): void {
  if (!sandboxEnabled()) throw new ApiError('not_found', 'Not found');
}

export async function devClock(body: { advance?: string; reset?: boolean }) {
  requireSandbox();
  if (body.reset) await resetSandboxClock();
  else if (body.advance) await advanceSandboxClock(durationMs(body.advance));
  await refreshClock(true);
  return { now: new Date(now()).toISOString() };
}

export async function devLaunch(body: { default?: LaunchMode; accounts?: Record<string, LaunchMode>; paused?: boolean }) {
  requireSandbox();
  const update: Record<string, unknown> = {};
  if (body.default) update['launch.default'] = body.default;
  for (const [tenant, mode] of Object.entries(body.accounts ?? {})) update[`launch.accounts.${tenant}`] = mode;
  if (typeof body.paused === 'boolean') update['killSwitch.sendingPaused'] = body.paused;
  if (Object.keys(update).length) {
    update['launch.changedBy'] = 'sandbox';
    await db.collection(COL.config).doc(CONFIG_DOC_ID).update(update);
  }
  clearEngineSettingsCache();
  const settings = await readEngineSettings();
  return { launch: settings.launch, paused: settings.paused };
}

/** Everything the engine knows about one person — the local stand-in for the PR D guest timeline. */
export async function devGuestLog(query: { email?: string; phone?: string; lang?: string }) {
  requireSandbox();
  const pointIds: string[] = [];
  const email = query.email ? normalizeEmail(query.email) : null;
  const phone = query.phone ? normalizeE164('', query.phone) : null;
  if (email) pointIds.push(contactPointId('email', email));
  if (phone) pointIds.push(contactPointId('phone', phone));
  if (!pointIds.length) throw new ApiError('bad_request', 'Give an email or a phone (+41…)');

  const contactIds = new Set<string>();
  for (const id of pointIds) {
    const snap = await db.collection(COL.contactPoints).doc(id).get();
    for (const c of Object.values((snap.get('tenantContacts') ?? {}) as Record<string, string>)) contactIds.add(c);
  }
  const lang = (query.lang === 'de' ? 'de' : 'en') as Lang;
  const contacts = [];
  for (const contactId of contactIds) {
    const [contact, events, sends, instances] = await Promise.all([
      db.collection(COL.contacts).doc(contactId).get(),
      db.collection(COL.journeyEvents).where('contactId', '==', contactId).get(),
      db.collection(COL.journeySends).where('contactId', '==', contactId).get(),
      db.collection(COL.journeyInstances).where('contactId', '==', contactId).get(),
    ]);
    const tz = String(contact.get('lastVenueTz') ?? 'Europe/Zurich');
    const timeline = events.docs
      .map((d) => {
        const e = d.data();
        const decision = e.data?.decision as DecisionRecord | undefined;
        return {
          at: toJson(e.occurredAt),
          type: e.type,
          journeyKey: e.journeyKey,
          nodeId: e.nodeId,
          why: decision ? explainDecision(decision, lang, tz) : undefined,
          checks: decision?.checks,
        };
      })
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    contacts.push({
      contactId,
      contact: toJson(contact.data() ?? null),
      instances: instances.docs.map((d) => ({ id: d.id, ...toJson(d.data()) })),
      sends: sends.docs.map((d) => ({ sendKey: d.id, ...toJson(d.data()) })),
      timeline,
    });
  }
  return { now: new Date(now()).toISOString(), contacts };
}

const PROVIDER_EVENTS = ['delivered', 'failed', 'opened', 'bounce', 'spam', 'unsubscribe', 'click', 'rating', 'stop', 'start', 'reply'] as const;

/**
 * Sandbox only: fake what a provider or the CMS would send back for one send —
 * through the same hook functions the real webhooks call, so the whole path runs.
 */
export async function devProviderEvent(body: unknown) {
  requireSandbox();
  const p = z
    .object({
      sendKey: z.string().regex(/^js_[0-9a-f]{32}$/),
      event: z.enum(PROVIDER_EVENTS),
      stars: z.number().int().min(1).max(5).optional(),
      text: z.string().max(500).optional(),
    })
    .parse(body);
  const snap = await db.collection(COL.journeySends).doc(p.sendKey).get();
  const s = snap.data() as JourneySendDoc | undefined;
  if (!s) throw new ApiError('not_found', 'No such send');
  const contact = (await db.collection(COL.contacts).doc(s.contactId).get()).data() as ContactDoc | undefined;
  const brevo = (event: string) => adaptiveOnBrevoEvents([{ event, 'message-id': s.providerMessageId ?? '', 'X-Mailin-custom': p.sendKey }]);
  const inbound = (kind: 'stop' | 'start' | null, text: string) => {
    if (!contact?.phoneE164) throw new ApiError('bad_request', 'This guest has no phone number');
    return adaptiveOnInboundSms({ from: contact.phoneE164, body: text, legacyKind: kind, messageSid: `SMdev${Date.now()}`, optOutType: null, signatureChecked: true });
  };
  switch (p.event) {
    case 'delivered':
    case 'failed':
      if (s.channel === 'sms') await adaptiveOnTwilioStatus({ messageSid: s.providerMessageId ?? '', status: p.event === 'delivered' ? 'delivered' : 'undelivered', errorCode: p.event === 'failed' ? '30003' : null });
      else await brevo(p.event === 'delivered' ? 'delivered' : 'error');
      break;
    case 'opened':
      await brevo('opened');
      break;
    case 'bounce':
      await brevo('hard_bounce');
      break;
    case 'spam':
      await brevo('spam');
      break;
    case 'unsubscribe':
      await adaptiveOnUnsubscribe({ g: p.sendKey, v: s.venueId, c: p.sendKey });
      break;
    case 'click':
    case 'rating': {
      const codes = s.shortCodes ?? [];
      if (!codes.length) throw new ApiError('bad_request', 'This send has no links');
      const links = await Promise.all(codes.map((c) => db.collection('CaptivePortal_ShortLinks').doc(c).get()));
      const rating = links.find((l) => l.get('journeyLink') === 'rating');
      if (p.event === 'click') await ingestClick({ shortCode: codes[0] });
      else if (!rating) throw new ApiError('bad_request', 'This send has no rating link');
      else await ingestRating({ shortCode: rating.id, stars: p.stars ?? 5, feedback: p.text ?? null });
      break;
    }
    case 'stop':
      await inbound('stop', 'STOP');
      break;
    case 'start':
      await inbound('start', 'START');
      break;
    case 'reply':
      await inbound(null, p.text ?? 'danke');
      break;
  }
  return { queued: p.event, sendKey: p.sendKey };
}
