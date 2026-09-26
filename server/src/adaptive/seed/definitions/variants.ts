/**
 * Platform wording for every pool of the available journeys, English + German,
 * SMS + email. Offer labels are written so they read in the nominative
 * ("… wartet ein Gratis-Dessert auf dich"), so German stays grammatical whatever
 * the owner picks. The engine adds the STOP line (SMS) and the unsubscribe footer
 * (email); they are not part of the wording.
 *
 * No WhatsApp wording yet: every catalogue template is still `not_submitted`
 * (cms/docs/whatsapp-templates/registry.json), and WhatsApp can only send
 * approved templates.
 */

import type { VariantSeedInput } from './types';

const HI_EN = 'Hi {{contact.firstName | default:"there"}}';
const HI_DE = 'Hallo {{contact.firstName | default:"du"}}';

export const VARIANTS_V1: VariantSeedInput[] = [
  // ── Welcome → come back ────────────────────────────────────────────────────
  {
    poolKey: 'welcome_offer',
    journeyKey: 'welcome_second_visit',
    letter: 'A',
    name: 'Friendly & short',
    purpose: 'marketing',
    axes: { hook: 'reciprocity', length: 'short', tone: 'playful', emoji: true },
    channels: {
      sms: { text: `${HI_EN}, thanks for visiting {{venue.name}}! Come back within {{offer.days}} days for {{offer.label}} 🎁 {{link.offer}}` },
      email: {
        subject: 'A little thank-you from {{venue.name}}',
        preheader: 'Something for your next visit',
        bodyFormat: 'text',
        body: `${HI_EN},\n\nthanks for stopping by {{venue.name}}! Come back within {{offer.days}} days and enjoy {{offer.label}} on us.\n\nShow this when you're here: {{link.offer}}\n\nSee you soon,\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `${HI_DE}, danke für deinen Besuch bei {{venue.name}}! Komm innert {{offer.days}} Tagen wieder – dann wartet {{offer.label}} auf dich 🎁 {{link.offer}}` },
        email: {
          subject: 'Ein kleines Dankeschön von {{venue.name}}',
          preheader: 'Etwas für deinen nächsten Besuch',
          bodyFormat: 'text',
          body: `${HI_DE},\n\ndanke für deinen Besuch bei {{venue.name}}! Komm innert {{offer.days}} Tagen wieder – dann wartet {{offer.label}} auf dich, aufs Haus.\n\nZeig das einfach vor Ort: {{link.offer}}\n\nBis bald,\n{{venue.name}}`,
        },
      },
    },
  },
  {
    poolKey: 'welcome_offer',
    journeyKey: 'welcome_second_visit',
    letter: 'B',
    name: 'Scarcity',
    purpose: 'marketing',
    axes: { hook: 'scarcity', length: 'short', tone: 'direct', emoji: false },
    channels: {
      sms: { text: `{{venue.name}}: there's {{offer.label}} waiting for you on your next visit – valid until {{offer.expiryDate | date:"d.M."}} {{link.offer}}` },
      email: {
        subject: 'Your offer is waiting until {{offer.expiryDate | date:"d.M."}}',
        preheader: 'Only valid for a few days',
        bodyFormat: 'text',
        body: `${HI_EN},\n\nthere's {{offer.label}} waiting for you at {{venue.name}} – but only until {{offer.expiryDate | date:"d.M."}}\n\nYour offer: {{link.offer}}\n\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `{{venue.name}}: Bei deinem nächsten Besuch wartet {{offer.label}} auf dich – gültig bis {{offer.expiryDate | date:"d.M."}} {{link.offer}}` },
        email: {
          subject: 'Dein Angebot wartet bis {{offer.expiryDate | date:"d.M."}}',
          preheader: 'Nur ein paar Tage gültig',
          bodyFormat: 'text',
          body: `${HI_DE},\n\nbei {{venue.name}} wartet {{offer.label}} auf dich – aber nur bis {{offer.expiryDate | date:"d.M."}}\n\nDein Angebot: {{link.offer}}\n\n{{venue.name}}`,
        },
      },
    },
  },
  {
    poolKey: 'last_chance',
    journeyKey: 'welcome_second_visit',
    letter: 'A',
    name: 'Gentle reminder',
    purpose: 'marketing',
    axes: { hook: 'reminder', length: 'short', tone: 'warm', emoji: false },
    channels: {
      sms: { text: `${HI_EN}, a quick reminder: your offer at {{venue.name}} is valid until {{offer.expiryDate | date:"d.M."}} {{link.offer}}` },
      email: {
        subject: 'Only a few days left for your offer',
        preheader: 'We would love to see you again',
        bodyFormat: 'text',
        body: `${HI_EN},\n\nyour offer at {{venue.name}} – {{offer.label}} – is valid until {{offer.expiryDate | date:"d.M."}} We'd love to see you again!\n\n{{link.offer}}\n\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `${HI_DE}, kleine Erinnerung: Dein Angebot bei {{venue.name}} gilt noch bis {{offer.expiryDate | date:"d.M."}} {{link.offer}}` },
        email: {
          subject: 'Nur noch wenige Tage für dein Angebot',
          preheader: 'Wir freuen uns auf dich',
          bodyFormat: 'text',
          body: `${HI_DE},\n\ndein Angebot bei {{venue.name}} – {{offer.label}} – gilt noch bis {{offer.expiryDate | date:"d.M."}} Wir freuen uns auf dich!\n\n{{link.offer}}\n\n{{venue.name}}`,
        },
      },
    },
  },
  {
    poolKey: 'thank_you',
    journeyKey: 'welcome_second_visit',
    letter: 'A',
    name: 'Warm thanks',
    purpose: 'service',
    axes: { hook: 'gratitude', length: 'short', tone: 'warm', emoji: false },
    channels: {
      sms: { text: 'Thanks for coming back to {{venue.name}}, {{contact.firstName | default:"dear guest"}}! We hope you enjoyed it.' },
      email: {
        subject: 'Thanks for coming back!',
        preheader: 'It was great to see you again',
        bodyFormat: 'text',
        body: `${HI_EN},\n\nthanks for coming back to {{venue.name}} – it was great to see you again.\n\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: 'Danke, dass du wieder bei {{venue.name}} warst, {{contact.firstName | default:"lieber Gast"}}! Wir hoffen, es hat dir gefallen.' },
        email: {
          subject: 'Danke, dass du wiedergekommen bist!',
          preheader: 'Schön, dich wiederzusehen',
          bodyFormat: 'text',
          body: `${HI_DE},\n\ndanke, dass du wieder bei {{venue.name}} warst – schön, dich wiederzusehen.\n\n{{venue.name}}`,
        },
      },
    },
  },

  // ── Review ask ─────────────────────────────────────────────────────────────
  {
    poolKey: 'review_ask',
    journeyKey: 'review_ask',
    letter: 'A',
    name: 'Quick tap',
    purpose: 'marketing',
    axes: { hook: 'ease', length: 'short', tone: 'friendly', emoji: false },
    channels: {
      sms: { text: `${HI_EN}, how was your visit to {{venue.name}}? Tap a star: {{link.rating}}` },
      email: {
        subject: 'How was your visit to {{venue.name}}?',
        preheader: 'It takes one tap',
        bodyFormat: 'text',
        body: `${HI_EN},\n\nthanks for visiting {{venue.name}}! How was it? It takes one tap: {{link.rating}}\n\nEvery guest can also leave a public review on Google.\n\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `${HI_DE}, wie war dein Besuch bei {{venue.name}}? Tipp auf einen Stern: {{link.rating}}` },
        email: {
          subject: 'Wie war dein Besuch bei {{venue.name}}?',
          preheader: 'Ein Tipp genügt',
          bodyFormat: 'text',
          body: `${HI_DE},\n\ndanke für deinen Besuch bei {{venue.name}}! Wie war's? Ein Tipp genügt: {{link.rating}}\n\nAlle Gäste können auch eine öffentliche Bewertung auf Google hinterlassen.\n\n{{venue.name}}`,
        },
      },
    },
  },

  // ── Stay guide ─────────────────────────────────────────────────────────────
  {
    poolKey: 'stay_welcome',
    journeyKey: 'stay_guide',
    letter: 'A',
    name: 'Arrival welcome',
    purpose: 'service',
    axes: { hook: 'helpful', length: 'short', tone: 'warm', emoji: false },
    channels: {
      sms: { text: 'Welcome to {{venue.name}}, {{contact.firstName | default:"dear guest"}}! Wi-Fi, house info and check-out time: {{link.hub}}' },
      email: {
        subject: 'Welcome to {{venue.name}}',
        preheader: 'Everything for your stay in one place',
        bodyFormat: 'text',
        body: `${HI_EN},\n\nwelcome! Everything for your stay is here – Wi-Fi, house rules and check-out time:\n\n{{link.hub}}\n\nEnjoy your stay,\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: 'Herzlich willkommen, {{contact.firstName | default:"lieber Gast"}}! WLAN, Hausinfos und Check-out-Zeit für {{venue.name}}: {{link.hub}}' },
        email: {
          subject: 'Willkommen – {{venue.name}}',
          preheader: 'Alles für deinen Aufenthalt an einem Ort',
          bodyFormat: 'text',
          body: `${HI_DE},\n\nherzlich willkommen! Hier findest du alles für deinen Aufenthalt – WLAN, Hausregeln und Check-out-Zeit:\n\n{{link.hub}}\n\nEinen schönen Aufenthalt,\n{{venue.name}}`,
        },
      },
    },
  },
  {
    poolKey: 'stay_midstay',
    journeyKey: 'stay_guide',
    letter: 'A',
    name: 'Everything OK?',
    purpose: 'service',
    axes: { hook: 'care', length: 'short', tone: 'warm', emoji: false },
    channels: {
      sms: { text: `${HI_EN}, is everything OK at {{venue.name}}? If you need anything, reach us here: {{guestinfo.hostContactUrl}}` },
      email: {
        subject: 'Is everything OK?',
        preheader: 'A quick check from your host',
        bodyFormat: 'text',
        body: `${HI_EN},\n\njust checking in – is everything OK at {{venue.name}}? If you need anything, reach us here: {{guestinfo.hostContactUrl}}\n\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `${HI_DE}, ist in {{venue.name}} alles in Ordnung? Wenn du etwas brauchst, erreichst du uns hier: {{guestinfo.hostContactUrl}}` },
        email: {
          subject: 'Ist alles in Ordnung?',
          preheader: 'Kurze Nachfrage von deinem Gastgeber',
          bodyFormat: 'text',
          body: `${HI_DE},\n\nwir wollten kurz nachfragen – ist in {{venue.name}} alles in Ordnung? Wenn du etwas brauchst, erreichst du uns hier: {{guestinfo.hostContactUrl}}\n\n{{venue.name}}`,
        },
      },
    },
  },
  {
    poolKey: 'stay_checkout',
    journeyKey: 'stay_guide',
    letter: 'A',
    name: 'Checkout instructions',
    purpose: 'service',
    axes: { hook: 'helpful', length: 'medium', tone: 'clear', emoji: false },
    channels: {
      sms: { text: `${HI_EN}, check-out tomorrow is at {{guestinfo.checkOutTime}}. Want to stay longer? Late check-out until 14:00 is CHF {{slot.late_checkout_price}} – ask your host: {{guestinfo.hostContactUrl}}` },
      email: {
        subject: 'Your check-out tomorrow',
        preheader: 'Time and a few simple steps',
        bodyFormat: 'text',
        body: `${HI_EN},\n\ncheck-out tomorrow is at {{guestinfo.checkOutTime}}. The details are here: {{link.hub}}\n\nWant to stay longer? Late check-out until 14:00 is CHF {{slot.late_checkout_price}} – just ask your host: {{guestinfo.hostContactUrl}}\n\nSafe travels,\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `${HI_DE}, morgen ist Check-out um {{guestinfo.checkOutTime}}. Länger bleiben? Später Check-out bis 14:00 kostet CHF {{slot.late_checkout_price}} – frag deinen Gastgeber: {{guestinfo.hostContactUrl}}` },
        email: {
          subject: 'Dein Check-out morgen',
          preheader: 'Zeit und ein paar einfache Schritte',
          bodyFormat: 'text',
          body: `${HI_DE},\n\nmorgen ist Check-out um {{guestinfo.checkOutTime}}. Alle Details findest du hier: {{link.hub}}\n\nLänger bleiben? Später Check-out bis 14:00 kostet CHF {{slot.late_checkout_price}} – frag einfach deinen Gastgeber: {{guestinfo.hostContactUrl}}\n\nGute Reise,\n{{venue.name}}`,
        },
      },
    },
  },

  // PR C, wording fix #1: the checkout message without the late-checkout sentence, used when
  // the owner's late-checkout price is 0 or cleared (D-C22). A is never picked then (it uses
  // {{slot.late_checkout_price}}); B only then.
  {
    poolKey: 'stay_checkout',
    journeyKey: 'stay_guide',
    letter: 'B',
    name: 'Checkout instructions (no late check-out)',
    purpose: 'service',
    axes: { hook: 'helpful', length: 'short', tone: 'clear', emoji: false },
    when: { not: { fact: 'slot.late_checkout_price', gt: 0 } },
    channels: {
      sms: { text: `${HI_EN}, check-out tomorrow is at {{guestinfo.checkOutTime}}. Need anything? Ask your host: {{guestinfo.hostContactUrl}}` },
      email: {
        subject: 'Your check-out tomorrow',
        preheader: 'Time and a few simple steps',
        bodyFormat: 'text',
        body: `${HI_EN},\n\ncheck-out tomorrow is at {{guestinfo.checkOutTime}}. The details are here: {{link.hub}}\n\nNeed anything before you leave? Just ask your host: {{guestinfo.hostContactUrl}}\n\nSafe travels,\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `${HI_DE}, morgen ist Check-out um {{guestinfo.checkOutTime}}. Brauchst du noch etwas? Frag deinen Gastgeber: {{guestinfo.hostContactUrl}}` },
        email: {
          subject: 'Dein Check-out morgen',
          preheader: 'Zeit und ein paar einfache Schritte',
          bodyFormat: 'text',
          body: `${HI_DE},\n\nmorgen ist Check-out um {{guestinfo.checkOutTime}}. Alle Details findest du hier: {{link.hub}}\n\nBrauchst du vor der Abreise noch etwas? Frag einfach deinen Gastgeber: {{guestinfo.hostContactUrl}}\n\nGute Reise,\n{{venue.name}}`,
        },
      },
    },
  },

  // ── Local tips, stay review, book direct ───────────────────────────────────
  {
    poolKey: 'local_tips',
    journeyKey: 'stay_local_tips',
    letter: 'A',
    name: 'Our favourite places',
    purpose: 'marketing',
    axes: { hook: 'insider', length: 'short', tone: 'friendly', emoji: false },
    channels: {
      email: {
        subject: 'Our favourite places near {{venue.name}}',
        preheader: 'Cafés, walks and a great dinner spot',
        bodyFormat: 'text',
        body: `${HI_EN},\n\nhere are our favourite places nearby – cafés, walks and a great spot for dinner: {{link.hub}}\n\nHave a lovely day,\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        email: {
          subject: 'Unsere Lieblingsorte rund um {{venue.name}}',
          preheader: 'Cafés, Spaziergänge und ein tolles Restaurant',
          bodyFormat: 'text',
          body: `${HI_DE},\n\nhier sind unsere Lieblingsorte in der Nähe – Cafés, Spaziergänge und ein tolles Restaurant fürs Abendessen: {{link.hub}}\n\nEinen schönen Tag,\n{{venue.name}}`,
        },
      },
    },
  },
  {
    poolKey: 'stay_review',
    journeyKey: 'stay_review',
    letter: 'A',
    name: 'After your stay',
    purpose: 'marketing',
    axes: { hook: 'ease', length: 'short', tone: 'friendly', emoji: false },
    channels: {
      sms: { text: `Thanks for staying at {{venue.name}}, {{contact.firstName | default:"dear guest"}}! How was it? Tap a star: {{link.rating}}` },
      email: {
        subject: 'How was your stay at {{venue.name}}?',
        preheader: 'It takes one tap',
        bodyFormat: 'text',
        body: `${HI_EN},\n\nthanks for staying at {{venue.name}}! How was it? It takes one tap: {{link.rating}}\n\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `Danke für deinen Aufenthalt in {{venue.name}}, {{contact.firstName | default:"lieber Gast"}}! Wie war's? Tipp auf einen Stern: {{link.rating}}` },
        email: {
          subject: 'Wie war dein Aufenthalt in {{venue.name}}?',
          preheader: 'Ein Tipp genügt',
          bodyFormat: 'text',
          body: `${HI_DE},\n\ndanke für deinen Aufenthalt in {{venue.name}}! Wie war's? Ein Tipp genügt: {{link.rating}}\n\n{{venue.name}}`,
        },
      },
    },
  },
  {
    poolKey: 'book_direct',
    journeyKey: 'stay_book_direct',
    letter: 'A',
    name: 'Book direct and save',
    purpose: 'marketing',
    axes: { hook: 'value', length: 'short', tone: 'warm', emoji: false },
    channels: {
      sms: { text: 'Loved your stay at {{venue.name}}? Book directly next time and get {{offer.label}}: {{link.booking}}' },
      email: {
        subject: 'Come back to {{venue.name}} – and save',
        preheader: 'Your direct-booking offer',
        bodyFormat: 'text',
        body: `${HI_EN},\n\nwe hope you loved your stay at {{venue.name}}. Next time, book directly with us and get {{offer.label}}:\n\n{{link.booking}}\n\nValid for {{offer.days}} days.\n\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: 'Hat dir {{venue.name}} gefallen? Buch nächstes Mal direkt bei uns – dann gibt es {{offer.label}}: {{link.booking}}' },
        email: {
          subject: 'Komm wieder nach {{venue.name}} – und spar',
          preheader: 'Dein Angebot für Direktbuchungen',
          bodyFormat: 'text',
          body: `${HI_DE},\n\nwir hoffen, dein Aufenthalt in {{venue.name}} hat dir gefallen. Wenn du das nächste Mal direkt bei uns buchst, gibt es {{offer.label}}:\n\n{{link.booking}}\n\n{{offer.days}} Tage gültig.\n\n{{venue.name}}`,
        },
      },
    },
  },

  // ── Guest info ─────────────────────────────────────────────────────────────
  {
    poolKey: 'wifi_info',
    journeyKey: 'wifi_info_card',
    letter: 'A',
    name: 'Info card',
    purpose: 'service',
    axes: { hook: 'helpful', length: 'short', tone: 'clear', emoji: false },
    channels: {
      sms: { text: "Welcome to {{venue.name}}! You're online on {{guestinfo.wifiName}}. Menu, opening hours and more: {{link.hub}}" },
      email: {
        subject: "You're online at {{venue.name}}",
        preheader: 'Wi-Fi details and house info',
        bodyFormat: 'text',
        body: `${HI_EN},\n\nyou're online at {{venue.name}} on the {{guestinfo.wifiName}} network. Menu, opening hours and everything else: {{link.hub}}\n\nEnjoy your visit,\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: 'Willkommen bei {{venue.name}}! Du bist im WLAN {{guestinfo.wifiName}} online. Menü, Öffnungszeiten und mehr: {{link.hub}}' },
        email: {
          subject: 'Du bist online bei {{venue.name}}',
          preheader: 'WLAN-Details und Hausinfos',
          bodyFormat: 'text',
          body: `${HI_DE},\n\ndu bist bei {{venue.name}} im WLAN {{guestinfo.wifiName}} online. Menü, Öffnungszeiten und alles Weitere: {{link.hub}}\n\nViel Spass bei deinem Besuch,\n{{venue.name}}`,
        },
      },
    },
  },
  {
    poolKey: 'checkout_info',
    journeyKey: 'checkout_reminder',
    letter: 'A',
    name: 'Checkout reminder',
    purpose: 'service',
    axes: { hook: 'helpful', length: 'short', tone: 'clear', emoji: false },
    channels: {
      sms: { text: `${HI_EN}, a reminder: check-out tomorrow is at {{guestinfo.checkOutTime}}. Everything you need: {{link.hub}}` },
      email: {
        subject: 'Check-out tomorrow at {{guestinfo.checkOutTime}}',
        preheader: 'A short reminder',
        bodyFormat: 'text',
        body: `${HI_EN},\n\na short reminder: check-out tomorrow is at {{guestinfo.checkOutTime}}. Everything you need is here: {{link.hub}}\n\nThank you for staying with us,\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `${HI_DE}, kleine Erinnerung: Morgen ist Check-out um {{guestinfo.checkOutTime}}. Alles Wichtige: {{link.hub}}` },
        email: {
          subject: 'Check-out morgen um {{guestinfo.checkOutTime}}',
          preheader: 'Eine kurze Erinnerung',
          bodyFormat: 'text',
          body: `${HI_DE},\n\neine kurze Erinnerung: Morgen ist Check-out um {{guestinfo.checkOutTime}}. Alles Wichtige findest du hier: {{link.hub}}\n\nDanke, dass du bei uns warst,\n{{venue.name}}`,
        },
      },
    },
  },
];

// ── Venue-neutral Wi-Fi card (PR E follow-up, decision E-D10) ────────────────
// The Wi-Fi card goes out at every venue type (journeysGuestInfo.ts), so it no longer promises
// a menu and opening hours (an Airbnb has neither): SMS and email share one neutral line that
// fits every venue type (EN "Everything you need to know:", DE "Alles Wichtige:"). Patched here,
// when this module loads — before the seed reads the list (definitions/index.ts imports
// VARIANTS_V1 from this module) — with the same blanks, so the stored `mergeFieldsUsed` stays
// right. The seed only creates missing docs: where it already ran, the stored wording is edited
// by hand (docs/adaptive-api.md, "Seed").
// Never throws: this module loads at server boot.
const WIFI_CARD = VARIANTS_V1.find((v) => v.poolKey === 'wifi_info' && v.letter === 'A');
if (WIFI_CARD) {
  const en = WIFI_CARD.channels;
  if (en.sms) en.sms = { ...en.sms, text: "Welcome to {{venue.name}}! You're online on {{guestinfo.wifiName}}. Everything you need to know: {{link.hub}}" };
  if (en.email) {
    en.email = {
      ...en.email,
      body: `${HI_EN},\n\nyou're online at {{venue.name}} on the {{guestinfo.wifiName}} network. Everything you need to know: {{link.hub}}\n\nEnjoy your visit,\n{{venue.name}}`,
    };
  }
  const de = WIFI_CARD.locales?.de;
  if (de?.sms) de.sms = { ...de.sms, text: 'Willkommen bei {{venue.name}}! Du bist im WLAN {{guestinfo.wifiName}} online. Alles Wichtige: {{link.hub}}' };
  if (de?.email) {
    de.email = {
      ...de.email,
      body: `${HI_DE},\n\ndu bist bei {{venue.name}} im WLAN {{guestinfo.wifiName}} online. Alles Wichtige: {{link.hub}}\n\nViel Spass bei deinem Besuch,\n{{venue.name}}`,
    };
  }
}
