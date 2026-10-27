/**
 * `GET /admin/journey-templates/:key/messages?lang=&version=` — the admin journey page's messages
 * (journey channels): loads one journey version, its wording, the example's blanks and offer menu, the
 * credit rates and the WhatsApp registry, and hands them to the pure view (journeyMessagesView.ts).
 * Read-only; never calls Meta.
 *
 * The example: guest Anna at Café Bellevue (the example venue Meta's template examples use), with the
 * blanks and offer menu of the published playbook that uses this journey at the most venues (then by
 * name), the journey's own defaults where a playbook gives none, and the no-branding email look.
 */

import { z } from 'zod';
import { LANGS, type Lang } from '../core/constants';
import { journeyDefinitionSchema, pickLang, type JourneyDefinition, type Offer, type SlotValue } from '../core/schemas';
import { slotStartValue } from '../core/registry';
import { getJourneyTemplate, getPlaybookVersion, listPlaybookHeaders } from '../store/definitions';
import { countSetupsByPlaybook } from '../store/venueSetups';
import { getCreditConfig } from '../../services/credits';
import { STOP_LINES } from '../send/compose';
import { designBrandFrom } from '../send/design';
import { loadWaPickContext, pickWaTemplate, type WaPickContext } from '../whatsapp/pick';
import { notFound } from '../api/errors';
import { loadCatalogue, versionContent } from './catalogue';
import { buildJourneyMessages, type WaPoolInput } from './journeyMessagesView';

export const EXAMPLE_VENUE = 'Café Bellevue';

const querySchema = z.object({
  lang: z.enum(LANGS).default('en'),
  version: z.coerce.number().int().positive().optional(),
});

/** The published playbook whose blanks and offers the example uses (null: no playbook uses this journey). */
async function examplePlaybook(journeyKey: string): Promise<{ key: string; name: string; slotDefaults: Record<string, SlotValue>; offers: Offer[] } | null> {
  const headers = (await listPlaybookHeaders()).filter((h) => h.publishedVersion);
  const found = await Promise.all(
    headers.map(async (h) => {
      const version = await getPlaybookVersion(h.key, h.publishedVersion as number);
      if (!version) return null;
      const content = versionContent(version);
      const entry = content.journeys.find((j) => j.journeyKey === journeyKey);
      if (!entry) return null;
      const counts = await countSetupsByPlaybook(h.key).catch(() => ({ setUp: 0, active: 0 }));
      return { key: h.key, name: pickLang(content.name) || h.key, slotDefaults: entry.slotDefaults ?? {}, offers: content.offerMenuDefaults ?? [], active: counts.active, setUp: counts.setUp };
    }),
  );
  const used = found.filter((f): f is NonNullable<typeof f> => f !== null);
  used.sort((a, b) => b.active - a.active || b.setUp - a.setUp || a.name.localeCompare(b.name));
  return used[0] ?? null;
}

function journeyDefaults(definition: JourneyDefinition): Record<string, SlotValue> {
  const out: Record<string, SlotValue> = {};
  for (const [key, def] of Object.entries(definition.slots ?? {})) {
    const value = slotStartValue(def);
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

export async function journeyMessages(journeyKey: string, query: Record<string, unknown>) {
  const q = querySchema.parse(query);
  const [rec, cat] = await Promise.all([getJourneyTemplate(journeyKey), loadCatalogue({ fresh: true })]);
  if (!rec) throw notFound('Journey not found');
  const wanted = q.version ?? rec.header.publishedVersion ?? rec.header.latestVersion;
  const version = rec.versions.find((v) => v.version === wanted);
  if (!version) throw notFound(`Version ${wanted} doesn't exist`);
  const definition = journeyDefinitionSchema.parse(version.definition);
  const poolKeys = Object.keys(definition.pools ?? {});

  const waPools = poolKeys.filter((k) => definition.pools[k].channels.includes('whatsapp'));
  const [example, config, waCtx] = await Promise.all([
    examplePlaybook(journeyKey),
    getCreditConfig(),
    // The registry only when a message can go by WhatsApp; unreadable → no WhatsApp part, SMS and email still show.
    waPools.length
      ? loadWaPickContext().catch((err) => {
          console.error('[ADAPTIVE ADMIN] WhatsApp registry unreadable; journey messages without WhatsApp', (err as Error)?.name ?? 'Error');
          return null as WaPickContext | null;
        })
      : Promise.resolve(null as WaPickContext | null),
  ]);

  const whatsapp: Record<string, WaPoolInput> = {};
  if (waCtx) {
    for (const poolKey of waPools) {
      const pool = definition.pools[poolKey];
      const row = waCtx.pools.find((p) => p.journeyKey === journeyKey && p.poolKey === poolKey);
      const rule = row?.whatsappCategory ?? pool.whatsappCategory ?? (pool.purpose === 'service' ? 'utility' : 'marketing');
      const templates = waCtx.docs
        .filter((d) => d.use?.kind === 'adaptive' && d.use.journeyKey === journeyKey && d.use.poolKey === poolKey && d.dismissed !== true && d.source)
        .sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.language).localeCompare(String(b.language)))
        .map((d) => ({ id: d.id, name: d.name, lang: d.lang, source: d.source! }));
      let pick: WaPoolInput['pick'] = null;
      try {
        const p = pickWaTemplate(waCtx, { journeyKey, poolKey }, q.lang);
        if (p?.template.source) pick = { status: p.status, lang: p.lang, name: p.template.name, source: p.template.source };
      } catch (err) {
        console.error('[ADAPTIVE ADMIN] WhatsApp pick failed', poolKey, (err as Error)?.name ?? 'Error');
      }
      whatsapp[poolKey] = { rule, linkField: row?.linkField ?? null, templates, pick };
    }
  }

  const slots = { ...journeyDefaults(definition), ...(example?.slotDefaults ?? {}) };
  const offers = example?.offers ?? [];
  const variants = cat.variants.filter((v) => poolKeys.includes(v.poolKey) && (!v.journeyKey || v.journeyKey === journeyKey));
  const messages = buildJourneyMessages({
    definition,
    variants,
    lang: q.lang as Lang,
    venueName: EXAMPLE_VENUE,
    slots,
    offers,
    rates: { smsPerPart: config.channelRates.sms.creditsPerSegment, email: config.channelRates.email.creditsPerMessage },
    design: { brand: designBrandFrom(null, { name: EXAMPLE_VENUE }), poweredBy: true },
    whatsapp,
    stopLines: STOP_LINES,
  });
  const offerKey = Object.values(slots).find((v) => typeof v === 'string' && offers.some((o) => o.offerKey === v));
  const offer = offers.find((o) => o.offerKey === offerKey) ?? null;

  return {
    journeyKey,
    version: wanted,
    lang: q.lang,
    example: {
      guest: 'Anna',
      venue: EXAMPLE_VENUE,
      playbook: example ? { key: example.key, name: example.name } : null,
      offer: offer ? pickLang(offer.label, q.lang) : null,
    },
    whatsappReadable: waPools.length === 0 || waCtx !== null,
    messages,
  };
}
