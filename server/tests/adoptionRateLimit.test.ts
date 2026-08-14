/**
 * Tests for the in-memory adoption rate limiter — specifically the check-vs-charge split.
 *
 * Run: npx tsx tests/adoptionRateLimit.test.ts   (from captive-server/server)
 *
 * Why this is load-bearing: authenticate() reads the code_fail bucket on EVERY request but
 * only failures may charge it. When the gate used the charging variant, ten legitimate
 * requests — one short helper session — consumed the whole wrong-code budget and locked the
 * account's code out for ten minutes, which presented as adoption stuck at "Connecting"
 * while the server had actually finished. The peek/charge distinction is the fix.
 */

import { adoptionRateLimitPeek, adoptionRateLimited } from '../src/services/adoptionRateLimit';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label?: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label || 'value'}: got ${a}, want ${b}`);
}

console.log('peek never charges');

test('a thousand peeks do not limit the bucket', () => {
  const key = 'peek-only';
  for (let i = 0; i < 1000; i += 1) {
    assertEqual(adoptionRateLimitPeek('code_fail', key).limited, false, `peek #${i}`);
  }
  // Still room to charge the full budget afterwards — nothing was recorded.
  for (let i = 0; i < 10; i += 1) {
    assertEqual(adoptionRateLimited('code_fail', key).limited, false, `charge #${i}`);
  }
});

console.log('\ncharging still limits');

test('the budget runs out exactly at the cap, and peek agrees', () => {
  const key = 'charge-path';
  for (let i = 0; i < 10; i += 1) {
    assertEqual(adoptionRateLimited('code_fail', key).limited, false, `charge #${i}`);
  }
  const eleventh = adoptionRateLimited('code_fail', key);
  assertEqual(eleventh.limited, true, 'over budget');
  if (eleventh.retryAfterSeconds < 1) throw new Error('retryAfterSeconds must be >= 1');

  const peek = adoptionRateLimitPeek('code_fail', key);
  assertEqual(peek.limited, true, 'peek sees the same state');
});

test('buckets are isolated by key', () => {
  for (let i = 0; i < 10; i += 1) adoptionRateLimited('code_fail', 'noisy-neighbour');
  assertEqual(adoptionRateLimitPeek('code_fail', 'quiet-tenant').limited, false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
