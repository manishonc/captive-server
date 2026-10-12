/**
 * Opt-outs coming back from the channels (plan §3.9), applied in one transaction
 * each and safe to repeat:
 *
 *  STOP (Twilio inbound, or 21610 on a send) → SMS blocked on that number for
 *        every owner (one shared sender) + SMS consent revoked wherever it was
 *        given, `revokedVia: 'channel'` so a splash tick can't undo it.
 *  START → the STOP block lifted and exactly the scopes STOP took re-granted.
 *  WhatsApp (PR W3): the same for a STOP / START sent on WhatsApp and Meta's 131050 — the
 *        number's WhatsApp block + WhatsApp consent (`waKeywordAt` orders them). An SMS STOP
 *        also ends WhatsApp *marketing*, read at send time (core/runtime/whatsappRules.ts).
 *  Email: the unsubscribe link / Brevo "unsubscribed" → email consent revoked for
 *        that venue; Brevo "spam" → the same + the address blocked for everyone.
 */

import { db } from '../../firebase';
import { COL } from '../store/collections';
import type { ContactDoc, ContactPointDoc } from '../store/engineTypes';
import { SCHEMA_VERSION } from '../core/constants';
import { tsMs } from '../store/time';
import { heldStartScopes, revokedScopesBy, stopScopes, writeConsentChanges, writeSuppression, type ConsentChange, type ConsentSource } from '../identity/consent';
import { WA_LIMITED_MS, WA_UNREACHABLE_MS } from '../core/runtime/whatsappRules';

const STOP_SOURCES = ['sms_keyword', 'provider_stop', 'import_legacy'];

async function readContacts(tx: FirebaseFirestore.Transaction, point: ContactPointDoc | null): Promise<Array<{ id: string; doc: ContactDoc }>> {
  const ids = Object.values(point?.tenantContacts ?? {}).filter(Boolean);
  if (!ids.length) return [];
  const snaps = await tx.getAll(...ids.map((id) => db.collection(COL.contacts).doc(id)));
  return snaps.filter((s) => s.exists).map((s) => ({ id: s.id, doc: s.data() as ContactDoc }));
}

/** When the last STOP / START for a number arrived: keywords apply in the order they were sent. */
function keywordTimes(point: ContactPointDoc | null): { stop: number; start: number } {
  const k = (point as unknown as { smsKeywordAt?: { stop?: unknown; start?: unknown } } | null)?.smsKeywordAt;
  return { stop: tsMs(k?.stop) ?? tsMs(point?.suppression?.sms?.at) ?? 0, start: tsMs(k?.start) ?? 0 };
}

/**
 * A STOP for a phone contact point (`at` = when the text arrived). Creates a bare
 * contact point when the number is new, so the block is waiting for them. Ignored if
 * a START that arrived later has already been applied.
 */
export async function applyPhoneStop(pointId: string, source: 'sms_keyword' | 'provider_stop', at: number, ref: Record<string, unknown> = {}): Promise<number> {
  return db.runTransaction(async (tx) => {
    const cpRef = db.collection(COL.contactPoints).doc(pointId);
    const cpSnap = await tx.get(cpRef);
    const point = cpSnap.exists ? (cpSnap.data() as ContactPointDoc) : null;
    const contacts = await readContacts(tx, point);
    if (keywordTimes(point).start > at) return 0; // the guest said START after this STOP
    if (!point) {
      tx.set(cpRef, {
        kind: 'phone',
        networkId: null,
        tenantContacts: {},
        suppression: { sms: { reason: 'stop', source, at: new Date(at) } },
        smsKeywordAt: { stop: new Date(at) },
        hardBounceCount: 0,
        lastBounceAt: null,
        verifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        schemaVersion: SCHEMA_VERSION,
      });
    } else {
      // One write: the block (unless already there) + when this STOP arrived.
      tx.set(
        cpRef,
        {
          ...(point.suppression?.sms ? {} : { suppression: { sms: { reason: 'stop', source, at: new Date(at), sendKey: (ref.sendKey as string) ?? null } } }),
          smsKeywordAt: { stop: new Date(Math.max(at, keywordTimes(point).stop)) },
          updatedAt: new Date(),
        },
        { merge: true },
      );
    }
    let revoked = 0;
    for (const c of contacts) {
      // Also where the owner stopped marketing after a yes (PR D): the guest's own STOP must stand.
      const changes: ConsentChange[] = stopScopes(c.doc, 'sms').map((venueId) => ({
        venueId,
        channel: 'sms',
        action: 'revoke',
        source,
        revokedVia: 'channel',
        sourceRef: ref,
      }));
      revoked += writeConsentChanges(tx, c.id, c.doc, changes, at).length;
    }
    return revoked;
  });
}

