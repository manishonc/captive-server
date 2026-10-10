/**
 * PR A7: platform wording for Bring-a-friend (`referral_invite`) and the Friend reward
 * (`friend_reward`, `reward_thanks`), English + German, SMS + email. Same rules as variants.ts:
 * German "du", Swiss "ss", offer labels read in the nominative; SMS text is plain GSM-7 (no
 * emoji, no typographic dashes — PR F0); the engine adds the STOP line and the unsubscribe footer.
 *
 * `{{referral.code}}` is the regular's personal code (minted at send time). The friend's offer is
 * the invite's `friend_offer` blank (`{{slot.friend_offer}}`); the regular's reward is the issued
 * offer (`{{offer.label}}`). The regular is never told who the friend was.
 */

import type { VariantSeedInput } from './types';

const HI_EN = 'Hi {{contact.firstName | default:"there"}}';
const HI_DE = 'Hallo {{contact.firstName | default:"du"}}';
const UNTIL = '{{offer.expiryDate | date:"d.M."}}';

export const VARIANTS_REFERRAL: VariantSeedInput[] = [
  // ── Bring a friend ─────────────────────────────────────────────────────────
  {
    poolKey: 'referral_invite',
    journeyKey: 'bring_a_friend',
    letter: 'A',
    name: 'Your code to share',
    purpose: 'marketing',
    axes: { hook: 'reciprocity', length: 'short', tone: 'warm', emoji: false },
    channels: {
      sms: { text: `${HI_EN}, bring a friend to {{venue.name}}! With your code {{referral.code}} at the Wi-Fi login they get {{slot.friend_offer}} - and you get a reward too.` },
      email: {
        subject: 'Bring a friend to {{venue.name}}',
        preheader: 'Your personal code is inside',
        bodyFormat: 'text',
        body: `${HI_EN},\n\nthanks for coming back to {{venue.name}}! Next time, bring a friend: when they log in to our Wi-Fi with your code, they get {{slot.friend_offer}} on their first visit – and you get a reward for your next one.\n\nYour code: {{referral.code}}\n\nIt works for your first 3 friends, for 60 days.\n\nSee you soon,\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `${HI_DE}, bring Freunde mit zu {{venue.name}}! Mit deinem Code {{referral.code}} beim WLAN-Login bekommen sie {{slot.friend_offer}} - und du eine Belohnung.` },
        email: {
          subject: 'Bring Freunde mit zu {{venue.name}}',
          preheader: 'Dein persönlicher Code',
          bodyFormat: 'text',
          body: `${HI_DE},\n\ndanke, dass du wieder bei {{venue.name}} warst! Bring nächstes Mal Freunde mit: Wenn sie sich mit deinem Code in unserem WLAN anmelden, bekommen sie {{slot.friend_offer}} beim ersten Besuch – und du eine Belohnung für deinen nächsten.\n\nDein Code: {{referral.code}}\n\nEr gilt für deine ersten 3 Freunde, 60 Tage lang.\n\nBis bald,\n{{venue.name}}`,
        },
      },
    },
  },

  // ── Friend reward ──────────────────────────────────────────────────────────
  {
    poolKey: 'friend_reward',
    journeyKey: 'friend_reward',
    letter: 'A',
    name: 'Your code worked',
    purpose: 'marketing',
    axes: { hook: 'reciprocity', length: 'short', tone: 'warm', emoji: false },
    channels: {
      sms: { text: `${HI_EN}, a friend came to {{venue.name}} with your code - thank you! Your reward until ${UNTIL}: {{offer.label}} {{link.offer}}` },
      email: {
        subject: 'Your code worked – here is your reward',
        preheader: 'Thanks for bringing a friend',
        bodyFormat: 'text',
        body: `${HI_EN},\n\na friend came to {{venue.name}} with your code – thank you for bringing them! Your reward: {{offer.label}} on your next visit, until ${UNTIL}.\n\nShow this when you're here: {{link.offer}}\n\nSee you soon,\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: `${HI_DE}, jemand war mit deinem Code bei {{venue.name}} - danke! Deine Belohnung bis ${UNTIL}: {{offer.label}} {{link.offer}}` },
        email: {
          subject: 'Dein Code hat gewirkt – hier ist deine Belohnung',
          preheader: 'Danke, dass du Freunde mitbringst',
          bodyFormat: 'text',
          body: `${HI_DE},\n\njemand war mit deinem Code bei {{venue.name}} – danke, dass du Freunde mitbringst! Deine Belohnung: {{offer.label}} beim nächsten Besuch, bis ${UNTIL}.\n\nZeig das einfach vor Ort: {{link.offer}}\n\nBis bald,\n{{venue.name}}`,
        },
      },
    },
  },
  {
    poolKey: 'reward_thanks',
    journeyKey: 'friend_reward',
    letter: 'A',
    name: 'Warm thanks',
    purpose: 'service',
    axes: { hook: 'gratitude', length: 'short', tone: 'warm', emoji: false },
    channels: {
      sms: { text: 'Thanks for coming back to {{venue.name}}, {{contact.firstName | default:"dear guest"}}! Enjoy your reward.' },
      email: {
        subject: 'Thanks for coming back!',
        preheader: 'Enjoy your reward',
        bodyFormat: 'text',
        body: `${HI_EN},\n\nthanks for coming back to {{venue.name}} – enjoy your reward, and thanks again for bringing a friend.\n\n{{venue.name}}`,
      },
    },
    locales: {
      de: {
        sms: { text: 'Danke, dass du wieder bei {{venue.name}} warst, {{contact.firstName | default:"lieber Gast"}}! Viel Freude mit deiner Belohnung.' },
        email: {
          subject: 'Danke, dass du wiedergekommen bist!',
          preheader: 'Viel Freude mit deiner Belohnung',
          bodyFormat: 'text',
          body: `${HI_DE},\n\ndanke, dass du wieder bei {{venue.name}} warst – viel Freude mit deiner Belohnung, und nochmals danke, dass du Freunde mitgebracht hast.\n\n{{venue.name}}`,
        },
      },
    },
  },
];
