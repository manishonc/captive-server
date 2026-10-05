/**
 * PR W2 — the AI template writer's pure core (core/whatsapp/aiBrief.ts) and its job, against the
 * seed's real messages. No Firestore, no model.
 *
 * Run: npx tsx tests/adaptiveWhatsAppAi.test.ts   (from captive-server/server)
 *
 *  - For every seed message × EN/DE/FR/IT: the brief has no personal data (the privacy scan finds
 *    nothing), only the message's allowed fields, wording without links or fields WhatsApp can't
 *    carry; the sandbox's answer passes every check of the job, the numbers check included.
 *  - Wording with contact data is left out (and counted), never sent.
 *  - Translations need an English template with text; fixes a template Meta rejected or paused.
 *  - Each WW check rejects; a template check's error rejects under its T code; a warning rejects
 *    only the daily gap-fill and the AI fixes (WW08).
 *  - Still needed? The gap-fill never writes into a filled cell; a fix only against the version
 *    it read, while editable, under the AI-fix limit.
 *  - Coverage gaps: English first, translations once the English is approved or in review,
 *    coming-soon skipped, 30-day waits, pending and cooled-down cells skipped, orphans.
 *  - Suggest options per cell.
 */

import { SEED } from '../src/adaptive/seed/definitions';
import { journeyDefinitionSchema } from '../src/adaptive/core/schemas';
import { whatsappPools, type PoolRow } from '../src/adaptive/core/whatsapp/pools';
import { STOP_LINES } from '../src/adaptive/send/compose';
import { scanPackage } from '../src/adaptive/brain/privacy';
import { numbersCheck } from '../src/adaptive/brain/checks';
import { jobFor } from '../src/adaptive/brain/registry';
import { LANGS, type Lang } from '../src/adaptive/core/constants';
import {
  GAP_COOLDOWN_MS,
  buildWriterRequest,
  cleanText,
  coverageGaps,
  englishSourceFor,
  parseWriterParams,
  sandboxWriterAnswer,
  stillNeeded,
  suggestOptionsFor,
  writerAnswerSchema,
  writerChecks,
  wantedCategory,
  type WriterAnswer,
  type WriterBrief,
  type WriterKind,
  type WriterLocal,
  type WriterRequestInput,
  type WriterTemplateView,
} from '../src/adaptive/core/whatsapp/aiBrief';
import type { CheckContext } from '../src/adaptive/core/whatsapp/checks';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const eq = (a: unknown, b: unknown, msg: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// ── The seed's messages ──────────────────────────────────────────────────────

const POOLS: PoolRow[] = whatsappPools(
  SEED.journeys.map((j) => ({ key: j.header.key, name: j.header.name, availability: j.header.availability ?? 'available', definition: journeyDefinitionSchema.parse(j.definition) })) as never,
  SEED.variants.map((v) => ({ ...v, status: 'active' })) as never,
);

function wordingOf(pool: PoolRow): WriterRequestInput['wording'] {
  const v = SEED.variants.filter((x) => x.poolKey === pool.poolKey && (!x.journeyKey || x.journeyKey === pool.journeyKey)).sort((a, b) => String(a.letter).localeCompare(String(b.letter)))[0] as any;
  if (!v) return {};
  const out: WriterRequestInput['wording'] = {};
  for (const lang of LANGS) {
    const c = v.locales?.[lang] ?? (lang === 'en' ? v.channels : null);
    if (!c) continue;
    out[lang] = { sms: c.sms?.text ?? null, email: c.email ? [c.email.subject, c.email.bodyFormat === 'text' || !c.email.bodyFormat ? c.email.body : ''].join('\n') : null };
  }
  return out;
}

const hasContactData = (t: string) => scanPackage(t).length > 0;

function ctxFor(pool: PoolRow, siblings: CheckContext['siblings'] = []): CheckContext {
  return {
    visitorBaseUrl: 'https://visit.askheidi.app',
    optOutKeywords: ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'],
    footers: STOP_LINES,
    pool,
    siblings,
    templateCount: 3,
    templateLimit: 250,
    createsThisHour: 0,
  };
}

function request(pool: PoolRow, lang: Lang, kind: WriterKind = 'new', templates: WriterTemplateView[] = [], extra: Partial<WriterRequestInput> = {}) {
  return buildWriterRequest({
    kind,
    requestedBy: 'gap_fill',
    lang,
    pool,
    templates,
    wording: wordingOf(pool),
    checkCtx: ctxFor(pool),
    hasContactData,
    rejectionWords: (c) => `words for ${c}`,
    ...extra,
  });
}

function view(over: Partial<WriterTemplateView>): WriterTemplateView {
  return {
    id: 'wt_x',
    name: 'hf_welcome_offer_1',
    lang: 'en',
    origin: 'ai',
    display: 'approved',
    dismissed: false,
    version: 1,
    stage: 'submitted',
    metaStatus: 'APPROVED',
    rejectedReason: null,
    source: { body: 'Hello {{contact.firstName | default:"there"}}, thanks for visiting {{venue.name}} today, we hope you liked it here.', footer: null, button: null },
    changedAtMs: 0,
    aiFixes: 0,
    dismissedAtMs: null,
    category: null,
    ...over,
  };
}

const job = jobFor('wa_template_writer')!;
const prompt = job.prompts[job.defaults.promptVersion];

console.log('\nThe AI template writer (PR W2)\n');

test('the seed has WhatsApp messages to write for (both rules)', () => {
  assert(POOLS.length >= 8, `pools: ${POOLS.length}`);
  assert(POOLS.some((p) => p.whatsappCategory === 'marketing') && POOLS.some((p) => p.whatsappCategory === 'utility'), 'both rules');
});

test('every seed message × language: no personal data, allowed fields only, clean wording; the sandbox answer passes every check', () => {
  for (const pool of POOLS) {
    for (const lang of LANGS) {
      for (const requestedBy of ['gap_fill', 'suggest'] as const) {
        const r = request(pool, lang, 'new', [], { requestedBy });
        assert(!('refuse' in r), `${pool.poolKey} ${lang}: refused ${JSON.stringify(r)}`);
        const { brief, local } = r;
        const found = scanPackage(brief);
        assert(!found.length, `${pool.poolKey} ${lang}: personal data in the brief ${JSON.stringify(found)}`);
        for (const f of brief.fields) assert(pool.allowedFields.includes(f.field), `${pool.poolKey}: field ${f.field} not allowed`);
        for (const w of brief.wording) {
          assert(!/\{\{\s*link\./.test(w.text), `${pool.poolKey}: a link left in the wording: ${w.text}`);
          for (const m of w.text.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)/g)) assert(pool.allowedFields.includes(m[1]), `${pool.poolKey}: ${m[1]} left in the wording`);
        }
        eq(brief.category, pool.whatsappCategory === 'utility' ? 'UTILITY' : 'MARKETING', `${pool.poolKey}: category`);
        eq(Boolean(brief.button), Boolean(pool.linkField), `${pool.poolKey}: button`);
        const answer = sandboxWriterAnswer(brief);
        assert(writerAnswerSchema.safeParse(answer).success, `${pool.poolKey} ${lang}: the sandbox answer fits the schema`);
        const checks = job.check(answer, brief, local);
        const bad = checks.filter((c) => !c.ok);
        assert(!bad.length, `${pool.poolKey} ${lang} ${requestedBy}: ${JSON.stringify(bad)}`);
        const nums = numbersCheck(job.reasoningOf(answer), JSON.parse(JSON.stringify(brief)), [prompt.system, prompt.instructions]);
        assert(nums.ok, `${pool.poolKey}: ${nums.detail}`);
      }
    }
  }
});

test('the sandbox gives each message its own text (Meta refuses duplicates, T18)', () => {
  for (const lang of LANGS) {
    const bodies = POOLS.map((p) => sandboxWriterAnswer((request(p, lang) as { brief: WriterBrief }).brief).body);
    eq(new Set(bodies).size, POOLS.length, `${lang}: one text per message`);
  }
});

test('the prompt asks for no counts in the reasoning, names the rules, and quotes no number it doesn’t give', () => {
  assert(/never quote counts, lengths or other numbers/.test(prompt.system), 'no counts');
  assert(/\{\{venue\.name\}\}/.test(prompt.system) && /UTILITY/.test(prompt.system), 'rules');
  eq(job.cacheSystem, true, 'the system prompt is cached');
});

test('wording with contact data is left out of the brief (and counted)', () => {
  const pool = POOLS.find((p) => p.poolKey === 'welcome_offer')!;
  const r = request(pool, 'en', 'new', [], { wording: { en: { sms: 'Call us on +41 79 123 45 67 at {{venue.name}}', email: 'Write to hello@venue.ch' }, de: { sms: 'Hallo bei {{venue.name}}' } } });
  assert(!('refuse' in r), 'built');
  eq(r.local.withheld, 2, 'two texts withheld');
  assert(!JSON.stringify(r.brief).includes('+41') && !JSON.stringify(r.brief).includes('@venue'), 'not in the brief');
  eq(r.brief.wording.map((w) => w.language), ['de'], 'the clean one stays');
});

test('a translation needs an English template with text; it goes under that name; a language the name has is refused', () => {
  const pool = POOLS.find((p) => p.poolKey === 'welcome_offer')!;
  eq((request(pool, 'de', 'translation') as { refuse: string }).refuse, 'english_missing', 'no English');
  const en = view({ id: 'wt_en', name: 'hf_welcome_offer_3', lang: 'en', display: 'in_review', metaStatus: 'PENDING' });
  const r = request(pool, 'de', 'translation', [en]);
  assert(!('refuse' in r), 'built');
  eq([r.local.existingName, r.local.targetTemplateId, Boolean(r.brief.english)], ['hf_welcome_offer_3', 'wt_en', true], 'from the English');
  eq((request(pool, 'de', 'translation', [en, view({ id: 'wt_de', name: 'hf_welcome_offer_3', lang: 'de', display: 'rejected' })]) as { refuse: string }).refuse, 'language_exists', 'the name has DE');
});

test('a fix needs a template of ours that Meta rejected or paused; it carries Meta’s reason and the version it read', () => {
  const pool = POOLS.find((p) => p.poolKey === 'welcome_offer')!;
  const approved = view({ id: 'wt_a' });
  eq((request(pool, 'en', 'fix', [approved], { targetTemplateId: 'wt_a' }) as { refuse: string }).refuse, 'not_rejected', 'approved');
  const rejected = view({ id: 'wt_r', display: 'rejected', metaStatus: 'REJECTED', rejectedReason: 'INVALID_FORMAT', version: 4 });
  const r = request(pool, 'en', 'fix', [rejected], { targetTemplateId: 'wt_r' });
  assert(!('refuse' in r), 'built');
  eq([r.local.targetVersion, r.brief.rejection?.reason, Boolean(r.brief.current)], [4, 'INVALID_FORMAT', true], 'fix');
  eq((request(pool, 'en', 'fix', [view({ id: 'wt_i', origin: 'imported', source: null, display: 'rejected', metaStatus: 'REJECTED' })], { targetTemplateId: 'wt_i' }) as { refuse: string }).refuse, 'not_ours', 'imported');
  eq((request(pool, 'en', 'fix', [{ ...rejected, aiFixes: 2 }], { targetTemplateId: 'wt_r' }) as { refuse: string }).refuse, 'fix_limit', 'fixed twice already');
});

test('each WW check rejects; a template error rejects under its T code; a warning rejects only the gap-fill and AI fixes (WW08)', () => {
  const marketing = POOLS.find((p) => p.whatsappCategory === 'marketing' && p.linkField)!;
  const utility = POOLS.find((p) => p.whatsappCategory === 'utility')!;
  const built = (pool: PoolRow, requestedBy: 'gap_fill' | 'suggest' = 'gap_fill') => request(pool, 'en', 'new', [], { requestedBy }) as { brief: WriterBrief; local: WriterLocal };
  const fails = (pool: PoolRow, change: Partial<WriterAnswer>, requestedBy: 'gap_fill' | 'suggest' = 'gap_fill') => {
    const { brief, local } = built(pool, requestedBy);
    return writerChecks({ ...sandboxWriterAnswer(brief), ...change }, brief, local, hasContactData).filter((c) => !c.ok).map((c) => c.code);
  };
  assert(fails(marketing, { category: 'UTILITY' }).includes('WW01'), 'WW01 category');
  assert(fails(marketing, { language: 'de' }).includes('WW02'), 'WW02 language');
  assert(fails(marketing, { buttonText: null }).includes('WW09'), 'WW09 button');
  assert(fails(marketing, { reasoning: 'Call +41 79 123 45 67' }).includes('WW05'), 'WW05 contact data');
  assert(fails(utility, { body: 'Hello {{contact.firstName | default:"there"}}, enjoy a free dessert at {{venue.name}} when you come back soon.' }).includes('WW06'), 'WW06 promotion');
  const { brief: b2, local: l2 } = built(marketing);
  const dupBrief = { ...b2, existingBodies: [sandboxWriterAnswer({ ...b2, existingBodies: [] }).body] };
  // The sandbox avoids repeats: force one.
  const dupAnswer = { ...sandboxWriterAnswer({ ...b2, existingBodies: [] }) };
  assert(writerChecks(dupAnswer, dupBrief, l2, hasContactData).some((c) => c.code === 'WW07' && !c.ok), 'WW07 duplicate');
  assert(fails(marketing, { body: 'Hello {{contact.firstName | default:"there"}}, see {{guestinfo.hostContactUrl}} at {{venue.name}} for everything you need today.' }).includes('T08'), 'T08 a field not allowed');
  assert(fails(marketing, { body: '{{venue.name}} says hello and thanks you for the lovely visit today, see you soon.' }).includes('T09'), 'T09 field first');
  // A warning (T10: few words per field) rejects the gap-fill, not a person's Suggest.
  const few = { body: 'Hi {{contact.firstName | default:"there"}}, thanks for visiting {{venue.name}} today.' };
  const { brief: fb, local: fl } = built(marketing);
  const fewCodes = writerChecks({ ...sandboxWriterAnswer(fb), ...few }, fb, fl, hasContactData);
  assert(!fewCodes.some((c) => !c.ok && c.code !== 'WW08'), `only WW08 fails: ${JSON.stringify(fewCodes.filter((c) => !c.ok))}`);
  assert(fails(marketing, few).includes('WW08'), 'WW08 for the gap-fill');
  assert(!fails(marketing, few, 'suggest').includes('WW08'), 'a Suggest keeps its warnings');
});

test('still needed: the gap-fill never writes into a filled cell; a fix only for the version it read, while editable, under the limit', () => {
  const pool = POOLS.find((p) => p.poolKey === 'welcome_offer')!;
  const { local } = request(pool, 'en') as { local: WriterLocal };
  eq(stillNeeded(local, [view({ lang: 'en', display: 'ready', stage: 'draft', metaStatus: null })]), 'cell_filled', 'filled');
  eq(stillNeeded({ ...local, requestedBy: 'suggest' }, [view({ lang: 'en' })]), null, 'a Suggest writes anyway');
  eq(stillNeeded(local, [view({ lang: 'en', display: 'rejected', metaStatus: 'REJECTED' })]), null, 'a rejected one isn’t filling');
  const fix: WriterLocal = { ...local, kind: 'fix', targetTemplateId: 'wt_r', targetVersion: 2 };
  const r = view({ id: 'wt_r', display: 'rejected', metaStatus: 'REJECTED', version: 2 });
  eq(stillNeeded(fix, [r]), null, 'needed');
  eq(stillNeeded(fix, [{ ...r, version: 3 }]), 'edited_since', 'edited');
  eq(stillNeeded(fix, [{ ...r, stage: 'submitting' }]), 'not_editable', 'being sent');
  eq(stillNeeded(fix, [{ ...r, aiFixes: 2 }]), 'fix_limit', 'limit');
  eq(stillNeeded(fix, []), 'no_target', 'gone');
});

test('coverage gaps: English first, translations once the English is approved or in review, waits, pending and cooldowns', () => {
  const now = Date.UTC(2026, 9, 5, 10, 0);
  const marketing = POOLS.filter((p) => p.availability === 'available').slice(0, 2);
  const [a, b] = marketing;
  const byPool: Record<string, WriterTemplateView[]> = {
    [`${a.journeyKey}:${a.poolKey}`]: [view({ id: 'wt_a_en', name: `hf_${a.poolKey}_1`, lang: 'en', display: 'approved' })],
    [`${b.journeyKey}:${b.poolKey}`]: [view({ id: 'wt_b_en', name: `hf_${b.poolKey}_1`, lang: 'en', display: 'rejected', metaStatus: 'REJECTED', changedAtMs: now - 5 * 86_400_000 })],
  };
  const gaps = coverageGaps({ pools: marketing, templatesOf: (j, p) => byPool[`${j}:${p}`] ?? [], realNow: now, cooldowns: {}, pending: new Set() });
  eq(
    gaps.map((g) => `${g.poolKey}:${g.lang}:${g.kind}`),
    [`${a.poolKey}:de:translation`, `${a.poolKey}:it:translation`, `${a.poolKey}:fr:translation`],
    'a: translations of its approved English; b: rejected 5 days ago waits (30 days), its languages need an English first',
  );
  const later = coverageGaps({ pools: marketing, templatesOf: (j, p) => byPool[`${j}:${p}`] ?? [], realNow: now + GAP_COOLDOWN_MS, cooldowns: {}, pending: new Set() });
  assert(later.some((g) => g.poolKey === b.poolKey && g.lang === 'en' && g.kind === 'new'), 'after 30 days: a new English');
  const pendingSkip = coverageGaps({ pools: marketing, templatesOf: (j, p) => byPool[`${j}:${p}`] ?? [], realNow: now, cooldowns: { [`${a.journeyKey}:${a.poolKey}:it`]: now + 1000 }, pending: new Set([`${a.journeyKey}:${a.poolKey}:de`]) });
  eq(pendingSkip.map((g) => g.lang), ['fr'], 'pending DE and cooled-down IT skipped');
  const soon = coverageGaps({ pools: [{ ...a, availability: 'coming_soon' }], templatesOf: () => [], realNow: now, cooldowns: {}, pending: new Set() });
  eq(soon.length, 0, 'coming soon: skipped');
  const dismissed = coverageGaps({ pools: [a], templatesOf: () => [view({ lang: 'en', dismissed: true, display: 'dismissed', dismissedAtMs: now - 86_400_000 })], realNow: now, cooldowns: {}, pending: new Set() });
  eq(dismissed.length, 0, 'a dismissed AI draft waits 30 days (a person said no)');
  const orphan = coverageGaps({
    pools: [a],
    templatesOf: () => [
      view({ id: 'en1', name: 'hf_x_1', lang: 'en', dismissed: true, display: 'dismissed' }),
      view({ id: 'en2', name: 'hf_x_2', lang: 'en', display: 'approved' }),
      view({ id: 'de1', name: 'hf_x_1', lang: 'de', display: 'ready', stage: 'draft', metaStatus: null }),
    ],
    realNow: now,
    cooldowns: {},
    pending: new Set(),
  });
  assert(orphan.some((g) => g.lang === 'de' && g.kind === 'translation' && g.englishId === 'en2'), `an orphaned German draft (its English dismissed) is a gap: ${JSON.stringify(orphan)}`);
});

test('Suggest options: new (and a translation) for a missing cell, a fix and an alternative for a rejected one of ours, else an alternative', () => {
  const en = view({ id: 'en', lang: 'en', display: 'approved' });
  eq(suggestOptionsFor([], [], 'en').map((o) => o.kind), ['new'], 'missing EN');
  eq(suggestOptionsFor([], [en], 'de').map((o) => `${o.kind}:${o.templateId}`), ['translation:en', 'new:null'], 'missing DE with an English');
  const rej = view({ id: 'r', lang: 'de', display: 'rejected', metaStatus: 'REJECTED' });
  eq(suggestOptionsFor([rej], [en, rej], 'de').map((o) => `${o.kind}:${o.templateId}`), ['fix:r', 'alternative:null'], 'rejected');
  eq(suggestOptionsFor([{ ...rej, aiFixes: 2 }], [en, rej], 'de').map((o) => o.kind), ['alternative'], 'fix limit');
  eq(suggestOptionsFor([en], [en], 'en').map((o) => o.kind), ['alternative'], 'approved');
});

test('params that don’t read are refused; a valid request round-trips', () => {
  eq(parseWriterParams({}), null, 'empty');
  eq(parseWriterParams({ brief: {}, local: { lang: 'xx' } }), null, 'bad local');
  const pool = POOLS[0];
  const r = request(pool, 'en') as { brief: WriterBrief; local: WriterLocal };
  const back = parseWriterParams(JSON.parse(JSON.stringify({ brief: r.brief, local: r.local })));
  assert(back && back.local.use.poolKey === pool.poolKey && back.brief.language === 'en', 'round trip');
});

// ── Review round 1 (PR W2a): each confirmed finding, pinned ──────────────────

const offerPool = POOLS.find((p) => p.poolKey === 'welcome_offer')!;
const reviewPool = POOLS.find((p) => p.poolKey === 'review_ask')!;
const checkoutPool = POOLS.find((p) => p.poolKey === 'checkout_info')!;
const builtFor = (pool: PoolRow, lang: Lang = 'en', requestedBy: 'gap_fill' | 'suggest' = 'gap_fill', extra: Partial<WriterRequestInput> = {}) =>
  request(pool, lang, 'new', [], { requestedBy, ...extra }) as { brief: WriterBrief; local: WriterLocal };
const failsOf = (pool: PoolRow, change: Partial<WriterAnswer>, lang: Lang = 'en', requestedBy: 'gap_fill' | 'suggest' = 'gap_fill', extra: Partial<WriterRequestInput> = {}) => {
  const { brief, local } = builtFor(pool, lang, requestedBy, extra);
  return writerChecks({ ...sandboxWriterAnswer(brief), ...change }, brief, local, hasContactData).filter((c) => !c.ok).map((c) => c.code);
};

test('WW10: a number, price or percentage the brief doesn’t give is rejected (text, defaults, button), for every requester', () => {
  const hi = 'Hi {{contact.firstName | default:"there"}}, thanks for visiting {{venue.name}} today';
  assert(failsOf(offerPool, { body: `${hi}. Come back soon and get 20% off your bill, valid for 2 weeks.` }).includes('WW10'), '20% off, 2 weeks');
  assert(failsOf(reviewPool, { body: `${hi}. Rate us today and get a CHF 10 voucher on your next visit.` }, 'en', 'suggest').includes('WW10'), 'CHF 10 voucher (Suggest too)');
  assert(failsOf(offerPool, { body: `${hi}. Come back within {{offer.days | default:"7"}} days for {{offer.label | default:"a surprise"}} at our place.` }).includes('WW10'), 'a made-up default');
  assert(failsOf(checkoutPool, { body: `${hi}. A late check-out costs extra, please tell us by 9 in the morning.` }).includes('WW10'), 'a made-up time');
  assert(failsOf(offerPool, { body: `${hi}. We would love to see you again, with a little thank-you on us.`, buttonText: 'Get 50 percent' }).includes('WW10'), 'in the button');
  // A number the wording gives is fine.
  const given = { wording: { en: { sms: 'Hi {{contact.firstName}}, check-out is at 11:00 tomorrow at {{venue.name}}.' } } };
  const ok = failsOf(checkoutPool, { body: `${hi}. Check-out tomorrow is at 11:00, and the details are in the guest info below.` }, 'en', 'suggest', given);
  assert(!ok.includes('WW10'), `11:00 from the wording: ${ok.join(',')}`);
});

test('WW11: a default left as “…” or a first-name default in another language is rejected', () => {
  const tail = ', thanks for visiting {{venue.name}} today, we hope you enjoyed every moment of your time with us.';
  assert(failsOf(offerPool, { body: `Hi {{contact.firstName | default:"…"}}${tail}` }).includes('WW11'), '“…”');
  const de = failsOf(offerPool, { language: 'de', body: 'Hallo {{contact.firstName | default:"there"}}, danke für deinen Besuch bei {{venue.name}}, wir freuen uns sehr auf dich und deinen nächsten Besuch.' }, 'de');
  assert(de.includes('WW11'), `“there” in German: ${de.join(',')}`);
});

test('WW02: the text’s own words decide the language; Swiss German writes “ss”', () => {
  const en = 'Hello {{contact.firstName | default:"du"}}, thank you for choosing {{venue.name}} today. We are happy to have you with us and wish you a lovely time.';
  assert(failsOf(offerPool, { language: 'de', body: en, buttonText: 'Angebot ansehen' }, 'de').includes('WW02'), 'English text in a German cell');
  const eszett = 'Hallo {{contact.firstName | default:"du"}}, danke für deinen Besuch bei {{venue.name}}. Wir freuen uns, dich bald wieder zu sehen – viele Grüße!';
  assert(failsOf(offerPool, { language: 'de', body: eszett, buttonText: 'Angebot ansehen' }, 'de').includes('WW02'), 'ß');
  for (const lang of LANGS) assert(!failsOf(offerPool, {}, lang).includes('WW02'), `the sandbox's ${lang} passes`);
});

test('the prompt names the field rules the checks enforce; a service brief lists the words to avoid', () => {
  assert(/not even with only a comma/.test(prompt.system) && /three words of your own/.test(prompt.system), 'T09 and T10 in words');
  assert(/never "…"/.test(prompt.system) && /avoidWords/.test(prompt.system), 'defaults and the avoid list');
  assert(/follow the rules, not its shape/.test(prompt.instructions), 'the wording is for meaning only');
  const { brief } = builtFor(checkoutPool, 'de');
  assert(brief.avoidWords.includes('kostenlos') && brief.avoidWords.includes('free'), 'German + English words');
  eq(builtFor(offerPool).brief.avoidWords, [], 'none for a marketing message');
});

test('cleanText: a sentence that held a field WhatsApp can’t carry goes whole; old field names count', () => {
  const allowed = new Set(['venue.name', 'contact.firstName', 'guestinfo.checkOutTime']);
  const out = cleanText('Hi {{firstName}}, check-out tomorrow is at {{guestinfo.checkOutTime}}. Want to stay longer? Late check-out until 14:00 is CHF {{slot.late_checkout_price}} – ask your host: {{guestinfo.hostContactUrl}}', allowed);
  assert(!/CHF|14:00|host/.test(out), out);
  assert(out.includes('{{contact.firstName}}') && out.includes('{{guestinfo.checkOutTime}}'), out);
  eq(cleanText('The details are here: {{link.hub}}\nSafe travels,\n{{venueName}}', allowed), 'The details are here\nSafe travels,\n{{venue.name}}', 'links out, alias in');
});

test('a fix must change something; a translation must not be the English text (WW07)', () => {
  const rejected = view({ id: 'wt_r', display: 'rejected', metaStatus: 'REJECTED', rejectedReason: 'INVALID_FORMAT', version: 2, source: { body: 'Hi {{contact.firstName | default:"there"}}, thanks for visiting {{venue.name}} today, we hope you liked it here and see you soon.', footer: null, button: { text: 'See your offer', field: 'link.offer' } } });
  const r = request(offerPool, 'en', 'fix', [rejected], { targetTemplateId: 'wt_r', requestedBy: 'suggest' }) as { brief: WriterBrief; local: WriterLocal };
  const same = writerChecks({ ...sandboxWriterAnswer(r.brief), body: rejected.source!.body, buttonText: 'See your offer' }, r.brief, r.local, hasContactData);
  assert(same.some((c) => c.code === 'WW07' && !c.ok), 'unchanged fix');
  const buttonOnly = writerChecks({ ...sandboxWriterAnswer(r.brief), body: rejected.source!.body, buttonText: 'Open your offer' }, r.brief, r.local, hasContactData);
  assert(buttonOnly.some((c) => c.code === 'WW07' && c.ok), 'a new button text is a change');
});

test('a fix must target the language asked for (other_language), at Suggest and before the model', () => {
  const de = view({ id: 'wt_de', lang: 'de', display: 'rejected', metaStatus: 'REJECTED', version: 1 });
  eq((request(offerPool, 'en', 'fix', [de], { targetTemplateId: 'wt_de' }) as { refuse: string }).refuse, 'other_language', 'refused');
  const { local } = builtFor(offerPool);
  eq(stillNeeded({ ...local, kind: 'fix', targetTemplateId: 'wt_de', targetVersion: 1 }, [de]), 'other_language', 'skipped');
});

test('orphans: a translation without its English doesn’t fill its cell (both rules agree); a fresh-name German draft does', () => {
  const now = Date.UTC(2026, 9, 5, 10, 0);
  const templates = [
    view({ id: 'en1', name: 'hf_x_1', lang: 'en', dismissed: true, display: 'dismissed' }),
    view({ id: 'en2', name: 'hf_x_2', lang: 'en', display: 'approved' }),
    view({ id: 'de1', name: 'hf_x_1', lang: 'de', display: 'ready', stage: 'draft', metaStatus: null }),
  ];
  const gaps = coverageGaps({ pools: [offerPool], templatesOf: () => templates, realNow: now, cooldowns: {}, pending: new Set() });
  const de = gaps.find((g) => g.lang === 'de');
  assert(de && de.kind === 'translation' && de.englishId === 'en2', JSON.stringify(gaps));
  const r = request(offerPool, 'de', 'translation', templates, { targetTemplateId: 'en2' }) as { local: WriterLocal };
  eq(stillNeeded(r.local, templates), null, 'the precheck agrees: still needed');
  // A person's Suggest "new" in German: its own name, no English of that name — it fills the cell.
  const fresh = [view({ id: 'en', name: 'hf_x_2', lang: 'en', display: 'approved' }), view({ id: 'd5', name: 'hf_x_5', lang: 'de', display: 'ready', stage: 'draft', metaStatus: null })];
  const g2 = coverageGaps({ pools: [offerPool], templatesOf: () => fresh, realNow: now, cooldowns: {}, pending: new Set() });
  assert(!g2.some((g) => g.lang === 'de'), `no German gap: ${JSON.stringify(g2)}`);
  const { local } = builtFor(offerPool, 'de');
  eq(stillNeeded(local, fresh), 'cell_filled', 'a gap-fill new German is not needed');
});

test('an English template filed under another category than the message’s rule is never a translation source', () => {
  const now = Date.UTC(2026, 9, 5, 10, 0);
  const utilityEn = view({ id: 'en_u', name: 'hf_review_ask_1', lang: 'en', display: 'approved', category: 'UTILITY' });
  const wanted = wantedCategory(reviewPool);
  eq(wanted, 'MARKETING', 'review asks are marketing');
  eq(englishSourceFor([utilityEn], wanted), null, 'not a source');
  eq(coverageGaps({ pools: [reviewPool], templatesOf: () => [utilityEn], realNow: now, cooldowns: {}, pending: new Set() }).filter((g) => g.kind === 'translation').length, 0, 'no translation gaps');
  eq(suggestOptionsFor([], [utilityEn], 'de', wanted).map((o) => o.kind), ['new'], 'Suggest offers no translation');
  eq((request(reviewPool, 'de', 'translation', [utilityEn], { targetTemplateId: 'en_u' }) as { refuse: string }).refuse, 'english_missing', 'refused');
  // Its own category: a source.
  eq(englishSourceFor([{ ...utilityEn, category: 'MARKETING' }], wanted)?.id, 'en_u', 'a marketing English is');
});

test('a translation of a dismissed English is refused when it is asked for', () => {
  const dismissedEn = view({ id: 'en_d', name: 'hf_welcome_offer_1', lang: 'en', dismissed: true, display: 'dismissed' });
  eq((request(offerPool, 'de', 'translation', [dismissedEn], { targetTemplateId: 'en_d' }) as { refuse: string }).refuse, 'english_missing', 'refused');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
