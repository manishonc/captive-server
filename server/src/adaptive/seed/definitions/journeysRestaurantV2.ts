/**
 * PR S: the runnable versions (v2) of the four restaurant scan journeys. Their v1 (in
 * journeysRestaurant.ts, unchanged) were "coming soon" placeholders that never run
 * (core/scans/occasions.ts SCAN_MIN_TEMPLATE_VERSION). The seed publishes v2 next to v1
 * (seed/versionUpgrades.ts) — publishing never changes a published version (AU-3).
 *
 * What changed from v1:
 *  - the triggers run (daily venue scan) and name their blanks / rules;
 *  - each journey stays open after its message until its goal window ends, so a guest who
 *    comes back counts ("came back", revenue, the offer page's "Welcome back");
 *  - Win-back branches on the stage the scan found (`instance.vars.winbackDays`) — one run
 *    and one message per stage;
 *  - Holidays has its blanks: which holidays (S-D3) and an optional table booking link;
 *  - "Quiet-hours filler" is the "Slow-time filler" (S-D4): "quiet hours" already means the
 *    21:00–09:00 no-message rule;
 *  - previews ("See what guests get") for all four.
 */

import { DEFAULT_HOLIDAYS_VALUE } from '../../core/scans/holidays';
import { t, type JourneySeed } from './types';

const DINING = ['restaurant', 'cafe', 'other'] as const;

export interface JourneyVersionSeed extends JourneySeed {
  version: number;
}

export const winBackV2: JourneyVersionSeed = {
  version: 2,
  header: {
    key: 'win_back',
    name: t('Win-back', 'Zurückgewinnen'),
    description: t('Guests who stopped coming get a “we miss you” offer.', 'Gäste, die nicht mehr kommen, erhalten ein „Wir vermissen dich“-Angebot.'),
    purpose: 'marketing',
    venueTypes: [...DINING],
    availability: 'available',
    kpi: 'reactivation_rate',
    requiredCapabilities: ['scan_daily'],
    display: { icon: 'heart', when: t('30, 60 and 90 days after their last visit', '30, 60 und 90 Tage nach dem letzten Besuch') },
  },
  changelog: 'Runs: a daily scan finds guests whose last visit was 30, 60 or 90 days ago; one message and a growing offer per stage; counts guests who come back while the offer lasts (14 days)',
  definition: {
    entry: {
      trigger: { type: 'days_since_visit', config: { days: [30, 60, 90], catchUpDays: 2 } },
      requires: ['consent:venue:marketing'],
      reentry: { mode: 'after_exit' },
    },
    // A newer occasion of this journey closes a run that already sent its message (scans/trigger.ts).
    exitOn: [{ event: 'scan.due' }],
    goal: { event: 'visit.revisit', within: '14d', exit: 'converted' },
    caps: { maxTouches: 1, stopAfterClicks: 1 },
    channelLadder: ['email', 'sms'],
    slots: {
      offer_30: { type: 'offer', label: t('Offer after 30 days', 'Angebot nach 30 Tagen'), required: true, kinds: ['percent', 'free_item', 'amount'] },
      offer_60: { type: 'offer', label: t('Offer after 60 days', 'Angebot nach 60 Tagen'), required: true, kinds: ['percent', 'free_item', 'amount'] },
      offer_90: { type: 'offer', label: t('Offer after 90 days', 'Angebot nach 90 Tagen'), required: true, kinds: ['percent', 'free_item', 'amount'] },
    },
    pools: {
      winback: { name: t('We miss you', 'Wir vermissen dich'), purpose: 'marketing', channels: ['email', 'sms'], requiredLocales: ['en', 'de'] },
    },
    autonomy: { allowed: ['tune_trigger_days', 'swap_offer', 'retire_variant'], bounds: { triggerDays: [14, 120] } },
    start: 'stage',
    nodes: {
      stage: {
        type: 'branch',
        config: {
          cases: [
            { when: { fact: 'instance.vars.winbackDays', eq: 30 }, edge: 'd30', label: '30 days' },
            { when: { fact: 'instance.vars.winbackDays', eq: 60 }, edge: 'd60', label: '60 days' },
          ],
        },
        edges: { d30: 'o30', d60: 'o60', default: 'o90' },
      },
      o30: { type: 'issue_offer', config: { slot: 'offer_30' }, edges: { done: 's', none: 'x' } },
      o60: { type: 'issue_offer', config: { slot: 'offer_60' }, edges: { done: 's', none: 'x' } },
      o90: { type: 'issue_offer', config: { slot: 'offer_90' }, edges: { done: 's', none: 'x' } },
      s: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'winback', channel: 'auto', timing: { mode: 'slot', default: 'morning' }, expireAfter: '24h' },
        edges: { sent: 'w', skipped: 'x' },
      },
      // Open while the offer lasts (14 days): a guest who comes back then counts.
      w: { type: 'delay', config: { for: '14d' }, edges: { done: 'x' } },
      x: { type: 'exit', config: { status: 'completed' } },
    },
    previewSteps: [
      {
        nodeId: 's',
        pool: 'winback',
        channel: 'email',
        offerSlot: 'offer_30',
        when: t('30 days after her last visit', '30 Tage nach ihrem letzten Besuch'),
        why: t('She hasn’t been back for a month. A friendly nudge with your first offer.', 'Sie war einen Monat nicht mehr da. Ein freundlicher Anstoss mit deinem ersten Angebot.'),
      },
      {
        nodeId: 's',
        pool: 'winback',
        channel: 'email',
        offerSlot: 'offer_60',
        when: t('60 days after her last visit — if she still hasn’t come', '60 Tage nach ihrem letzten Besuch – falls sie noch nicht da war'),
        why: t('Still away: a bigger offer.', 'Immer noch weg: ein grösseres Angebot.'),
      },
      {
        nodeId: 's',
        pool: 'winback',
        channel: 'email',
        offerSlot: 'offer_90',
        when: t('90 days after her last visit — the last try', '90 Tage nach ihrem letzten Besuch – der letzte Versuch'),
        why: t('The last message of this journey. Any visit starts the count again.', 'Die letzte Nachricht dieser Journey. Jeder Besuch startet die Zählung neu.'),
      },
    ],
  },
};

