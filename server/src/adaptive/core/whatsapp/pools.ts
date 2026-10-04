/**
 * The Adaptive messages that can go by WhatsApp (PR W1): every pool of a journey's live definition
 * whose `channels` include WhatsApp — each with its rule (`whatsappCategory`), the fields its
 * wording uses (what a template may use), and the link it carries (what the button opens). Read
 * from the catalogue, so a new journey shows up in the coverage grid by itself. Pure.
 */

import type { JourneyDefinition, I18n } from '../schemas';
import { pickLang } from '../schemas';
import { canonicalField, parseMergeExpressions } from '../registry/mergeFields';
import type { PoolInfo } from './checks';
import { WA_BODY_FIELDS, WA_BUTTON_FIELDS, WA_PROMO_FIELDS } from './template';

export interface PoolRow extends PoolInfo {
  journeyName: string;
  poolName: string;
  availability: 'available' | 'coming_soon';
}

/** A pool whose wording has no `link.*` but whose WhatsApp button should still open a page. */
const LINK_OVERRIDE: Readonly<Record<string, string>> = {
  // The SMS gives the host's own contact link (not a short link); on WhatsApp the button opens the info page.
  stay_midstay: 'link.hub',
};

const BASE_FIELDS = ['venue.name', 'contact.firstName'];

interface VariantLike {
  poolKey: string;
  journeyKey?: string | null;
  status?: string;
  channels: Record<string, unknown>;
  locales?: Partial<Record<string, Record<string, unknown>>>;
}

interface TemplateLike {
  key: string;
  name: I18n;
  availability: 'available' | 'coming_soon';
  definition: JourneyDefinition | null;
}

function textsOf(content: Record<string, unknown> | undefined): string[] {
  if (!content) return [];
  const out: string[] = [];
  const sms = content.sms as { text?: unknown } | undefined;
  const email = content.email as { subject?: unknown; preheader?: unknown; body?: unknown } | undefined;
  if (typeof sms?.text === 'string') out.push(sms.text);
  for (const v of [email?.subject, email?.preheader, email?.body]) if (typeof v === 'string') out.push(v);
  return out;
}

function fieldsIn(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) for (const e of parseMergeExpressions(t)) out.push(canonicalField(e.name));
  return out;
}

export function whatsappPools(templates: TemplateLike[], variants: VariantLike[]): PoolRow[] {
  const rows: PoolRow[] = [];
  for (const t of templates) {
    if (!t.definition) continue;
    for (const [poolKey, pool] of Object.entries(t.definition.pools ?? {})) {
      if (!pool.channels.includes('whatsapp')) continue;
      const rule = pool.whatsappCategory ?? (pool.purpose === 'service' ? 'utility' : 'marketing');
      const wordings = variants.filter((v) => v.poolKey === poolKey && (!v.journeyKey || v.journeyKey === t.key) && v.status !== 'retired');
      const allTexts = wordings.flatMap((v) => [...textsOf(v.channels), ...Object.values(v.locales ?? {}).flatMap((c) => textsOf(c))]);
      const used = new Set(fieldsIn(allTexts));
      const allowed = new Set<string>(BASE_FIELDS);
      for (const f of WA_BODY_FIELDS) if (used.has(f)) allowed.add(f);
      if (rule === 'utility') for (const f of WA_PROMO_FIELDS) allowed.delete(f);
      // The link: the first one the English SMS carries, else the email's; some pools have an override.
      const enTexts = wordings.flatMap((v) => textsOf(v.channels));
      const link = fieldsIn(enTexts).find((f) => (WA_BUTTON_FIELDS as readonly string[]).includes(f)) ?? LINK_OVERRIDE[poolKey] ?? null;
      rows.push({
        journeyKey: t.key,
        poolKey,
        purpose: pool.purpose,
        whatsappCategory: rule,
        allowedFields: [...allowed],
        linkField: link,
        journeyName: pickLang(t.name, 'en'),
        poolName: pool.name ? pickLang(pool.name, 'en') : poolKey,
        availability: t.availability,
      });
    }
  }
  return rows;
}
