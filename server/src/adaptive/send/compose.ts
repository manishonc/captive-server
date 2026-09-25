/**
 * The last mile of a live message (plan §3.7 "Rendering"), pure so it can be
 * tested without Firestore:
 *
 *  - SMS: the rendered text + a STOP line in the guest's language. The line always
 *    contains the literal word STOP (services/optOut.ts only knows English
 *    keywords) and stays GSM-7, so it never changes the encoding.
 *  - Email: plain-text wording becomes simple HTML — the whole text is escaped
 *    once (merge values come from a public form), links are made clickable,
 *    paragraphs and line breaks kept — plus the hidden preheader, the unsubscribe
 *    footer (marketing) and "Powered by HeidiFi" unless the plan hides it.
 *  - Pricing placeholders exactly as long as a real short link, so the SMS is
 *    priced (segments) on the text that will really be sent.
 */

import type { Lang } from '../core/constants';
import { injectPoweredBy } from '../../services/poweredBy';

/** services/shortlinks.ts mints 8-character codes from a GSM-7 alphabet. */
export const SHORT_CODE_LENGTH = 8;

/** A stand-in with the exact length and character set of `${VISITOR_BASE_URL}/s/<code>`. */
export function placeholderLink(visitorBaseUrl: string): string {
  return `${visitorBaseUrl}/s/${'x'.repeat(SHORT_CODE_LENGTH)}`;
}

export function shortLinkUrl(visitorBaseUrl: string, code: string): string {
  return `${visitorBaseUrl}/s/${code}`;
}

/** GSM-7 only (é/è/à are in the basic set; straight apostrophe). */
export const STOP_LINES: Record<Lang, string> = {
  en: 'Reply STOP to unsubscribe',
  de: 'Antworte STOP zum Abmelden',
  fr: 'Répondez STOP pour vous désabonner',
  it: "Rispondi STOP per disiscriverti",
};

/**
 * The SMS exactly as sent (and priced): the text plus the STOP line, unless the
 * wording itself already has one. Pass the wording (before merge values) as
 * `template`, so a venue or guest name containing "STOP" can't drop the line.
 */
export function smsFinalText(text: string, lang: Lang, template: string = text): string {
  if (/\bSTOP\b/.test(template)) return text;
  return `${text}\n${STOP_LINES[lang] ?? STOP_LINES.en}`;
}

const FOOTER: Record<Lang, { why: string; link: string }> = {
  en: { why: 'You are receiving this because you said yes to news and offers from this place.', link: 'Unsubscribe' },
  de: { why: 'Du erhältst diese E-Mail, weil du Neuigkeiten und Angeboten von diesem Ort zugestimmt hast.', link: 'Abmelden' },
  fr: { why: 'Vous recevez cet e-mail car vous avez accepté les nouvelles et offres de cet établissement.', link: 'Se désabonner' },
  it: { why: 'Ricevi questa e-mail perché hai accettato novità e offerte da questo locale.', link: 'Annulla iscrizione' },
};

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Raw text → escaped HTML with its URLs as links; trailing punctuation stays outside. */
function linkify(raw: string): string {
  let out = '';
  let last = 0;
  // Quotes of any style end a URL; closing punctuation after it stays outside the link.
  for (const m of raw.matchAll(/https?:\/\/[^\s<>"'“”„«»‹›‘’]+/g)) {
    const start = m.index ?? 0;
    const trail = /[.,!?;:)\]}…—–]+$/.exec(m[0]);
    const url = trail ? m[0].slice(0, trail.index) : m[0];
    out += escapeHtml(raw.slice(last, start)) + `<a href="${escapeHtml(url)}" style="color:#1a5fb4;">${escapeHtml(url)}</a>`;
    last = start + url.length;
  }
  return out + escapeHtml(raw.slice(last));
}

function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px 0;">${linkify(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

export interface EmailComposeInput {
  /** The rendered body (values already escaped for 'html', raw for 'text'). */
  body: string;
  bodyFormat: 'text' | 'html' | 'blocks';
  /** The rendered preheader ('' for none). */
  preheader: string;
  lang: Lang;
  /** Marketing: the unsubscribe link for the footer; service: null (no footer). */
  unsubscribeUrl: string | null;
  poweredBy: boolean;
}

export type ComposedEmail = { html: string; text: string } | { error: 'unsupported_format' };

export function composeEmail(i: EmailComposeInput): ComposedEmail {
  if (i.bodyFormat === 'blocks') return { error: 'unsupported_format' };
  const footer = FOOTER[i.lang] ?? FOOTER.en;
  const footerHtml = i.unsubscribeUrl
    ? `<p style="margin:24px 0 0 0;font-size:12px;line-height:18px;color:#777;">${escapeHtml(footer.why)} <a href="${escapeHtml(i.unsubscribeUrl)}" style="color:#777;">${escapeHtml(footer.link)}</a></p>`
    : '';
  const preheaderHtml = i.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(i.preheader)}</div>`
    : '';
  const content = i.bodyFormat === 'html' ? i.body : textToHtml(i.body);
  let html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:#ffffff;">${preheaderHtml}` +
    `<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:#222;">` +
    `${content}${footerHtml}</div></body></html>`;
  if (i.poweredBy) html = injectPoweredBy(html);

  const plainBody = i.bodyFormat === 'html' ? i.body.replace(/<[^>]+>/g, '') : i.body.trim();
  const text = i.unsubscribeUrl ? `${plainBody}\n\n${footer.why}\n${footer.link}: ${i.unsubscribeUrl}` : plainBody;
  return { html, text };
}

/** Secrets never reach a stored preview: Wi-Fi password, door code, key instructions. */
const SECRET_FIELDS = ['wifiPassword', 'doorCode', 'keyInstructions'];

export function maskSecretValues(values: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...values };
  for (const key of Object.keys(out)) {
    if (key.startsWith('guestinfo.secret.') || SECRET_FIELDS.some((f) => key === `guestinfo.${f}`)) out[key] = '••••';
  }
  return out;
}
