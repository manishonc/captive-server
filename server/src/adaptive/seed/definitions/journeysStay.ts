/**
 * Airbnb stay journeys (PRD §6.8 B2), split into the four journeys the prototypes
 * show so owners can switch each one on or off. Each starts at a stay moment
 * (`stay.window`: arrival day 17:00, day 2 10:00, checkout 15:00, checkout +3 days),
 * which needs the stay feed that ships with the stays release.
 */

import { t, type JourneySeed } from './types';

export const stayGuide: JourneySeed = {
  header: {
    key: 'stay_guide',
    name: t('Stay guide', 'Aufenthalts-Guide'),
    description: t(
      'Welcome with Wi-Fi & house info, a mid-stay check and checkout instructions.',
      'Willkommen mit WLAN- und Hausinfos, ein Check-in während des Aufenthalts und Check-out-Hinweise.',
    ),
    purpose: 'service',
    venueTypes: ['airbnb'],
    availability: 'available',
    kpi: 'hub_views',
    requiredCapabilities: ['stays'],
    display: { icon: 'book', when: t('Arrival day 17:00 · mid-stay · day before checkout', 'Anreisetag 17:00 · während des Aufenthalts · Tag vor dem Check-out') },
  },
  changelog: 'First version: arrival welcome, mid-stay check (4+ nights), checkout instructions',
  definition: {
    entry: {
      trigger: { type: 'stay.window', config: { requireConnect: true, anchor: 'checkInAt', offsetDays: 0, at: '17:00' } },
      requires: [],
      reentry: { mode: 'after_exit' },
    },
    exitOn: [{ event: 'stay.cancelled' }],
    channelLadder: ['email', 'whatsapp', 'sms'],
    slots: {
      late_checkout_price: {
        type: 'int',
        label: t('Late checkout price', 'Preis für späten Check-out'),
        help: t('Mentioned in the checkout message. 0 = not offered.', 'Steht in der Check-out-Nachricht. 0 = nicht angeboten.'),
        unit: 'CHF',
        min: 0,
        max: 500,
        default: 30,
        required: false,
      },
    },
    pools: {
      stay_welcome: { name: t('Arrival welcome', 'Willkommen bei der Anreise'), purpose: 'service', channels: ['email', 'whatsapp', 'sms'], requiredLocales: ['en', 'de'], whatsappCategory: 'utility' },
      stay_midstay: { name: t('Mid-stay check', 'Zwischendurch nachfragen'), purpose: 'service', channels: ['email', 'whatsapp', 'sms'], requiredLocales: ['en', 'de'], whatsappCategory: 'utility' },
      stay_checkout: { name: t('Checkout instructions', 'Check-out-Hinweise'), purpose: 'service', channels: ['email', 'whatsapp', 'sms'], requiredLocales: ['en', 'de'], whatsappCategory: 'utility' },
    },
    start: 'welcome',
    nodes: {
      welcome: {
        type: 'send',
        config: { purpose: 'service', pool: 'stay_welcome', channel: 'auto', timing: { mode: 'now' }, urgent: true },
        edges: { sent: 'long', skipped: 'long' },
      },
      long: {
        type: 'branch',
        config: { cases: [{ when: { fact: 'stay.nights', gte: 4 }, edge: 'mid', label: '4+ nights' }] },
        edges: { mid: 'mid_w', default: 'co_w' },
      },
      mid_w: { type: 'wait_until', config: { anchor: 'stay.checkInAt', offset: '+2d', at: '11:00' }, edges: { done: 'mid', past: 'co_w' } },
      mid: {
        type: 'send',
        config: { purpose: 'service', pool: 'stay_midstay', channel: 'auto', timing: { mode: 'now' } },
        edges: { sent: 'co_w', skipped: 'co_w' },
      },
      co_w: { type: 'wait_until', config: { anchor: 'stay.checkOutAt', offset: '-1d', at: '17:00' }, edges: { done: 'co', past: 'x' } },
      co: {
        type: 'send',
        config: { purpose: 'service', pool: 'stay_checkout', channel: 'auto', timing: { mode: 'now' } },
        edges: { sent: 'x', skipped: 'x' },
      },
      x: { type: 'exit', config: { status: 'completed' } },
    },
    previewSteps: [
      { nodeId: 'welcome', pool: 'stay_welcome', channel: 'email', when: t('Arrival day, 17:00', 'Anreisetag, 17:00'), why: t('Everything she needs to settle in. An info message — free.', 'Alles, was sie zum Ankommen braucht. Eine Info-Nachricht – gratis.') },
      { nodeId: 'mid', pool: 'stay_midstay', channel: 'email', when: t('Day 3, 11:00 — stays of 4+ nights', 'Tag 3, 11:00 – ab 4 Nächten'), why: t('A quick check that everything is fine.', 'Kurz nachfragen, ob alles passt.') },
      { nodeId: 'co', pool: 'stay_checkout', channel: 'email', when: t('Day before checkout, 17:00', 'Tag vor dem Check-out, 17:00'), why: t('Checkout time and instructions, plus late checkout if you offer it.', 'Check-out-Zeit und Hinweise, dazu später Check-out, falls du ihn anbietest.') },
    ],
  },
};