export const birthdayV2: JourneyVersionSeed = {
  version: 2,
  header: {
    key: 'birthday',
    name: t('Birthday', 'Geburtstag'),
    description: t('In their birthday month, a small gift. Only for guests who told us their month.', 'Im Geburtstagsmonat ein kleines Geschenk – nur für Gäste, die uns ihren Monat verraten haben.'),
    purpose: 'marketing',
    venueTypes: [...DINING],
    availability: 'available',
    kpi: 'redemptions',
    requiredCapabilities: ['scan_daily', 'profile_birthday'],
    display: { icon: 'cake', when: t('1st of the birthday month, 10:00', 'Am 1. des Geburtstagsmonats, 10:00') },
  },
  changelog: 'Runs: on the 1st of the month at 10:00 for guests who told us their birthday month (later in the month until the 25th); the gift is valid 14 days',
  definition: {
    entry: {
      trigger: { type: 'date_field', config: { field: 'birthdayMonth', day: 1, at: '10:00', lateUntilDay: 25 } },
      requires: ['consent:venue:marketing'],
      reentry: { mode: 'cooldown', cooldown: '300d' },
    },
    // A newer occasion of this journey closes a run that already sent its message (scans/trigger.ts).
    exitOn: [{ event: 'scan.due' }],
    goal: { event: 'visit.revisit', within: '14d', exit: 'converted' },
    caps: { maxTouches: 1, stopAfterClicks: 1 },
    channelLadder: ['email', 'sms'],
    // A gift reads "on us" / "aufs Haus": free items only.
    slots: { gift: { type: 'offer', label: t('Gift', 'Geschenk'), required: true, kinds: ['free_item'] } },
    pools: {
      birthday: { name: t('Birthday gift', 'Geburtstagsgeschenk'), purpose: 'marketing', channels: ['email', 'whatsapp', 'sms'], requiredLocales: ['en', 'de'], whatsappCategory: 'marketing' },
    },
    start: 'o',
    nodes: {
      o: { type: 'issue_offer', config: { slot: 'gift', expiryDays: 14 }, edges: { done: 's', none: 'x' } },
      s: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'birthday', channel: 'auto', timing: { mode: 'local_time', at: '10:00' }, expireAfter: '8h' },
        edges: { sent: 'w', skipped: 'x' },
      },
      w: { type: 'delay', config: { for: '14d' }, edges: { done: 'x' } },
      x: { type: 'exit', config: { status: 'completed' } },
    },
    previewSteps: [
      {
        nodeId: 's',
        pool: 'birthday',
        channel: 'email',
        when: t('The 1st of her birthday month, 10:00', 'Am 1. ihres Geburtstagsmonats, 10:00'),
        why: t('She told us her birthday month. One message, a gift for the next 14 days.', 'Sie hat uns ihren Geburtstagsmonat verraten. Eine Nachricht, ein Geschenk für die nächsten 14 Tage.'),
      },
    ],
  },
};

