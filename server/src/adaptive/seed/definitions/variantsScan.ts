/**
 * PR S: platform wording for the four scan journeys (Win-back, Birthday, Slow-time filler,
 * Holidays), English + German, SMS + email. Same rules as variants.ts: German "du", Swiss "ss",
 * offer labels read in the nominative; SMS text is plain GSM-7 (no emoji, no typographic
 * dashes — PR F0), the engine adds the STOP line and the email unsubscribe footer.
 *
 * Occasion merge fields (core/scans/occasions.ts): `holiday.name`, `holiday.day`
 * ("Saturday 14 February" / "Samstag, 14. Februar"), `slow.when` ("this Tuesday afternoon" /
 * "diesen Dienstagnachmittag").
 */

import type { VariantSeedInput } from './types';

const HI_EN = 'Hi {{contact.firstName | default:"there"}}';
const HI_DE = 'Hallo {{contact.firstName | default:"du"}}';
const UNTIL = '{{offer.expiryDate | date:"d.M."}}';

export const VARIANTS_SCAN: VariantSeedInput[] = [
  // ── Win-back ───────────────────────────────────────────────────────────────
  {
    poolKey: 'winback',
    journeyKey: 'win_back',
    letter: 'A',
    name: 'We miss you',
    purpose: 'marketing',
    axes: { hook: 'reciprocity', length: 'short', tone: 'warm', emoji: false },
    channels: {
      sms: { text: `${HI_EN}, we miss you at {{venue.name}}! Come back by ${UNTIL} and enjoy {{offer.label}}: {{link.offer}}` },
      email: {
        subject: 'We miss you at {{venue.name}}',
        preheader: 'Something for your next visit',
        bodyFormat: 'text',
        body: `${HI_EN},\n\nit's been a while since your last visit to {{venue.name}} – we'd love to see you again! Come back by ${UNTIL} and enjoy {{offer.label}}.\n\nShow this when you're here: {{link.offer}}\n\nSee you soon,\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `${HI_DE}, wir vermissen dich bei {{venue.name}}! Komm bis ${UNTIL} vorbei, dann wartet {{offer.label}} auf dich: {{link.offer}}` },
        email: {
          subject: 'Wir vermissen dich bei {{venue.name}}',
          preheader: 'Etwas für deinen nächsten Besuch',
          bodyFormat: 'text',
          body: `${HI_DE},\n\ndein letzter Besuch bei {{venue.name}} ist eine Weile her – wir würden uns freuen, dich wiederzusehen! Komm bis ${UNTIL} vorbei, dann wartet {{offer.label}} auf dich.\n\nZeig das einfach vor Ort: {{link.offer}}\n\nBis bald,\n{{venue.name}}`,
        },
      },
    },
  },

  // ── Birthday ───────────────────────────────────────────────────────────────
  {
    poolKey: 'birthday',
    journeyKey: 'birthday',
    letter: 'A',
    name: 'Birthday gift',
    purpose: 'marketing',
    axes: { hook: 'gift', length: 'short', tone: 'warm', emoji: false },
    channels: {
      sms: { text: `Happy birthday month, {{contact.firstName | default:"dear guest"}}! {{venue.name}} has {{offer.label}} for you until ${UNTIL}: {{link.offer}}` },
      email: {
        subject: 'A birthday gift from {{venue.name}}',
        preheader: `Valid until ${UNTIL}`,
        bodyFormat: 'text',
        body: `${HI_EN},\n\nit's your birthday month – happy birthday! Come by {{venue.name}} by ${UNTIL} and enjoy {{offer.label}} on us.\n\nYour gift: {{link.offer}}\n\nCheers,\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `Alles Gute im Geburtstagsmonat, {{contact.firstName | default:"lieber Gast"}}! Bei {{venue.name}} wartet bis ${UNTIL} {{offer.label}} auf dich: {{link.offer}}` },
        email: {
          subject: 'Ein Geburtstagsgeschenk von {{venue.name}}',
          preheader: `Gültig bis ${UNTIL}`,
          bodyFormat: 'text',
          body: `${HI_DE},\n\nes ist dein Geburtstagsmonat – alles Gute! Komm bis ${UNTIL} bei {{venue.name}} vorbei, dann wartet {{offer.label}} auf dich, aufs Haus.\n\nDein Geschenk: {{link.offer}}\n\nHerzliche Grüsse,\n{{venue.name}}`,
        },
      },
    },
  },

  // ── Slow-time filler ───────────────────────────────────────────────────────
  {
    poolKey: 'slow_day',
    journeyKey: 'quiet_hours_filler',
    letter: 'A',
    name: 'Calm time',
    purpose: 'marketing',
    axes: { hook: 'convenience', length: 'short', tone: 'friendly', emoji: false },
    channels: {
      sms: { text: `${HI_EN}, it's nice and calm at {{venue.name}} {{slow.when}}. Come by and enjoy {{offer.label}} (until ${UNTIL}): {{link.offer}}` },
      email: {
        subject: 'Come by {{slow.when}}',
        preheader: 'And {{offer.label}} with it',
        bodyFormat: 'text',
        body: `${HI_EN},\n\nit's nice and calm at {{venue.name}} {{slow.when}} – the perfect time to come by. Enjoy {{offer.label}} (valid until ${UNTIL}).\n\nShow this when you're here: {{link.offer}}\n\nSee you soon,\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `${HI_DE}, {{slow.when}} ist es bei {{venue.name}} schön ruhig. Komm vorbei, dann wartet {{offer.label}} auf dich (bis ${UNTIL}): {{link.offer}}` },
        email: {
          subject: 'Komm {{slow.when}} vorbei',
          preheader: 'Mit einem kleinen Extra',
          bodyFormat: 'text',
          body: `${HI_DE},\n\nbei {{venue.name}} ist es {{slow.when}} schön ruhig – die perfekte Zeit für einen Besuch. Dann wartet {{offer.label}} auf dich (gültig bis ${UNTIL}).\n\nZeig das einfach vor Ort: {{link.offer}}\n\nBis bald,\n{{venue.name}}`,
        },
      },
    },
  },

  // ── Holidays ───────────────────────────────────────────────────────────────
  // A carries the owner's booking link (`link.booking`, minted from the booking-link blank),
  // B is for venues without one.
  {
    poolKey: 'holiday',
    journeyKey: 'holidays',
    letter: 'A',
    name: 'Book your table',
    purpose: 'marketing',
    axes: { hook: 'scarcity', length: 'short', tone: 'friendly', emoji: false },
    // The owner's booking link, as a tracked short link (clicks count).
    when: { all: [{ fact: 'slot.booking_url', exists: true }, { fact: 'slot.booking_url', ne: '' }] },
    channels: {
      sms: { text: `${HI_EN}, {{holiday.name}} is on {{holiday.day}}. Book your table at {{venue.name}} now: {{link.booking}}` },
      email: {
        subject: '{{holiday.name}} at {{venue.name}}',
        preheader: 'Book your table now',
        bodyFormat: 'text',
        body: `${HI_EN},\n\n{{holiday.name}} is on {{holiday.day}} – and tables at {{venue.name}} go quickly. Book yours now:\n\n{{link.booking}}\n\nWe look forward to seeing you,\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `${HI_DE}, am {{holiday.day}} ist {{holiday.name}}. Reserviere jetzt deinen Tisch bei {{venue.name}}: {{link.booking}}` },
        email: {
          subject: '{{holiday.name}} bei {{venue.name}}',
          preheader: 'Reserviere jetzt deinen Tisch',
          bodyFormat: 'text',
          body: `${HI_DE},\n\nam {{holiday.day}} ist {{holiday.name}} – und die Tische bei {{venue.name}} sind schnell weg. Reserviere jetzt deinen:\n\n{{link.booking}}\n\nWir freuen uns auf dich,\n{{venue.name}}`,
        },
      },
    },
  },
  {
    poolKey: 'holiday',
    journeyKey: 'holidays',
    letter: 'B',
    name: 'Book early (no link)',
    purpose: 'marketing',
    axes: { hook: 'scarcity', length: 'short', tone: 'friendly', emoji: false },
    when: { any: [{ fact: 'slot.booking_url', exists: false }, { fact: 'slot.booking_url', eq: '' }] },
    channels: {
      sms: { text: `${HI_EN}, {{holiday.name}} is on {{holiday.day}}. Book your table at {{venue.name}} early, big days fill up fast!` },
      email: {
        subject: '{{holiday.name}} at {{venue.name}}',
        preheader: 'Book your table early',
        bodyFormat: 'text',
        body: `${HI_EN},\n\n{{holiday.name}} is on {{holiday.day}} – and tables at {{venue.name}} go quickly. Book yours early, we look forward to seeing you!\n\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `${HI_DE}, am {{holiday.day}} ist {{holiday.name}}. Reserviere früh deinen Tisch bei {{venue.name}}, solche Tage sind schnell ausgebucht!` },
        email: {
          subject: '{{holiday.name}} bei {{venue.name}}',
          preheader: 'Reserviere früh deinen Tisch',
          bodyFormat: 'text',
          body: `${HI_DE},\n\nam {{holiday.day}} ist {{holiday.name}} – und die Tische bei {{venue.name}} sind schnell weg. Reserviere früh, wir freuen uns auf dich!\n\n{{venue.name}}`,
        },
      },
    },
  },
];