export const stayLocalTips: JourneySeed = {
  header: {
    key: 'stay_local_tips',
    name: t('Local tips', 'Lokale Tipps'),
    description: t('Day 2: your favourite places nearby.', 'Tag 2: deine Lieblingsorte in der Nähe.'),
    purpose: 'marketing',
    venueTypes: ['airbnb'],
    availability: 'available',
    kpi: 'tips_clicks',
    requiredCapabilities: ['stays'],
    display: { icon: 'map', when: t('Day 2 of the stay, 10:00', 'Tag 2 des Aufenthalts, 10:00') },
  },
  changelog: 'First version: one message on day 2',
  definition: {
    entry: {
      trigger: { type: 'stay.window', config: { requireConnect: true, anchor: 'checkInAt', offsetDays: 1, at: '10:00' } },
      requires: ['consent:venue:marketing'],
      reentry: { mode: 'after_exit' },
    },
    exitOn: [{ event: 'stay.cancelled' }],
    caps: { maxTouches: 1, stopAfterClicks: 1 },
    channelLadder: ['email', 'whatsapp'],
    pools: {
      local_tips: { name: t('Local tips', 'Lokale Tipps'), purpose: 'marketing', channels: ['email', 'whatsapp'], requiredLocales: ['en', 'de'], whatsappCategory: 'marketing' },
    },
    start: 's',
    nodes: {
      s: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'local_tips', channel: 'auto', timing: { mode: 'now' } },
        edges: { sent: 'x', skipped: 'x' },
      },
      x: { type: 'exit', config: { status: 'completed' } },
    },
    previewSteps: [
      { nodeId: 's', pool: 'local_tips', channel: 'email', when: t('Day 2 of the stay, 10:00', 'Tag 2 des Aufenthalts, 10:00'), why: t('She has settled in and is planning her day.', 'Sie ist angekommen und plant ihren Tag.') },
    ],
  },
};

