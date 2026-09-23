/**
 * The four playbooks from the prototypes, seeded as published v1.
 * Offers use the nominative in German so they drop into any wording.
 */

import { t, type PlaybookSeed } from './types';

const FREE_DESSERT = { offerKey: 'dessert', name: 'Free dessert', label: t('a free dessert', 'ein Gratis-Dessert'), kind: 'free_item', value: 0, expiryDays: 14 } as const;
const FREE_COFFEE = { offerKey: 'coffee', name: 'Free coffee', label: t('a free coffee', 'ein Gratis-Kaffee'), kind: 'free_item', value: 0, expiryDays: 7 } as const;
const FREE_DRINK = { offerKey: 'drink', name: 'Free welcome drink', label: t('a free welcome drink', 'ein Gratis-Willkommensdrink'), kind: 'free_item', value: 0, expiryDays: 14 } as const;
const TEN_PCT = { offerKey: 'ten_pct', name: '10% off', label: t('10% off your next visit', '10% Rabatt auf deinen nächsten Besuch'), kind: 'percent', value: 10, expiryDays: 14 } as const;
const DIRECT_12 = { offerKey: 'direct12', name: '12% off direct booking', label: t('12% off', '12% Rabatt'), kind: 'percent', value: 12, expiryDays: 60 } as const;

export const restaurantGrowth: PlaybookSeed = {
  key: 'restaurant_growth',
  sortOrder: 10,
  changelog: 'First version: welcome offer and review ask; win-back, birthday, quiet hours and holidays coming soon',
  content: {
    kind: 'marketing',
    name: t('Restaurant growth', 'Restaurant-Wachstum'),
    summary: t('Bring first-time guests back and collect more good reviews.', 'Erstbesucher zurückholen und mehr gute Bewertungen sammeln.'),
    icon: 'utensils',
    venueTypes: ['restaurant', 'cafe'],
    journeys: [
      { journeyKey: 'welcome_second_visit', templateVersion: 1, defaultEnabled: true, required: true, priority: 60, slotDefaults: { offer: 'dessert', offer_days: 14 } },
      { journeyKey: 'review_ask', templateVersion: 1, defaultEnabled: true, required: false, priority: 50, slotDefaults: {} },
      { journeyKey: 'win_back', templateVersion: 1, defaultEnabled: false, required: false, priority: 40, slotDefaults: {} },
      { journeyKey: 'birthday', templateVersion: 1, defaultEnabled: false, required: false, priority: 30, slotDefaults: {} },
      { journeyKey: 'quiet_hours_filler', templateVersion: 1, defaultEnabled: false, required: false, priority: 20, slotDefaults: {} },
      { journeyKey: 'holidays', templateVersion: 1, defaultEnabled: false, required: false, priority: 10, slotDefaults: {} },
    ],
    offerMenuDefaults: [FREE_DESSERT, FREE_COFFEE, FREE_DRINK, TEN_PCT],
    questionKeys: ['visit_type', 'occasion', 'birthday_month'],
    estimateHints: {
      avgTouchesPerGuest: { welcome_second_visit: 2.4, review_ask: 1.3, win_back: 1.5, birthday: 1, quiet_hours_filler: 1, holidays: 1 },
      returnRate: 0.12,
      avgSpend: { amountMinor: 4500, currency: 'CHF' },
    },
  },
};

