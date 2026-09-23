/**
 * Restaurant & café journeys (PRD §6.8): A1 and A2 as specified in
 * 03-playbook-format §13, plus A3–A6, which ship as "coming soon" — their
 * triggers need the daily/weekly scans the engine adds later.
 */

import { t, type JourneySeed } from './types';

const DINING = ['restaurant', 'cafe', 'other'] as const;
const ALL_CHANNELS = ['sms', 'email', 'whatsapp'] as const;

export const welcomeSecondVisit: JourneySeed = {
  header: {
    key: 'welcome_second_visit',
    name: t('Welcome → come back', 'Willkommen → wiederkommen'),
    description: t(
      'After a guest’s first visit, send a small offer so they come back.',
      'Nach dem ersten Besuch ein kleines Angebot, damit Gäste wiederkommen.',
    ),
    purpose: 'marketing',
    venueTypes: [...DINING],
    availability: 'available',
    kpi: 'second_visit_rate_30d',
    requiredCapabilities: [],
    display: { icon: 'gift', when: t('15 min after their first Wi-Fi login', '15 Min. nach dem ersten WLAN-Login') },
  },
  changelog: 'First version: offer after the first visit, follow-up on the next channel, last-chance reminder, thank-you on return',
  definition: {
    entry: {
      trigger: { type: 'visit.started', config: { firstVisit: true } },
      requires: ['consent:venue:marketing'],
      reentry: { mode: 'never' },
    },
    goal: { event: 'offer.redeemed', within: '30d', onReach: 'thanks', exit: 'converted' },
    caps: { maxTouches: 5, stopAfterClicks: 3 },
    channelLadder: ['sms', 'email', 'whatsapp'],
    slots: {
      offer: { type: 'offer', label: t('Offer', 'Angebot'), required: true },
      offer_days: { type: 'days', label: t('Valid for (days)', 'Gültig (Tage)'), min: 1, max: 90, default: 14, required: true },
    },
    pools: {
      welcome_offer: {
        name: t('Welcome offer', 'Willkommensangebot'),
        purpose: 'marketing',
        channels: [...ALL_CHANNELS],
        requiredLocales: ['en', 'de'],
        whatsappCategory: 'marketing',
      },
      last_chance: {
        name: t('Last chance', 'Letzte Chance'),
        purpose: 'marketing',
        channels: [...ALL_CHANNELS],
        requiredLocales: ['en', 'de'],
        whatsappCategory: 'marketing',
      },
      thank_you: {
        name: t('Thank you', 'Dankeschön'),
        purpose: 'service',
        channels: [...ALL_CHANNELS],
        requiredLocales: ['en', 'de'],
        whatsappCategory: 'utility',
      },
    },
    autonomy: { allowed: ['shift_slot', 'reorder_ladder', 'swap_offer', 'retire_variant', 'spawn_variants'], bounds: {} },
    start: 'offer',
    nodes: {
      offer: { type: 'issue_offer', config: { slot: 'offer' }, edges: { done: 'd1', none: 'x_done' } },
      d1: { type: 'delay', config: { for: '15m' }, edges: { done: 's1' } },
      s1: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'welcome_offer', channel: 'auto', timing: { mode: 'now' } },
        edges: { sent: 'w1', skipped: 'x_done' },
      },
      w1: {
        type: 'wait_for',
        config: {
          events: [
            { key: 'clicked', event: 'message.clicked' },
            { key: 'opened', event: 'message.opened' },
          ],
          timeout: '48h',
        },
        edges: { clicked: 'w_redeem', opened: 's2_same', timeout: 's2_next' },
      },
      s2_next: {
        type: 'send',
        config: {
          purpose: 'marketing',
          pool: 'welcome_offer',
          channel: 'next_on_ladder',
          requireDiff: ['channel', 'variant'],
          timing: { mode: 'slot', default: 'afternoon' },
          expireAfter: '24h',
        },
        edges: { sent: 'w2', skipped: 'x_done' },
      },
      s2_same: {
        type: 'send',
        config: {
          purpose: 'marketing',
          pool: 'welcome_offer',
          channel: 'same_as_last',
          requireDiff: ['variant'],
          timing: { mode: 'slot', default: 'evening' },
          expireAfter: '24h',
        },
        edges: { sent: 'w2', skipped: 'x_done' },
      },
      w2: {
        type: 'wait_for',
        config: { events: [{ key: 'clicked', event: 'message.clicked' }], timeout: '72h' },
        edges: { clicked: 'w_redeem', timeout: 'x_exhausted' },
      },
      w_redeem: { type: 'delay', config: { for: '72h' }, edges: { done: 'last' } },
      last: {
        type: 'send',
        config: {
          purpose: 'marketing',
          pool: 'last_chance',
          channel: 'same_as_last_click',
          highValue: true,
          timing: { mode: 'slot', default: 'evening' },
        },
        edges: { sent: 'x_exhausted', skipped: 'x_exhausted' },
      },
      thanks: {
        type: 'send',
        config: { purpose: 'service', pool: 'thank_you', channel: 'same_as_last_click', timing: { mode: 'now' } },
        edges: { sent: 'x_converted', skipped: 'x_converted' },
      },
      x_done: { type: 'exit', config: { status: 'completed' } },
      x_exhausted: { type: 'exit', config: { status: 'exhausted' } },
      x_converted: { type: 'exit', config: { status: 'converted' } },
    },
    previewSteps: [
      {
        nodeId: 's1',
        pool: 'welcome_offer',
        channel: 'sms',
        when: t('15 min after her first login', '15 Min. nach ihrem ersten Login'),
        why: t('Her first visit. A text reaches her while she still remembers you.', 'Ihr erster Besuch. Eine SMS erreicht sie, solange sie sich noch an dich erinnert.'),
      },
      {
        nodeId: 's2_next',
        pool: 'welcome_offer',
        channel: 'email',
        when: t('2 days later — only if she didn’t react', '2 Tage später – nur wenn sie nicht reagiert hat'),
        why: t('No reaction, so the next channel and a different wording.', 'Keine Reaktion, also der nächste Kanal und ein anderer Text.'),
      },
      {
        nodeId: 'last',
        pool: 'last_chance',
        channel: 'email',
        when: t('3 days after she clicked — if she hasn’t come back', '3 Tage nach dem Klick – falls sie noch nicht da war'),
        why: t('She was interested but hasn’t been back yet.', 'Sie war interessiert, war aber noch nicht wieder da.'),
      },
      {
        nodeId: 'thanks',
        pool: 'thank_you',
        channel: 'email',
        when: t('When she connects to your Wi-Fi again', 'Wenn sie sich wieder mit deinem WLAN verbindet'),
        why: t('She came back. An info message — no credits.', 'Sie ist wiedergekommen. Eine Info-Nachricht – ohne Credits.'),
      },
    ],
  },
};

