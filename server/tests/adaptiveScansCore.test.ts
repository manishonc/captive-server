/**
 * Scan journeys, the pure parts (PR S): the Swiss holiday calendar, slow-time detection, the
 * occasion keys, scan triggers and entry keys, the revisit goal, the `holidays` blank, the
 * runnable-version rule, the v2 journeys in the interpreter, and the seed's version step rule.
 *
 * Run: npx tsx tests/adaptiveScansCore.test.ts   (from captive-server/server)
 */

import { DEFAULT_HOLIDAYS_VALUE, addDays, easterSunday, holidaysDue, holidaysOf, parseHolidayKeys, unknownHolidayKeys } from '../src/adaptive/core/scans/holidays';
import { daypartOfHour, findSlowTimes, inviteTriggerAt, isoWeekKey, slowWhenText, type VisitRow } from '../src/adaptive/core/scans/dayparts';
import {
  SCAN_EVENT,
  dayText,
  occasionKey,
  occasionMergeValues,
  occasionVars,
  scanJourneyRunnable,
  winbackWindow,
} from '../src/adaptive/core/scans/occasions';
import { entryKeyFor, triggerMatches } from '../src/adaptive/core/runtime/triggers';
import { goalMatches, step, type InterpreterContext } from '../src/adaptive/core/runtime/interpreter';
import { freshState, type EngineEvent, type InstanceState } from '../src/adaptive/core/runtime/types';
import { DAY_MS, localParts, zonedTime } from '../src/adaptive/core/runtime/time';
import { checkSlotValue } from '../src/adaptive/core/registry';
import { journeyDefinitionSchema, type Offer, slotDefSchema } from '../src/adaptive/core/schemas';
import { holidaysV2, slowTimeFillerV2, winBackV2, birthdayV2 } from '../src/adaptive/seed/definitions/journeysRestaurantV2';
import { buildSeedPlan, versionDecision } from '../src/adaptive/seed/buildSeed';
import { renderText } from '../src/adaptive/core/render';
import { renderValues } from '../src/adaptive/engine/renderSend';
import { VARIANTS_SCAN } from '../src/adaptive/seed/definitions/variantsScan';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const ZRH = 'Europe/Zurich';
const at = (y: number, m: number, d: number, h = 3, min = 0) => zonedTime(y, m, d, h, min, ZRH).getTime();

const OFFERS: Offer[] = [
  { offerKey: 'ten_pct', name: '10% off', label: { en: '10% off your next visit', de: '10% Rabatt auf deinen nächsten Besuch' }, kind: 'percent', value: 10, expiryDays: 14 },
  { offerKey: 'fifteen_pct', name: '15% off', label: { en: '15% off your next visit', de: '15% Rabatt auf deinen nächsten Besuch' }, kind: 'percent', value: 15, expiryDays: 14 },
  { offerKey: 'twenty_pct', name: '20% off', label: { en: '20% off your next visit', de: '20% Rabatt auf deinen nächsten Besuch' }, kind: 'percent', value: 20, expiryDays: 14 },
  { offerKey: 'coffee', name: 'Free coffee', label: { en: 'a free coffee', de: 'ein Gratis-Kaffee' }, kind: 'free_item', value: 0, expiryDays: 7 },
];

function interp(def: unknown, now: number, slots: Record<string, unknown>): InterpreterContext {
  return { now, definition: journeyDefinitionSchema.parse(def), venueTz: ZRH, slots: slots as never, offers: OFFERS, facts: () => undefined, stay: null };
}

function scanEvent(journeyKey: string, trigger: string, occasion: string, data: Record<string, unknown> = {}): EngineEvent {
  return { id: 'ev_scan', type: SCAN_EVENT, occurredAt: at(2026, 10, 12), venueId: 'v', contactId: 'c', data: { journeyKey, trigger, occasion, ...data } };
}