/**
 * START (`at` = when the text arrived): lift a STOP block and re-grant what STOP
 * revoked — never a bounce or an unsubscribe. Ignored if a later STOP was applied.
 */
export async function applyPhoneStart(pointId: string, at: number, ref: Record<string, unknown> = {}): Promise<number> {
  return db.runTransaction(async (tx) => {
    const cpRef = db.collection(COL.contactPoints).doc(pointId);
    const cpSnap = await tx.get(cpRef);
    if (!cpSnap.exists) {
      // A number we don't know yet: remember the START, so an older STOP processed later can't win.
      tx.set(cpRef, {
        kind: 'phone',
        networkId: null,
        tenantContacts: {},
        suppression: {},
        smsKeywordAt: { start: new Date(at) },
        hardBounceCount: 0,
        lastBounceAt: null,
        verifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        schemaVersion: SCHEMA_VERSION,
      });
      return 0;
    }
    const point = cpSnap.data() as ContactPointDoc;
    const contacts = await readContacts(tx, point);
    const times = keywordTimes(point);
    if (times.stop > at || times.start >= at) return 0; // a later STOP wins; an older START changes nothing
    // One write: the STOP block lifted (only a STOP, never a bounce) + when this START arrived.
    const lift = point.suppression?.sms?.reason === 'stop';
    const { sms: _stop, ...rest } = point.suppression ?? {};
    tx.update(cpRef, { ...(lift ? { suppression: rest } : {}), 'smsKeywordAt.start': new Date(at), updatedAt: new Date() });
    let granted = 0;
    for (const c of contacts) {
      const changes: ConsentChange[] = [
        ...revokedScopesBy(c.doc, 'sms', STOP_SOURCES).map((venueId) => ({
          venueId,
          channel: 'sms' as const,
          action: 'grant' as const,
          source: 'sms_keyword' as const,
          sourceRef: ref,
        })),
        // Where the owner stopped marketing since the STOP (PR D): the START is kept for the owner's Resume.
        ...heldStartScopes(c.doc, 'sms', STOP_SOURCES).map((venueId) => ({
          venueId,
          channel: 'sms' as const,
          action: 'grant' as const,
          source: 'sms_keyword' as const,
          sourceRef: { ...ref, heldByOwnerStop: true },
          heldByOwnerStop: true,
        })),
      ];
      granted += writeConsentChanges(tx, c.id, c.doc, changes, at).length;
    }
    return granted;
  });
}

const WA_STOP_SOURCES = ['whatsapp_keyword', 'meta_stop', 'import_legacy'];

/**
 * PR W3: Meta's 131049 (marketing held back: 24 h) or 131026 (can't get WhatsApp: 30 days) — no
 * WhatsApp (marketing) to the number until then. Only ever later: a repeated or older notice never
 * shortens it. Nothing when the number isn't known.
 */
