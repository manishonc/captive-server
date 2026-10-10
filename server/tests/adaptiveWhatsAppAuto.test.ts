/**
 * PR W2b — Auto's rules (core/whatsapp/auto.ts), pure: which AI templates the tick sends to Meta by
 * itself and which it leaves (and why), which rejected AI templates it asks the AI to fix, the
 * unsent-fix rule, the summary's new lists, and Suggest's refusal of a second fix not sent yet.
 *
 * Run: npx tsx tests/adaptiveWhatsAppAuto.test.ts   (from captive-server/server)
 */

import { aiFixUnsent, autoFixCandidates, autoMaySend, autoQueue, autoWaitWords, writtenAsOf, type AutoView } from '../src/adaptive/core/whatsapp/auto';
import { aiFixUnsentOf, buildWriterRequest, suggestOptionsFor, type WriterTemplateView } from '../src/adaptive/core/whatsapp/aiBrief';
import { digestText } from '../src/adaptive/core/whatsapp/status';
import { SEED } from '../src/adaptive/seed/definitions';
import { journeyDefinitionSchema } from '../src/adaptive/core/schemas';
import { whatsappPools } from '../src/adaptive/core/whatsapp/pools';
import { STOP_LINES } from '../src/adaptive/send/compose';

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

const USE = { journeyKey: 'welcome_second_visit', poolKey: 'welcome_offer' };
const wanted = () => 'MARKETING';
let n = 0;
function v(over: Partial<AutoView> & { ai?: Partial<NonNullable<AutoView['ai']>> | null } = {}): AutoView {
  n += 1;
  const { ai, ...rest } = over;
  return {
    id: `wt_${n}`,
    name: 'hf_welcome_offer_1',
    lang: 'en',
    use: USE,
    origin: 'ai',
    dismissed: false,
    version: 1,
    stage: 'draft',
    display: 'ready',
    metaStatus: null,
    requestedCategory: 'MARKETING',
    checks: { errors: 0, warnings: 0 },
    lastSubmitErrorCode: null,
    usable: false,
    ai: ai === null ? null : { kind: 'new', writtenAs: 'new', appliedVersion: 1, fixes: 0, atMs: 1_000, autoSubmittedVersion: null, ...(ai ?? {}) },
    metaChangedAtMs: null,
    orderMs: n,
    ...rest,
  };
}
const ids = (q: { send: AutoView[] }) => q.send.map((x) => x.id);
const reasonOf = (q: ReturnType<typeof autoQueue>, id: string) => q.waiting.find((w) => w.id === id)?.reason ?? null;

console.log('\nWhatsApp Auto (PR W2b)\n');

test('a clean AI draft of a message’s rule is sent; manual and imported templates are never Auto’s', () => {
  const ok = v();
  const manual = v({ origin: 'manual', ai: null, name: 'hf_welcome_offer_2' });
  const imported = v({ origin: 'imported', ai: null, name: 'heidifi_x', use: null });
  const q = autoQueue([ok, manual, imported], wanted);
  eq(ids(q), [ok.id], 'only the AI draft');
  eq(q.waiting, [], 'the others aren’t Auto’s to list');
});

test('it leaves, with the reason: an alternative, a hand edit, a failing or warning check, another category, a Meta refusal, a version it sent', () => {
  const cases: Array<[AutoView, string]> = [
    [v({ ai: { kind: 'alternative', writtenAs: 'alternative' } }), 'alternative'],
    [v({ version: 2, ai: { appliedVersion: 1 } }), 'edited_by_hand'],
    [v({ checks: { errors: 1, warnings: 0 }, display: 'needs_fix' }), 'checks'],
    [v({ checks: { errors: 0, warnings: 1 } }), 'warnings'],
    [v({ requestedCategory: 'UTILITY' }), 'category'],
    [v({ lastSubmitErrorCode: 'invalid' }), 'meta_refused'],
    [v({ ai: { autoSubmittedVersion: 1 } }), 'tried'],
  ];
  for (const [view, reason] of cases) {
    const q = autoQueue([view], wanted);
    eq([ids(q), reasonOf(q, view.id)], [[], reason], reason);
    assert(autoWaitWords(reason) !== reason, `words for ${reason}`);
  }
});