export const slowTimeFillerV2: JourneyVersionSeed = {
  version: 2,
  header: {
    key: 'quiet_hours_filler',
    name: t('Slow-time filler', 'Ruhige Zeiten füllen'),
    description: t('We find your slowest times of the week and invite guests who usually come around then.', 'Wir finden die ruhigsten Zeiten deiner Woche und laden Gäste ein, die meist um diese Zeit kommen.'),
    purpose: 'marketing',
    venueTypes: [...DINING],
    availability: 'available',
    kpi: 'extra_visits_in_daypart',
    requiredCapabilities: ['scan_weekly'],
    display: { icon: 'clock', when: t('Every Monday, for that week’s slowest times', 'Jeden Montag, für die ruhigsten Zeiten der Woche') },
  },
  changelog: 'Runs: every Monday finds the 2 slowest open times of the last 8 weeks (needs 4 weeks and 40 visits) and invites guests who came at that time of day; the message names the time',
  definition: {
    entry: {
      trigger: { type: 'computed.slow_daypart', config: { dayparts: 2, lookbackWeeks: 8, minWeeks: 4, minVisits: 40, recentDays: 3 } },
      requires: ['consent:venue:marketing'],
      reentry: { mode: 'cooldown', cooldown: '21d' },
    },
    // A newer occasion of this journey closes a run that already sent its message (scans/trigger.ts).
    exitOn: [{ event: 'scan.due' }],
    goal: { event: 'visit.revisit', within: '7d', exit: 'converted' },
    caps: { maxTouches: 1, stopAfterClicks: 1 },
    channelLadder: ['sms', 'email'],
    slots: { offer: { type: 'offer', label: t('Offer', 'Angebot'), required: true } },
    pools: {
      slow_day: { name: t('Slow-time invite', 'Einladung für ruhige Zeiten'), purpose: 'marketing', channels: ['email', 'sms'], requiredLocales: ['en', 'de'] },
    },
    start: 'o',
    nodes: {
      o: { type: 'issue_offer', config: { slot: 'offer', expiryDays: 7 }, edges: { done: 'when', none: 'x' } },
      when: {
        type: 'branch',
        config: { cases: [{ when: { fact: 'instance.vars.slowDaypart', eq: 'morning' }, edge: 'eve', label: 'Morning: the evening before' }] },
        edges: { eve: 's_eve', default: 's' },
      },
      // A morning slow time is announced the evening before; any later one that morning.
      s_eve: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'slow_day', channel: 'auto', timing: { mode: 'slot', default: 'evening' }, expireAfter: '3h' },
        edges: { sent: 'w', skipped: 'x' },
      },
      s: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'slow_day', channel: 'auto', timing: { mode: 'slot', default: 'morning' }, expireAfter: '5h' },
        edges: { sent: 'w', skipped: 'x' },
      },
      w: { type: 'delay', config: { for: '7d' }, edges: { done: 'x' } },
      x: { type: 'exit', config: { status: 'completed' } },
    },
    previewSteps: [
      {
        nodeId: 's',
        pool: 'slow_day',
        channel: 'sms',
        when: t('The morning of a slow time (Monday finds them)', 'Am Morgen einer ruhigen Zeit (der Montag findet sie)'),
        why: t('Tuesday afternoons are calm here. She came around that time before — an invite with your offer.', 'Dienstagnachmittags ist es hier ruhig. Sie kam schon um diese Zeit – eine Einladung mit deinem Angebot.'),
      },
    ],
  },
};