export const reviewAsk: JourneySeed = {
  header: {
    key: 'review_ask',
    name: t('Review ask', 'Bewertungsanfrage'),
    description: t(
      'A few hours after the visit, ask how it was. Everyone sees your Google link.',
      'Ein paar Stunden nach dem Besuch fragen, wie es war. Alle sehen deinen Google-Link.',
    ),
    purpose: 'marketing',
    venueTypes: [...DINING],
    availability: 'available',
    kpi: 'public_reviews_per_100_visits',
    requiredCapabilities: ['visit_end'],
    display: { icon: 'star', when: t('3 hours after they leave (never at night)', '3 Stunden nach dem Besuch (nie nachts)') },
  },
  changelog: 'First version: one ask after the visit, one retry on another channel, public review links for every rating',
  definition: {
    entry: {
      trigger: { type: 'visit.ended', config: { minDwellMinutes: 25, fallbackAfterConnect: '3h' } },
      requires: ['consent:venue:marketing'],
      reentry: { mode: 'cooldown', cooldown: '60d' },
    },
    exitOn: [{ event: 'rating.submitted' }],
    caps: { maxTouches: 2, stopAfterClicks: 1 },
    channelLadder: ['sms', 'email', 'whatsapp'],
    slots: {
      staff_name: {
        type: 'text',
        label: t('Staff name to mention (optional)', 'Name fürs Team (optional)'),
        placeholder: t('e.g. Priya', 'z. B. Priya'),
        help: t('Shown on the rating page: “Say hi to Priya in your review!”', 'Steht auf der Bewertungsseite: „Grüss Priya in deiner Bewertung!“'),
        maxLength: 40,
        i18n: false,
        required: false,
      },
    },
    pools: {
      review_ask: {
        name: t('Review ask', 'Bewertungsanfrage'),
        purpose: 'marketing',
        channels: [...ALL_CHANNELS],
        requiredLocales: ['en', 'de'],
        whatsappCategory: 'marketing',
      },
    },
    autonomy: { allowed: ['shift_slot', 'reorder_ladder', 'retire_variant'], bounds: {} },
    start: 't',
    nodes: {
      t: { type: 'delay', config: { for: '3h' }, edges: { done: 's1' } },
      s1: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'review_ask', channel: 'auto', timing: { mode: 'now' }, expireAfter: '18h' },
        edges: { sent: 'w1', skipped: 'x' },
      },
      w1: {
        type: 'wait_for',
        config: { events: [{ key: 'clicked', event: 'message.clicked' }], timeout: '72h' },
        edges: { clicked: 'x', timeout: 's2' },
      },
      s2: {
        type: 'send',
        config: {
          purpose: 'marketing',
          pool: 'review_ask',
          channel: 'next_on_ladder',
          requireDiff: ['channel'],
          timing: { mode: 'slot', default: 'morning' },
        },
        edges: { sent: 'x', skipped: 'x' },
      },
      x: { type: 'exit', config: { status: 'completed' } },
    },
    previewSteps: [
      {
        nodeId: 's1',
        pool: 'review_ask',
        channel: 'sms',
        when: t('3 hours after she leaves', '3 Stunden nachdem sie gegangen ist'),
        why: t('She stayed long enough to have an opinion. Never sent at night.', 'Sie war lange genug da, um eine Meinung zu haben. Nie nachts.'),
      },
      {
        nodeId: 's1',
        channel: 'page',
        when: t('When she taps the link', 'Wenn sie auf den Link tippt'),
        why: t('Everyone sees your public review links. 1–3 stars? She can tell you privately first.', 'Alle sehen deine öffentlichen Bewertungslinks. 1–3 Sterne? Sie kann dir zuerst privat schreiben.'),
      },
      {
        nodeId: 's2',
        pool: 'review_ask',
        channel: 'email',
        when: t('3 days later — only if she didn’t tap', '3 Tage später – nur wenn sie nicht getippt hat'),
        why: t('One retry on another channel, then it stops.', 'Ein zweiter Versuch auf einem anderen Kanal, dann ist Schluss.'),
      },
    ],
  },
};

