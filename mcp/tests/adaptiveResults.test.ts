/**
 * The Adaptive Campaigns result tools' pure view code (PR D): get_adaptive_results,
 * list_adaptive_messages and explain_adaptive_guest shape the server's answers here, and
 * every tool result is stored by the cms AI — so these check that test runs stay apart,
 * revenue is labelled an estimate, nothing but allow-listed fields passes, addresses are
 * masked, the timeline is capped, and the inputs refuse what the tools can't use.
 *
 * Run: npx tsx tests/adaptiveResults.test.ts   (from captive-server/mcp)
 *
 * It imports only the pure module (the tool file loads firebase through ../shared).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  errorText,
  explainInputSchema,
  explainNoVenueView,
  explainView,
  findBody,
  findPath,
  foundVenues,
  guestPath,
  maskName,
  maskTo,
  messageRowView,
  messagesInputSchema,
  messagesPath,
  messagesView,
  notFoundView,
  pickVenue,
  resultsInputSchema,
  resultsPath,
  resultsView,
  TIMELINE_CAP,
} from '../src/mcp/tools/adaptiveResultsView';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function eq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

type Raw = Record<string, any>;

/** No raw email (a local part with 2+ visible characters) and no run of 4+ digits. */
function assertMasked(text: string, what: string) {
  const emails = text.match(/[^\s"@]+@[^\s"@]+/g) ?? [];
  for (const m of emails) {
    const local = m.slice(0, m.indexOf('@')).replace(/•/g, '');
    assert(local.length <= 1, `${what}: unmasked email ${m}`);
  }
  // ISO dates/times are fine; strip them before looking for number runs.
  const noDates = text.replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g, '');
  assert(!/\d{4,}/.test(noDates), `${what}: a run of 4+ digits survived: ${noDates.match(/\d{4,}/)?.[0]}`);
}

// ── Fixtures (shaped like server/src/adaptive/service/results.ts and guests.ts answers) ──

function cardFixture(over: Raw = {}): Raw {
  return {
    guestsStarted: 42,
    cameBack: 9,
    messages: { total: 51, byChannel: { sms: 20, email: 31 }, service: 12 },
    creditsUsed: { total: 340, byChannel: { sms: 300, email: 40 } },
    estimatedRevenue: { amountMinor: 40500, currency: 'CHF', averageSpendMinor: 4500, basis: 'Guests who came back through a journey × the average spend per visit' },
    visits: { total: 120, first: 80, revisits: 40, captures: 95 },
    stays: { syncedInRange: 0, changed: 0, cancelled: 0, linked: 0, upcoming: null },
    skipped: { weekly_limit: 4 },
    ...over,
  };
}

function zeroCard(): Raw {
  return cardFixture({
    guestsStarted: 0,
    cameBack: 0,
    messages: { total: 0, byChannel: {}, service: 0 },
    creditsUsed: { total: 0, byChannel: {} },
    estimatedRevenue: null,
    visits: { total: 0, first: 0, revisits: 0, captures: 0 },
    skipped: {},
  });
}

function resultsFixture(venue: Raw = {}): Raw {
  return {
    ok: true,
    range: { from: '2026-08-27', to: '2026-09-25' },
    venues: [
      {
        venueId: 'venue_1',
        name: 'Indian Gourmet',
        timezone: 'Europe/Zurich',
        card: cardFixture(),
        testRun: cardFixture({
          guestsStarted: 7,
          cameBack: 2,
          messages: { total: 11, byChannel: { sms: 11 }, service: 0 },
          creditsUsed: { total: 165, byChannel: { sms: 165 } },
          visits: { total: 0, first: 0, revisits: 0, captures: 0 },
          skipped: {},
        }),
        waitingForCredits: { waiting: false, lowBalance: false, startedWaitingLast72h: 0 },
        journeys: [
          {
            journeyKey: 'welcome_back',
            name: 'Welcome → come back',
            returnVisit: true,
            live: { entered: 30, converted: 9, sends: { sms: { sent: 20, delivered: 19 } }, credits: { sms: 300 }, bySlot: { now: { sent: 20 } }, skipped: { quiet_hours: 2 } },
            testRun: { entered: 3, sends: { sms: { sent: 3 } } },
          },
        ],
        ...venue,
      },
    ],
  };
}

