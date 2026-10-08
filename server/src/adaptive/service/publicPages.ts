/**
 * Data for the small guest pages the cms serves (plan §5: `GET /public/offer/:shortCode`,
 * `GET /public/info/:shortCode`; PR D — and `GET /public/rating/:shortCode`, the rating page's
 * language and staff name, PR E follow-up). Mounted at `/internal/adaptive/public/…` behind the
 * shared secret — the cms page calls it server-side (a top-level `/public` is the pricing feed).
 *
 *  - Only a live journey link of the right kind, at the venue the page is for, answers.
 *    Anything else (unknown code, another kind, a test run, a legacy link, another venue)
 *    gets the same 404, so codes can't be probed.
 *  - No guest name, no contact details, no ids beyond the venue.
 *  - Opening a page isn't a click (the cms forwards clicks separately, H5).
 *  - Secrets and link lifetimes: core/owner/publicPages.ts (D-D7). The rating page has no end
 *    date (nothing secret; a rating from the link counts at any time).
 */

import type { ContactDoc } from '../store/engineTypes';
import { loadVenueContext, type VenueContext } from '../engine/context';
import { consentFor, consentState } from '../identity/resolve';
import { appendEvent } from '../engine/events';
import { eventIdFor } from '../core/runtime/ids';
import { scanJourneyRunnable } from '../core/scans/occasions';
import { db } from '../../firebase';
import { COL, guestInfoId } from '../store/collections';
import type { JourneySendDoc } from '../store/engineTypes';
import { notFound } from '../api/errors';
import { gone } from '../api/http';
import { LANGS, type Lang } from '../core/constants';
import { isI18n, pickLang } from '../core/schemas';
import { localDateKey } from '../core/runtime/time';
import { tsMs } from '../store/time';
import { now, refreshClock } from '../engine/clock';
import { loadInstance } from '../engine/instanceStore';
import { pinnedConfig } from '../engine/context';
import { loadStay } from '../stays/store';
import { resolveStayTimes } from '../stays/times';
import { GUEST_INFO_FIELD_NAMES, GUEST_INFO_SECRET_FIELDS } from '../core/owner/guestInfo';
import { infoLinkOpen, offerLinkOpen, offerStatus, pageField, secretsShown, staffNameOf, type InfoStay } from '../core/owner/publicPages';

const CODE = /^[A-Za-z0-9_]{1,64}$/;
const SEND_KEY = /^js_[0-9a-f]{32}$/;
const VENUE = /^[A-Za-z0-9_-]{1,128}$/;
const NOT_FOUND = 'Not found';

function asLang(v: unknown): Lang | null {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v) ? (v as Lang) : null;
}

/** The live journey link of this kind at this venue, with its send — or the one 404. */
async function journeyPage(shortCode: string, venueId: unknown, kind: 'offer' | 'hub' | 'rating') {
  if (!CODE.test(shortCode) || typeof venueId !== 'string' || !VENUE.test(venueId)) throw notFound(NOT_FOUND);
  const link = (await db.collection('CaptivePortal_ShortLinks').doc(shortCode).get()).data();
  if (!link || link.sendKind !== 'journey' || link.journeyLink !== kind || typeof link.sendKey !== 'string' || !SEND_KEY.test(link.sendKey)) throw notFound(NOT_FOUND);
  if (link.venueId !== venueId) throw notFound(NOT_FOUND);
  const send = (await db.collection(COL.journeySends).doc(link.sendKey).get()).data() as JourneySendDoc | undefined;
  if (!send || send.mode !== 'live' || send.venueId !== venueId || send.status === 'failed' || send.status === 'cancelled' || !send.instanceId) {
    throw notFound(NOT_FOUND);
  }
  const inst = await loadInstance(send.instanceId);
  if (!inst || inst.meta.venueId !== venueId) throw notFound(NOT_FOUND);
  const venue = (await db.collection(COL.venues).doc(venueId).get()).data() ?? {};
  await refreshClock();
  return {
    send,
    inst,
    sentAt: tsMs(send.sentAt) ?? tsMs(send.createdAt) ?? now(),
    venueName: String(venue.venue_name ?? venue.name ?? ''),
    tz: String(inst.meta.context?.venueTz ?? venue.timezone ?? 'Europe/Zurich'),
    lang: asLang(inst.meta.context?.lang) ?? 'en',
    t: now(),
  };
}

