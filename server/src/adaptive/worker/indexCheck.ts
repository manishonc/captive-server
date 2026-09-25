/**
 * Startup index check. The Firebase project is shared, so the engine's composite
 * indexes are created by hand (docs/adaptive-engine.md) — and the emulator doesn't
 * enforce them, so a missing one would only show up in production as a failed
 * query. The worker runs every engine query once with limit(1) at startup and
 * stays idle (saying which index is missing) until they all work.
 */

import { db } from '../../firebase';
import { COL } from '../store/collections';

interface Probe {
  name: string;
  run: () => Promise<unknown>;
}

const past = () => new Date(Date.now() - 1000);

const PROBES: Probe[] = [
  { name: 'JourneyTasks(status, dueAt)', run: () => db.collection(COL.journeyTasks).where('status', '==', 'queued').where('dueAt', '<=', past()).orderBy('dueAt').limit(1).get() },
  { name: 'JourneyTasks(status, leaseUntil)', run: () => db.collection(COL.journeyTasks).where('status', '==', 'leased').where('leaseUntil', '<=', past()).limit(1).get() },
  { name: 'JourneyInstances(contactId, status)', run: () => db.collection(COL.journeyInstances).where('contactId', '==', '_probe').where('status', '==', 'active').limit(1).get() },
  {
    name: 'JourneySends(venueId, mode, createdAt)',
    run: () => db.collection(COL.journeySends).where('venueId', '==', '_probe').where('mode', '==', 'live').where('createdAt', '>=', past()).count().get(),
  },
  { name: 'JourneySends(mode, createdAt)', run: () => db.collection(COL.journeySends).where('mode', '==', 'live').where('createdAt', '>=', past()).count().get() },
  {
    name: 'JourneySends(venueId, mode, purpose, createdAt)',
    run: () =>
      db.collection(COL.journeySends).where('venueId', '==', '_probe').where('mode', '==', 'live').where('purpose', '==', 'service').where('createdAt', '>=', past()).count().get(),
  },
  // The old opt-out lookups (engine/route.ts): equality only, which Firestore serves by
  // merging single-field indexes — probed so a field exempted from indexing shows up here.
  ...(['smsOptOut', 'whatsappOptOut'] as const).flatMap((flag) => [
    { name: `Users(phoneE164, ${flag})`, run: () => db.collection(COL.guests).where('phoneE164', '==', '_probe').where(flag, '==', true).limit(1).get() },
    { name: `Users(${flag})`, run: () => db.collection(COL.guests).where(flag, '==', true).select('phone').limit(1).get() },
  ]),
  { name: 'Users(email in, unsubscribed)', run: () => db.collection(COL.guests).where('email', 'in', ['_probe', '_probe2']).where('unsubscribed', '==', true).limit(1).get() },
];

export interface IndexCheckResult {
  ok: boolean;
  missing: Array<{ name: string; message: string }>;
}

export async function checkIndexes(): Promise<IndexCheckResult> {
  const missing: IndexCheckResult['missing'] = [];
  for (const p of PROBES) {
    try {
      await p.run();
    } catch (err) {
      const e = err as { code?: number; message?: string };
      const msg = String(e?.message ?? err);
      if (e?.code === 9 || /index/i.test(msg)) missing.push({ name: p.name, message: msg.slice(0, 400) });
      else throw err;
    }
  }
  return { ok: missing.length === 0, missing };
}
