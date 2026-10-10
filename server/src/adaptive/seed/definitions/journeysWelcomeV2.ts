/**
 * Welcome → come back v2: the journey stays open until its offer ends, so a guest who comes
 * back while the offer is still valid counts — they get the thank-you and the journey converts
 * ("came back", revenue, the offer page's "Welcome back"). Published next to v1 by the seed
 * (seed/versionUpgrades.ts); Restaurant growth v3 and Local business v3 pin it (playbooksV3.ts).
 *
 * v1 ended as soon as it had nothing more to send — about 3 days after a click, about 5 days
 * without one, or right after a follow-up was skipped — while the offer stays valid for the
 * owner's "Valid for (days)" (14 by default, up to 90). A return visit only redeems the offer of
 * a running journey (engine/route.ts), so a guest back on day 6–14 wasn't counted.
 *
 * What changed from v1:
 *  - every path that had nothing more to send (no click after the follow-up, the last-chance
 *    message, a skipped follow-up) now waits in `w_offer` until the offer ends
 *    (`wait_until` anchored on `offer.expiresAt`), then ends as `exhausted`;
 *  - the goal window covers the longest offer (90 days): the journey itself ends with the offer.
 */

import type { JourneyVersionSeed } from './journeysRestaurantV2';
import { welcomeSecondVisit } from './journeysRestaurant';

const v1 = welcomeSecondVisit.definition;

export const welcomeSecondVisitV2: JourneyVersionSeed = {
  version: 2,
  header: welcomeSecondVisit.header,
  changelog: 'Stays open until the offer ends, so a guest who comes back while it is valid counts and gets the thank-you',
  definition: {
    ...v1,
    goal: { event: 'offer.redeemed', within: '90d', onReach: 'thanks', exit: 'converted' },
    nodes: {
      ...v1.nodes,
      s2_next: { ...v1.nodes.s2_next, edges: { sent: 'w2', skipped: 'w_offer' } },
      s2_same: { ...v1.nodes.s2_same, edges: { sent: 'w2', skipped: 'w_offer' } },
      w2: { ...v1.nodes.w2, edges: { clicked: 'w_redeem', timeout: 'w_offer' } },
      last: { ...v1.nodes.last, edges: { sent: 'w_offer', skipped: 'w_offer' } },
      // Open while the offer can still be redeemed: a return visit now redeems it (goal → thanks).
      w_offer: { type: 'wait_until', config: { anchor: 'offer.expiresAt' }, edges: { done: 'x_exhausted', past: 'x_exhausted' } },
    },
  },
};