export async function publicOffer(shortCode: string, venueId: unknown, langHint?: unknown) {
  const p = await journeyPage(shortCode, venueId, 'offer');
  const vars = p.inst.state.vars ?? {};
  const expiresAt = typeof vars.offerExpiresAt === 'number' ? vars.offerExpiresAt : null;
  if (!offerLinkOpen(p.t, expiresAt, p.sentAt)) throw gone('This offer has ended');
  const lang = asLang(langHint) ?? p.lang;
  const redeemed = Boolean(p.inst.state.goal?.reachedAt);
  const label = isI18n(vars.offerLabel) ? pickLang(vars.offerLabel, lang) : typeof vars.offerLabel === 'string' ? vars.offerLabel : '';
  return {
    venueId: p.send.venueId,
    venueName: p.venueName,
    lang,
    birthday: await birthdayAsk(p.inst.meta.contactId, p.send.venueId),
    offer: {
      label,
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
      expiresOn: expiresAt === null ? null : localDateKey(new Date(expiresAt), p.tz),
      status: offerStatus(p.t, expiresAt, redeemed),
    },
  };
}

export async function publicInfo(shortCode: string, venueId: unknown, langHint?: unknown) {
  const p = await journeyPage(shortCode, venueId, 'hub');
  const lang = asLang(langHint) ?? p.lang;
  const stayId = typeof p.inst.meta.context?.stayId === 'string' ? p.inst.meta.context.stayId : null;
  let stay: (InfoStay & { checkIn: string; checkOut: string; nights: number }) | null = null;
  if (stayId) {
    const s = await loadStay(stayId);
    // A cancelled booking, or one no longer this guest's: the link is over (nothing of it shows).
    const current = Boolean(s) && s!.status !== 'cancelled' && s!.contactId === p.inst.meta.contactId;
    if (!s || !current) throw gone('This page is no longer available');
    stay = { checkInAt: s.checkInAt, checkOutAt: s.checkOutAt, current, checkIn: s.checkIn, checkOut: s.checkOut, nights: s.nights };
  }
  if (!infoLinkOpen(p.t, p.sentAt, stay)) throw gone('This page is no longer available');

  const gi = (await db.collection(COL.venueGuestInfo).doc(guestInfoId(p.send.venueId)).get()).data() ?? null;
  const secrets = secretsShown(p.t, p.sentAt, stay);
  const fields: Record<string, string | null> = {};
  for (const f of GUEST_INFO_FIELD_NAMES) {
    if (GUEST_INFO_SECRET_FIELDS.includes(f)) continue;
    fields[f] = pageField(gi, lang, f);
  }
  const times = resolveStayTimes(gi as { locales?: Record<string, Record<string, unknown> | undefined> } | null);
  // The venue-level times (D-C20): the same ones the messages print; never the 15:00/10:00 fallback.
  fields.checkInTime = times.checkIn;
  fields.checkOutTime = times.checkOut;
  return {
    venueId: p.send.venueId,
    venueName: p.venueName,
    lang,
    birthday: await birthdayAsk(p.inst.meta.contactId, p.send.venueId),
    info: fields,
    secrets: {
      wifiPassword: secrets.wifiPassword ? pageField(gi, lang, 'wifiPassword') : null,
      doorCode: secrets.doorCode ? pageField(gi, lang, 'doorCode') : null,
      keyInstructions: secrets.doorCode ? pageField(gi, lang, 'keyInstructions') : null,
      shownFrom: secrets.from === null ? null : new Date(secrets.from).toISOString(),
      shownUntil: secrets.until === null ? null : new Date(secrets.until).toISOString(),
    },
    stay: stay ? { checkIn: stay.checkIn, checkOut: stay.checkOut, nights: stay.nights, checkInTime: times.checkIn, checkOutTime: times.checkOut } : null,
  };
}

/**
 * The rating page opened from a journey's review ask (`{{link.rating}}`): the guest's language and
 * the staff name the owner put in that journey's `staff_name` blank — from the config version the
 * guest's journey runs with, as the engine reads it (`pinnedConfig`, engine/advance.ts). No offer,
 * no guest details. Never a 410 (see core/owner/publicPages.ts).
 */
export async function publicRating(shortCode: string, venueId: unknown, langHint?: unknown) {
  const p = await journeyPage(shortCode, venueId, 'rating');
  const lang = asLang(langHint) ?? p.lang;
  const pinned = await pinnedConfig(p.inst.meta.installId, p.inst.meta.configVersion, p.inst.meta.journeyKey);
  return {
    venueId: p.send.venueId,
    venueName: p.venueName,
    lang,
    staffName: staffNameOf(pinned.slots.staff_name, lang),
    birthday: await birthdayAsk(p.inst.meta.contactId, p.send.venueId),
  };
}

// ── PR S: the birthday month (decision S-D2) ─────────────────────────────────