// ── get_adaptive_results ─────────────────────────────────────────────────────

test('results: live numbers come from the card; test run is a separate, labelled block', () => {
  const out = resultsView(resultsFixture());
  const v = out.venues[0] as Raw;
  eq(v.guestsStarted, 42, 'guestsStarted');
  eq(v.cameBack, 9, 'cameBack');
  eq(v.messages, { total: 51, byChannel: { sms: 20, email: 31 }, freeInfoMessages: 12 }, 'messages');
  eq(v.creditsUsed, { total: 340, byChannel: { sms: 300, email: 40 } }, 'creditsUsed');
  eq(v.visits, { total: 120, firstVisits: 80, returnVisits: 40, captures: 95 }, 'visits');
  assert(v.testRun && /nothing was sent or charged/i.test(v.testRun.label), 'test run must say nothing was sent or charged');
  eq(v.testRun.guestsStarted, 7, 'testRun.guestsStarted');
  eq(v.testRun.messagesWouldHaveSent.total, 11, 'testRun messages');
  eq(v.testRun.creditsWouldHaveUsed, 165, 'testRun credits');
  assert(!('estimatedRevenue' in v.testRun), 'no revenue estimate for a test run');
  eq(out.period, { from: '2026-08-27', to: '2026-09-25' }, 'period');
  assert(/15 minutes/.test(out.freshness), 'freshness says ~15 minutes');
});

test('results: a test run with nothing in it is null, not zeros', () => {
  const out = resultsView(resultsFixture({ testRun: zeroCard() }));
  eq((out.venues[0] as Raw).testRun, null, 'testRun');
});

test('results: revenue is labelled an estimate with its basis', () => {
  const v = resultsView(resultsFixture()).venues[0] as Raw;
  const r = v.estimatedRevenue;
  assert(r && r.estimate === true, 'estimate flag');
  eq(r.amount, 'CHF 405.00', 'amount');
  eq(r.amountMinor, 40500, 'amountMinor');
  assert(/estimate/i.test(r.basis) && /9 guests who came back/.test(r.basis) && /CHF 45\.00/.test(r.basis) && /average spend/.test(r.basis), `basis: ${r.basis}`);
});

test('results: no average spend → revenue null with a reason', () => {
  const v = resultsView(resultsFixture({ card: cardFixture({ estimatedRevenue: null }) })).venues[0] as Raw;
  eq(v.estimatedRevenue, null, 'estimatedRevenue');
  assert(typeof v.estimatedRevenueNote === 'string' && /average spend/.test(v.estimatedRevenueNote), 'note says why');
});

test('results: per journey only when asked; bySlot never passes', () => {
  const without = resultsView(resultsFixture()).venues[0] as Raw;
  assert(!('journeys' in without), 'no journeys without byJourney');
  const withJ = resultsView(resultsFixture(), { byJourney: true }).venues[0] as Raw;
  const j = withJ.journeys[0];
  eq(j.started, 30, 'journey started');
  eq(j.reachedGoal, 9, 'journey reachedGoal');
  eq(j.messages, { total: 20, byChannel: { sms: 20 } }, 'journey messages');
  eq(j.creditsUsed, 300, 'journey credits');
  eq(j.testRun.started, 3, 'journey testRun');
  assert(!JSON.stringify(j).includes('bySlot'), 'bySlot must not pass');
});

test('results: stays synced as two numbers, null when there is no calendar', () => {
  const none = resultsView(resultsFixture()).venues[0] as Raw;
  eq(none.staysSynced, null, 'no calendar');
  const some = resultsView(resultsFixture({ card: cardFixture({ stays: { syncedInRange: 4, upcoming: 3 } }) })).venues[0] as Raw;
  eq(some.staysSynced, { createdInRange: 4, upcoming: 3 }, 'staysSynced');
});

