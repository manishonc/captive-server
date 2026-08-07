/**
 * The guest's language: one normaliser, one variant resolver, one filter.
 *
 * A guest picks a language on the splash screen (portal/public/js/config.js);
 * it is stored on their CaptivePortal_Users document and then decides the
 * wording of everything we send them afterwards — the OTP, venue automations,
 * campaigns.
 *
 * MIRROR SITES — the supported set is repeated in three places because they run
 * in three different runtimes and none can import from the others:
 *   - captive-server/portal/public/js/i18n.js   (browser, no modules)
 *   - captive-server/portal/server.js           (CommonJS)
 *   - cms/app/api/captive-portal/_lib/languages.js
 * Adding a language means adding it to all three plus a catalog block in
 * i18n.js. A code that reaches Firestore but is missing from a catalog renders
 * English to the guest, which is a silent failure — hence the allowlist here
 * rather than accepting any ISO code.
 */

export const SUPPORTED_LANGUAGES = ['en', 'de', 'it', 'fr'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

/**
 * Anything → a supported code, or null.
 *
 * Returns null rather than defaulting to 'en' so callers can tell "the guest
 * chose English" apart from "we do not know what this guest reads". The
 * difference matters for audience filters, where the second group is the
 * `unknown` bucket, and for writes, where we must not stamp a guess onto a
 * record and then treat it as a choice.
 *
 * Regional tags collapse to their base ('de-CH' → 'de'): a Swiss-German browser
 * should get German, and Meta/Twilio locale strings ('en_US') arrive here too.
 */
export function normalizeLanguage(value: unknown): SupportedLanguage | null {
  if (typeof value !== 'string') return null;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(base)
    ? (base as SupportedLanguage)
    : null;
}

/** Same, but for paths that need a usable code no matter what. */
export function languageOrDefault(value: unknown): SupportedLanguage {
  return normalizeLanguage(value) ?? DEFAULT_LANGUAGE;
}

/**
 * A message with optional per-language overrides of its own fields.
 *
 * The base fields ARE the default-language content, so an absent variant is
 * never an error — it is the fallback the spec asks for. That is why resolution
 * needs no venue-config lookup at send time.
 */
export interface TranslatableMessage {
  translations?: Record<string, Record<string, unknown>> | null;
}

/**
 * Overlay the guest's language variant onto a message.
 *
 * Only non-empty string fields override; a variant that exists but leaves
 * `subject` blank keeps the base subject rather than sending an empty one.
 * Structural fields a variant must never carry (channel, delayMinutes, id) are
 * simply absent from any variant the validators accept — see
 * cms/app/api/captive-portal/_lib/campaigns.js.
 */
export function resolveVariant<T extends TranslatableMessage>(
  message: T,
  language: unknown,
): T {
  const code = normalizeLanguage(language);
  if (!code || !message || typeof message !== 'object') return message;

  const variant = message.translations?.[code];
  if (!variant || typeof variant !== 'object') return message;

  // The return type is T, not a widened record: callers keep every field type
  // they had, because a variant may only overwrite values, never add new keys
  // the base message did not declare.
  const out: Record<string, unknown> = { ...(message as Record<string, unknown>) };
  for (const [key, value] of Object.entries(variant)) {
    if (typeof value === 'string') {
      if (value.trim()) out[key] = value;
    } else if (value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out as T;
}

/** The value an audience filter uses for a guest with no language recorded. */
export const UNKNOWN_LANGUAGE = 'unknown';

/**
 * Does this guest match a `segment.language` filter?
 *
 * An absent filter matches everyone — language targeting is opt-in, so adding
 * the field must not shrink existing campaigns' audiences. `unknown` selects
 * exactly the guests captured before the splash screen offered a language (or
 * who never picked one), which is the only way to reach them deliberately.
 */
export function matchesLanguageFilter(
  guestLanguage: unknown,
  filter: unknown,
): boolean {
  if (!filter || typeof filter !== 'string') return true;
  const wanted = filter.trim().toLowerCase();
  if (!wanted) return true;
  const actual = normalizeLanguage(guestLanguage);
  if (wanted === UNKNOWN_LANGUAGE) return actual === null;
  return actual === wanted;
}
