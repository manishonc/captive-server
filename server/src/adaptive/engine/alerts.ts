/**
 * Alerts (plan §2.6, §3.5, §3.9): to HeidiFi when something needs a person —
 * a setup problem blocks sends, a daily ceiling is reached, a burst of sign-ups
 * trips the breaker, provider credentials fail, several bookings vanish from a
 * calendar at once — and to the owner for a low private rating, a calendar link
 * that keeps failing, or two bookings that overlap.
 *
 * Each alert has a deterministic id from its dedupe key (e.g. once per venue,
 * reason and day), so it is recorded — and emailed — at most once. HeidiFi's
 * address is `AdaptiveConfig/global.alerts.email`; with none set the alert is
 * only recorded (the admin card shows it, PR D). Emails go through the existing
 * services/brevo.ts sender (alerts are not journey sends). In the local stack
 * nothing is emailed.
 */

import { db } from '../../firebase';
import { COL } from '../store/collections';
import { hashId } from '../core/checksum';
import { DAY_MS } from '../core/runtime/time';
import { cachedEngineSettings } from '../store/engineSettings';
import { sendEmail } from '../../services/brevo';
import { escapeHtml } from '../send/compose';
import { sandboxEnabled } from './clock';

export type AlertKind =
  | 'setup_block'
  | 'venue_ceiling'
  | 'platform_ceiling'
  | 'signup_breaker'
  | 'provider_config'
  | 'low_rating'
  // Airbnb stays (PR C): a calendar link failing for over 24 h (owner, daily), several
  // bookings vanishing at once (HeidiFi, D-C35), two bookings overlapping (owner, D-C10)
  | 'stay_feed_failing'
  | 'stay_feed_suspect'
  | 'stay_overlap';

export interface AlertInput {
  kind: AlertKind;
  /** Same key → same alert (it is sent once). */
  dedupeKey: string;
  audience: 'heidifi' | 'owner';
  tenantUserId?: string | null;
  venueId?: string | null;
  subject: string;
  /** Plain text; no guest contact details. */
  text: string;
}

const KEEP_MS = 90 * DAY_MS;

function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return e?.code === 6 || /ALREADY_EXISTS/i.test(String(e?.message));
}

async function recipientFor(a: AlertInput): Promise<string | null> {
  if (a.audience === 'heidifi') return (await cachedEngineSettings()).alerts.email;
  if (!a.tenantUserId) return null;
  const snap = await db.collection(COL.tenantUsers).doc(a.tenantUserId).get();
  const email = snap.get('email');
  return typeof email === 'string' && email.includes('@') ? email : null;
}

/** Records the alert once and emails it. Never throws (an alert must not fail the work that raised it). */
export async function raiseAlert(a: AlertInput): Promise<void> {
  try {
    const ref = db.collection(COL.alerts).doc(hashId('al', a.dedupeKey));
    try {
      await ref.create({
        kind: a.kind,
        audience: a.audience,
        dedupeKey: a.dedupeKey,
        tenantUserId: a.tenantUserId ?? null,
        venueId: a.venueId ?? null,
        subject: a.subject,
        text: a.text,
        emailedTo: null,
        emailError: null,
        createdAt: new Date(),
        expireAt: new Date(Date.now() + KEEP_MS),
      });
    } catch (err) {
      if (isAlreadyExists(err)) return;
      throw err;
    }
    const to = await recipientFor(a);
    if (!to) return;
    if (sandboxEnabled() || process.env.FIRESTORE_EMULATOR_HOST) {
      await ref.update({ emailedTo: `sandbox:${to}` });
      return;
    }
    const html = `<p>${escapeHtml(a.text).replace(/\n/g, '<br>')}</p>`;
    const id = await sendEmail(to, a.subject, html, 0);
    await ref.update(id ? { emailedTo: to } : { emailError: 'email not configured' });
  } catch (err) {
    console.error('[ADAPTIVE ALERT]', a.kind, (err as Error)?.message || err);
  }
}

/** yyyymmdd of a moment in a time zone (dedupe keys "once per day"). */
export function dayKey(ms: number, tz: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  return p.replace(/-/g, '');
}