test('Meta only unreachable: a version Auto tried goes again (3 tries); an account error never parks it; a refusal waits for a person', () => {
  const again = v({ ai: { autoSubmittedVersion: 1, autoAttempts: 1 }, lastSubmitErrorCode: 'unavailable' });
  eq(ids(autoQueue([again], wanted)), [again.id], 'unreachable: again');
  const third = v({ ai: { autoSubmittedVersion: 1, autoAttempts: 3 }, lastSubmitErrorCode: 'unknown_outcome' });
  eq(reasonOf(autoQueue([third], wanted), third.id), 'no_answer', 'three tries: a person looks');
  for (const code of ['setup', 'permission', 'not_found']) {
    const account = v({ ai: { autoSubmittedVersion: 1, autoAttempts: 3 }, lastSubmitErrorCode: code });
    eq(ids(autoQueue([account], wanted)), [account.id], `${code}: the account, not the template`);
  }
  const refused = v({ ai: { autoSubmittedVersion: 1 }, lastSubmitErrorCode: 'name_locked' });
  eq(reasonOf(autoQueue([refused], wanted), refused.id), 'meta_refused', 'locked: a person');
});

test('an AI fix from before W2b (no first kind recorded) is never Auto’s; a paused approved template still counts as approved', () => {
  const old = v({ stage: 'submitted', display: 'rejected', metaStatus: 'REJECTED', version: 2, metaChangedAtMs: 500, ai: { kind: 'fix', writtenAs: null, appliedVersion: 2, fixes: 1, atMs: 1_000 } });
  eq(reasonOf(autoQueue([old], wanted), old.id), 'unknown_origin', 'unknown origin');
  eq(autoFixCandidates([{ ...old, metaChangedAtMs: 2_000 }], {}).length, 0, 'never fixed by Auto either');
  const draft = v();
  const paused = v({ name: 'hf_welcome_offer_9', stage: 'submitted', display: 'approved', metaStatus: 'APPROVED', usable: false, origin: 'manual', ai: null });
  eq(reasonOf(autoQueue([draft, paused], wanted), draft.id), 'cell_has_approved', 'a person paused it: still theirs');
});

test('an AI fix keeps what it was written as: a fixed alternative stays an alternative', () => {
  eq(writtenAsOf({ kind: 'fix', writtenAs: 'alternative', appliedVersion: 2, fixes: 1, atMs: 1, autoSubmittedVersion: null }), 'alternative', 'kept');
  eq(writtenAsOf({ kind: 'fix', writtenAs: null, appliedVersion: 2, fixes: 1, atMs: 1, autoSubmittedVersion: null }), null, 'unknown (W2a)');
  eq(writtenAsOf({ kind: 'translation', writtenAs: null, appliedVersion: 1, fixes: 0, atMs: 1, autoSubmittedVersion: null }), 'translation', 'its kind');
});

test('English first: a translation waits for its English (the same name) approved or in review; one with no English waits', () => {
  const en = v({ display: 'ready' });
  const de = v({ lang: 'de', ai: { kind: 'translation', writtenAs: 'translation' } });
  let q = autoQueue([en, de], wanted);
  eq([ids(q), reasonOf(q, de.id)], [[en.id], 'english'], 'the English is only a draft');
  q = autoQueue([{ ...en, stage: 'submitted', display: 'in_review', metaStatus: 'PENDING' }, de], wanted);
  eq(ids(q), [de.id], 'English in review: the translation goes');
  const lone = v({ lang: 'fr', name: 'hf_welcome_offer_7' });
  eq(reasonOf(autoQueue([lone], wanted), lone.id), 'english', 'a French draft with no English of its name');
});

