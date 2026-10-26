/**
 * Today's plain-text wordings, read as blocks so they get the design too (the seeded wording is
 * never changed). Works on the template, before merge values are filled in:
 *
 *  - paragraphs are split on blank lines;
 *  - the last paragraph is the sign-off when it ends with `{{venue.name}}` ("See you soon,\n{{venue.name}}");
 *  - the first journey link (`{{link.offer|rating|hub|booking}}`) is the email's one action: it
 *    leaves the text and becomes the slip's button (or the stars), and the slip sits where it was;
 *    a paragraph that only labelled it ("Your offer: {{link.offer}}") goes with it;
 *  - a Bring-a-friend line ("Your code: {{referral.code}}") becomes the code slip.
 *
 * Other links in the text (the host's contact page) stay in the text.
 */

import type { JourneyLinkKind } from '../links';

export interface TextStructure {
  before: string[];
  after: string[];
  link: { kind: JourneyLinkKind; field: string } | null;
  code: { label: string } | null;
  /** Template of the closing line ('' when the wording ends with the venue name only); null: none. */
  signoff: string | null;
}

const LINK = /\{\{\s*link\.(offer|rating|hub|booking)\s*\}\}/;
const VENUE_LINE = /^\{\{\s*venue\.name\s*\}\}$/;
const CODE_LINE = /^([^{}:\n]{1,40}):\s*\{\{\s*referral\.code\s*\}\}\s*\.?$/;
/** A paragraph that only labelled the link: "Your offer:", "Show this when you're here:". */
const LABEL_ONLY = /^[^.!?\n]{0,48}:$/;

function tidy(s: string): string {
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([.,!?;:])/g, '$1')
    .replace(/ *\n */g, '\n')
    .trim();
}

export function structureFromText(body: string): TextStructure {
  const paragraphs = String(body ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  let signoff: string | null = null;
  const last = paragraphs[paragraphs.length - 1];
  if (last) {
    const lines = last.split('\n').map((l) => l.trim());
    if (VENUE_LINE.test(lines[lines.length - 1])) {
      signoff = lines.slice(0, -1).join('\n').trim();
      paragraphs.pop();
    }
  }

  let link: TextStructure['link'] = null;
  let code: TextStructure['code'] = null;
  let at = -1;
  const out: string[] = [];
  for (const p of paragraphs) {
    if (at < 0) {
      const codeLine = CODE_LINE.exec(p);
      if (codeLine && !link) {
        code = { label: codeLine[1].trim() };
        at = out.length;
        continue;
      }
      const m = LINK.exec(p);
      if (m) {
        link = { kind: m[1] as JourneyLinkKind, field: `link.${m[1]}` };
        at = out.length;
        const token = new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        let rest = tidy(p.replace(token, ''));
        if (!rest || LABEL_ONLY.test(rest)) continue; // the paragraph only carried the link
        // "It takes one tap:" keeps its colon: the slip or the button follows right after it.
        if (!/[.!?…):]$/.test(rest)) rest = `${rest}.`;
        out.push(rest);
        at = out.length;
        continue;
      }
    }
    out.push(p);
  }
  if (at < 0) return { before: out, after: [], link, code, signoff };
  return { before: out.slice(0, at), after: out.slice(at), link, code, signoff };
}
