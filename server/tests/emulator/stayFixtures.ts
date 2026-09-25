/**
 * Shared set-up for the Airbnb stays emulator tests (adaptiveStays*.test.ts): an Airbnb
 * venue with the stay playbook and Guest info, the sandbox calendar its feed reads, and
 * a clock anchored on an arrival day `D0` safely after the (real-time) activation stamp.
 */

import { randomUUID } from 'crypto';
import { COL, TZ, db, docsWhere, now, resetEmulator, runDue, seedCatalogue, setClock, setLaunch, setupVenue, type AnyDoc, type VenueFixture } from './helpers';
import { zonedTime } from '../../src/adaptive/core/runtime/time';
import { stayFeedId } from '../../src/adaptive/store/collections';
import { readEngineSettingsStrict } from '../../src/adaptive/store/engineSettings';
import { addDays } from '../../src/adaptive/stays/ical';
import { buildSandboxCalendar, putSandboxCalendar } from '../../src/adaptive/stays/source';
import { pollFeed, type PollResult } from '../../src/adaptive/stays/sync';
import { saveStayFeed } from '../../src/adaptive/service/stays';

export const R: VenueFixture = { tenant: 'tenant_r', venueId: 'venue_r', apId: 'ap_r', apMac: 'aa:bb:cc:dd:ee:10', venueType: 'airbnb', playbookKey: 'str_stay', guestInfo: true };
export const ACTOR = { uid: 'owner_r', kind: 'tenant_user' as const, role: 'ADMIN' };

/** Arrival day: ten days after real now (the activation stamps are real time, the moments engine time). */
export const D0 = (() => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 10 * 86_400_000));
  return p;
})();

export const day = (n: number) => addDays(D0, n);

/** `HH:MM` on arrival day + n, in the venue's zone. */
export function at(n: number, hhmm: string): number {
  const [y, m, d] = day(n).split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return zonedTime(y, m, d, h, mi, TZ).getTime();
}

/** "D+2 11:00" for messages. */
export function label(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const [y, m, d] = D0.split('-').map(Number);
  const [y2, m2, d2] = date.split('-').map(Number);
  const n = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y, m - 1, d)) / 86_400_000);
  return `D${n >= 0 ? '+' : ''}${n} ${get('hour')}:${get('minute')}`;
}

export const GUEST_INFO = (venueId: string, tenant: string, over: Record<string, unknown> = {}) => ({
  tenantUserId: tenant,
  venueId,
  locales: {
    en: {
      wifiName: 'Retreat Guest',
      checkInTime: '15:00',
      checkOutTime: '10:00',
      hostContactUrl: 'https://wa.me/41790000000',
      localTips: 'The bakery on the corner opens at 7.',
      directBookingUrl: 'https://retreat.example/book',
      ...over,
    },
    de: {
      wifiName: 'Retreat Gast',
      checkInTime: '15:00',
      checkOutTime: '10:00',
      hostContactUrl: 'https://wa.me/41790000000',
      localTips: 'Die Bäckerei an der Ecke öffnet um 7.',
      directBookingUrl: 'https://retreat.example/book',
    },
  },
});

export async function writeGuestInfo(v: VenueFixture = R, over: Record<string, unknown> = {}): Promise<void> {
  await db.collection(COL.venueGuestInfo).doc(`venue_${v.venueId}`).set(GUEST_INFO(v.venueId, v.tenant, over));
}

export interface Booking {
  uid?: string;
  checkIn: string;
  checkOut: string;
}

/** The sandbox calendar `name` holds these bookings (Airbnb-shaped). */
export async function writeCalendar(name: string, bookings: Booking[]): Promise<void> {
  await putSandboxCalendar(
    name,
    buildSandboxCalendar(
      bookings.map((b, i) => ({ uid: b.uid ?? `${name}-${i + 1}@sandbox.test`, checkIn: b.checkIn, checkOut: b.checkOut })),
      now(),
    ),
  );
}

/**
 * A fresh emulator with the Airbnb venue on, Guest info written, test mode, the clock at
 * `start` and the calendar `r` with `bookings` saved as the venue's feed and synced.
 */
export async function freshStay(bookings: Booking[], opts: { start?: number; venue?: VenueFixture; guestInfo?: boolean; launch?: 'test' | 'live' | 'off' } = {}): Promise<void> {
  const v = opts.venue ?? R;
  await resetEmulator();
  await seedCatalogue();
  await setupVenue(v);
  if (opts.guestInfo !== false) await writeGuestInfo(v);
  await setClock(opts.start ?? at(0, '09:00'));
  await setLaunch({ [v.tenant]: opts.launch ?? 'test' });
  await writeCalendar('r', bookings);
  await saveStayFeed(v.tenant, v.venueId, 'sandbox:calendar/r', ACTOR);
  await runDue();
}

/** A sync now, in this process, like /dev/stay-sync. */
export async function sync(v: VenueFixture = R): Promise<PollResult> {
  return pollFeed(stayFeedId(v.venueId), { now: now(), settings: await readEngineSettingsStrict() }, { kind: 'manual', owner: `test:${randomUUID()}` });
}

export async function staysAt(venueId = R.venueId): Promise<AnyDoc[]> {
  return docsWhere(COL.stays, 'venueId', venueId);
}

export async function instancesAt(venueId = R.venueId): Promise<AnyDoc[]> {
  return docsWhere(COL.journeyInstances, 'venueId', venueId);
}

export async function sendsFor(instanceId: string): Promise<AnyDoc[]> {
  const s = await docsWhere(COL.journeySends, 'instanceId', instanceId);
  return s.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
}

export async function eventsOf(type: string): Promise<AnyDoc[]> {
  return docsWhere(COL.journeyEvents, 'type', type);
}

/** Every send at the venue as "journey/node @ D+n HH:MM". */
export async function sendLog(venueId = R.venueId): Promise<string[]> {
  const sends = await docsWhere(COL.journeySends, 'venueId', venueId);
  return sends
    .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis() || String(a.journeyKey).localeCompare(String(b.journeyKey)))
    .map((s) => `${s.journeyKey}/${s.nodeId} @ ${label(s.createdAt.toMillis())}`);
}

export async function tasksOfKind(kind: string): Promise<AnyDoc[]> {
  return docsWhere(COL.journeyTasks, 'kind', kind);
}

export { runDue };