test('one at a time per message × language, never next to an approved template, English sent before others', () => {
  const a = v();
  const b = v({ name: 'hf_welcome_offer_2' });
  let q = autoQueue([a, b], wanted);
  eq([ids(q), reasonOf(q, b.id)], [[a.id], 'cell_busy'], 'two drafts of one cell: the older');
  const inReview = v({ name: 'hf_welcome_offer_3', stage: 'submitted', display: 'in_review', metaStatus: 'PENDING', ai: null, origin: 'manual' });
  q = autoQueue([a, inReview], wanted);
  eq(reasonOf(q, a.id), 'cell_busy', 'another one with Meta');
  const approved = v({ name: 'hf_welcome_offer_4', stage: 'submitted', display: 'approved', metaStatus: 'APPROVED', usable: true, origin: 'manual', ai: null });
  q = autoQueue([a, approved], wanted);
  eq(reasonOf(q, a.id), 'cell_has_approved', 'never next to an approved one');
  const enOther = v({ use: { journeyKey: 'review_ask', poolKey: 'review_ask' }, name: 'hf_review_ask_1' });
  const deDone = v({ lang: 'de', use: { journeyKey: 'review_ask', poolKey: 'review_ask' }, name: 'hf_review_ask_1', ai: { kind: 'translation' } });
  const enDone = { ...enOther, stage: 'submitted' as const, display: 'approved' as const, metaStatus: 'APPROVED', usable: true, id: 'wt_en_ok' };
  q = autoQueue([deDone, enDone, a], wanted);
  eq(ids(q), [a.id, deDone.id], 'English first, then the others');
});

test('an AI fix of a rejected template goes again once (not sent yet); after Meta’s next word it is a new rejection', () => {
  const fixed = v({ stage: 'submitted', display: 'rejected', metaStatus: 'REJECTED', version: 2, metaChangedAtMs: 500, ai: { kind: 'fix', writtenAs: 'new', appliedVersion: 2, fixes: 1, atMs: 1_000 } });
  eq(aiFixUnsent(fixed), true, 'unsent');
  eq(ids(autoQueue([fixed], wanted)), [fixed.id], 'sent again');
  const answered = { ...fixed, metaChangedAtMs: 2_000 };
  eq([aiFixUnsent(answered), ids(autoQueue([answered], wanted))], [false, []], 'Meta answered since: not Auto’s to resend');
  eq(aiFixUnsentOf({ kind: 'fix', appliedVersion: 2, atMs: 1_000 }, 3, 500), false, 'edited by hand since');
  // From W2b: what Meta saw decides, not change times.
  eq(aiFixUnsentOf({ kind: 'fix', appliedVersion: 2, atMs: 1_000, sentVersion: null }, 2, 9_000), true, 'not sent, though Meta changed something since');
  eq(aiFixUnsentOf({ kind: 'fix', appliedVersion: 2, atMs: 1_000, sentVersion: 2 }, 2, 500), false, 'sent (Meta refused it, or it is in review)');
  eq(aiFixUnsentOf({ kind: 'fix', appliedVersion: 2, atMs: 1_000, sentVersion: 1 }, 2, 9_000), true, 'Meta saw the version before the fix');
});

test('AI fixes: a rejected AI template, once per rejection, under the limit, never an alternative or a hand edit', () => {
  const rejected = v({ stage: 'submitted', display: 'rejected', metaStatus: 'REJECTED', metaChangedAtMs: 2_000 });
  eq(autoFixCandidates([rejected], {}).map((x) => x.id), [rejected.id], 'asked');
  eq(autoFixCandidates([rejected], { [rejected.id]: { at: 2_000, tries: 1, retry: false } }).length, 0, 'once for this rejection');
  eq(autoFixCandidates([rejected], { [rejected.id]: { at: 1_500, tries: 3, retry: false } }).length, 1, 'a new rejection: again');
  eq(autoFixCandidates([rejected], { [rejected.id]: { at: 2_000, tries: 1, retry: true } }).length, 1, 'the run ended for a passing reason: again');
  eq(autoFixCandidates([rejected], { [rejected.id]: { at: 2_000, tries: 3, retry: true } }).length, 0, 'but at most 3 tries');
  eq(autoFixCandidates([{ ...rejected, ai: { ...rejected.ai!, fixes: 2 } }], {}).length, 0, 'the AI fixed it twice');
  eq(autoFixCandidates([{ ...rejected, ai: { ...rejected.ai!, writtenAs: 'alternative', kind: 'alternative' } }], {}).length, 0, 'an alternative');
  eq(autoFixCandidates([{ ...rejected, version: 2 }], {}).length, 0, 'edited by hand');
  eq(autoFixCandidates([{ ...rejected, metaStatus: 'PAUSED', display: 'paused' }], {}).length, 0, 'paused: not a fix');
  const unsent = { ...rejected, version: 2, metaChangedAtMs: 500, ai: { ...rejected.ai!, kind: 'fix' as const, appliedVersion: 2, fixes: 1, atMs: 1_000 } };
  eq(autoFixCandidates([unsent], {}).length, 0, 'its fix waits to be sent');
});

