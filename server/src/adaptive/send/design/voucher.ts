/**
 * The Voucher design (approved by Manish, 2026-10-26): a short note, then one slip on the
 * venue's background colour that holds the one thing the guest can use — the offer with a
 * perforated stub, the rating stars, a key card with the Wi-Fi on the stub, or a code.
 *
 * Email-safe: one 600px column of tables, every style inline; a small <style> block only adds
 * phone sizes and dark mode (Apple Mail / iOS prefers-color-scheme, Outlook.com [data-ogsc]),
 * so a client that strips it still shows the whole design. Outlook desktop draws square corners
 * and no shadow. Every text is escaped here; nothing in a block can add markup. Pure.
 */

import type { Lang } from '../../core/constants';
import { CHAR_WIDTH, FONT_STACKS, type DesignBrand } from './brand';
import type { Action, EmailModel, FactRow, Feature } from './model';
import { tokens, WHITE, type DesignTokens } from './colors';
import { labelsFor } from './labels';

const MONO = "Menlo, Consolas, 'Courier New', monospace";
/** Same marker as services/poweredBy.ts, so the send-time injector never adds a second line. */
const POWERED_BY_MARKER = '<!--hf-pb-->';

export interface VoucherInput {
  brand: DesignBrand;
  model: EmailModel;
  lang: Lang;
  purpose: 'marketing' | 'service';
  preheader: string;
  subject: string;
  /** Marketing: the unsubscribe link; null on service emails (and on owner tests). */
  unsubscribeUrl: string | null;
  /** Shown on marketing and service emails alike unless the plan hides it. */
  poweredBy: boolean;
  /** 'light': the owner's preview always shows the light look; guests' emails follow their app ('auto'). */
  colorScheme?: 'auto' | 'light';
}

export function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Ctx {
  T: DesignTokens;
  D: DesignTokens;
  F: string;
  brand: DesignBrand;
  phone: Map<string, string>;
}

/** Text with its URLs as links (trailing punctuation stays outside), line breaks kept. */
function richText(raw: string, linkColor: string): string {
  let out = '';
  let last = 0;
  for (const m of raw.matchAll(/https?:\/\/[^\s<>"'“”„«»‹›‘’]+/g)) {
    const start = m.index ?? 0;
    const trail = /[.,!?;:)\]}…—–]+$/.exec(m[0]);
    const url = trail ? m[0].slice(0, trail.index) : m[0];
    out += esc(raw.slice(last, start)) + `<a href="${esc(url)}" class="hf-c-btext" style="color:${linkColor};text-decoration:underline;">${esc(url)}</a>`;
    last = start + url.length;
  }
  return (out + esc(raw.slice(last))).replace(/\n/g, '<br>');
}

/** A phone size for one element; returns its class. */
function phoneSize(c: Ctx, size: number, lh: number): string {
  const cls = `hf-f${size}-${lh}`;
  c.phone.set(cls, `.${cls}{font-size:${size}px!important;line-height:${lh}px!important}`);
  return cls;
}

/** A short fact set big: smaller when longer, never wider than the column, on desktop and phone. */
function fit(c: Ctx, text: string, maxD: number, maxP: number): { d: number; lhD: number; cls: string } {
  const len = [...text].length;
  const longest = Math.max(1, ...text.split(/\s+/).map((w) => [...w].length));
  const cw = CHAR_WIDTH[c.brand.font] ?? 0.6;
  const step = (max: number) =>
    len <= 4 ? max : len <= 6 ? max * 0.82 : len <= 9 ? max * 0.64 : len <= 14 ? max * 0.5 : len <= 22 ? max * 0.4 : len <= 34 ? max * 0.33 : max * 0.28;
  const lh = (n: number) => Math.round(n * (n >= 56 ? 0.98 : n >= 36 ? 1.08 : 1.18));
  // The column wins over the usual floor: a very long word gets smaller type (and still wraps, see WRAP).
  const d = Math.max(longest * cw * 24 > 456 ? 16 : 24, Math.floor(Math.min(step(maxD), 456 / (longest * cw))));
  const p = Math.max(longest * cw * 22 > 270 ? 15 : 22, Math.floor(Math.min(step(maxP), 270 / (longest * cw))));
  return { d, lhD: lh(d), cls: phoneSize(c, p, lh(p)) };
}

/** A word longer than the column (a Wi-Fi name, a code) wraps instead of widening the email. */
const WRAP = 'overflow-wrap:anywhere;word-wrap:break-word;word-break:break-word;';

