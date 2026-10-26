/**
 * The admin journey page (journey channels): every message of one journey version in one language —
 * each wording's SMS and email as written and as the example guest gets them (the SMS as sent, with its
 * STOP line, parts, encoding and credits; the email's subject, preheader, text and the whole email in
 * the Voucher design) — and the message's WhatsApp templates rendered with the same values, plus what
 * a guest who speaks that language gets on WhatsApp (as the owner's "See what guests get" picks it).
 *
 * Pure: service/journeyMessages.ts loads the catalogue, the WhatsApp registry and the rates. Nothing
 * here says what is ready or broken: the cms puts these texts next to the WhatsApp tab's states
 * (`GET admin/whatsapp`) and the wording's status.
 */

import type { Channel, Lang } from '../core/constants';
import type { ChannelContent, JourneyDefinition, Offer, SlotValue } from '../core/schemas';
import { pickLang } from '../core/schemas';
import { renderText, sampleValues, type RenderValues } from '../core/render';
import { smsParts } from '../core/runtime/smsParts';
import { blocksTemplateText } from '../core/emailBlocks';
import { describeJourneySteps } from '../core/describeJourney';
import { buildWordingIndex } from '../core/wording';
import { whatsappExample, whatsappMissing, whatsappVersion, type PreviewVersion } from '../core/owner/previewVersions';
import type { WaRequestable, WaSource } from '../core/whatsapp/template';
import { smsFinalText } from '../send/compose';
import { designEmail, type DesignBrand } from '../send/design';
import { variantContent, variantEligible } from '../engine/renderSend';
import type { VariantDoc } from '../store/types';

export type WordingLike = Pick<VariantDoc, 'poolKey' | 'journeyKey' | 'letter' | 'name' | 'status' | 'channels' | 'locales' | 'when'> & { id: string };

export interface WaPoolInput {
  /** The message's rule on WhatsApp (marketing or utility). */
  rule: 'marketing' | 'utility';
  /** The link its button opens (the wording's link). */
  linkField: string | null;
  /** Our templates for this message, every language (dismissed ones left out). */
  templates: Array<{ id: string; name: string; lang: Lang | null; source: WaSource }>;
  /** What a guest who speaks the asked language gets: approved (else English), else one with Meta. */
  pick: { status: 'approved' | 'in_review'; lang: Lang; name: string; source: WaSource } | null;
}

export interface JourneyMessagesInput {
  definition: JourneyDefinition;
  variants: WordingLike[];
  lang: Lang;
  venueName: string;
  slots: Record<string, SlotValue>;
  offers: Offer[];
  now?: Date;
  /** Credits a marketing message costs: per SMS part, per email (info messages are free). */
  rates: { smsPerPart: number; email: number };
  /** The example venue's look; null: no designed email (the text still shows). */
  design: { brand: DesignBrand; poweredBy: boolean } | null;
  /** Per pool that can go by WhatsApp. A pool left out has no WhatsApp part. */
  whatsapp: Record<string, WaPoolInput>;
  stopLines: Readonly<Record<Lang, string>>;
}

export interface SmsView {
  /** The wording's language: the asked one, else English (`fallback`). */
  lang: Lang;
  fallback: boolean;
  template: string;
  text: string;
  /** As sent: the text plus the STOP line the engine adds. */
  sent: string;
  parts: number;
  encoding: 'gsm7' | 'ucs2';
  /** The characters that made it Unicode. */
  nonGsm: string[];
  credits: number;
  unknown: string[];
}

export interface EmailView {
  lang: Lang;
  fallback: boolean;
  subjectTemplate: string;
  preheaderTemplate: string;
  bodyTemplate: string;
  subject: string;
  preheader: string;
  text: string;
  /** The whole email as guests get it (light look); null when it can't be drawn. */
  html: string | null;
  credits: number;
  unknown: string[];
}

export interface WordingView {
  id: string;
  letter: string;
  name: string;
  status: string;
  /** False when the example's blanks rule it out (e.g. the checkout wording that needs a late check-out price). */
  usable: boolean;
  sms: SmsView | null;
  email: EmailView | null;
}

export interface WaTemplateView {
  id: string;
  name: string;
  lang: Lang | null;
  template: string;
  text: string;
  footer: string | null;
  button: string | null;
  unknown: string[];
}

export interface MessageView {
  poolKey: string;
  name: string;
  purpose: 'marketing' | 'service';
  channels: Channel[];
  requiredLocales: Lang[];
  /** The languages its active SMS and email wording has (as the journey list gives them): the coverage strip. */
  languages: { sms: Lang[]; email: Lang[] };
  /** The steps that send it, in the journey's order. */
  steps: Array<{ number: number; nodeId: string; detail: string }>;
  wordings: WordingView[];
  whatsapp: { rule: 'marketing' | 'utility'; linkField: string | null; templates: WaTemplateView[]; guest: PreviewVersion } | null;
}

/**
 * The offer a guest of this journey holds: the offer blank of its first offer step that names an
 * offer from the menu (as the owner preview picks it). A journey without one has none.
 */
function journeyOffer(definition: JourneyDefinition, slots: Record<string, SlotValue>, offers: Offer[]): Offer | null {
  const steps = Object.values(definition.nodes ?? {}).filter((n) => n.type === 'issue_offer');
  if (!steps.length) return null;
  for (const blank of [...steps.map((n) => String(n.config?.slot ?? '')), 'offer']) {
    const key = slots[blank];
    const offer = typeof key === 'string' ? offers.find((o) => o.offerKey === key) : undefined;
    if (offer) return offer;
  }
  return null;
}