export const holidaysV2: JourneyVersionSeed = {
  version: 2,
  header: {
    key: 'holidays',
    name: t('Holidays', 'Feiertage'),
    description: t('A week before big days, a reminder to book a table.', 'Eine Woche vor wichtigen Tagen eine Erinnerung, einen Tisch zu reservieren.'),
    purpose: 'marketing',
    venueTypes: [...DINING],
    availability: 'available',
    kpi: 'reservations_attributed',
    requiredCapabilities: ['scan_daily', 'region_calendar'],
    display: { icon: 'calendar', when: t('7 days before the days you pick', '7 Tage vor den gewählten Tagen') },
  },
  changelog: 'Runs: 7 days before each holiday you pick (Swiss calendar), to guests of the last 12 months, spread over 3 mornings; optional table booking link',
  definition: {
    entry: {
      trigger: { type: 'calendar.holiday', config: { leadDays: 7, slot: 'holidays', spreadDays: 3, catchUpDays: 2 } },
      requires: ['consent:venue:marketing'],
      reentry: { mode: 'after_exit' },
    },
    // A newer occasion of this journey closes a run that already sent its message (scans/trigger.ts).
    exitOn: [{ event: 'scan.due' }],
    goal: { event: 'visit.revisit', within: '10d', exit: 'converted' },
    caps: { maxTouches: 1, stopAfterClicks: 1 },
    channelLadder: ['sms', 'email'],
    slots: {
      holidays: {
        type: 'holidays',
        label: t('Which days', 'Welche Tage'),
        help: t('Guests get a reminder 7 days before each day you tick.', 'Gäste erhalten 7 Tage vor jedem gewählten Tag eine Erinnerung.'),
        required: true,
        default: DEFAULT_HOLIDAYS_VALUE,
      },
      booking_url: {
        type: 'url',
        label: t('Table booking link (optional)', 'Link zur Tischreservierung (optional)'),
        placeholder: t('https://…', 'https://…'),
        required: false,
      },
    },
    pools: {
      holiday: { name: t('Holiday reminder', 'Feiertags-Erinnerung'), purpose: 'marketing', channels: ['sms', 'email'], requiredLocales: ['en', 'de'] },
    },
    start: 's',
    nodes: {
      s: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'holiday', channel: 'auto', timing: { mode: 'slot', default: 'morning' }, expireAfter: '48h' },
        edges: { sent: 'w', skipped: 'x' },
      },
      w: { type: 'delay', config: { for: '10d' }, edges: { done: 'x' } },
      x: { type: 'exit', config: { status: 'completed' } },
    },
    previewSteps: [
      {
        nodeId: 's',
        pool: 'holiday',
        channel: 'sms',
        when: t('7 days before a day you picked', '7 Tage vor einem gewählten Tag'),
        why: t('Big days fill up early. A reminder to book, with your link if you add one.', 'Wichtige Tage sind schnell ausgebucht. Eine Erinnerung zu reservieren, mit deinem Link, falls du einen angibst.'),
      },
    ],
  },
};

export const RESTAURANT_SCAN_JOURNEYS_V2: JourneyVersionSeed[] = [winBackV2, birthdayV2, slowTimeFillerV2, holidaysV2];