const spacer = (h: number) => `<div style="height:${h}px;line-height:${h}px;font-size:1px;mso-line-height-rule:exactly;">&nbsp;</div>`;

function button(c: Ctx, a: Action, align: 'left' | 'right' = 'left'): string {
  const { T, F } = c;
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="${align}">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="hf-btn" style="border-collapse:separate;">` +
    `<tr><td align="center" bgcolor="${T.fill}" class="hf-btn-bg" style="background-color:${T.fill};border-radius:999px;mso-padding-alt:14px 26px;">` +
    `<a href="${esc(a.href)}" target="_blank" class="hf-btn-c" style="display:inline-block;padding:14px 26px;font-family:${F};font-size:15px;line-height:20px;font-weight:bold;color:${T.on};text-decoration:none;border-radius:999px;">${esc(a.label)}</a>` +
    `</td></tr></table></td></tr></table>`
  );
}

/** The light logo on light grounds; in dark mode the dark-background logo, or the light one on a white plate. */
function logo(c: Ctx): string {
  const { brand, T } = c;
  const img = (src: string) =>
    `<img src="${esc(src)}" height="44" alt="${esc(brand.name)}" style="display:block;height:auto;width:auto;max-height:44px;max-width:190px;border:0;outline:none;text-decoration:none;">`;
  if (!brand.logoUrl) {
    return `<p class="hf-c-ink" style="margin:0;font-family:${c.F};font-size:20px;line-height:26px;font-weight:bold;letter-spacing:-0.01em;color:${T.ink};${WRAP}">${esc(brand.name)}</p>`;
  }
  const plate = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td bgcolor="${WHITE}" style="background-color:${WHITE};border-radius:8px;padding:7px 10px;">${img(brand.logoUrl)}</td></tr></table>`;
  const dark = brand.logoDarkUrl ? img(brand.logoDarkUrl) : plate;
  return (
    `<div class="hf-logo-l">${img(brand.logoUrl)}</div>` +
    `<!--[if !mso]><!--><div class="hf-logo-d" style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${dark}</div><!--<![endif]-->`
  );
}