export async function applyWhatsAppHold(pointId: string, effect: 'limited' | 'unreachable', at: number): Promise<void> {
  const field = effect === 'limited' ? 'whatsappLimitedUntil' : 'whatsappUnreachableUntil';
  const until = at + (effect === 'limited' ? WA_LIMITED_MS : WA_UNREACHABLE_MS);
  const ref = db.collection(COL.contactPoints).doc(pointId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || (tsMs(snap.get(field)) ?? 0) >= until) return;
    tx.update(ref, { [field]: new Date(until), updatedAt: new Date() });
  });
}

/** When the last WhatsApp STOP / START for a number arrived (PR W3). */
function waKeywordTimes(point: ContactPointDoc | null): { stop: number; start: number } {
  const k = (point as unknown as { waKeywordAt?: { stop?: unknown; start?: unknown } } | null)?.waKeywordAt;
  return { stop: tsMs(k?.stop) ?? tsMs(point?.suppression?.whatsapp?.at) ?? 0, start: tsMs(k?.start) ?? 0 };
}

/**
 * PR W3: Meta's own WhatsApp id for a number we send to differs from it (Mexico's 521…): remember the
 * id's point on the number's point (`whatsappWaIdOf`, a STOP from the id applies here too), and carry
 * a WhatsApp STOP that already came from the id (before this number's first send). Safe to repeat.
 */
export async function linkWhatsAppId(pointId: string, waIdPointId: string, ref: Record<string, unknown> = {}): Promise<void> {
  if (pointId === waIdPointId) return;
  await db.collection(COL.contactPoints).doc(pointId).set({ whatsappWaIdOf: waIdPointId }, { merge: true });
  const alias = (await db.collection(COL.contactPoints).doc(waIdPointId).get()).data() as ContactPointDoc | undefined;
  if (alias?.suppression?.whatsapp?.reason === 'stop') {
    await applyWhatsAppStop(pointId, 'whatsapp_keyword', waKeywordTimes(alias).stop || Date.now(), { ...ref, fromWaId: true });
  }
}

/**
 * PR W3: a WhatsApp STOP for a phone (`at` = when it arrived: an inbound STOP, or Meta's 131050).
 * Blocks WhatsApp on the number for every owner (one shared sender) and revokes WhatsApp consent
 * wherever it was given (`revokedVia: 'channel'`). Ignored if a later START was applied.
 */
export async function applyWhatsAppStop(pointId: string, source: 'whatsapp_keyword' | 'meta_stop', at: number, ref: Record<string, unknown> = {}): Promise<number> {
  return db.runTransaction(async (tx) => {
    const cpRef = db.collection(COL.contactPoints).doc(pointId);
    const cpSnap = await tx.get(cpRef);
    const point = cpSnap.exists ? (cpSnap.data() as ContactPointDoc) : null;
    const contacts = await readContacts(tx, point);
    if (waKeywordTimes(point).start > at) return 0; // the guest said START after this STOP
    if (!point) {
      tx.set(cpRef, {
        kind: 'phone',
        networkId: null,
        tenantContacts: {},
        suppression: { whatsapp: { reason: 'stop', source, at: new Date(at) } },
        waKeywordAt: { stop: new Date(at) },
        hardBounceCount: 0,
        lastBounceAt: null,
        verifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        schemaVersion: SCHEMA_VERSION,
      });
    } else {
      tx.set(
        cpRef,
        {
          ...(point.suppression?.whatsapp ? {} : { suppression: { whatsapp: { reason: 'stop', source, at: new Date(at), sendKey: (ref.sendKey as string) ?? null } } }),
          waKeywordAt: { stop: new Date(Math.max(at, waKeywordTimes(point).stop)) },
          updatedAt: new Date(),
        },
        { merge: true },
      );
    }
    let revoked = 0;
    for (const c of contacts) {
      const changes: ConsentChange[] = stopScopes(c.doc, 'whatsapp').map((venueId) => ({
        venueId,
        channel: 'whatsapp',
        action: 'revoke',
        source,
        revokedVia: 'channel',
        sourceRef: ref,
      }));
      revoked += writeConsentChanges(tx, c.id, c.doc, changes, at).length;
    }
    return revoked;
  });
}

