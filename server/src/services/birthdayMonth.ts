/**
 * The splash's built-in Birthday month field (loginPage.fields.birthdayMonth).
 *
 * The portal builds a Jan–Dec picker (portal/public/js/config.js) and sends the pick as
 * a number 1–12 with /create-user and /unifi/authorize. The answer is saved on the guest
 * (CaptivePortal_Users.birthdayMonth) and handed to Adaptive, which keeps it on the
 * contact's profile (profile.birthdayMonth, via 'splash') for the Birthday journey.
 */

/**
 * A whole month 1–12 — a number, or its digits as a string. Anything else (skipped,
 * blank, junk, a date) is null, so a guest who skips the field never erases an earlier
 * answer.
 */
export function parseBirthdayMonth(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,2}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}