function stars(c: Ctx, f: Extract<Feature, { kind: 'rating' }>): string {
  const { T, F } = c;
  // 5 × (36 + 2 × 4) = 220px: fits the slip on a 375px phone even when a mail app drops the phone styles.
  const size = 36;
  const gap = 4;
  const cells = [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<td align="center" class="hf-star-td" style="padding:0 ${gap}px;"><a href="${esc(f.href)}" target="_blank" title="${esc(f.aria(n))}" aria-label="${esc(f.aria(n))}" class="hf-c-star hf-star" style="display:block;font-family:Arial, Helvetica, sans-serif;font-size:${size}px;line-height:${size + 6}px;color:${T.star};text-decoration:none;">&#9733;</a></td>`,
    )
    .join('');
  const width = 5 * (size + 2 * gap);
  const label = (s: string, align: string, pad: string) =>
    `<td align="${align}" class="hf-c-ink2" style="padding:${pad};font-family:${F};font-size:13px;line-height:18px;color:${T.ink2};">${esc(s)}</td>`;
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="hf-star-labels" style="width:100%;max-width:${width}px;"><tr>${label(f.low, 'left', `8px 0 0 ${gap}px`)}${label(f.high, 'right', `8px ${gap}px 0 0`)}</tr></table>` +
    `</td></tr></table>`
  );
}

function fact(c: Ctx, r: FactRow, size: number): string {
  const { T, F } = c;
  return (
    `<p class="hf-c-ink2" style="margin:0;font-family:${F};font-size:13px;line-height:18px;color:${T.ink2};">${esc(r.label)}</p>` +
    `<p class="hf-c-ink" style="margin:2px 0 0 0;font-family:${r.code ? MONO : F};font-size:${size}px;line-height:${size + 7}px;font-weight:bold;color:${T.ink};${WRAP}">${esc(r.value)}</p>`
  );
}

/** The slip: top part, perforation with notches, stub. */
function slip(c: Ctx, m: EmailModel): { html: string; actionAfter: Action | null } {
  const { T, F } = c;
  const f = m.feature;
  if (!f) return { html: '', actionAfter: null };
  let top = '';
  let stub = '';
  let actionAfter: Action | null = null;
  if (f.kind === 'offer') {
    if (f.value) {
      const z = fit(c, f.value, 76, 60);
      top += `<p class="${z.cls} hf-c-btext" style="margin:0;font-family:${F};font-size:${z.d}px;line-height:${z.lhD}px;font-weight:bold;letter-spacing:-0.03em;color:${T.btext};${WRAP}">${esc(f.value)}</p>`;
      top += `<p class="hf-c-ink ${phoneSize(c, 19, 25)}" style="margin:8px 0 0 0;font-family:${F};font-size:21px;line-height:27px;font-weight:bold;letter-spacing:-0.01em;color:${T.ink};${WRAP}">${esc(f.label)}</p>`;
    } else {
      const z = fit(c, f.label, 46, 36);
      top += `<p class="${z.cls} hf-c-btext" style="margin:0;font-family:${F};font-size:${z.d}px;line-height:${z.lhD}px;font-weight:bold;letter-spacing:-0.02em;color:${T.btext};${WRAP}">${esc(f.label)}</p>`;
    }
    if (f.untilDate || f.action) {
      stub =
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        (f.untilDate ? `<td class="hf-stack" valign="middle" style="padding:0 16px 0 0;">${fact(c, { label: f.untilLabel ?? '', value: f.untilDate }, 16)}</td>` : '') +
        (f.action ? `<td class="hf-stack hf-pt16" valign="middle" align="right" style="padding:0;">${button(c, f.action, f.untilDate ? 'right' : 'left')}</td>` : '') +
        `</tr></table>`;
    }
  } else if (f.kind === 'rating') {
    top += stars(c, f);
  } else if (f.kind === 'info') {
    const z = fit(c, f.lead.value, 52, 44);
    top += `<p class="hf-c-ink2" style="margin:0;font-family:${F};font-size:13px;line-height:18px;color:${T.ink2};">${esc(f.lead.label)}</p>`;
    top += `<p class="${z.cls} hf-c-ink" style="margin:2px 0 0 0;font-family:${F};font-size:${z.d}px;line-height:${z.lhD}px;font-weight:bold;letter-spacing:-0.02em;color:${T.ink};${WRAP}">${esc(f.lead.value)}</p>`;
    if (f.lead.sub) top += `<p class="hf-c-ink" style="margin:4px 0 0 0;font-family:${F};font-size:16px;line-height:24px;color:${T.ink};">${esc(f.lead.sub)}</p>`;
    if (f.rows.length) {
      top += spacer(18) + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">`;
      for (const r of f.rows) top += `<tr><td class="hf-b-line" style="padding:12px 0;border-top:1px solid ${T.line};">${fact(c, r, 16)}</td></tr>`;
      top += `</table>`;
    }
    if (f.stub.length) {
      stub =
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        f.stub
          .map((r, i) => `<td class="hf-stack${i ? ' hf-pt12' : ''}" valign="top" width="${Math.floor(100 / f.stub.length)}%" style="padding:0 ${i < f.stub.length - 1 ? 12 : 0}px 0 0;">${fact(c, r, 17)}</td>`)
          .join('') +
        `</tr></table>`;
    }
    actionAfter = f.action;
  } else if (f.kind === 'code') {
    const z = fit(c, f.code, 40, 32);
    top += `<p class="hf-c-ink2" style="margin:0;font-family:${F};font-size:13px;line-height:18px;color:${T.ink2};">${esc(f.label)}</p>`;
    top += `<p class="${z.cls} hf-c-btext" style="margin:4px 0 0 0;font-family:${MONO};font-size:${z.d}px;line-height:${z.lhD}px;font-weight:bold;letter-spacing:0.04em;color:${T.btext};${WRAP}">${esc(f.code)}</p>`;
  }

  const notch = (side: 'l' | 'r') =>
    `<td width="14" class="hf-bg-ground" bgcolor="${T.ground}" style="width:14px;height:28px;background-color:${T.ground};border-radius:${side === 'l' ? '0 14px 14px 0' : '14px 0 0 14px'};font-size:1px;line-height:1px;">&nbsp;</td>`;
  const perforation =
    `<tr><td style="padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${notch('l')}` +
    `<td valign="middle" style="padding:0 10px;"><div class="hf-b-dash" style="border-top:2px dashed ${T.lineStrong};height:0;line-height:0;font-size:0;">&nbsp;</div></td>${notch('r')}</tr></table></td></tr>`;
  const image = m.image
    ? `<tr><td style="padding:0;"><img src="${esc(m.image.src)}" width="520" alt="${esc(m.image.alt)}" style="display:block;width:100%;max-width:520px;height:auto;border:0;border-radius:16px 16px 0 0;"></td></tr>`
    : '';
  const html =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="hf-bg-paper hf-shadow" bgcolor="${T.paper}" style="border-collapse:separate;background-color:${T.paper};border-radius:16px;box-shadow:0 1px 2px rgba(20,20,20,0.06),0 10px 28px rgba(20,20,20,0.08);">` +
    image +
    `<tr><td class="hf-slip-pad" style="padding:28px 32px ${stub ? 22 : 28}px 32px;">${top}</td></tr>` +
    (stub ? perforation + `<tr><td class="hf-slip-pad" style="padding:18px 32px 26px 32px;">${stub}</td></tr>` : '') +
    `</table>`;
  return { html, actionAfter };
}

function footer(c: Ctx, v: VoucherInput): string {
  const { T, F, brand } = c;
  const L = labelsFor(v.lang);
  const t = `font-family:${F};font-size:13px;line-height:20px;color:${T.ink2Ground};${WRAP}`;
  const a = (href: string, label: string) => `<a href="${esc(href)}" target="_blank" class="hf-c-ink2g" style="color:${T.ink2Ground};text-decoration:underline;">${esc(label)}</a>`;
  const place = [brand.name, brand.address].filter(Boolean).join(' · ');
  let h = place ? `<p class="hf-c-ink2g" style="margin:0 0 8px 0;${t}">${esc(place)}</p>` : '';
  const why = v.purpose === 'marketing' ? L.whyMarketing(brand.name) : L.whyService(brand.name);
  h += `<p class="hf-c-ink2g" style="margin:0;${t}">${esc(why)}${v.unsubscribeUrl ? ` ${a(v.unsubscribeUrl, L.unsubscribe)}` : ''}</p>`;
  if (brand.links.length) h += `<p class="hf-c-ink2g" style="margin:8px 0 0 0;${t}">${brand.links.map((l) => a(l.url, l.label)).join(' &nbsp;·&nbsp; ')}</p>`;
  if (v.poweredBy) h += `<p class="hf-c-ink2g" style="margin:20px 0 0 0;${t}font-size:12px;line-height:18px;">${POWERED_BY_MARKER}Powered by HeidiFi</p>`;
  return h;
}

/** Dark-mode overrides: Apple Mail and iOS Mail (prefers-color-scheme), Outlook.com ([data-ogsc]). */
function darkCss(c: Ctx): string {
  const { D, T } = c;
  const rules: Array<[string, string]> = [
    ['.hf-body,.hf-bg-ground', `background-color:${D.ground}!important`],
    ['.hf-bg-paper', `background-color:${D.paper}!important`],
    ['.hf-shadow', 'box-shadow:none!important'],
    ['.hf-c-ink', `color:${D.ink}!important`],
    ['.hf-c-ink2', `color:${D.ink2}!important`],
    ['.hf-c-ink2g', `color:${D.ink2Ground}!important`],
    ['.hf-c-btext', `color:${D.btext}!important`],
    ['.hf-c-star', `color:${D.star}!important`],
    ['.hf-b-line', `border-color:${D.line}!important`],
    ['.hf-b-dash', `border-color:${D.lineStrong}!important`],
  ];
  if (D.fill !== T.fill || D.on !== T.on) {
    rules.push(['.hf-btn-bg', `background-color:${D.fill}!important`], ['.hf-btn-c', `color:${D.on}!important`]);
  }
  const media = rules.map(([s, d]) => `${s}{${d}}`).join('');
  const swap = '.hf-logo-l{display:none!important}.hf-logo-d{display:block!important;max-height:none!important;overflow:visible!important}';
  const ogsc = rules
    .filter(([s]) => !s.includes('shadow'))
    .map(([s, d]) => `${s.split(',').map((x) => `[data-ogsc] ${x}`).join(',')}{${d}}`)
    .join('');
  return `:root{color-scheme:light dark;supported-color-schemes:light dark}@media (prefers-color-scheme: dark){${media}${swap}}${ogsc}`;
}

export function renderVoucher(v: VoucherInput): string {
  const c: Ctx = {
    T: tokens(v.brand, 'light'),
    D: tokens(v.brand, 'dark'),
    F: FONT_STACKS[v.brand.font] ?? FONT_STACKS.helvetica,
    brand: v.brand,
    phone: new Map(),
  };
  const { T, F } = c;
  const m = v.model;
  const para = (s: string, color: string, cls: string) =>
    `<p class="${cls}" style="margin:0 0 12px 0;font-family:${F};font-size:16px;line-height:26px;color:${color};${WRAP}">${richText(s, T.btextGround)}</p>`;

  let note = logo(c) + spacer(32);
  if (m.heading) {
    note += `<h1 class="hf-c-ink ${phoneSize(c, 24, 30)}" style="margin:0 0 12px 0;font-family:${F};font-size:28px;line-height:34px;font-weight:bold;letter-spacing:-0.02em;color:${T.ink};${WRAP}">${esc(m.heading)}</h1>`;
  }
  for (const p of m.before) note += para(p, T.ink, 'hf-c-ink');
  if (!m.feature && m.image) {
    note += spacer(8) + `<img src="${esc(m.image.src)}" width="520" alt="${esc(m.image.alt)}" style="display:block;width:100%;max-width:520px;height:auto;border:0;border-radius:12px;">` + spacer(8);
  }

  const s = slip(c, m);
  let close = '';
  // The info card's button, or the email's own button (an offer slip carries its button in the stub).
  const action = s.actionAfter ?? m.action;
  if (action) close += button(c, action) + spacer(22);
  for (const p of m.after) close += para(p, T.ink, 'hf-c-ink');
  if (m.signoff !== null) {
    const line = m.signoff ? `${richText(m.signoff, T.btextGround)}<br>` : '';
    close += `<p class="hf-c-ink" style="margin:${m.after.length ? 12 : 0}px 0 0 0;font-family:${F};font-size:16px;line-height:24px;color:${T.ink};${WRAP}">${line}<strong>${esc(v.brand.name)}</strong></p>`;
  }

  const body =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="hf-bg-ground" bgcolor="${T.ground}" style="width:100%;background-color:${T.ground};"><tr><td align="center" style="padding:0;">` +
    `<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->` +
    // Fluid: a client that drops the <style> block still gets a column as wide as the phone; Outlook gets its fixed 600px table above.
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" align="center" class="hf-w" style="width:100%;max-width:600px;">` +
    `<tr><td class="hf-px" style="padding:36px 40px 0 40px;">${note}</td></tr>` +
    (s.html ? `<tr><td class="hf-px16" style="padding:16px 40px 0 40px;">${s.html}</td></tr>` : '') +
    (close ? `<tr><td class="hf-px" style="padding:28px 40px 0 40px;">${close}</td></tr>` : '') +
    `<tr><td class="hf-px" style="padding:36px 40px 48px 40px;">${footer(c, v)}</td></tr>` +
    `</table><!--[if mso]></td></tr></table><![endif]--></td></tr></table>`;

  const phone = [
    '.hf-w{width:100%!important;max-width:100%!important}',
    '.hf-px{padding-left:24px!important;padding-right:24px!important}',
    '.hf-px16{padding-left:16px!important;padding-right:16px!important}',
    '.hf-slip-pad{padding-left:22px!important;padding-right:22px!important}',
    '.hf-stack{display:block!important;width:100%!important;box-sizing:border-box}',
    '.hf-pt12{padding-top:12px!important}',
    '.hf-pt16{padding-top:16px!important;text-align:left!important}',
    '.hf-btn{width:100%!important}',
    '.hf-btn a{display:block!important;text-align:center!important}',
    // Five stars fit a 320px phone (the slip there is about 244px wide).
    '.hf-star{font-size:34px!important;line-height:40px!important}',
    '.hf-star-td{padding:0 3px!important}',
    ...c.phone.values(),
  ].join('');
  const base =
    'body{margin:0!important;padding:0!important;width:100%!important}' +
    'table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse}' +
    'img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}' +
    'a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}p,h1{margin:0}';
  const scheme = v.colorScheme === 'light' ? 'light only' : 'light dark';
  const themeCss = v.colorScheme === 'light' ? ':root{color-scheme:light only}' : darkCss(c);
  const pre = v.preheader
    ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${T.ground};">${esc(v.preheader)}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>`
    : '';
  return (
    `<!DOCTYPE html>\n<html lang="${v.lang}" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">\n<head>\n` +
    `<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="x-apple-disable-message-reformatting">\n` +
    `<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">\n<meta name="color-scheme" content="${scheme}">\n<meta name="supported-color-schemes" content="${scheme}">\n` +
    `<title>${esc(v.subject)}</title>\n` +
    `<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->\n` +
    `<style>${base}@media only screen and (max-width:620px){${phone}}${themeCss}</style>\n</head>\n` +
    `<body class="hf-body hf-bg-ground" style="margin:0;padding:0;width:100%;background-color:${T.ground};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">\n` +
    `${pre}${body}\n</body>\n</html>`
  );
}
