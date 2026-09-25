/**
 * Helpers for the engine's emulator tests. Only ever run through
 * tests/emulator/run.sh, which points everything at a throwaway emulator.
 */

import { db } from '../../src/firebase';
import { ensureAdaptiveSeed } from '../../src/adaptive/seed/ensureSeed';
import { invalidateCatalogue } from '../../src/adaptive/service/catalogue';
import { saveSetups } from '../../src/adaptive/service/tenant';
import { clearEngineSettingsCache, type LaunchMode } from '../../src/adaptive/store/engineSettings';
import { adaptiveOnConnect, __clearConnectCaches } from '../../src/adaptive/ingest/connect';
import { __clearLegacyCaches } from '../../src/adaptive/engine/route';
import { setSandboxClock, refreshClock, now } from '../../src/adaptive/engine/clock';
import { AdaptiveWorker } from '../../src/adaptive/worker/worker';
import { COL, CONFIG_DOC_ID } from '../../src/adaptive/store/collections';
import { zonedTime, localParts, DAY_MS } from '../../src/adaptive/core/runtime/time';
import { __clearRollupArming } from '../../src/adaptive/rollups/rollup';

if (!process.env.FIRESTORE_EMULATOR_HOST || process.env.ADAPTIVE_SANDBOX !== '1') {
  console.error('Run these through tests/emulator/run.sh (emulator + sandbox only).');
  process.exit(1);
}

export const TZ = 'Europe/Zurich';

let passed = 0;
let failed = 0;

export async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${(error as Error).stack?.split('\n').slice(0, 3).join('\n    ')}`);
  }
}

export function done(): never {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export async function resetEmulator(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const project = process.env.FIREBASE_PROJECT_ID;
  const res = await fetch(`http://${host}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`emulator reset failed: ${res.status}`);
  clearCaches();
}

export function clearCaches(): void {
  clearEngineSettingsCache();
  __clearConnectCaches();
  __clearLegacyCaches();
  invalidateCatalogue();
  __clearRollupArming();
}

export async function seedCatalogue(): Promise<void> {
  await ensureAdaptiveSeed();
  invalidateCatalogue();
}

export interface VenueFixture {
  tenant: string;
  venueId: string;
  apId: string;
  apMac: string;
  venueType?: string;
  playbookKey?: string;
  guestInfo?: boolean;
}

/** A venue + AP owned by the tenant, turned on through PR 1's real path (saveSetups, activate). */
export async function setupVenue(f: VenueFixture): Promise<void> {
  await db.collection(COL.venues).doc(f.venueId).set({
    tenantUserId: f.tenant,
    venue_name: `Venue ${f.venueId}`,
    venue_type: f.venueType ?? 'restaurant',
    timezone: TZ,
    isActive: true,
  });
  await db.collection(COL.accessPoints).doc(f.apId).set({ mac: f.apMac, venueId: f.venueId, tenantUserId: f.tenant, vendor: 'aruba' });
  await db.collection(COL.tenantUsers).doc(f.tenant).set({ email: `${f.tenant}@test.local`, active: true }, { merge: true });
  await saveSetups(
    f.tenant,
    {
      playbookKey: f.playbookKey ?? 'restaurant_growth',
      venueIds: [f.venueId],
      journeys: {},
      timezones: { [f.venueId]: TZ },
      overlapAck: { [f.venueId]: true },
      ...(f.guestInfo !== undefined ? { guestInfo: f.guestInfo } : {}),
      activate: true,
    },
    { uid: `${f.tenant}_owner`, kind: 'tenant_user', role: 'ADMIN' },
  );
  clearCaches();
}

export async function setLaunch(accounts: Record<string, LaunchMode>, opts: { default?: LaunchMode; paused?: boolean } = {}): Promise<void> {
  const update: Record<string, unknown> = { 'launch.default': opts.default ?? 'off' };
  for (const [t, m] of Object.entries(accounts)) update[`launch.accounts.${t}`] = m;
  if (opts.paused !== undefined) update['killSwitch.sendingPaused'] = opts.paused;
  await db.collection(COL.config).doc(CONFIG_DOC_ID).update(update);
  clearCaches();
}

/** Safety limits on AdaptiveConfig/global (e.g. a high sign-up limit for bulk tests). */
export async function setSafety(safety: Partial<{ maxSendsPerVenuePerDay: number; maxSendsPlatformPerDay: number; maxNewContactsPerApPerHour: number; staleAfterHours: number }>): Promise<void> {
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(safety)) update[`safety.${k}`] = v;
  await db.collection(COL.config).doc(CONFIG_DOC_ID).update(update);
  clearCaches();
}