/** PR W3: a WhatsApp START — lifts a WhatsApp STOP block and re-grants what a STOP took. */
export async function applyWhatsAppStart(pointId: string, at: number, ref: Record<string, unknown> = {}): Promise<number> {
  return db.runTransaction(async (tx) => {
    const cpRef = db.collection(COL.contactPoints).doc(pointId);
    const cpSnap = await tx.get(cpRef);
    if (!cpSnap.exists) {
      tx.set(cpRef, {
        kind: 'phone',
        networkId: null,
        tenantContacts: {},
        suppression: {},
        waKeywordAt: { start: new Date(at) },
        hardBounceCount: 0,
        lastBounceAt: null,
        verifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        schemaVersion: SCHEMA_VERSION,
      });
      return 0;
    }
    const point = cpSnap.data() as ContactPointDoc;
    const contacts = await readContacts(tx, point);
    const times = waKeywordTimes(point);
    if (times.stop > at || times.start >= at) return 0;
    const lift = point.suppression?.whatsapp?.reason === 'stop';
    const { whatsapp: _stop, ...rest } = point.suppression ?? {};
    tx.update(cpRef, { ...(lift ? { suppression: rest } : {}), 'waKeywordAt.start': new Date(at), updatedAt: new Date() });
    let granted = 0;
    for (const c of contacts) {
      const changes: ConsentChange[] = [
        ...revokedScopesBy(c.doc, 'whatsapp', WA_STOP_SOURCES).map((venueId) => ({
          venueId,
          channel: 'whatsapp' as const,
          action: 'grant' as const,
          source: 'whatsapp_keyword' as const,
          sourceRef: ref,
        })),
        ...heldStartScopes(c.doc, 'whatsapp', WA_STOP_SOURCES).map((venueId) => ({
          venueId,
          channel: 'whatsapp' as const,
          action: 'grant' as const,
          source: 'whatsapp_keyword' as const,
          sourceRef: { ...ref, heldByOwnerStop: true },
          heldByOwnerStop: true,
        })),
      ];
      granted += writeConsentChanges(tx, c.id, c.doc, changes, at).length;
    }
    return granted;
  });
}

/**
 * Email consent revoked for one venue (unsubscribe link, Brevo unsubscribed, spam).
 * `spam` also blocks the address for every owner.
 */
export async function applyEmailRevoke(args: {
  contactId: string;
  venueId: string;
  source: Extract<ConsentSource, 'unsubscribe_page' | 'brevo_unsubscribed' | 'brevo_spam'>;
  at: number;
  ref?: Record<string, unknown>;
}): Promise<number> {
  return db.runTransaction(async (tx) => {
    const contactRef = db.collection(COL.contacts).doc(args.contactId);
    const snap = await tx.get(contactRef);
    if (!snap.exists) return 0;
    const contact = snap.data() as ContactDoc;
    let point: ContactPointDoc | null = null;
    if (args.source === 'brevo_spam' && contact.emailPointId) {
      const cp = await tx.get(db.collection(COL.contactPoints).doc(contact.emailPointId));
      point = cp.exists ? (cp.data() as ContactPointDoc) : null;
    }
    if (args.source === 'brevo_spam' && contact.emailPointId && point) {
      writeSuppression(tx, contact.emailPointId, point, 'email', { reason: 'spam_complaint', source: 'brevo', at: args.at, sendKey: (args.ref?.sendKey as string) ?? null });
    }
    return writeConsentChanges(
      tx,
      args.contactId,
      contact,
      [{ venueId: args.venueId, channel: 'email', action: 'revoke', source: args.source, revokedVia: 'channel', sourceRef: args.ref ?? {} }],
      args.at,
    ).length;
  });
}