export const airbnbStay: PlaybookSeed = {
  key: 'str_stay',
  sortOrder: 20,
  changelog: 'First version: stay guide, local tips, review after checkout, book direct next time',
  content: {
    kind: 'marketing',
    name: t('Airbnb stay', 'Airbnb-Aufenthalt'),
    summary: t(
      'Helpful messages during the stay, a review after, and a direct booking next time.',
      'Hilfreiche Nachrichten während des Aufenthalts, danach eine Bewertung und nächstes Mal eine Direktbuchung.',
    ),
    icon: 'home',
    venueTypes: ['airbnb'],
    journeys: [
      { journeyKey: 'stay_guide', templateVersion: 1, defaultEnabled: true, required: true, priority: 90, slotDefaults: { late_checkout_price: 30 } },
      { journeyKey: 'stay_local_tips', templateVersion: 1, defaultEnabled: true, required: false, priority: 60, slotDefaults: {} },
      { journeyKey: 'stay_review', templateVersion: 1, defaultEnabled: true, required: false, priority: 50, slotDefaults: {} },
      { journeyKey: 'stay_book_direct', templateVersion: 1, defaultEnabled: true, required: false, priority: 40, slotDefaults: { offer: 'direct12' } },
    ],
    offerMenuDefaults: [DIRECT_12],
    questionKeys: ['stay_length', 'interests'],
    estimateHints: {
      avgTouchesPerGuest: { stay_guide: 3, stay_local_tips: 1, stay_review: 1.3, stay_book_direct: 1 },
      returnRate: 0.05,
      avgSpend: { amountMinor: 18000, currency: 'CHF' },
    },
  },
};

export const localBusiness: PlaybookSeed = {
  key: 'local_business',
  sortOrder: 30,
  changelog: 'First version: derived from Restaurant growth — welcome offer and review ask; quiet hours coming soon',
  content: {
    kind: 'marketing',
    name: t('Local business', 'Lokales Geschäft'),
    summary: t('A simpler version: welcome offer, review ask, quiet-hours filler.', 'Die einfache Version: Willkommensangebot, Bewertungsanfrage, ruhige Stunden füllen.'),
    icon: 'store',
    venueTypes: ['restaurant', 'cafe', 'other'],
    journeys: [
      { journeyKey: 'welcome_second_visit', templateVersion: 1, defaultEnabled: true, required: true, priority: 60, slotDefaults: { offer: 'coffee', offer_days: 14 } },
      { journeyKey: 'review_ask', templateVersion: 1, defaultEnabled: true, required: false, priority: 50, slotDefaults: {} },
      { journeyKey: 'quiet_hours_filler', templateVersion: 1, defaultEnabled: false, required: false, priority: 20, slotDefaults: {} },
    ],
    offerMenuDefaults: [FREE_COFFEE, TEN_PCT],
    questionKeys: ['visit_type'],
    estimateHints: {
      avgTouchesPerGuest: { welcome_second_visit: 2.4, review_ask: 1.3, quiet_hours_filler: 1 },
      returnRate: 0.08,
      avgSpend: { amountMinor: 3000, currency: 'CHF' },
    },
  },
};

export const guestInfo: PlaybookSeed = {
  key: 'guest_info',
  sortOrder: 40,
  changelog: 'First version: Wi-Fi & info card, checkout reminder',
  content: {
    kind: 'utility',
    name: t('Guest info', 'Gästeinfos'),
    summary: t(
      'Wi-Fi details and house info right after guests connect, and a checkout reminder. Free.',
      'WLAN-Details und Hausinfos direkt nach dem Verbinden, dazu eine Check-out-Erinnerung. Gratis.',
    ),
    icon: 'key',
    venueTypes: ['restaurant', 'cafe', 'airbnb', 'other'],
    journeys: [
      { journeyKey: 'wifi_info_card', templateVersion: 1, defaultEnabled: true, required: false, priority: 90, slotDefaults: {} },
      { journeyKey: 'checkout_reminder', templateVersion: 1, defaultEnabled: true, required: false, priority: 80, slotDefaults: {} },
    ],
    offerMenuDefaults: [],
    questionKeys: [],
    estimateHints: { avgTouchesPerGuest: { wifi_info_card: 1, checkout_reminder: 1 }, returnRate: 0, avgSpend: { amountMinor: 0, currency: 'CHF' } },
  },
};

export const PLAYBOOKS_V1: PlaybookSeed[] = [restaurantGrowth, airbnbStay, localBusiness, guestInfo];