export function buildJourneyMessages(input: JourneyMessagesInput): MessageView[] {
  const { definition, lang } = input;
  const valuesCache = new Map<Lang, RenderValues>();
  const valuesFor = (l: Lang): RenderValues => {
    let v = valuesCache.get(l);
    if (!v) {
      v = sampleValues({ lang: l, venueName: input.venueName, slots: input.slots, offers: input.offers, ...(input.now ? { now: input.now } : {}) });
      valuesCache.set(l, v);
    }
    return v;
  };
  const offer = journeyOffer(definition, input.slots, input.offers);
  const described = describeJourneySteps(definition);
  const index = buildWordingIndex(input.variants);

  return Object.entries(definition.pools ?? {}).map(([poolKey, pool]): MessageView => {
    const marketing = pool.purpose === 'marketing';
    const steps = described
      .filter((s) => s.type === 'send' && String(definition.nodes[s.nodeId]?.config?.pool ?? '') === poolKey)
      .map((s) => ({ number: s.number, nodeId: s.nodeId, detail: s.detail }));
    const wordings = input.variants
      .filter((v) => v.poolKey === poolKey)
      .sort((a, b) => a.letter.localeCompare(b.letter))
      .map((v): WordingView => {
        let sms: SmsView | null = null;
        let email: EmailView | null = null;
        if (pool.channels.includes('sms')) {
          const found = variantContent(v, 'sms', lang);
          if (found) {
            const template = String((found.content as NonNullable<ChannelContent['sms']>).text ?? '');
            const rendered = renderText(template, valuesFor(found.locale));
            const sent = smsFinalText(rendered.text, found.locale, template);
            const p = smsParts(sent);
            sms = {
              lang: found.locale,
              fallback: found.fallback,
              template,
              text: rendered.text,
              sent,
              parts: p.segments,
              encoding: p.encoding,
              nonGsm: p.nonGsm,
              credits: marketing ? p.segments * input.rates.smsPerPart : 0,
              unknown: rendered.unknown,
            };
          }
        }
        if (pool.channels.includes('email')) {
          const found = variantContent(v, 'email', lang);
          if (found) {
            const content = found.content as NonNullable<ChannelContent['email']>;
            const values = valuesFor(found.locale);
            const subject = renderText(content.subject, values);
            const pre = renderText(content.preheader || '', values);
            // A blocks wording reads as text here, as the engine reads it; never the raw JSON.
            const bodyTemplate = content.bodyFormat === 'blocks' ? blocksTemplateText(content.body) : content.body;
            const body = bodyTemplate === null ? { text: '', unknown: ['email.blocks'] } : renderText(bodyTemplate, values);
            let html: string | null = null;
            if (input.design) {
              try {
                const drawn = designEmail({
                  brand: { ...input.design.brand, name: input.venueName },
                  lang: found.locale,
                  content,
                  values,
                  facts: { purpose: marketing ? 'marketing' : 'service', pool: poolKey, offer: offer ? { kind: offer.kind, value: offer.value, currency: offer.currency } : null },
                  unsubscribeUrl: marketing ? (values['link.unsubscribe'] ?? null) : null,
                  poweredBy: input.design.poweredBy,
                  colorScheme: 'light',
                });
                html = 'error' in drawn ? null : drawn.html;
              } catch {
                html = null;
              }
            }
            email = {
              lang: found.locale,
              fallback: found.fallback,
              subjectTemplate: content.subject,
              preheaderTemplate: content.preheader || '',
              bodyTemplate: bodyTemplate ?? '',
              subject: subject.text,
              preheader: pre.text,
              text: body.text,
              html,
              credits: marketing ? input.rates.email : 0,
              unknown: [...new Set([...subject.unknown, ...pre.unknown, ...body.unknown])],
            };
          }
        }
        return { id: v.id, letter: v.letter, name: v.name, status: v.status, usable: variantEligible(v, input.slots), sms, email };
      });

    const wa = pool.channels.includes('whatsapp') ? input.whatsapp[poolKey] : undefined;
    let whatsapp: MessageView['whatsapp'] = null;
    if (wa) {
      const templates = wa.templates.map((t): WaTemplateView => {
        const rendered = renderText(t.source.body, valuesFor(t.lang ?? 'en'));
        return { id: t.id, name: t.name, lang: t.lang, template: t.source.body, text: rendered.text, footer: t.source.footer, button: t.source.button?.text ?? null, unknown: rendered.unknown };
      });
      // What a guest of this language gets: the template the engine would pick, else the example the
      // owner preview makes from the SMS text (the first wording these values allow), else nothing.
      let guest: PreviewVersion;
      if (wa.pick) {
        guest = whatsappVersion(wa.pick.status, wa.pick.lang, wa.pick.name, wa.pick.source, valuesFor(wa.pick.lang));
      } else {
        const smsSource = wordings.find((w) => w.usable && w.sms) ?? wordings.find((w) => w.sms);
        if (smsSource?.sms) {
          const category: WaRequestable = wa.rule === 'utility' ? 'UTILITY' : 'MARKETING';
          guest = whatsappExample(smsSource.sms.template, { lang: smsSource.sms.lang, category, linkField: wa.linkField, footers: input.stopLines, values: valuesFor(smsSource.sms.lang) });
        } else {
          guest = whatsappMissing(lang);
        }
      }
      whatsapp = { rule: wa.rule, linkField: wa.linkField, templates, guest };
    }

    return {
      poolKey,
      name: pool.name ? pickLang(pool.name, lang) : poolKey,
      purpose: pool.purpose,
      channels: [...pool.channels],
      requiredLocales: [...pool.requiredLocales],
      languages: {
        sms: pool.channels.includes('sms') ? [...(index.get(poolKey)?.sms ?? [])].sort() : [],
        email: pool.channels.includes('email') ? [...(index.get(poolKey)?.email ?? [])].sort() : [],
      },
      steps,
      wordings,
      whatsapp,
    };
  });
}
