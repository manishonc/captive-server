/**
 * The weekly-limit touches (`NetworkPeople.recentMarketingTouches`) as the spacing rule
 * reads them (PR F0). No Firestore access here, so the pure tests can use it.
 */

import type { MarketingTouch } from '../store/engineTypes';
import { tsMs } from '../store/time';

/** When this person's newest other marketing message went (ms), or null. */
export function newestTouchAt(touches: MarketingTouch[], exceptSendKey: string): number | null {
  let newest: number | null = null;
  for (const t of touches) {
    if (t.sendKey === exceptSendKey) continue;
    const at = tsMs(t.at);
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest;
}
