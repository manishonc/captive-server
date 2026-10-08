/**
 * PR S: Restaurant growth v2 and Local business v2 — they pin the runnable scan journeys (v2,
 * journeysRestaurantV2.ts), add "15% off" and "20% off" to the offer menu, and prefill the new
 * blanks: Win-back 10% → 15% → 20%, a free dessert for birthdays, a free coffee for slow
 * times, and the four pre-ticked holidays (S-D3). Published next to v1 by the seed
 * (seed/versionUpgrades.ts); a venue on v1 moves to v2 the next time its owner saves.
 */

import { DEFAULT_HOLIDAYS_VALUE } from '../../core/scans/holidays';
import { localBusiness, restaurantGrowth } from './playbooks';
import { t, type PlaybookSeed } from './types';

export interface PlaybookVersionSeed extends PlaybookSeed {
  version: number;
}

const FIFTEEN_PCT = { offerKey: 'fifteen_pct', name: '15% off', label: t('15% off your next visit', '15% Rabatt auf deinen nächsten Besuch'), kind: 'percent', value: 15, expiryDays: 14 } as const;
const TWENTY_PCT = { offerKey: 'twenty_pct', name: '20% off', label: t('20% off your next visit', '20% Rabatt auf deinen nächsten Besuch'), kind: 'percent', value: 20, expiryDays: 14 } as const;

const SCAN_V2: Record<string, Record<string, string>> = {
  win_back: { offer_30: 'ten_pct', offer_60: 'fifteen_pct', offer_90: 'twenty_pct' },
  birthday: { gift: 'dessert' },
  quiet_hours_filler: { offer: 'coffee' },
  holidays: { holidays: DEFAULT_HOLIDAYS_VALUE },
};

function withScanV2(seed: PlaybookSeed, extraOffers: ReadonlyArray<(typeof FIFTEEN_PCT) | (typeof TWENTY_PCT)>): PlaybookSeed['content'] {
  return {
    ...seed.content,
    journeys: seed.content.journeys.map((j) =>
      SCAN_V2[j.journeyKey] ? { ...j, templateVersion: 2, slotDefaults: { ...(j.slotDefaults ?? {}), ...SCAN_V2[j.journeyKey] } } : j,
    ),
    offerMenuDefaults: [...(seed.content.offerMenuDefaults ?? []), ...extraOffers],
    // Messages a month per guest who said yes (the estimate): a birthday gift reaches the ~15 %
    // who tell us their month; Holidays sends once per picked day (×picks in the estimate);
    // slow-time invites reach the guests of a slow daypart, at most every 3 weeks.
    estimateHints: seed.content.estimateHints
      ? {
          ...seed.content.estimateHints,
          avgTouchesPerGuest: {
            ...(seed.content.estimateHints.avgTouchesPerGuest ?? {}),
            ...Object.fromEntries(Object.entries(SCAN_HINTS).filter(([k]) => seed.content.journeys.some((j) => j.journeyKey === k))),
          },
        }
      : undefined,
  };
}

const SCAN_HINTS: Record<string, number> = { win_back: 1.5, birthday: 0.15, quiet_hours_filler: 0.5, holidays: 1 };

export const restaurantGrowthV2: PlaybookVersionSeed = {
  key: 'restaurant_growth',
  sortOrder: restaurantGrowth.sortOrder,
  version: 2,
  changelog: 'Win-back, Birthday, Slow-time filler and Holidays run now; offers 15% and 20% off; Win-back prefilled 10% → 15% → 20%',
  content: withScanV2(restaurantGrowth, [FIFTEEN_PCT, TWENTY_PCT]),
};

export const localBusinessV2: PlaybookVersionSeed = {
  key: 'local_business',
  sortOrder: localBusiness.sortOrder,
  version: 2,
  changelog: 'The Slow-time filler runs now (prefilled with a free coffee)',
  content: {
    ...withScanV2(localBusiness, []),
    summary: t('A simpler version: welcome offer, review ask, slow-time filler.', 'Die einfache Version: Willkommensangebot, Bewertungsanfrage, ruhige Zeiten füllen.'),
  },
};

export const PLAYBOOK_VERSIONS: PlaybookVersionSeed[] = [restaurantGrowthV2, localBusinessV2];