test('results: each venue has its own period; the shared one is null when venues differ', () => {
  const zurich = { range: { from: '2026-08-28', to: '2026-09-26' } };
  const out = resultsView({ ...resultsFixture(zurich), range: null, rangesDiffer: true });
  eq(out.period, null, 'no shared period');
  eq((out.venues[0] as Raw).period, { from: '2026-08-28', to: '2026-09-26' }, 'the venue period');
  eq((resultsView(resultsFixture()).venues[0] as Raw).period, null, 'a server without per-venue ranges → null');
});

test('results: waiting for credits — messages waiting now, and "N+" when the count was cut off', () => {
  const v = resultsView(resultsFixture({ waitingForCredits: { waiting: true, lowBalance: false, messagesWaiting: 3, startedWaitingLast72h: 1000, startedWaitingLast72hTruncated: true } })).venues[0] as Raw;
  eq(v.waitingForCredits, { waiting: true, balanceTooLow: false, messagesWaiting: 3, startedWaitingLast72h: '1000+' }, 'waitingForCredits');
  const exact = resultsView(resultsFixture({ waitingForCredits: { waiting: false, lowBalance: false, messagesWaiting: 0, startedWaitingLast72h: 2 } })).venues[0] as Raw;
  eq(exact.waitingForCredits.startedWaitingLast72h, 2, 'an exact count stays a number');
  const many = resultsView(resultsFixture({ waitingForCredits: { waiting: true, lowBalance: true, messagesWaiting: 500, messagesWaitingTruncated: true, startedWaitingLast72h: 3 } })).venues[0] as Raw;
  eq(many.waitingForCredits.messagesWaiting, '500+', 'a cut-off count of waiting messages');
  const unread = resultsView(resultsFixture({ waitingForCredits: { waiting: true, lowBalance: false, messagesWaiting: 0, messagesWaitingUnknown: true, startedWaitingLast72h: 0 } })).venues[0] as Raw;
  eq(unread.waitingForCredits.messagesWaiting, 'unknown', 'a count that could not be read');
});

test('results: no Adaptive venue → an empty list with a note', () => {
  const out = resultsView({ ok: true, range: null, venues: [] }, { venueId: 'venue_9' });
  eq(out.count, 0, 'count');
  eq(out.period, null, 'period');
  assert(typeof (out as Raw).note === 'string', 'note');
});

// ── list_adaptive_messages ───────────────────────────────────────────────────

const MESSAGE_KEYS = ['at', 'outcome', 'testRun', 'journey', 'channel', 'status', 'credits', 'to', 'guest', 'contactId', 'reason'];

test('messages: only allow-listed fields pass, never a body', () => {
  const row = messageRowView({
    at: '2026-09-24T10:56:00.000Z',
    type: 'message.sent',
    mode: 'live',
    journeyKey: 'welcome_back',
    journeyName: 'Welcome → come back',
    channel: 'sms',
    status: 'delivered',
    credits: 15,
    to: '+49 ••• ••• 321',
    contactId: 'tenant_x_9f2a',
    guest: 'Anna M.',
    line: 'Sent by SMS (15 credits).',
    body: 'SECRET BODY 10% off with code WELCOME',
    content: { preview: 'SECRET PREVIEW', subject: 'SECRET SUBJECT' },
    preview: 'SECRET PREVIEW',
    text: 'SECRET TEXT',
    html: '<p>SECRET</p>',
    errorMessage: 'Twilio: +4915112345678 is not reachable',
    detail: { wifiPassword: 'SECRET-WIFI' },
  });
  eq(Object.keys(row), MESSAGE_KEYS, 'row keys');
  assert(!/SECRET|Twilio|wifi/i.test(JSON.stringify(row)), `leak: ${JSON.stringify(row)}`);
  eq(row.outcome, 'sent', 'outcome');
  eq(row.to, '+49 ••• ••• 321', 'already masked passes unchanged');
  eq(row.reason, 'Sent by SMS (15 credits).', 'reason');
});