export const winBack: JourneySeed = {
  header: {
    key: 'win_back',
    name: t('Win-back', 'Zurückgewinnen'),
    description: t('Guests who stopped coming get a “we miss you” offer.', 'Gäste, die nicht mehr kommen, erhalten ein „Wir vermissen dich“-Angebot.'),
    purpose: 'marketing',
    venueTypes: [...DINING],
    availability: 'coming_soon',
    kpi: 'reactivation_rate',
    requiredCapabilities: ['scan_daily'],
    display: { icon: 'heart', when: t('30, 60 and 90 days after their last visit', '30, 60 und 90 Tage nach dem letzten Besuch') },
  },
  changelog: 'First version: three stages with growing offers; any visit resets',
  definition: {
    entry: {
      trigger: { type: 'days_since_visit', config: { days: [30, 60, 90] } },
      requires: ['consent:venue:marketing'],
      reentry: { mode: 'after_exit' },
    },
    goal: { event: 'visit.revisit', within: '30d', exit: 'converted' },
    caps: { maxTouches: 3, stopAfterClicks: 2 },
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
            { when: { fact: 'event.data.days', eq: 30 }, edge: 'd30', label: '30 days' },
            { when: { fact: 'event.data.days', eq: 60 }, edge: 'd60', label: '60 days' },
          ],
        },
        edges: { d30: 'o30', d60: 'o60', default: 'o90' },
      },
      o30: { type: 'issue_offer', config: { slot: 'offer_30' }, edges: { done: 's', none: 'x' } },
      o60: { type: 'issue_offer', config: { slot: 'offer_60' }, edges: { done: 's', none: 'x' } },
      o90: { type: 'issue_offer', config: { slot: 'offer_90' }, edges: { done: 's', none: 'x' } },
      s: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'winback', channel: 'auto', timing: { mode: 'slot', default: 'morning' } },
        edges: { sent: 'x', skipped: 'x' },
      },
      x: { type: 'exit', config: { status: 'completed' } },
    },
  },
};