/** A credit wallet with `credits` purchased credits in the shared bucket. */
export async function seedWallet(tenant: string, credits: number): Promise<void> {
  await db.collection(COL.creditWallets).doc(tenant).set({ balance: credits, subscriptionBalance: 0, purchasedBalance: credits, reserved: 0 });
}

export async function ledger(tenant: string): Promise<AnyDoc[]> {
  const snap = await db.collection(COL.creditWallets).doc(tenant).collection('ledger').get();
  return snap.docs.map((d) => ({ ...(d.data() as Record<string, any>), id: d.id }));
}

/** What the sandbox provider "sent". */
export async function outbox(): Promise<AnyDoc[]> {
  const snap = await db.collection(COL.sandboxOutbox).get();
  return snap.docs.map((d) => ({ ...(d.data() as Record<string, any>), id: d.id }));
}

export interface ConnectFixture {
  venue: VenueFixture;
  firstName?: string;
  email?: string | null;
  phone?: string | null;
  phoneCountryCode?: string | null;
  consent?: boolean;
  phoneVerified?: boolean;
  language?: string | null;
  guestId?: string;
  legacy?: Record<string, unknown>;
}

/** What /create-user does, minus the parts Adaptive doesn't read: save a guest doc, then call the real hook. */
export async function connect(c: ConnectFixture): Promise<string> {
  const ref = c.guestId ? db.collection(COL.guests).doc(c.guestId) : db.collection(COL.guests).doc();
  const phoneE164 = c.phone ? `+${(c.phoneCountryCode ?? '').replace(/\D/g, '')}${c.phone.replace(/\D/g, '').replace(/^0/, '')}` : null;
  await ref.set(
    {
      firstName: c.firstName ?? 'Guest',
      lastName: '',
      email: c.email ?? '',
      phone: c.phone ?? '',
      phoneCountryCode: c.phoneCountryCode ?? '',
      captivePortalAccessPointId: c.venue.apId,
      marketingOptIn: c.consent ?? false,
      marketingConsent: { given: c.consent ?? false },
      ...(phoneE164 ? { phoneE164 } : {}),
      ...(c.phoneVerified ? { phoneVerified: true } : {}),
      ...(c.language ? { language: c.language } : {}),
      ...(c.legacy ?? {}),
      createdAt: new Date(),
    },
    { merge: true },
  );
  await adaptiveOnConnect({
    route: 'create-user',
    wifiGuestId: ref.id,
    accessPointId: c.venue.apId,
    venueId: c.venue.venueId,
    apVendor: 'aruba',
    consentGiven: c.consent ?? false,
    language: c.language ?? null,
    firstName: c.firstName ?? 'Guest',
    lastName: null,
    email: c.email ?? null,
    phone: c.phone ?? null,
    phoneCountryCode: c.phoneCountryCode ?? null,
    phoneE164,
    emailVerified: false,
    phoneVerified: Boolean(c.phoneVerified),
  });
  return ref.id;
}

export const worker = new AdaptiveWorker();

export async function runDue(): Promise<number> {
  return worker.runDue();
}

export async function setClock(ms: number): Promise<void> {
  await setSandboxClock(ms);
  await refreshClock(true);
}

export async function advance(ms: number): Promise<void> {
  await setClock(now() + ms);
}

/** Runs everything due, moving the clock forward step by step to each next due task, up to `until`. */
export async function runUntil(until: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await runDue();
    const next = await db.collection(COL.journeyTasks).where('status', '==', 'queued').orderBy('dueAt').limit(1).get();
    const due = next.docs[0]?.get('dueAt')?.toMillis?.() ?? null;
    if (due === null || due > until) break;
    if (due > now()) await setClock(due);
  }
  if (now() < until) await setClock(until);
  await runDue();
}

/** The next Tuesday at 12:40 in Zurich, at least two days from real now (after any activation stamp). */
export function nextTuesday1240(): number {
  let t = Date.now() + 2 * DAY_MS;
  while (localParts(new Date(t), TZ).weekday !== 2) t += DAY_MS;
  const p = localParts(new Date(t), TZ);
  return zonedTime(p.year, p.month, p.day, 12, 40, TZ).getTime();
}

export type AnyDoc = Record<string, any> & { id: string };

export async function docsWhere(collection: string, field: string, value: unknown): Promise<AnyDoc[]> {
  const snap = await db.collection(collection).where(field, '==', value).get();
  return snap.docs.map((d) => ({ ...(d.data() as Record<string, any>), id: d.id }));
}

export async function contactIdFor(tenant: string, guestId: string): Promise<string> {
  const contacts = await docsWhere(COL.contacts, 'tenantUserId', tenant);
  const c = contacts.find((x) => (x.guestIds ?? []).includes(guestId));
  if (!c) throw new Error(`no contact for guest ${guestId}`);
  return c.id;
}

export { db, COL, now };
