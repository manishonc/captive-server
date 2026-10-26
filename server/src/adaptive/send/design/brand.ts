/**
 * The venue's look for an email, from the account's Branding page (`CaptivePortal_TenantBranding`,
 * validated by the cms API) and the venue doc. An account with no branding saved gets a neutral
 * ink look with the venue name as the wordmark — never HeidiFi's colours. Pure.
 */

export const FONT_STACKS = {
  arial: 'Arial, Helvetica, sans-serif',
  helvetica: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  georgia: "Georgia, 'Times New Roman', Times, serif",
  verdana: 'Verdana, Geneva, sans-serif',
  trebuchet: "'Trebuchet MS', 'Lucida Grande', Tahoma, sans-serif",
} as const;
export type FontKey = keyof typeof FONT_STACKS;

/** Average bold glyph width in em, so a big fact's longest word always fits the column. */
export const CHAR_WIDTH: Record<FontKey, number> = { arial: 0.6, helvetica: 0.6, georgia: 0.63, verdana: 0.72, trebuchet: 0.6 };

export interface DesignBrand {
  /** The venue's name: the wordmark when there is no logo, the sign-off, the footer. */
  name: string;
  primary: string;
  secondary: string;
  accent: string;
  font: FontKey;
  /** For light backgrounds. */
  logoUrl: string | null;
  /** For dark backgrounds (dark mode); without it the light logo sits on a white plate. */
  logoDarkUrl: string | null;
  address: string | null;
  /** Website and social links, in the order the footer shows them. */
  links: Array<{ label: string; url: string }>;
}

/** No branding saved: neutral ink, Helvetica, no logo. */
export const FALLBACK_COLORS = { primary: '#23262B', secondary: '#F2F2EF', accent: '#23262B' } as const;

const HEX = /^#[0-9a-fA-F]{6}$/;
const SOCIAL_LABELS: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', x: 'X', linkedin: 'LinkedIn', tiktok: 'TikTok' };

function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function text(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

/**
 * The brand for one venue's email. `branding` is the account's Branding doc (null when none was
 * saved); `venue` is what the venue doc says. The account logo comes first (the Branding page says
 * it is used in emails), the venue's own logo when the account has none.
 */
export function designBrandFrom(
  branding: Record<string, unknown> | null,
  venue: { name: string; address?: unknown; logoUrl?: unknown },
): DesignBrand {
  const b = branding ?? {};
  const saved = branding !== null;
  const color = (v: unknown, fallback: string) => (typeof v === 'string' && HEX.test(v) ? v.toUpperCase() : fallback);
  const font = typeof b.fontFamily === 'string' && b.fontFamily in FONT_STACKS ? (b.fontFamily as FontKey) : saved ? 'arial' : 'helvetica';
  const links: DesignBrand['links'] = [];
  const website = httpsUrl(b.website);
  const socials = (b.socials && typeof b.socials === 'object' ? b.socials : {}) as Record<string, unknown>;
  for (const key of Object.keys(SOCIAL_LABELS)) {
    const url = httpsUrl(socials[key]);
    if (url) links.push({ label: SOCIAL_LABELS[key], url });
  }
  if (website) links.push({ label: 'Website', url: website });
  return {
    name: text(venue.name, 120) ?? '',
    primary: saved ? color(b.primaryColor, FALLBACK_COLORS.primary) : FALLBACK_COLORS.primary,
    secondary: saved ? color(b.secondaryColor, FALLBACK_COLORS.secondary) : FALLBACK_COLORS.secondary,
    accent: saved ? color(b.accentColor, FALLBACK_COLORS.accent) : FALLBACK_COLORS.accent,
    font,
    logoUrl: httpsUrl(b.logoUrl) ?? httpsUrl(venue.logoUrl),
    logoDarkUrl: httpsUrl(b.logoDarkUrl),
    address: text(venue.address, 160),
    links: links.slice(0, 4),
  };
}