async function main() {
  console.log('\nHoliday calendar');
  await test('Easter, Mother’s Day and Father’s Day move with the year; the fixed days don’t', () => {
    assertEqual(easterSunday(2024), { month: 3, day: 31 }, 'Easter 2024');
    assertEqual(easterSunday(2025), { month: 4, day: 20 }, 'Easter 2025');
    assertEqual(easterSunday(2026), { month: 4, day: 5 }, 'Easter 2026');
    assertEqual(easterSunday(2027), { month: 3, day: 28 }, 'Easter 2027');
    const y2026 = Object.fromEntries(holidaysOf(2026).map((h) => [h.key, h.date]));
    assertEqual(y2026, {
      valentines: '2026-02-14',
      easter: '2026-04-05',
      mothers_day: '2026-05-10',
      fathers_day: '2026-06-07',
      national_day: '2026-08-01',
      christmas_eve: '2026-12-24',
      christmas: '2026-12-25',
      new_years_eve: '2026-12-31',
    }, '2026');
    assertEqual(holidaysOf(2027).find((h) => h.key === 'mothers_day')!.date, '2027-05-09', 'Mother’s Day 2027');
  });

  await test('a holiday is due from 7 days before until 5 (catch-up), across the year end', () => {
    const picks = ['christmas_eve', 'christmas', 'new_years_eve', 'valentines'];
    assertEqual(holidaysDue('2026-12-16', picks, 7, 2).map((h) => h.key), [], '8 days before: not yet');
    assertEqual(holidaysDue('2026-12-17', picks, 7, 2).map((h) => h.key), ['christmas_eve'], '7 days before Christmas Eve');
    assertEqual(holidaysDue('2026-12-18', picks, 7, 2).map((h) => h.key), ['christmas_eve', 'christmas'], 'a caught-up day');
    assertEqual(holidaysDue('2026-12-20', picks, 7, 2).map((h) => h.key), ['christmas'], '4 days before Christmas Eve: too close');
    assertEqual(holidaysDue('2026-12-25', picks, 7, 2).map((h) => `${h.key}@${h.date}`), ['new_years_eve@2026-12-31'], 'New Year’s Eve');
    assertEqual(holidaysDue('2027-02-07', picks, 7, 2).map((h) => `${h.key}@${h.date}`), ['valentines@2027-02-14'], 'next year’s Valentine’s');
    assertEqual(holidaysDue('2026-12-17', [], 7, 2), [], 'nothing picked');
  });

  await test('the holidays blank: known keys in calendar order, unknown ones refused', () => {
    assertEqual(parseHolidayKeys('new_years_eve, valentines ,nope'), ['valentines', 'new_years_eve'], 'parsed');
    assertEqual(parseHolidayKeys(42), [], 'not a string');
    assertEqual(unknownHolidayKeys('valentines,nope'), ['nope'], 'unknown');
    const def = slotDefSchema.parse({ type: 'holidays', label: { en: 'Which days' }, required: true, default: DEFAULT_HOLIDAYS_VALUE });
    assertEqual(checkSlotValue(def, DEFAULT_HOLIDAYS_VALUE, { offers: [] }), null, 'the default fits');
    assertEqual(checkSlotValue(def, '', { offers: [] }), 'is required', 'empty');
    assert(checkSlotValue(def, 'valentines,nope', { offers: [] })?.includes('nope'), 'an unknown day');
    assertEqual(checkSlotValue(def, 7 as never, { offers: [] }), 'must be a list of holidays', 'a number');
  });

  console.log('\nSlow times');
  // Monday 12 Oct 2026, 03:00 Zurich: the scan.
  const MONDAY = at(2026, 10, 12, 3);
  const visitsAt = (weeksBack: number, weekday: number, hour: number, n: number, guest: (i: number) => string): VisitRow[] => {
    // weekday 1 = Monday … 7 = Sunday of the week `weeksBack` weeks before this Monday.
    const base = MONDAY - weeksBack * 7 * DAY_MS + (weekday - 1) * DAY_MS;
    const p = localParts(new Date(base), ZRH);
    return Array.from({ length: n }, (_, i) => ({ contactId: guest(i), startedAt: zonedTime(p.year, p.month, p.day, hour, 10 + i, ZRH).getTime() }));
  };

  await test('dayparts by local hour (midnight to 06:00 isn’t counted)', () => {
    assertEqual([3, 6, 10, 11, 13, 14, 17, 20, 21, 23].map(daypartOfHour), [null, 'morning', 'morning', 'lunch', 'lunch', 'afternoon', 'evening', 'evening', 'late', 'late'], 'dayparts');
  });

  await test('the 2 slowest open times; a time with nobody most weeks counts as closed; recent guests aren’t invited', () => {
    const visits: VisitRow[] = [];
    for (let w = 1; w <= 8; w += 1) {
      visits.push(...visitsAt(w, 1, 12, 6, (i) => `lunch_mon_${w}_${i}`)); // Monday lunch: busy
      visits.push(...visitsAt(w, 2, 15, 1, () => `tue_pm_${w % 3}`)); // Tuesday afternoon: 1 a week, 3 regulars
      visits.push(...visitsAt(w, 4, 19, 2, (i) => `thu_eve_${i}`)); // Thursday evening: 2 a week
      if (w <= 4) visits.push(...visitsAt(w, 5, 12, 3, (i) => `fri_lunch_${i}`)); // Friday lunch: 4 of 8 weeks (open)
    }
    visits.push(...visitsAt(3, 3, 9, 1, () => 'wed_morning')); // Wednesday morning: 1 week only (closed)
    // tue_pm_1 was here 2 days ago: not invited.
    const recent = new Map([['tue_pm_1', MONDAY - 2 * DAY_MS]]);
    const r = findSlowTimes(visits, MONDAY, ZRH, undefined, recent);
    assert(r.kind === 'targets', `targets: ${JSON.stringify(r)}`);
    // Friday lunch had guests in 4 of the 8 weeks (open) and 12 visits: slower than Thursday evening (16).
    assertEqual(r.targets.map((t) => `${t.weekday}:${t.daypart}:${t.date}:${t.visits}`), ['2:afternoon:2026-10-13:8', '5:lunch:2026-10-16:12'], 'the two slowest');
    const invited = r.invites.map((i) => `${i.contactId}→${i.target.weekday}`).sort();
    // Lunch guests of any weekday are invited to Friday lunch (Monday lunch's too), the Tuesday regulars to Tuesday.
    assert(invited.includes('lunch_mon_2_0→5'), `lunch guests: ${invited.slice(0, 5)}`);
    // The Friday-lunch guests were here last Friday (under 3 days ago): not invited.
    assert(!invited.some((i) => i.startsWith('fri_lunch')), 'recent Friday guests');
    assertEqual(invited.filter((i) => i.startsWith('tue_pm')), ['tue_pm_0→2', 'tue_pm_2→2'], 'Tuesday regulars, not the one seen 2 days ago');
    assert(!invited.some((i) => i.startsWith('thu_eve') || i.startsWith('wed_morning')), 'no evening or closed-time guests');
  });

  await test('not enough data: under 4 weeks or under 40 visits waits', () => {
    const few = [...visitsAt(1, 1, 12, 30, (i) => `g${i}`), ...visitsAt(2, 1, 12, 20, (i) => `h${i}`)];
    assertEqual(findSlowTimes(few, MONDAY, ZRH).kind, 'not_enough_data', '2 weeks');
    const thin: VisitRow[] = [];
    for (let w = 1; w <= 8; w += 1) thin.push(...visitsAt(w, 2, 15, 2, (i) => `t${i}`));
    assertEqual(findSlowTimes(thin, MONDAY, ZRH).kind, 'not_enough_data', '16 visits');
  });

  await test('a morning slow time today can’t be announced the evening before; a later one is', () => {
    const visits: VisitRow[] = [];
    for (let w = 1; w <= 8; w += 1) {
      visits.push(...visitsAt(w, 1, 8, 1, () => `mon_am_${w}`)); // Monday morning: the slowest, but today
      visits.push(...visitsAt(w, 1, 12, 5, (i) => `mon_lunch_${i}`));
      visits.push(...visitsAt(w, 3, 9, 2, (i) => `wed_am_${i}`));
    }
    const r = findSlowTimes(visits, MONDAY, ZRH);
    assert(r.kind === 'targets', 'targets');
    assertEqual(r.targets.map((t) => `${t.weekday}:${t.daypart}`), ['3:morning', '1:lunch'], 'Monday morning passed over');
    const wed = r.targets[0];
    assertEqual(new Date(inviteTriggerAt(wed, ZRH)).toISOString(), new Date(at(2026, 10, 13, 16)).toISOString(), 'a morning invite: 16:00 the day before');
    assertEqual(new Date(inviteTriggerAt(r.targets[1], ZRH)).toISOString(), new Date(at(2026, 10, 12, 7)).toISOString(), 'lunch: 07:00 that day');
  });

  await test('ISO weeks and the slow-time words', () => {
    assertEqual(isoWeekKey('2026-10-12'), '2026-W42', 'a Monday');
    assertEqual(isoWeekKey('2026-10-18'), '2026-W42', 'its Sunday');
    assertEqual(isoWeekKey('2027-01-01'), '2026-W53', 'new year in the old week');
    assertEqual(slowWhenText(2, 'afternoon', 'en'), 'this Tuesday afternoon', 'EN');
    assertEqual(slowWhenText(2, 'afternoon', 'de'), 'diesen Dienstagnachmittag', 'DE');
    assertEqual(slowWhenText(5, 'lunch', 'en'), 'this Friday at lunchtime', 'EN lunch');
    assertEqual(slowWhenText(5, 'lunch', 'fr'), 'this Friday at lunchtime', 'FR reads the English');
  });

  console.log('\nOccasions, triggers, entry keys');
  await test('occasion keys: one start per guest and occasion; stages never collide', () => {
    const last = at(2026, 9, 12, 19);
    assertEqual(occasionKey({ kind: 'winback', days: 30, lastVisitAt: last }), `winback:30:${last}`, 'win-back 30');
    assert(occasionKey({ kind: 'winback', days: 30, lastVisitAt: last }) !== occasionKey({ kind: 'winback', days: 60, lastVisitAt: last }), 'stages differ');
    assertEqual(occasionKey({ kind: 'birthday', year: 2026, month: 3 }), 'birthday:2026', 'birthday: once a year');
    assertEqual(occasionKey({ kind: 'holiday', holidayKey: 'christmas_eve', date: '2026-12-24' }), 'holiday:christmas_eve:2026', 'holiday');
    assertEqual(occasionKey({ kind: 'slow', week: '2026-W42', weekday: 2, daypart: 'afternoon', date: '2026-10-13' }), 'slow:2026-W42', 'slow: once a week');
    assertEqual(occasionVars({ kind: 'winback', days: 60, lastVisitAt: last }), { occasionKind: 'winback', winbackDays: 60, lastVisitAt: last }, 'vars');
  });

  await test('a scan event starts only the journey and trigger it names; its occasion is the entry key', () => {
    const e = scanEvent('win_back', 'days_since_visit', 'winback:30:1');
    assert(triggerMatches({ type: 'days_since_visit', config: { days: [30, 60, 90] } }, e, 'win_back'), 'matches');
    assert(!triggerMatches({ type: 'days_since_visit', config: { days: [30, 60, 90] } }, e, 'birthday'), 'another journey');
    assert(!triggerMatches({ type: 'date_field', config: { field: 'birthdayMonth' } }, e, 'win_back'), 'another trigger');
    assert(!triggerMatches({ type: 'days_since_visit', config: { days: [30] } }, { ...e, type: 'visit.started' }, 'win_back'), 'not a scan event');
    assertEqual(entryKeyFor('after_exit', e), 'winback:30:1', 'after_exit');
    assertEqual(entryKeyFor('cooldown', e), 'winback:30:1', 'cooldown');
    assertEqual(entryKeyFor('never', e), 'once', 'never');
    assertEqual(entryKeyFor('after_exit', { ...e, type: 'visit.started', data: { visitId: 'vi_1' } }), 'visit:vi_1', 'other events unchanged');
  });

  await test('a revisit reaches a visit.revisit goal; a first visit or another event doesn’t', () => {
    const visit = (isRevisit: boolean): EngineEvent => ({ id: 'e', type: 'visit.started', occurredAt: 0, venueId: 'v', contactId: 'c', data: { isRevisit } });
    assert(goalMatches('visit.revisit', visit(true)), 'revisit');
    assert(!goalMatches('visit.revisit', visit(false)), 'first visit');
    assert(goalMatches('offer.redeemed', { ...visit(true), type: 'offer.redeemed' }), 'its own type');
    assert(!goalMatches('offer.redeemed', visit(true)), 'a visit isn’t a redemption');
  });

  await test('v1 of the four scan journeys never runs; v2 and other journeys do', () => {
    for (const k of ['win_back', 'birthday', 'quiet_hours_filler', 'holidays']) {
      assert(!scanJourneyRunnable(k, 1), `${k} v1`);
      assert(scanJourneyRunnable(k, 2), `${k} v2`);
    }
    assert(scanJourneyRunnable('welcome_second_visit', 1), 'other journeys');
    assert(scanJourneyRunnable('some_new_scan', 1), 'later journeys have no floor');
  });

  await test('win-back window: the stage’s day and a 2-day catch-up', () => {
    assertEqual(winbackWindow('2026-10-12', 30, 2), { fromDate: '2026-09-10', toDate: '2026-09-12' }, '30');
    assertEqual(addDays('2026-03-01', -1), '2026-02-28', 'month end');
  });

  await test('occasion words in messages: the holiday and its day, the slow time (EN, DE)', () => {
    assertEqual(dayText('2026-12-24', 'en'), 'Thursday 24 December', 'EN day');
    assertEqual(dayText('2026-12-24', 'de'), 'Donnerstag, 24. Dezember', 'DE day');
    assertEqual(occasionMergeValues({ holidayKey: 'valentines', holidayDate: '2027-02-14' }, 'de'), { 'holiday.name': 'Valentinstag', 'holiday.day': 'Sonntag, 14. Februar' }, 'DE holiday');
    assertEqual(occasionMergeValues({ slowWeekday: 2, slowDaypart: 'evening' }, 'en'), { 'slow.when': 'this Tuesday evening' }, 'EN slow');
    assertEqual(occasionMergeValues({}, 'en'), {}, 'no occasion');
  });

  await test('the seeded wording renders without gaps for every scan pool (EN, DE)', () => {
    for (const v of VARIANTS_SCAN) {
      for (const lang of ['en', 'de'] as const) {
        const content = lang === 'en' ? v.channels : v.locales?.de;
        const vars = { offerKey: 'ten_pct', offerLabel: OFFERS[0].label, offerDays: 14, offerExpiresAt: at(2026, 10, 26), ...occasionVars(v.poolKey === 'holiday' ? { kind: 'holiday', holidayKey: 'christmas_eve', date: '2026-12-24' } : { kind: 'slow', week: '2026-W42', weekday: 2, daypart: 'afternoon', date: '2026-10-13' }) };
        const values = renderValues({ lang, tz: ZRH, contact: { firstName: 'Anna', lastName: null }, venueName: 'Madras Jungle', vars, slots: { booking_url: 'https://book.example/table' }, offers: OFFERS, guestInfo: null, links: { offer: 'https://visit.example/s/abc', booking: 'https://visit.example/s/bk1' } });
        for (const [channel, c] of Object.entries(content ?? {})) {
          const texts = channel === 'sms' ? [(c as { text: string }).text] : [(c as { subject: string }).subject, (c as { body: string }).body];
          for (const text of texts) {
            const r = renderText(text, values);
            assertEqual(r.unknown, [], `${v.poolKey}/${v.letter} ${lang} ${channel}`);
          }
          if (channel === 'sms') assert(!/[–—…🎁🎂]/u.test((c as { text: string }).text), `${v.poolKey}/${v.letter} ${lang}: GSM-7 punctuation only`);
        }
      }
    }
  });

  console.log('\nThe v2 journeys in the interpreter');
  await test('Win-back v2: the stage picks its offer, one message, then open for 21 days; a revisit converts', () => {
    const now = at(2026, 10, 12, 3);
    const ctx = interp(winBackV2.definition, now, { offer_30: 'ten_pct', offer_60: 'fifteen_pct', offer_90: 'twenty_pct' });
    let state: InstanceState = freshState(ctx.definition.start, now);
    state.vars = occasionVars({ kind: 'winback', days: 60, lastVisitAt: now - 60 * DAY_MS });
    let r = step(state, { kind: 'start' }, ctx);
    assertEqual(r.state.vars.offerKey, 'fifteen_pct', 'the 60-day offer');
    assert(r.effects.some((e) => e.type === 'send'), 'a send');
    r = step(r.state, { kind: 'send_result', nodeId: 's', outcome: 'sent', touch: null as never }, ctx);
    assertEqual(r.state.cursor.nodeId, 'w', 'waits');
    assertEqual(r.state.status, 'active', 'still open');
    const back: EngineEvent = { id: 'ev_back', type: 'visit.started', occurredAt: now + 5 * DAY_MS, venueId: 'v', contactId: 'c', data: { isRevisit: true } };
    r = step(r.state, { kind: 'event', event: back }, { ...ctx, now: now + 5 * DAY_MS });
    assertEqual([r.state.status, r.state.exitReason], ['converted', 'goal'], 'came back');
    state = freshState(ctx.definition.start, now);
    state.vars = occasionVars({ kind: 'winback', days: 30, lastVisitAt: now - 30 * DAY_MS });
    assertEqual(step(state, { kind: 'start' }, ctx).state.vars.offerKey, 'ten_pct', 'the 30-day offer');
    state.vars = occasionVars({ kind: 'winback', days: 90, lastVisitAt: now - 90 * DAY_MS });
    assertEqual(step(state, { kind: 'start' }, ctx).state.vars.offerKey, 'twenty_pct', 'the 90-day offer');
  });

  await test('Slow-time filler v2: a morning time is announced the evening before, any other that morning', () => {
    const now = at(2026, 10, 12, 7);
    const ctx = interp(slowTimeFillerV2.definition, now, { offer: 'coffee' });
    const run = (daypart: string) => {
      const state = freshState(ctx.definition.start, now);
      state.vars = { occasionKind: 'slow', slowWeekday: 2, slowDaypart: daypart };
      return step(state, { kind: 'start' }, ctx).state;
    };
    assertEqual(run('morning').cursor.nodeId, 's_eve', 'morning');
    assertEqual(run('afternoon').cursor.nodeId, 's', 'afternoon');
    assertEqual(run('afternoon').vars.offerDays, 7, 'the offer is valid 7 days');
  });

  await test('Birthday and Holidays v2 parse, and their blanks have what owners need', () => {
    const b = journeyDefinitionSchema.parse(birthdayV2.definition);
    assertEqual(b.goal?.event, 'visit.revisit', 'birthday goal');
    const h = journeyDefinitionSchema.parse(holidaysV2.definition);
    assertEqual(Object.keys(h.slots), ['holidays', 'booking_url'], 'holiday blanks');
    assertEqual((h.slots.holidays as { default?: string }).default, DEFAULT_HOLIDAYS_VALUE, 'pre-ticked days');
  });

  console.log('\nSeed versions');
  await test('the seed publishes v2 of the four journeys and of the welcome, then the playbooks v2 and v3, with no problems', () => {
    const plan = buildSeedPlan(new Date('2026-10-08T00:00:00Z'));
    assertEqual(plan.problems, [], 'problems');
    assertEqual(plan.versions.map((v) => `${v.kind}:${v.key}@${v.version}`), [
      'journey:win_back@2',
      'journey:birthday@2',
      'journey:quiet_hours_filler@2',
      'journey:holidays@2',
      'journey:welcome_second_visit@2',
      'playbook:restaurant_growth@2',
      'playbook:local_business@2',
      'playbook:restaurant_growth@3',
      'playbook:local_business@3',
      // PR A7: Restaurant growth v4 adds Bring a friend.
      'playbook:restaurant_growth@4',
    ], 'order');
    const rg = plan.versions.find((v) => v.key === 'restaurant_growth')!;
    assert(rg.pins!.some((p) => p.journeyKey === 'holidays' && p.templateVersion === 2), 'pins holidays v2');
    assert(rg.pins!.some((p) => p.journeyKey === 'welcome_second_visit' && p.templateVersion === 1), 'v2 keeps welcome v1');
    // v3: the welcome that stays open until its offer ends (journeysWelcomeV2.ts).
    for (const key of ['restaurant_growth', 'local_business']) {
      const v3 = plan.versions.find((v) => v.key === key && v.version === 3)!;
      assert(v3.pins!.some((p) => p.journeyKey === 'welcome_second_visit' && p.templateVersion === 2), `${key} v3 pins welcome v2`);
      assert(v3.pins!.some((p) => p.journeyKey === 'review_ask' && p.templateVersion === 1), `${key} v3 keeps the review ask v1`);
    }
    assertEqual((plan.versions.find((v) => v.key === 'quiet_hours_filler')!.header.name as { en: string }).en, 'Slow-time filler', 'renamed');
    for (const [k, r] of Object.entries(plan.reports.versions)) assert(r.ok, `${k} passes its checks`);
  });

  await test('a version is published only one step behind; anything else is left alone', () => {
    const t = { version: 2 };
    assertEqual(versionDecision({ latestVersion: 1, publishedVersion: 1 }, false, t), 'publish', 'v1 published');
    assertEqual(versionDecision({ latestVersion: 2, publishedVersion: 2 }, true, t), 'current', 'already there');
    assertEqual(versionDecision({ latestVersion: 2, publishedVersion: 1 }, false, t), 'kept', 'an admin draft v2');
    assertEqual(versionDecision({ latestVersion: 3, publishedVersion: 3 }, false, t), 'kept', 'an admin moved on');
    assertEqual(versionDecision(null, false, t), 'missing', 'no header');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