test('messages: a raw address, name or number in the input comes out masked', () => {
  const email = messageRowView({ type: 'message.failed', to: 'anna.mueller@example.com', guest: 'Anna Müller', line: 'Tried anna.mueller@example.com and +41791234567; it did not go through.' });
  eq(email.to, 'a••••••@example.com', 'email masked');
  eq(email.guest, 'Anna M.', 'name shortened');
  assertMasked(JSON.stringify(email), 'email row');
  const phone = messageRowView({ type: 'message.sent', to: '+41791234567' });
  eq(phone.to, '+41 ••• ••• 567', 'phone masked');
  eq(maskTo('a••••••@gmail.com'), 'a••••••@gmail.com', 'masked email unchanged');
  eq(maskName('Anna M.'), 'Anna M.', 'short name unchanged');
});

test('messages: outcomes in words, test runs flagged, paging hint', () => {
  const out = messagesView(
    {
      ok: true,
      messages: [
        { type: 'send.dry_run', mode: 'test', line: 'Test run: would have sent by SMS (15 credits) — nothing was sent.' },
        { type: 'send.deferred', mode: 'live', line: 'Held back until Tue 09:07 because it was quiet hours.' },
        { type: 'send.skipped', mode: 'live', line: 'Not sent because the guest already got the most marketing messages allowed this week.' },
      ],
      nextCursor: 'abc123',
    },
    { venueId: 'venue_1' },
  );
  eq(out.messages.map((m) => m.outcome), ['test run (not sent)', 'held back', 'not sent'], 'outcomes');
  eq(out.messages.map((m) => m.testRun), [true, false, false], 'testRun flags');
  eq(out.nextCursor, 'abc123', 'nextCursor');
  eq(out.days, 7, 'default days');
  assert('more' in out, 'paging hint');
});

// ── explain_adaptive_guest ───────────────────────────────────────────────────

const findFixture: Raw = {
  ok: true,
  contactId: 'tenant_x_9f2a',
  guest: { name: 'Anna M.', email: 'a••••••@gmail.com', phone: '+49 ••• ••• 321' },
  venues: [
    { venueId: 'venue_old', lastVisitAt: '2026-08-01T10:00:00.000Z' },
    { venueId: 'venue_new', lastVisitAt: '2026-09-20T10:00:00.000Z' },
  ],
};

function guestFixture(lines: number, over: Raw = {}): Raw {
  const timeline = Array.from({ length: lines }, (_, i) => ({
    at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    kind: 'message.sent',
    venueId: 'venue_new',
    venueName: 'Indian Gourmet',
    journeyKey: 'welcome_back',
    sentence: `Line ${i}.`,
    mode: 'live',
    channel: 'sms',
    credits: 15,
    detail: { preview: 'SECRET BODY' },
  }));
  return {
    ok: true,
    contactId: 'tenant_x_9f2a',
    guest: { name: 'Anna M.', email: 'a••••••@gmail.com', phone: null, lang: 'de' },
    venue: { venueId: 'venue_new', firstVisitAt: '2026-09-01T10:00:00.000Z', lastVisitAt: '2026-09-20T10:00:00.000Z', visitCount: 3, consent: { sms: { state: 'yes', ownerStopped: false }, email: { state: 'no', ownerStopped: true }, whatsapp: { state: 'none', ownerStopped: false } }, lowRating: false },
    journeys: [{ journeyKey: 'welcome_back', name: 'Welcome → come back', venueId: 'venue_new', venueName: 'Indian Gourmet', status: 'active', mode: 'live', startedAt: '2026-09-01T10:00:00.000Z', endedAt: null, exitReason: null, nextAt: '2026-09-26T07:00:00.000Z' }],
    stays: [],
    creditsUsed: 30,
    timeline: timeline.reverse(), // newest first, like the server
    truncated: false,
    ...over,
  };
}

test('explain: timeline capped at 40, newest first, truncated flagged', () => {
  const shuffled = guestFixture(60);
  shuffled.timeline = [...shuffled.timeline.slice(30), ...shuffled.timeline.slice(0, 30)];
  const out = explainView(findFixture, shuffled, 'venue_new');
  eq(out.timeline.length, TIMELINE_CAP, 'cap');
  eq(out.timeline[0].sentence, 'Line 59.', 'newest first');
  eq(out.timeline[TIMELINE_CAP - 1].sentence, 'Line 20.', 'oldest kept');
  eq(out.timelineTruncated, true, 'truncated');
  assert(typeof (out as Raw).timelineNote === 'string', 'says it was cut');
});

