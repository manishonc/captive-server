/**
 * Channel-scoped marketing opt-outs (SMS STOP / WhatsApp opt-out).
 *
 * Email unsubscribes flow through /u/:token (services/unsubscribe.ts) and set
 * `unsubscribed`. SMS and WhatsApp opt-outs are independent suppressions:
 * a guest who texts STOP keeps receiving email they're still opted into.
 *
 * Guest doc fields (CaptivePortal_Users):
 *   smsOptOut / smsOptOutAt          — set by inbound Twilio STOP
 *   whatsappOptOut / whatsappOptOutAt — set by inbound WhatsApp STOP
 *
 * CTIA standard keywords. STOP by phone number opts out EVERY guest record
 * matching that phone (guests are per-access-point, and the carrier-level
 * opt-out is number-scoped anyway) — this intentionally crosses venue/tenant
 * boundaries, mirroring how Twilio's own Advanced Opt-Out behaves.
 */

import { db } from '../firebase';
import { FieldValue } from 'firebase-admin/firestore';

const USERS = 'CaptivePortal_Users';

export const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
export const START_KEYWORDS = ['START', 'UNSTOP', 'YES'];
export const HELP_KEYWORDS = ['HELP', 'INFO'];

export type OptOutChannel = 'sms' | 'whatsapp';

export function classifyInbound(body: string): 'stop' | 'start' | 'help' | null {
  const word = String(body ?? '').trim().toUpperCase();
  if (STOP_KEYWORDS.includes(word)) return 'stop';
  if (START_KEYWORDS.includes(word)) return 'start';
  if (HELP_KEYWORDS.includes(word)) return 'help';
  return null;
}

/** Digits-only form of a phone number ("+41 79 123 45 67" -> "41791234567"). */
function digitsOf(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

/**
 * Find guest docs matching an inbound phone number. Guests store phone in
 * whatever format they typed (plus a separate phoneCountryCode), so we try
 * cheap equality variants first and fall back to an in-memory scan comparing
 * digit-normalized values. STOP events are rare, so the fallback's cost is
 * acceptable; new guests should get a normalized phoneE164 field eventually.
 */
async function findGuestsByPhone(fromE164: string) {
  const digits = digitsOf(fromE164);
  if (digits.length < 8) return [];

  const variants = [
    `+${digits}`,
    digits,
    // National significant number for common 1-3 digit country codes.
    digits.slice(1),
    digits.slice(2),
    digits.slice(3),
  ];

  const matches = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
  await Promise.all(
    variants.map(async (variant) => {
      if (!variant) return;
      const snap = await db.collection(USERS).where('phone', '==', variant).get();
      snap.forEach((doc) => matches.set(doc.id, doc));
    }),
  );

  // Verify variant hits digit-wise (avoids false positives from the sliced
  // national-number variants matching a different country's number).
  const verified = Array.from(matches.values()).filter((doc) => {
    const d = doc.data() as Record<string, unknown>;
    const guestDigits = digitsOf(`${d.phoneCountryCode ?? ''}${d.phone ?? ''}`);
    return guestDigits.endsWith(digitsOf(String(d.phone ?? ''))) && digits.endsWith(digitsOf(String(d.phone ?? '')));
  });
  if (verified.length > 0) return verified;

  // Fallback: scan and compare normalized (rare path — STOP volume is tiny).
  const all = await db.collection(USERS).get();
  const scanned: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  all.forEach((doc) => {
    const d = doc.data() as Record<string, unknown>;
    const guestDigits = digitsOf(`${d.phoneCountryCode ?? ''}${d.phone ?? ''}`);
    if (guestDigits && (guestDigits === digits || digits.endsWith(guestDigits) || guestDigits.endsWith(digits))) {
      scanned.push(doc);
    }
  });
  return scanned;
}

/** Opt every guest record for this phone number out of (or back into) a channel. */
export async function setChannelOptOut(
  fromE164: string,
  channel: OptOutChannel,
  optedOut: boolean,
): Promise<number> {
  const guests = await findGuestsByPhone(fromE164);
  if (guests.length === 0) {
    console.warn(`[OPT-OUT] No guest records matched ${fromE164} (${channel} ${optedOut ? 'stop' : 'start'})`);
    return 0;
  }

  const field = channel === 'sms' ? 'smsOptOut' : 'whatsappOptOut';
  const atField = `${field}At`;
  await Promise.all(
    guests.map((doc) =>
      doc.ref
        .update({ [field]: optedOut, [atField]: FieldValue.serverTimestamp() })
        .catch((err) => console.error(`[OPT-OUT] update failed for ${doc.id}:`, err)),
    ),
  );

  console.log(
    `[OPT-OUT] ${optedOut ? 'Opted out' : 'Re-opted in'} ${guests.length} guest record(s) for ${fromE164} on ${channel}`,
  );
  return guests.length;
}
