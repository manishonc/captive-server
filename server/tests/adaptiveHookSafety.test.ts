/**
 * The login hook can never hurt a login (plan §2.2).
 *
 * Run: npx tsx tests/adaptiveHookSafety.test.ts   (from captive-server/server)
 *
 * Express 4 doesn't catch a failed async route and the server has no
 * `unhandledRejection` handler, so an Adaptive error escaping into /create-user
 * could crash Node and stop every Wi-Fi login. These pin that `runAdaptiveHook`:
 *
 *  - returns straight away (the route never waits for Adaptive);
 *  - swallows an error thrown immediately (e.g. while building arguments);
 *  - swallows a later rejection — no unhandled rejection reaches the process;
 *  - still runs the hook when it works.
 */

import { runAdaptiveHook } from '../src/adaptive/ingest/hook';

let passed = 0;
let failed = 0;
const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${(error as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const settle = () => new Promise((r) => setTimeout(r, 50));
const quietConsole = () => {
  const original = console.error;
  console.error = () => undefined;
  return () => {
    console.error = original;
  };
};

async function main() {
  console.log('\nAdaptive login hook safety\n');

  await test('returns at once, before a slow hook finishes', async () => {
    let finished = false;
    const started = Date.now();
    runAdaptiveHook('slow', () => new Promise((r) => setTimeout(() => { finished = true; r(null); }, 200)));
    assert(Date.now() - started < 20, 'the caller did not wait');
    assert(!finished, 'the hook is still running in the background');
    await new Promise((r) => setTimeout(r, 250));
    assert(finished, 'and it did finish');
  });

  await test('an immediate throw is caught', async () => {
    const restore = quietConsole();
    try {
      runAdaptiveHook('sync', () => {
        throw new Error('boom while building arguments');
      });
      await settle();
    } finally {
      restore();
    }
    assert(unhandled.length === 0, 'no unhandled rejection');
  });

  await test('a later rejection is caught (no unhandled rejection)', async () => {
    const restore = quietConsole();
    try {
      runAdaptiveHook('async', async () => {
        await settle();
        throw new Error('Firestore is down');
      });
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      restore();
    }
    assert(unhandled.length === 0, `no unhandled rejection (got ${unhandled.length})`);
  });

  await test('a working hook runs', async () => {
    let ran = false;
    runAdaptiveHook('ok', () => {
      ran = true;
    });
    await settle();
    assert(ran, 'ran');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
