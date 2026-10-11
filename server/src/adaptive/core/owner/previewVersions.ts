/**
 * "See what guests get" per channel (PR PV). The engine picks each guest's channel — the journey's
 * ladder, the guest's favourite channel, what the guest gave us — so the owner sees one message as
 * every channel would carry it: SMS, email and, for a message that can go by WhatsApp, its WhatsApp
 * template (approved, or waiting for Meta), else an example made from the SMS text (D1).
 *
 * Pure: the caller loads the wording, picks the WhatsApp template and builds the example values.
 */

import type { Channel, Lang } from '../constants';
import { renderText, type RenderValues } from '../render';
import type { ChannelContent } from '../schemas';
import { prefillFromSms, type WaRequestable, type WaSource } from '../whatsapp/template';

/**
 * WhatsApp only: `approved` — what guests get once WhatsApp sends; `in_review` — sent to Meta, not
 * approved yet; `example` — no template yet, made from the SMS text; `missing` — nothing to show.
 */
export type WaPreviewStatus = 'approved' | 'in_review' | 'example' | 'missing';

export interface PreviewVersion {
  channel: Channel;
  /** The language of this text: the one asked for, else English (as the engine falls back). */
  lang: Lang;
  status?: WaPreviewStatus;
  /** The wording's name (SMS, email) or the WhatsApp template's; null for an example. */
  name: string | null;
  subject?: string;
  preheader?: string;
  text: string;
  /** WhatsApp: Meta's grey footer line and the link button's label. */
  footer?: string | null;
  button?: { text: string } | null;
  /** Blanks with no value (shown raw). */
  unknown: string[];
}

/** After the journey's own ladder, the other channels in this order. */
const REST: readonly Channel[] = ['email', 'sms', 'whatsapp'];

/** The channels to show, in the journey's ladder order, then the rest — only those the message has. */
export function versionChannels(ladder: readonly Channel[], has: (c: Channel) => boolean): Channel[] {
  const out: Channel[] = [];
  for (const c of [...ladder, ...REST]) if (!out.includes(c) && has(c)) out.push(c);
  return out;
}

/** One wording's SMS or email content, rendered with the example values of its own language. */
export function emailSmsVersion(channel: 'sms' | 'email', content: unknown, lang: Lang, name: string, values: RenderValues): PreviewVersion {
  if (channel === 'email') {
    const email = content as NonNullable<ChannelContent['email']>;
    const subject = renderText(email.subject, values);
    const pre = renderText(email.preheader || '', values);
    const body = renderText(email.body, values);
    return {
      channel,
      lang,
      name,
      subject: subject.text,
      preheader: pre.text,
      text: body.text,
      unknown: [...new Set([...subject.unknown, ...pre.unknown, ...body.unknown])],
    };
  }
  const sms = renderText((content as NonNullable<ChannelContent['sms']>).text, values);
  return { channel, lang, name, text: sms.text, unknown: sms.unknown };
}

/** A WhatsApp template (or the example) with the example values: its text, footer and button. */
export function whatsappVersion(status: 'approved' | 'in_review' | 'example', lang: Lang, name: string | null, source: Pick<WaSource, 'body' | 'footer' | 'button'>, values: RenderValues): PreviewVersion {
  const body = renderText(source.body, values);
  return {
    channel: 'whatsapp',
    lang,
    status,
    name,
    text: body.text,
    footer: source.footer ?? null,
    button: source.button ? { text: source.button.text } : null,
    unknown: body.unknown,
  };
}

/** D1: no WhatsApp template yet — the first draft the WhatsApp tab's prefill would write from the SMS text. */
export function whatsappExample(
  smsText: string,
  opts: { lang: Lang; category: WaRequestable; linkField: string | null; footers: Readonly<Record<Lang, string>>; values: RenderValues },
): PreviewVersion {
  const source = prefillFromSms(smsText, { lang: opts.lang, category: opts.category, linkField: opts.linkField, footers: opts.footers });
  return whatsappVersion('example', opts.lang, null, source, opts.values);
}

/** A WhatsApp message with no template and no SMS text to make an example from. */
export function whatsappMissing(lang: Lang): PreviewVersion {
  return { channel: 'whatsapp', lang, status: 'missing', name: null, text: '', footer: null, button: null, unknown: [] };
}
