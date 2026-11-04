/**
 * The guest's time zone as their phone reports it on the splash (spec §2 `guests.timezone`:
 * "captured at connect; fallback: phone-country main tz; fallback: venue tz").
 *
 * The portal sends `Intl.DateTimeFormat().resolvedOptions().timeZone`. Only a real place
 * is kept: an IANA `Area/Location` name the runtime knows. Refused: offsets ("+02:00" —
 * the spec says never store an offset, DST would break it), UTC / GMT / `Etc/*` (privacy
 * browsers report UTC, which isn't where the guest is), anything unknown or too long.
 *
 * Phones set their zone from the network, so at the venue this is nearly always the
 * venue's own zone. It counts when the venue's zone is missing or wrong, or the phone's
 * zone was set by hand. Pure.
 */

import { isValidTimeZone } from './time';

const MAX_LEN = 64;
// `Area/Location` or `Area/Region/Location`, starting with a letter (no offsets).
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2}$/;
// Zones that name no place (also the `Etc/*` family).
const NOT_A_PLACE = /^(etc\/|utc$|gmt|uct$|universal$|zulu$|greenwich$)/i;

/**
 * The device's zone from the splash body, or null when it can't be used. Keeps the name the
 * phone sent (e.g. `Asia/Kolkata`; the runtime would turn it into the older `Asia/Calcutta`),
 * only fixing its letter case.
 */
export function parseDeviceTimeZone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const tz = raw.trim();
  if (!tz || tz.length > MAX_LEN || !IANA_NAME.test(tz) || NOT_A_PLACE.test(tz)) return null;
  if (!isValidTimeZone(tz)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  // An alias of UTC under another name.
  if (NOT_A_PLACE.test(resolved)) return null;
  return resolved.toLowerCase() === tz.toLowerCase() ? resolved : tz;
}

/** The zone the guest's phone reported at their latest connect (Contacts.profile.timezone), when it is a real zone. */
export function contactDeviceTz(contact: { profile?: { timezone?: string | null } | null }): string | null {
  const tz = contact.profile?.timezone;
  return isValidTimeZone(tz) ? tz : null;
}

/** The zone a journey picks its send times in: the guest's device zone when known, else the venue's (decision D3). */
export function sendZone(context: { venueTz: string; deviceTz?: string | null }): string {
  const d = context.deviceTz;
  return d && isValidTimeZone(d) ? d : context.venueTz;
}
