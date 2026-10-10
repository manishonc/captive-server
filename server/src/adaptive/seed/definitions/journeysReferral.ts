/**
 * Bring-a-friend (PR A7) — the manager's spec §5 A7 (P1): "after 2nd revisit — dual-redemption
 * code, both get the offer; friend's splash signup attributes the referral". Two journeys:
 *
 *  - **Bring a friend** (`bring_a_friend`): on a regular's 3rd visit ("after the 2nd revisit"),
 *    one invite the next morning with their personal code (`{{referral.code}}`, minted at send
 *    time — referrals/store.ts) and what a friend gets (`friend_offer`). Once per guest.
 *  - **Friend reward** (`friend_reward`): when a friend signs up on the splash with that code
 *    (`referral.joined`, engine/route.ts), the regular's reward for their next visit. It stays open
 *    until the offer ends (a return then redeems it, like the welcome v2), and a friend who comes
 *    while a reward is open waits their turn (`reentry.queue`) — one reward per friend, up to 3.
 *
 * Both are in Restaurant growth only (Playbook C is A1 + A2 + A5 in the spec); off by default.
 */

import { t, type JourneySeed } from './types';

const DINING = ['restaurant', 'cafe', 'other'] as const;
const KINDS = ['percent', 'free_item', 'amount'] as const;

export const bringAFriend: JourneySeed = {
  header: {
    key: 'bring_a_friend',
    name: t('Bring a friend', 'Freunde mitbringen'),
    description: t(
      'Regulars get a code to share. A friend who signs up with it gets your offer on their first visit — and your regular gets a reward.',
      'Stammgäste erhalten einen Code zum Teilen. Wer sich damit anmeldet, bekommt dein Angebot beim ersten Besuch – und dein Stammgast eine Belohnung.',
    ),
    purpose: 'marketing',
    venueTypes: [...DINING],
    availability: 'available',
    kpi: 'friends_per_100_invites',
    requiredCapabilities: [],
    display: { icon: 'users', when: t('The morning after their 3rd visit', 'Am Morgen nach dem 3. Besuch') },
  },
  changelog: 'First version: one invite with a personal code after the 3rd visit; a friend who signs up with it gets the offer',
  definition: {
    entry: {
      // The spec's "after 2nd revisit": the 3rd visit.
      trigger: { type: 'visit.started', config: { visitNumber: { eq: 3 } } },
      requires: ['consent:venue:marketing'],
      reentry: { mode: 'never' },
    },
    caps: { maxTouches: 1, stopAfterClicks: 1 },
    channelLadder: ['email', 'sms'],
    slots: {
      friend_offer: { type: 'offer', label: t('What a friend gets', 'Was Freunde bekommen'), required: true, kinds: [...KINDS] },
    },
    pools: {
      referral_invite: { name: t('Bring a friend', 'Freunde mitbringen'), purpose: 'marketing', channels: ['email', 'sms'], requiredLocales: ['en', 'de'] },
    },
    autonomy: { allowed: ['shift_slot', 'swap_offer', 'retire_variant'], bounds: {} },
    start: 's',
    nodes: {
      s: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'referral_invite', channel: 'auto', timing: { mode: 'slot', default: 'morning' }, expireAfter: '24h' },
        edges: { sent: 'x', skipped: 'x' },
      },
      x: { type: 'exit', config: { status: 'completed' } },
    },
    previewSteps: [
      {
        nodeId: 's',
        pool: 'referral_invite',
        channel: 'email',
        when: t('The morning after her 3rd visit', 'Am Morgen nach ihrem 3. Besuch'),
        why: t('She’s a regular now — her friends are your best new guests.', 'Sie ist jetzt Stammgast – ihre Freunde sind deine besten neuen Gäste.'),
      },
    ],
  },
};

export const friendReward: JourneySeed = {
  header: {
    key: 'friend_reward',
    name: t('Friend reward', 'Belohnung für Freunde'),
    description: t(
      'When a friend signs up with your regular’s code, your regular gets a reward for their next visit — for up to 3 friends.',
      'Wenn sich Freunde mit dem Code deines Stammgasts anmelden, bekommt er eine Belohnung für den nächsten Besuch – für bis zu 3 Freunde.',
    ),
    purpose: 'marketing',
    venueTypes: [...DINING],
    availability: 'available',
    kpi: 'reward_redemption_rate',
    requiredCapabilities: [],
    display: { icon: 'gift', when: t('When a friend signs up with their code', 'Wenn sich Freunde mit dem Code anmelden') },
  },
  changelog: 'First version: a reward per friend who signs up with the code (up to 3), open until it ends, thank-you on return',
  definition: {
    entry: {
      trigger: { type: 'event', config: { type: 'referral.joined' } },
      requires: ['consent:venue:marketing'],
      // One reward per friend: friends who come while a reward is open wait their turn.
      reentry: { mode: 'after_exit', queue: 3 },
    },
    goal: { event: 'offer.redeemed', within: '90d', onReach: 'thanks', exit: 'converted' },
    caps: { maxTouches: 1, stopAfterClicks: 1 },
    channelLadder: ['email', 'sms'],
    slots: {
      offer: { type: 'offer', label: t('Their reward', 'Ihre Belohnung'), required: true, kinds: [...KINDS] },
    },
    pools: {
      friend_reward: { name: t('Your friend came', 'Dein Code hat gewirkt'), purpose: 'marketing', channels: ['email', 'sms'], requiredLocales: ['en', 'de'] },
      reward_thanks: { name: t('Thank you', 'Dankeschön'), purpose: 'service', channels: ['email', 'sms'], requiredLocales: ['en', 'de'] },
    },
    autonomy: { allowed: ['swap_offer', 'retire_variant'], bounds: {} },
    start: 'o',
    nodes: {
      o: { type: 'issue_offer', config: { slot: 'offer' }, edges: { done: 's', none: 'x_done' } },
      s: {
        type: 'send',
        config: { purpose: 'marketing', pool: 'friend_reward', channel: 'auto', timing: { mode: 'now' } },
        edges: { sent: 'w_offer', skipped: 'x_done' },
      },
      // Open while the reward can be redeemed: a return visit redeems it (goal → thanks).
      w_offer: { type: 'wait_until', config: { anchor: 'offer.expiresAt' }, edges: { done: 'x_exhausted', past: 'x_exhausted' } },
      thanks: {
        type: 'send',
        config: { purpose: 'service', pool: 'reward_thanks', channel: 'auto', timing: { mode: 'now' } },
        edges: { sent: 'x_converted', skipped: 'x_converted' },
      },
      x_done: { type: 'exit', config: { status: 'completed' } },
      x_exhausted: { type: 'exit', config: { status: 'exhausted' } },
      x_converted: { type: 'exit', config: { status: 'converted' } },
    },
    previewSteps: [
      {
        nodeId: 's',
        pool: 'friend_reward',
        channel: 'email',
        when: t('When a friend signs up with her code', 'Wenn sich jemand mit ihrem Code anmeldet'),
        why: t('Her friend came — she gets a reward for her next visit.', 'Ihre Freundin war da – sie bekommt eine Belohnung für den nächsten Besuch.'),
      },
      {
        nodeId: 'thanks',
        pool: 'reward_thanks',
        channel: 'email',
        when: t('When she comes back for it', 'Wenn sie dafür wiederkommt'),
        why: t('A thank-you — free, no marketing.', 'Ein Dankeschön – gratis, keine Werbung.'),
      },
    ],
  },
};

export const REFERRAL_JOURNEYS: JourneySeed[] = [bringAFriend, friendReward];