test("explain: the server's own truncated flag carries through; short timelines aren't flagged", () => {
  eq(explainView(findFixture, guestFixture(5, { truncated: true }), 'venue_new').timelineTruncated, true, 'server truncated');
  const short = explainView(findFixture, guestFixture(5), 'venue_new');
  eq(short.timelineTruncated, false, 'not truncated');
  assert(!('timelineNote' in short), 'no note');
});

test('explain: only at / venueName / journey / sentence pass; non-sentences are dropped', () => {
  const g = guestFixture(2);
  g.timeline.push({ at: '2026-09-02T00:00:00.000Z', kind: 'send.skipped', sentence: { html: 'SECRET' } });
  g.timeline.push({ at: '2026-09-02T00:00:00.000Z', kind: 'send.skipped', sentence: '' });
  g.timeline.push({ at: '2026-09-02T00:00:00.000Z', kind: 'send.skipped' });
  g.timeline.push({ at: '2026-09-02T00:00:00.000Z', venueName: 'Indian Gourmet', sentence: 'Sent to anna.mueller@example.com.', body: 'SECRET BODY', errorMessage: 'SECRET' });
  const out = explainView(findFixture, g, 'venue_new');
  eq(out.timeline.length, 3, 'three plain sentences');
  for (const line of out.timeline) eq(Object.keys(line), ['at', 'venueName', 'journey', 'sentence'], 'line keys');
  eq(out.timeline.find((l) => l.journey)?.journey, 'Welcome → come back', 'journey key → name');
  const text = JSON.stringify(out);
  assert(!/SECRET/.test(text), `leak: ${text}`);
  assertMasked(text, 'explain output');
});

test('explain: masked guest, consent in words, journeys, other venues', () => {
  const out = explainView(findFixture, guestFixture(3), 'venue_new');
  eq(out.guest, { name: 'Anna M.', email: 'a••••••@gmail.com', phone: null, language: 'de' }, 'guest');
  eq(out.venue.name, 'Indian Gourmet', 'venue name');
  eq(out.venue.marketingConsent, { sms: 'yes', email: 'no (you stopped marketing)', whatsapp: 'no answer' }, 'consent');
  eq(out.journeys[0].nextStepAt, '2026-09-26T07:00:00.000Z', 'next step');
  eq(out.otherVenues.map((v) => v.venueId), ['venue_old'], 'other venues');
  eq(out.creditsUsed, 30, 'credits');
});

test('explain: picks the requested venue, else the most recent; says so when none fits', () => {
  const venues = foundVenues(findFixture);
  eq(pickVenue(undefined, venues), { venueId: 'venue_new' }, 'most recent');
  eq(pickVenue('venue_old', venues), { venueId: 'venue_old' }, 'requested');
  assert('none' in pickVenue('venue_other', venues), 'not seen there');
  assert('none' in pickVenue(undefined, []), 'no venues');
  const noVenue = explainNoVenueView({ ...findFixture, venues: [] }, 'x');
  eq(noVenue.found, true, 'still found');
});

test('explain: not found never echoes the lookup', () => {
  const text = JSON.stringify(notFoundView());
  assert(!text.includes('@') && !/\d{4,}/.test(text), 'no address in not-found');
  eq(notFoundView().found, false, 'found false');
});

// ── Inputs and paths ─────────────────────────────────────────────────────────

