/**
 * An email's content as blocks: the contract between wordings (and the AI copy writer, F2b) and
 * the email design (send/design/). A wording with `bodyFormat: 'blocks'` stores them as JSON
 * (`{"v":1,"blocks":[…]}`). Blocks carry words and merge fields, never colours, sizes or markup:
 * the design decides how everything looks. Pure (zod only).
 *
 * The limits are counted with every merge field as 12 characters (a first name, a date, a venue
 * name), so a wording that passes still fits once filled in.
 */

import { z } from 'zod';

export const BLOCK_LIMITS = {
  heading: 64,
  text: 300,
  texts: 3,
  button: 24,
  signoff: 40,
  alt: 120,
  emoji: 1,
} as const;

const MERGE = /\{\{[^{}]*\}\}/g;
const EMOJI = /\p{Extended_Pictographic}/gu;
const TYPED_URL = /https?:\/\/|www\./i;
const LINK_FIELD = /\{\{\s*link\./;

/** The length a text has once its merge fields are filled in (each counted as 12 characters). */
export function effectiveLength(template: string): number {
  return template.replace(MERGE, 'x'.repeat(12)).length;
}

export function emojiCount(s: string): number {
  return (s.match(EMOJI) ?? []).length;
}

const words = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((t) => effectiveLength(t) <= max, { message: `longer than ${max} characters` })
    .refine((t) => !TYPED_URL.test(t) && !LINK_FIELD.test(t), { message: 'links go in a button, not in the text' });
const line = (max: number) => words(max).refine((t) => !/\n/.test(t), { message: 'one line only' });

/** A link is always one of the engine's links, so it is minted, tracked and can't point elsewhere. */
export const blockHref = z.string().regex(/^\{\{\s*link\.(offer|rating|hub|booking)\s*\}\}$/, { message: 'not one of the engine links' });

const httpsSrc = z
  .string()
  .max(500)
  .refine((v) => {
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  }, { message: 'an https image' });

export const templateBlockSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('heading'), text: line(BLOCK_LIMITS.heading).refine((t) => emojiCount(t) === 0, { message: 'no emoji in the heading' }) }),
  z.object({ t: z.literal('text'), text: words(BLOCK_LIMITS.text) }),
  z.object({ t: z.literal('offer'), href: blockHref, button: line(BLOCK_LIMITS.button).optional() }),
  z.object({ t: z.literal('rating'), href: blockHref }),
  z.object({ t: z.literal('info'), href: blockHref, button: line(BLOCK_LIMITS.button).optional() }),
  z.object({ t: z.literal('button'), href: blockHref, label: line(BLOCK_LIMITS.button) }),
  z.object({ t: z.literal('image'), src: httpsSrc, alt: line(BLOCK_LIMITS.alt) }),
  z.object({ t: z.literal('signoff'), text: line(BLOCK_LIMITS.signoff) }),
]);
export type TemplateBlock = z.infer<typeof templateBlockSchema>;

const FEATURES = ['offer', 'rating', 'info'] as const;

export const blocksBodySchema = z
  .object({ v: z.literal(1), blocks: z.array(templateBlockSchema).min(2).max(10) })
  .superRefine((body, ctx) => {
    const count = (t: string) => body.blocks.filter((b) => b.t === t).length;
    const problem = (message: string) => ctx.addIssue({ code: 'custom', message, path: ['blocks'] });
    if (count('heading') !== 1) problem('exactly one heading');
    if (count('text') < 1 || count('text') > BLOCK_LIMITS.texts) problem(`one to ${BLOCK_LIMITS.texts} text blocks`);
    const features = body.blocks.filter((b) => (FEATURES as readonly string[]).includes(b.t));
    if (features.length > 1) problem('at most one offer, rating or info block');
    if (count('button') > 1) problem('at most one button');
    if (count('button') && features.some((f) => f.t !== 'rating')) problem('the offer or info block already carries the button');
    if (count('image') > 1) problem('at most one image');
    if (count('signoff') > 1) problem('at most one sign-off');
    if (body.blocks[0]?.t !== 'heading') problem('the heading comes first');
    const emoji = body.blocks.reduce((n, b) => n + (b.t === 'text' ? emojiCount(b.text) : 0), 0);
    if (emoji > BLOCK_LIMITS.emoji) problem(`at most ${BLOCK_LIMITS.emoji} emoji per email`);
  });
export type BlocksBody = z.infer<typeof blocksBodySchema>;

/** The stored JSON, checked; null when it isn't a valid blocks body. */
export function parseBlocksBody(json: string): BlocksBody | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = blocksBodySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * A blocks wording as plain text, for the text/plain part, the stored preview and the merge-field
 * checks (engine/renderSend.ts). Null when the JSON isn't a valid blocks body.
 */
export function blocksTemplateText(body: string): string | null {
  const parsed = parseBlocksBody(body);
  if (!parsed) return null;
  const lines: string[] = [];
  for (const b of parsed.blocks) {
    if (b.t === 'heading' || b.t === 'text') lines.push(b.text);
    else if (b.t === 'signoff') lines.push(`${b.text}\n{{venue.name}}`);
    else if (b.t === 'button') lines.push(`${b.label}: ${b.href}`);
    else if (b.t === 'offer' || b.t === 'info') lines.push(b.button ? `${b.button}: ${b.href}` : b.href);
    else if (b.t === 'rating') lines.push(b.href);
  }
  return lines.join('\n\n');
}