export const stayReview: JourneySeed = {
  header: {
    key: 'stay_review',
    name: t('Review after checkout', 'Bewertung nach dem Check-out'),
    description: t('Ask for a review on the day they leave.', 'Am Abreisetag um eine Bewertung bitten.'),
    purpose: 'marketing',
    venueTypes: ['airbnb'],
    availability: 'available',
    kpi: 'review_rate',
    requiredCapabilities: ['stays'],
    display: { icon: 'star', when: t('Checkout day, 15:00', 'Abreisetag, 15:00') },
  },
  changelog: 'First version: one ask, one retry on another channel',
  definition: {
    entry: {
      trigger: { type: 'stay.window', config: { requireConnect: true, anchor: 'checkOutAt', offsetDays: 0, at: '15:00' } },
      requires: ['consent:venue:marketing'],
      reentry: { mode: 'after_exit' },
    },
    exitOn: [{ event: 'rating.submitted' }, { event: 'stay.cancelled' }],
    caps: { maxTouches: 2, stopAfterClicks: 1 },
    channelLadder: ['sms', 'email'],
    pools: {
      stay_review: { name: t('Stay review ask', 'Bewertungsanfrage Aufenthalt'), purpose: 'marketing', channels: ['sms', 'email'], requiredLocales: ['en', 'de'] },
    },
    start: 's1',
    nodes: {
      s1: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'stay_review', channel: 'auto', timing: { mode: 'now' }, expireAfter: '18h' },
        edges: { sent: 'w1', skipped: 'x' },
      },
      w1: {
        type: 'wait_for',
        config: { events: [{ key: 'clicked', event: 'message.clicked' }], timeout: '72h' },
        edges: { clicked: 'x', timeout: 's2' },
      },
      s2: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'stay_review', channel: 'next_on_ladder', requireDiff: ['channel'], timing: { mode: 'slot', default: 'morning' } },
        edges: { sent: 'x', skipped: 'x' },
      },
      x: { type: 'exit', config: { status: 'completed' } },
    },
    previewSteps: [
      { nodeId: 's1', pool: 'stay_review', channel: 'sms', when: t('Checkout day, 15:00', 'Abreisetag, 15:00'), why: t('The stay is fresh in her mind.', 'Der Aufenthalt ist noch frisch.') },
      { nodeId: 's1', channel: 'page', when: t('When she taps the link', 'Wenn sie auf den Link tippt'), why: t('Every guest sees your public review links.', 'Alle Gäste sehen deine öffentlichen Bewertungslinks.') },
    ],
  },
};

export const stayBookDirect: JourneySeed = {
  header: {
    key: 'stay_book_direct',
    name: t('Book direct next time', 'Nächstes Mal direkt buchen'),
    description: t('A few days after the stay: save when you book with us directly.', 'Ein paar Tage nach dem Aufenthalt: beim direkten Buchen sparen.'),
    purpose: 'marketing',
    venueTypes: ['airbnb'],
    availability: 'available',
    kpi: 'direct_bookings',
    requiredCapabilities: ['stays'],
    display: { icon: 'home', when: t('3 days after checkout', '3 Tage nach dem Check-out') },
  },
  changelog: 'First version: one high-value message with the direct-booking offer',
  definition: {
    entry: {
      trigger: { type: 'stay.window', config: { requireConnect: true, anchor: 'checkOutAt', offsetDays: 3, at: '10:00' } },
      requires: ['consent:venue:marketing'],
      reentry: { mode: 'after_exit' },
    },
    goal: { event: 'booking.direct', within: '60d', exit: 'converted' },
    caps: { maxTouches: 1, stopAfterClicks: 1 },
    channelLadder: ['email', 'sms'],
    slots: {
      offer: {
        type: 'offer',
        label: t('Direct-booking offer', 'Angebot für Direktbuchung'),
        required: true,
        kinds: ['percent', 'amount'],
      },
    },
    pools: {
      book_direct: { name: t('Book direct', 'Direkt buchen'), purpose: 'marketing', channels: ['email', 'sms'], requiredLocales: ['en', 'de'] },
    },
    start: 'o',
    nodes: {
      o: { type: 'issue_offer', config: { slot: 'offer' }, edges: { done: 's', none: 'x' } },
      s: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'book_direct', channel: 'auto', timing: { mode: 'now' }, highValue: true },
        edges: { sent: 'x', skipped: 'x' },
      },
      x: { type: 'exit', config: { status: 'completed' } },
    },
    previewSteps: [
      { nodeId: 's', pool: 'book_direct', channel: 'email', when: t('3 days after checkout, 10:00', '3 Tage nach dem Check-out, 10:00'), why: t('She had a good stay — next time she can book with you directly.', 'Sie hatte einen schönen Aufenthalt – nächstes Mal bucht sie direkt bei dir.') },
    ],
  },
};

export const STAY_JOURNEYS: JourneySeed[] = [stayGuide, stayLocalTips, stayReview, stayBookDirect];