test('list_adaptive_messages input: venueId is required; bounds hold', () => {
  assert(!messagesInputSchema.safeParse({}).success, 'missing venueId must fail');
  assert(!messagesInputSchema.safeParse({ kind: 'sends' }).success, 'missing venueId must fail with other fields');
  assert(messagesInputSchema.safeParse({ venueId: 'venue_1' }).success, 'venueId alone is fine');
  assert(!messagesInputSchema.safeParse({ venueId: 'venue_1', limit: 51 }).success, 'limit > 50 fails');
  assert(!messagesInputSchema.safeParse({ venueId: 'venue_1', days: 93 }).success, 'days > 92 fails');
  assert(!messagesInputSchema.safeParse({ venueId: 'venue_1', days: 0 }).success, 'days < 1 fails');
  assert(!messagesInputSchema.safeParse({ venueId: '../admin/engine' }).success, 'a path in venueId fails');
});

test('explain_adaptive_guest input: an empty request is refused', () => {
  assert(!explainInputSchema.safeParse({}).success, 'empty must fail');
  assert(!explainInputSchema.safeParse({ venueId: 'venue_1', lang: 'de' }).success, 'venue + lang only must fail');
  assert(explainInputSchema.safeParse({ email: 'anna@example.com' }).success, 'email is enough');
  assert(explainInputSchema.safeParse({ contactId: 'tenant_x_9f2a' }).success, 'contactId is enough');
  assert(!explainInputSchema.safeParse({ contactId: 'a/b' }).success, 'a path in contactId fails');
  assert(!explainInputSchema.safeParse({ email: 'x@y.co', lang: 'it' }).success, 'lang is en or de');
});

test('get_adaptive_results input: dates must be YYYY-MM-DD', () => {
  assert(resultsInputSchema.safeParse({}).success, 'all optional');
  assert(!resultsInputSchema.safeParse({ from: '25.09.2026' }).success, 'bad date fails');
});

test('paths: tenant only in the path segment, never /admin, addresses only in the POST body', () => {
  const t = 'tenant/x';
  const r = resultsPath(t, { venueId: 'venue_1', from: '2026-09-01', to: '2026-09-25', byJourney: true });
  eq(r, '/internal/adaptive/tenants/tenant%2Fx/results?venueId=venue_1&from=2026-09-01&to=2026-09-25&journeys=1', 'results path');
  eq(resultsPath('t1', {}), '/internal/adaptive/tenants/t1/results', 'results path, no query');
  eq(messagesPath('t1', { venueId: 'venue_1', kind: 'skips', limit: 10 }), '/internal/adaptive/tenants/t1/venues/venue_1/messages?kind=skips&days=7&limit=10&lang=en', 'messages path');
  eq(guestPath('t1', 'venue_1', 'tenant_x_9f2a', 'de'), '/internal/adaptive/tenants/t1/venues/venue_1/guests/tenant_x_9f2a?lang=de', 'guest path');
  eq(findPath('t1'), '/internal/adaptive/tenants/t1/guests/find', 'find path');
  for (const p of [r, findPath('t1')]) assert(!p.includes('/admin'), `admin path: ${p}`);
  let threw = false;
  try {
    guestPath('t1', 'venue_1', '../../admin/engine', 'en');
  } catch {
    threw = true;
  }
  assert(threw, 'a bad contactId never becomes a path');
  eq(findBody({ email: ' anna@example.com ', venueId: 'venue_1', lang: 'de' } as never), { email: 'anna@example.com' }, 'find body');
});

test('errors: 403 is the usual venue sentence; server words are kept short and masked', () => {
  eq(errorText(403, { ok: false, error: 'Venue v was not found in this account', code: 'forbidden' }), 'Venue not found or not owned by this account.', '403');
  eq(errorText(400, { ok: false, error: 'At most 92 days at a time', code: 'bad_request' }), 'At most 92 days at a time', '400');
  assertMasked(errorText(500, { error: 'failed for anna.mueller@example.com' }), 'error text');
  eq(errorText(502, {}), 'Adaptive Campaigns request failed (502)', 'fallback');
});

test('the view module stays pure (no firebase, no ../shared)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'mcp', 'tools', 'adaptiveResultsView.ts'), 'utf8');
  const imports = src.match(/^import .* from ['"][^'"]+['"];?$/gm) ?? [];
  eq(imports.map((l) => l.replace(/.* from ['"]([^'"]+)['"];?$/, '$1')), ['zod'], 'imports');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
