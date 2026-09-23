/**
 * Wording helpers shared by the seed, the checks and the preview: which
 * languages exist per pool and channel, and a light lint of merge fields (the
 * merge-field part of V11). Spam-word and claim checks come with the P1 linter.
 */

import type { Channel, Lang } from './constants';
import type { ChannelContent } from './schemas';
import { checkMergeField, KNOWN_FILTERS, parseMergeExpressions } from './registry';
import type { WordingIndex } from './validatePlaybook';

export interface WordingLike {
  poolKey: string;
  status: string;
  channels: ChannelContent;
  locales: Partial<Record<string, Partial<ChannelContent> | undefined>>;
}

export function buildWordingIndex(variants: WordingLike[]): WordingIndex {
  const index: WordingIndex = new Map();
  for (const v of variants) {
    if (v.status !== 'active') continue;
    const entry = index.get(v.poolKey) ?? {};
    const add = (channel: Channel, lang: Lang) => {
      const set = entry[channel] ?? new Set<Lang>();
      set.add(lang);
      entry[channel] = set;
    };
    for (const channel of ['sms', 'email', 'whatsapp'] as Channel[]) {
      if (v.channels[channel]) add(channel, 'en');
      for (const [lang, content] of Object.entries(v.locales ?? {})) {
        if (content && content[channel]) add(channel, lang as Lang);
      }
    }
    index.set(v.poolKey, entry);
  }
  return index;
}

/** Every text field of a channel content block, labelled for messages. */
export function wordingTexts(content: Partial<ChannelContent>): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  if (content.sms) out.push({ where: 'SMS', text: content.sms.text });
  if (content.email) {
    out.push({ where: 'email subject', text: content.email.subject });
    if (content.email.preheader) out.push({ where: 'email preheader', text: content.email.preheader });
    out.push({ where: 'email body', text: content.email.body });
  }
  if (content.whatsapp) {
    content.whatsapp.params.body.forEach((p, i) => out.push({ where: `WhatsApp {{${i + 1}}}`, text: p }));
    content.whatsapp.params.buttons.forEach((b) => out.push({ where: `WhatsApp button ${b.index}`, text: b.value }));
  }
  return out;
}

/** Merge fields used, and any that are unknown or not allowed for this purpose. */
export function lintMergeFields(
  content: Partial<ChannelContent>,
  opts: { purpose: 'marketing' | 'service'; slotKeys: string[] },
): { used: string[]; problems: string[] } {
  const used = new Set<string>();
  const problems: string[] = [];
  for (const { where, text } of wordingTexts(content)) {
    for (const expr of parseMergeExpressions(text)) {
      used.add(expr.name);
      const reason = checkMergeField(expr.name, opts);
      if (reason) problems.push(`${where}: {{${expr.name}}} ${reason}`);
      for (const f of expr.filters) {
        if (!KNOWN_FILTERS.has(f.name)) problems.push(`${where}: unknown filter “${f.name}”`);
      }
    }
    if (/\{\{(?![^}]*\}\})/.test(text)) problems.push(`${where}: an opening {{ is never closed`);
  }
  return { used: [...used].sort(), problems };
}
