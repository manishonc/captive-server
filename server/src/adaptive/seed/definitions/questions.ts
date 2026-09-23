/**
 * The one-tap question bank (PRD SP-2), as drafted in the admin prototype.
 * Playbooks only store which keys they use; the splash asks them in a later release.
 */

import type { Question } from '../../core/schemas';

const ALL = ['restaurant', 'cafe', 'airbnb', 'other'] as Question['venueTypes'];
const DINING = ['restaurant', 'cafe', 'other'] as Question['venueTypes'];

const MONTHS: Array<[string, string, string]> = [
  ['jan', 'January', 'Januar'],
  ['feb', 'February', 'Februar'],
  ['mar', 'March', 'März'],
  ['apr', 'April', 'April'],
  ['may', 'May', 'Mai'],
  ['jun', 'June', 'Juni'],
  ['jul', 'July', 'Juli'],
  ['aug', 'August', 'August'],
  ['sep', 'September', 'September'],
  ['oct', 'October', 'Oktober'],
  ['nov', 'November', 'November'],
  ['dec', 'December', 'Dezember'],
];

export const QUESTIONS_V1: Question[] = [
  {
    key: 'visit_type',
    status: 'active',
    prompt: { en: 'Are you visiting or local?', de: 'Bist du zu Besuch oder aus der Gegend?' },
    chips: [
      { value: 'visiting', label: { en: 'Visiting', de: 'Zu Besuch' } },
      { value: 'local', label: { en: 'Local', de: 'Aus der Gegend' } },
    ],
    multi: false,
    maxPicks: 1,
    writesTag: 'visit_type',
    staleAfterDays: 60,
    venueTypes: ALL,
    sortOrder: 10,
  },
  {
    key: 'occasion',
    status: 'active',
    prompt: { en: 'What brings you here today?', de: 'Was führt dich heute zu uns?' },
    chips: [
      { value: 'business', label: { en: 'Business', de: 'Geschäftlich' } },
      { value: 'date', label: { en: 'A date', de: 'Ein Date' } },
      { value: 'friends', label: { en: 'Friends', de: 'Mit Freunden' } },
      { value: 'family', label: { en: 'Family', de: 'Familie' } },
      { value: 'solo', label: { en: 'Just me', de: 'Allein' } },
    ],
    multi: false,
    maxPicks: 1,
    writesTag: 'occasion',
    staleAfterDays: 60,
    venueTypes: DINING,
    sortOrder: 20,
  },
  {
    key: 'interests',
    status: 'active',
    prompt: { en: 'What do you like to do around here?', de: 'Was unternimmst du gern in der Gegend?' },
    chips: [
      { value: 'food', label: { en: 'Food & drink', de: 'Essen & Trinken' } },
      { value: 'outdoors', label: { en: 'Outdoors', de: 'Natur' } },
      { value: 'culture', label: { en: 'Culture', de: 'Kultur' } },
      { value: 'shopping', label: { en: 'Shopping', de: 'Shopping' } },
      { value: 'wellness', label: { en: 'Wellness', de: 'Wellness' } },
    ],
    multi: true,
    maxPicks: 3,
    writesTag: 'interests',
    staleAfterDays: 60,
    venueTypes: ALL,
    sortOrder: 30,
  },
  {
    key: 'birthday_month',
    status: 'active',
    prompt: { en: 'Want a birthday treat? Which month?', de: 'Lust auf eine Geburtstagsüberraschung? Welcher Monat?' },
    chips: MONTHS.map(([value, en, de]) => ({ value, label: { en, de } })),
    multi: false,
    maxPicks: 1,
    writesTag: 'birthday_month',
    staleAfterDays: null,
    venueTypes: DINING,
    sortOrder: 40,
  },
  {
    key: 'diet',
    status: 'active',
    prompt: { en: 'Any food preferences?', de: 'Hast du Ernährungsvorlieben?' },
    chips: [
      { value: 'vegetarian', label: { en: 'Vegetarian', de: 'Vegetarisch' } },
      { value: 'vegan', label: { en: 'Vegan', de: 'Vegan' } },
      { value: 'gluten_free', label: { en: 'Gluten-free', de: 'Glutenfrei' } },
      { value: 'halal', label: { en: 'Halal', de: 'Halal' } },
      { value: 'none', label: { en: 'No preference', de: 'Keine' } },
    ],
    multi: true,
    maxPicks: 3,
    writesTag: 'diet',
    staleAfterDays: null,
    venueTypes: DINING,
    sortOrder: 50,
  },
  {
    key: 'stay_length',
    status: 'active',
    prompt: { en: 'How long are you in town?', de: 'Wie lange bist du in der Gegend?' },
    chips: [
      { value: 'day', label: { en: 'One day', de: 'Einen Tag' } },
      { value: 'few_days', label: { en: '2–3 days', de: '2–3 Tage' } },
      { value: 'week', label: { en: 'A week', de: 'Eine Woche' } },
      { value: 'longer', label: { en: 'Longer', de: 'Länger' } },
    ],
    multi: false,
    maxPicks: 1,
    writesTag: 'stay_length',
    staleAfterDays: 60,
    venueTypes: ALL,
    sortOrder: 60,
  },
  {
    key: 'source',
    status: 'draft',
    prompt: { en: 'How did you find us?', de: 'Wie hast du uns gefunden?' },
    chips: [
      { value: 'google', label: { en: 'Google', de: 'Google' } },
      { value: 'friends', label: { en: 'Friends', de: 'Freunde' } },
      { value: 'walk_by', label: { en: 'Walking by', de: 'Vorbeigelaufen' } },
      { value: 'social', label: { en: 'Social media', de: 'Social Media' } },
    ],
    multi: false,
    maxPicks: 1,
    writesTag: 'source',
    staleAfterDays: null,
    venueTypes: ALL,
    sortOrder: 70,
  },
];
