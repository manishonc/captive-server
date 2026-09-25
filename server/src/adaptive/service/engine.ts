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
