/**
 * Data for the two small guest pages the cms serves (plan §5: `GET /public/offer/:shortCode`,
 * `GET /public/info/:shortCode`; PR D). Mounted at `/internal/adaptive/public/…` behind the
 * shared secret — the cms page calls it server-side (a top-level `/public` is the pricing feed).
 *
 *  - Only a live journey link of the right kind, at the venue the page is for, answers.
 *    Anything else (unknown code, another kind, a test run, a legacy link, another venue)
 *    gets the same 404, so codes can't be probed.
 *  - No guest name, no contact details, no ids beyond the venue.
 *  - Opening a page isn't a click (the cms forwards clicks separately, H5).
 *  - Secrets and link lifetimes: core/owner/publicPages.ts (D-D7).
 */

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
import { loadStay } from '../stays/store';
import { resolveStayTimes } from '../stays/times';
import { GUEST_INFO_FIELD_NAMES, GUEST_INFO_SECRET_FIELDS } from '../core/owner/guestInfo';
import { infoLinkOpen, offerLinkOpen, offerStatus, pageField, secretsShown, type InfoStay } from '../core/owner/publicPages';

const CODE = /^[A-Za-z0-9_]{1,64}$/;
const SEND_KEY = /^js_[0-9a-f]{32}$/;
const VENUE = /^[A-Za-z0-9_-]{1,128}$/;
const NOT_FOUND = 'Not found';

function asLang(v: unknown): Lang | null {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v) ? (v as Lang) : null;
}

/** The live journey link of this kind at this venue, with its send — or the one 404. */
async function journeyPage(shortCode: string, venueId: unknown, kind: 'offer' | 'hub') {
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