test('the submit’s own re-check says why', () => {
  const alt = v({ ai: { kind: 'alternative', writtenAs: 'alternative' } });
  eq(autoMaySend(alt.id, [alt], wanted), { ok: false, reason: 'alternative' }, 'alternative');
  const ok = v();
  eq(autoMaySend(ok.id, [ok], wanted), { ok: true }, 'ok');
  eq(autoMaySend('wt_gone', [ok], wanted), { ok: false, reason: 'not_eligible' }, 'unknown');
});

test('the summary lists what Auto sent and what the AI wrote — and a day with only those still sends', () => {
  const none = { approved: [], waiting: [], inReview: [], problems: [] };
  eq(digestText(none), null, 'nothing');
  const d = digestText({ ...none, autoSent: [{ label: 'hf_x_1 (en)' }], aiWritten: [{ label: 'hf_x_1 (en)', note: 'a first draft' }] });
  assert(d && /1 sent by Auto/.test(d.subject) && /1 written by AI/.test(d.subject), d?.subject ?? 'null');
  assert(/Sent to Meta by Auto \(1\)/.test(d.text) && /Written by the AI \(1\)/.test(d.text), d.text);
  eq(digestText({ ...none, approved: [{ label: 'a' }] })?.subject, 'WhatsApp templates: 1 approved', 'unchanged without them');
});

test('Suggest refuses a second fix while the AI’s fix isn’t sent yet (and doesn’t offer it)', () => {
  const pools = whatsappPools(
    SEED.journeys.map((j) => ({ key: j.header.key, name: j.header.name, availability: j.header.availability ?? 'available', definition: journeyDefinitionSchema.parse(j.definition) })) as never,
    SEED.variants.map((x) => ({ ...x, status: 'active' })) as never,
  );
  const pool = pools.find((p) => p.poolKey === 'welcome_offer')!;
  const t: WriterTemplateView = {
    id: 'wt_r',
    name: 'hf_welcome_offer_1',
    lang: 'en',
    origin: 'ai',
    display: 'rejected',
    dismissed: false,
    version: 2,
    stage: 'submitted',
    metaStatus: 'REJECTED',
    rejectedReason: 'INVALID_FORMAT',
    source: { body: 'Hi {{contact.firstName | default:"there"}}, thanks for visiting {{venue.name}} today, see you again soon.', footer: STOP_LINES.en, button: { text: 'See your offer', field: 'link.offer' } },
    changedAtMs: 0,
    aiFixes: 1,
    dismissedAtMs: null,
    category: 'MARKETING',
    aiFixUnsent: true,
  };
  const r = buildWriterRequest({
    kind: 'fix',
    requestedBy: 'suggest',
    lang: 'en',
    pool,
    templates: [t],
    targetTemplateId: 'wt_r',
    wording: {},
    checkCtx: { visitorBaseUrl: 'https://visit.askheidi.app', optOutKeywords: ['STOP'], footers: STOP_LINES, pool, siblings: [], templateCount: 1, templateLimit: 250, createsThisHour: 0 },
    hasContactData: () => false,
    rejectionWords: () => 'words',
  });
  eq((r as { refuse: string }).refuse, 'fix_unsent', 'refused');
  eq(suggestOptionsFor([t], [t], 'en').map((o) => o.kind), ['alternative'], 'not offered');
  eq(suggestOptionsFor([{ ...t, aiFixUnsent: false }], [t], 'en').map((o) => o.kind), ['fix', 'alternative'], 'once sent and answered');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
