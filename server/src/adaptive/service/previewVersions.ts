/**
 * "See what guests get" per channel (PR PV): the SMS, email and WhatsApp versions of each preview
 * message. The preview answer (service/tenant.ts `preview`) gets them as `versions`; its other
 * fields stay as they were (the channel the journey shows first), so an older cms keeps working.
 *
 *  - SMS / email: the first wording the owner's values allow (by letter) that has that channel, in
 *    the asked language or English, rendered with the example values of its own language — as the
 *    engine renders a guest's message.
 *  - WhatsApp, for a message whose pool can go by WhatsApp: the template `whatsapp/pick.ts` picks
 *    (approved, else waiting for Meta), else an example made from the SMS text (D1), else nothing.
 *    Whether journeys send WhatsApp now is the launch setting `whatsappSending` (PR W3): the preview
 *    answer's `sendingChannels` says so, and the cms shows a note while it is off.
 *    When the templates can't be read (or one is broken), the message has no WhatsApp version —
 *    never a wrong one, and SMS and email still show.
 */

import type { Lang } from '../core/constants';
import type { JourneyDefinition, Offer, PreviewStep, SlotValue } from '../core/schemas';
import { sampleValues, type RenderValues } from '../core/render';
import { whatsappPools } from '../core/whatsapp/pools';
import type { WaRequestable } from '../core/whatsapp/template';
import {
  emailSmsVersion,
  versionChannels,
  whatsappExample,
  whatsappMissing,
  whatsappVersion,
  type PreviewVersion,
} from '../core/owner/previewVersions';
import { variantContent, variantEligible } from '../engine/renderSend';
import { STOP_LINES } from '../send/compose';
import { loadWaPickContext, pickWaTemplate, type WaPickContext } from '../whatsapp/pick';
import type { Catalogue } from './catalogue';

export type { PreviewVersion } from '../core/owner/previewVersions';

export interface PreviewVersionsInput {
  journeyKey: string;
  definition: JourneyDefinition;
  steps: PreviewStep[];
  cat: Catalogue;
  lang: Lang;
  venueName: string;
  slots: Record<string, SlotValue>;
  offers: Offer[];
}

/** One entry per preview step: its versions, or null for the rating page (no message). */
export async function previewVersionsFor(input: PreviewVersionsInput): Promise<Array<PreviewVersion[] | null>> {
  const { definition, cat, lang, slots } = input;
  const valuesCache = new Map<string, RenderValues>();
  const valuesFor = (l: Lang, offerSlot?: string): RenderValues => {
    const key = `${l}|${offerSlot ?? ''}`;
    let v = valuesCache.get(key);
    if (!v) {
      v = sampleValues({ lang: l, venueName: input.venueName, slots, offers: input.offers, ...(offerSlot ? { offerSlot } : {}) });
      valuesCache.set(key, v);
    }
    return v;
  };

  const waPoolKeys = new Set(Object.entries(definition.pools ?? {}).filter(([, p]) => p.channels.includes('whatsapp')).map(([k]) => k));
  // The registry only when a message of this journey can go by WhatsApp.
  const needsRegistry = input.steps.some((s) => s.channel !== 'page' && s.pool && waPoolKeys.has(s.pool));
  let waCtx: WaPickContext | null = null;
  let waReadable = true;
  if (needsRegistry) {
    try {
      waCtx = await loadWaPickContext();
    } catch (err) {
      waReadable = false;
      console.error('[ADAPTIVE PREVIEW] WhatsApp templates unreadable; preview without WhatsApp', (err as Error)?.name ?? 'Error');
    }
  }
  // The rule (marketing / utility) and the button's link of each WhatsApp message, as the WhatsApp tab works them out.
  const poolRows = whatsappPools([{ key: input.journeyKey, name: { en: input.journeyKey }, availability: 'available', definition }], cat.variants as never);

  return input.steps.map((step) => {
    if (step.channel === 'page' || !step.pool) return null;
    const poolKey = step.pool;
    const all = cat.variants.filter((v) => v.poolKey === poolKey && v.status === 'active').sort((a, b) => a.letter.localeCompare(b.letter));
    const allowed = all.filter((v) => variantEligible(v, slots));
    const candidates = allowed.length ? allowed : all;
    const contentFor = (channel: 'sms' | 'email') => {
      for (const v of candidates) {
        const c = variantContent(v, channel, lang);
        if (c) return { variant: v, ...c };
      }
      return null;
    };
    const email = contentFor('email');
    const sms = contentFor('sms');

    // WhatsApp, built up front: a broken template doc (or registry) leaves this message without a
    // WhatsApp version instead of failing the whole preview.
    let whatsapp: PreviewVersion | null = null;
    if (waPoolKeys.has(poolKey) && waReadable) {
      try {
        const pick = waCtx ? pickWaTemplate(waCtx, { journeyKey: input.journeyKey, poolKey }, lang) : null;
        if (pick?.template.source) {
          whatsapp = whatsappVersion(pick.status, pick.lang, pick.template.name, pick.template.source, valuesFor(pick.lang, step.offerSlot));
        } else if (sms) {
          const row = poolRows.find((p) => p.poolKey === poolKey);
          const pool = definition.pools[poolKey];
          const rule = row?.whatsappCategory ?? pool?.whatsappCategory ?? (pool?.purpose === 'service' ? 'utility' : 'marketing');
          const category: WaRequestable = rule === 'utility' ? 'UTILITY' : 'MARKETING';
          const text = String((sms.content as { text?: unknown }).text ?? '');
          whatsapp = whatsappExample(text, { lang: sms.locale, category, linkField: row?.linkField ?? null, footers: STOP_LINES, values: valuesFor(sms.locale, step.offerSlot) });
        } else {
          whatsapp = whatsappMissing(lang);
        }
      } catch (err) {
        whatsapp = null;
        console.error('[ADAPTIVE PREVIEW] WhatsApp version failed', poolKey, (err as Error)?.name ?? 'Error');
      }
    }

    const channels = versionChannels(definition.channelLadder, (c) => (c === 'email' ? Boolean(email) : c === 'sms' ? Boolean(sms) : Boolean(whatsapp)));
    return channels.map((channel): PreviewVersion => {
      if (channel === 'whatsapp') return whatsapp!;
      const found = channel === 'email' ? email! : sms!;
      return emailSmsVersion(channel, found.content, found.locale, found.variant.name, valuesFor(found.locale, step.offerSlot));
    });
  });
}