export const birthday: JourneySeed = {
  header: {
    key: 'birthday',
    name: t('Birthday', 'Geburtstag'),
    description: t('In their birthday month, a small gift. Only for guests who told us their month.', 'Im Geburtstagsmonat ein kleines Geschenk – nur für Gäste, die uns ihren Monat verraten haben.'),
    purpose: 'marketing',
    venueTypes: [...DINING],
    availability: 'coming_soon',
    kpi: 'redemptions',
    requiredCapabilities: ['scan_daily', 'profile_birthday'],
    display: { icon: 'cake', when: t('1st of the birthday month, 10:00', 'Am 1. des Geburtstagsmonats, 10:00') },
  },
  changelog: 'First version: one message with a 14-day gift',
  definition: {
    entry: {
      trigger: { type: 'date_field', config: { field: 'birthdayMonth', day: 1, at: '10:00' } },
      requires: ['consent:venue:marketing'],
      reentry: { mode: 'cooldown', cooldown: '300d' },
    },
    goal: { event: 'offer.redeemed', within: '30d', exit: 'converted' },
    caps: { maxTouches: 1, stopAfterClicks: 1 },
    channelLadder: ['email', 'whatsapp', 'sms'],
    slots: { gift: { type: 'offer', label: t('Gift', 'Geschenk'), required: true } },
    pools: {
      birthday: { name: t('Birthday gift', 'Geburtstagsgeschenk'), purpose: 'marketing', channels: ['email', 'whatsapp', 'sms'], requiredLocales: ['en', 'de'], whatsappCategory: 'marketing' },
    },
    start: 'o',
    nodes: {
      o: { type: 'issue_offer', config: { slot: 'gift', expiryDays: 14 }, edges: { done: 's', none: 'x' } },
      s: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'birthday', channel: 'auto', timing: { mode: 'local_time', at: '10:00' } },
        edges: { sent: 'x', skipped: 'x' },
      },
      x: { type: 'exit', config: { status: 'completed' } },
    },
  },
};

export const quietHoursFiller: JourneySeed = {
  header: {
    key: 'quiet_hours_filler',
    name: t('Quiet-hours filler', 'Ruhige Stunden füllen'),
    description: t('We find your quietest hours and invite guests who usually come around then.', 'Wir finden deine ruhigsten Stunden und laden Gäste ein, die meist um diese Zeit kommen.'),
    purpose: 'marketing',
    venueTypes: [...DINING],
    availability: 'coming_soon',
    kpi: 'extra_visits_in_daypart',
    requiredCapabilities: ['scan_weekly'],
    display: { icon: 'clock', when: t('Once a week, found automatically', 'Einmal pro Woche, automatisch') },
  },
  changelog: 'First version: one promo for the two slowest dayparts',
  definition: {
    entry: {
      trigger: { type: 'computed.slow_daypart', config: { dayparts: 2, lookbackWeeks: 8 } },
      requires: ['consent:venue:marketing'],
      reentry: { mode: 'cooldown', cooldown: '21d' },
    },
    goal: { event: 'visit.revisit', within: '7d', exit: 'converted' },
    caps: { maxTouches: 1, stopAfterClicks: 1 },
    channelLadder: ['email', 'sms'],
    slots: { offer: { type: 'offer', label: t('Offer', 'Angebot'), required: true } },
    pools: {
      slow_day: { name: t('Quiet-hours invite', 'Einladung für ruhige Stunden'), purpose: 'marketing', channels: ['email', 'sms'], requiredLocales: ['en', 'de'] },
    },
    start: 'o',
    nodes: {
      o: { type: 'issue_offer', config: { slot: 'offer' }, edges: { done: 's', none: 'x' } },
      s: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'slow_day', channel: 'auto', timing: { mode: 'slot', default: 'morning' } },
        edges: { sent: 'x', skipped: 'x' },
      },
      x: { type: 'exit', config: { status: 'completed' } },
    },
  },
};

export const holidays: JourneySeed = {
  header: {
    key: 'holidays',
    name: t('Holidays', 'Feiertage'),
    description: t('A week before big days, a reminder to book a table.', 'Eine Woche vor wichtigen Tagen eine Erinnerung, einen Tisch zu reservieren.'),
    purpose: 'marketing',
    venueTypes: [...DINING],
    availability: 'coming_soon',
    kpi: 'reservations_attributed',
    requiredCapabilities: ['scan_daily', 'region_calendar'],
    display: { icon: 'calendar', when: t('7 days before holidays you pick', '7 Tage vor den gewählten Feiertagen') },
  },
  changelog: 'First version: one reservation reminder per holiday',
  definition: {
    entry: {
      trigger: { type: 'calendar.holiday', config: { leadDays: 7 } },
      requires: ['consent:venue:marketing'],
      reentry: { mode: 'after_exit' },
    },
    caps: { maxTouches: 1, stopAfterClicks: 1 },
    channelLadder: ['sms', 'email'],
    pools: {
      holiday: { name: t('Holiday reminder', 'Feiertags-Erinnerung'), purpose: 'marketing', channels: ['sms', 'email'], requiredLocales: ['en', 'de'] },
    },
    start: 's',
    nodes: {
      s: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'holiday', channel: 'auto', timing: { mode: 'slot', default: 'morning' } },
        edges: { sent: 'x', skipped: 'x' },
      },
      x: { type: 'exit', config: { status: 'completed' } },
    },
  },
};

export const RESTAURANT_JOURNEYS: JourneySeed[] = [welcomeSecondVisit, reviewAsk, winBack, birthday, quietHoursFiller, holidays];