/**
 * May this guest be asked their birthday month at this venue? Only while the venue runs the
 * Birthday journey (a version that runs), the guest said yes to marketing here (some channel)
 * and the owner hasn't stopped it — the gift couldn't reach anyone else — and only until they
 * have told us (never asked twice).
 */
function birthdayAskable(contact: ContactDoc | undefined, ctx: VenueContext | null, venueId: string): boolean {
  if (!contact || contact.status !== 'active' || typeof contact.profile?.birthdayMonth === 'number') return false;
  if (contact.ownerStoppedAll) return false;
  if (!Object.values(consentFor(contact, venueId)).some((c) => consentState(c) === 'granted')) return false;
  const jc = ctx?.marketing?.doc.journeys?.[BIRTHDAY_JOURNEY];
  return Boolean(jc?.enabled && scanJourneyRunnable(BIRTHDAY_JOURNEY, jc.templateVersion));
}

async function birthdayAsk(contactId: string, venueId: string): Promise<{ ask: boolean }> {
  try {
    const [contactSnap, ctx] = await Promise.all([db.collection(COL.contacts).doc(contactId).get(), loadVenueContext(venueId)]);
    return { ask: birthdayAskable(contactSnap.data() as ContactDoc | undefined, ctx, venueId) };
  } catch {
    return { ask: false }; // the page works without the question
  }
}

const BIRTHDAY_JOURNEY = 'birthday';

/** The page's link still opens (the same rules as the GETs: an ended offer or info link doesn't take answers). */
async function linkStillOpen(p: Awaited<ReturnType<typeof journeyPage>>, kind: 'offer' | 'hub' | 'rating'): Promise<boolean> {
  if (kind === 'rating') return true;
  if (kind === 'offer') {
    const vars = p.inst.state.vars ?? {};
    return offerLinkOpen(p.t, typeof vars.offerExpiresAt === 'number' ? vars.offerExpiresAt : null, p.sentAt);
  }
  const stayId = typeof p.inst.meta.context?.stayId === 'string' ? p.inst.meta.context.stayId : null;
  let stay: InfoStay | null = null;
  if (stayId) {
    const st = await loadStay(stayId);
    if (!st || st.status === 'cancelled' || st.contactId !== p.inst.meta.contactId) return false;
    stay = { checkInAt: st.checkInAt, checkOutAt: st.checkOutAt, current: true };
  }
  return infoLinkOpen(p.t, p.sentAt, stay);
}

export async function saveBirthdayMonth(shortCode: string, body: unknown): Promise<{ saved: boolean }> {
  const b = (body ?? {}) as { venueId?: unknown; kind?: unknown; month?: unknown };
  const kind = b.kind === 'offer' || b.kind === 'hub' || b.kind === 'rating' ? b.kind : null;
  const month = typeof b.month === 'number' && Number.isInteger(b.month) && b.month >= 1 && b.month <= 12 ? b.month : null;
  if (!kind || month === null) throw notFound(NOT_FOUND);
  const p = await journeyPage(shortCode, b.venueId, kind);
  if (!(await linkStillOpen(p, kind))) throw notFound(NOT_FOUND);
  const contactId = p.inst.meta.contactId;
  const ref = db.collection(COL.contacts).doc(contactId);
  const ctx = await loadVenueContext(p.send.venueId);
  const result = await db.runTransaction(async (tx): Promise<'saved' | 'had_one' | 'not_askable'> => {
    const snap = await tx.get(ref);
    const contact = snap.data() as ContactDoc | undefined;
    if (typeof contact?.profile?.birthdayMonth === 'number') return 'had_one';
    if (!birthdayAskable(contact, ctx, p.send.venueId)) return 'not_askable';
    tx.update(ref, { 'profile.birthdayMonth': month, 'profile.birthdayMonthAt': new Date(p.t), 'profile.birthdayMonthVia': `guest_page:${kind}`, updatedAt: new Date() });
    return 'saved';
  });
  // Nothing to ask here (Birthday isn't on, no yes to marketing): the same 404 as any other link.
  if (result === 'not_askable') throw notFound(NOT_FOUND);
  const saved = result === 'saved';
  if (saved) {
    await appendEvent(
      {
        type: 'profile.birthday_month',
        occurredAt: p.t,
        tenantUserId: p.inst.meta.tenantUserId,
        venueId: p.send.venueId,
        contactId,
        source: 'cms',
        data: { month, via: kind },
      },
      eventIdFor('guest', `birthday_month:${contactId}`),
    );
  }
  // A month told earlier is kept (first answer wins); the page isn't told which happened.
  return { saved: true };
}
