/**
 * The pause duration is clamped server-side.
 *
 * Run: npx tsx tests/adoptionPause.test.ts   (from captive-server/server)
 *
 * This matters: the clamp is the only thing stopping a fat-fingered minutes value from
 * leaving a public, unauthenticated endpoint without brute-force protection for a week.
 * services/adoptionPause.ts is split out of adoptionSettings.ts — which imports ../firebase
 * and needs credentials — so that this tests the real function rather than a copy of it.
 */
import {
  clampPauseMinutes as clamp,
  DEFAULT_PAUSE_MINUTES,
  MAX_PAUSE_MINUTES,
} from '../src/services/adoptionPause';

let passed = 0, failed = 0;
const t = (n: string, a: unknown, b: unknown) => {
  if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.error(`  ✗ ${n}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }
};

t('a normal request passes through', clamp(30), 30);
t('presets are honoured', clamp(15), 15);
t('an absurd duration is capped', clamp(10080), MAX_PAUSE_MINUTES);
t('exactly the cap is allowed', clamp(120), 120);
t('zero and negatives floor to 1, never "forever"', clamp(0), 1);
t('negative floors to 1', clamp(-99), 1);
t('missing falls back to the default', clamp(undefined), DEFAULT_PAUSE_MINUTES);
t('NaN falls back rather than producing NaN', clamp(NaN), DEFAULT_PAUSE_MINUTES);
t('Infinity is capped, not passed through', clamp(Infinity), DEFAULT_PAUSE_MINUTES);
t('fractional rounds', clamp(29.6), 30);
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
