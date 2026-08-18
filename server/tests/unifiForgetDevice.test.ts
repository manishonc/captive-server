/**
 * Tests for forgetDevice — the un-adopt call that releases hardware when a tenant is deleted.
 *
 * Run: npx tsx tests/unifiForgetDevice.test.ts   (from captive-server/server)
 *
 * No credentials needed: forgetDevice takes its request function as a parameter, so the
 * controller is a stub here. services/unifi.ts deliberately does not import ../firebase
 * (see unifiWlanIdentity.test.ts), which is what makes it importable at all.
 *
 * The two behaviours worth protecting:
 *   1. "Already gone" is SUCCESS. The CMS tenant-delete is resumable and re-runs partial
 *      jobs, so a second forget of the same MAC must not surface as a warning forever.
 *   2. The devmgr fallback fires only when sitemgr genuinely fails. Firing it after a
 *      success would send a delete command twice; never firing it strands older
 *      controllers, which do not serve the batch sitemgr form.
 */

import { forgetDevice, isDeviceAlreadyGone } from '../src/services/unifi';
import type { UnifiConfig } from '../src/types/unifi';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  const finish = (err?: unknown) => {
    if (err) {
      failed += 1;
      console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
    } else {
      passed += 1;
      console.log(`  ✓ ${name}`);
    }
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.then(() => finish()).catch(finish);
    finish();
  } catch (error) {
    finish(error);
  }
  return Promise.resolve();
}

function assertEqual(actual: unknown, expected: unknown, label?: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label || 'value'}: got ${a}, want ${b}`);
}

const config = { controllerUrl: 'https://unifi.test', site: 'default' } as unknown as UnifiConfig;

/** Records every call and replays scripted responses in order. */
function stubRequest(responses: Array<{ status: number; body?: any }>) {
  const calls: Array<{ path: string; payload: any }> = [];
  const fn = (async (_c: UnifiConfig, _m: string, path: string, payload?: unknown) => {
    calls.push({ path, payload });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected extra request to ${path}`);
    return { status: next.status, body: next.body };
  }) as any;
  return { fn, calls };
}

async function main() {
  console.log('\nisDeviceAlreadyGone');

  await test('404 counts as gone', () => {
    assertEqual(isDeviceAlreadyGone({ status: 404, body: undefined }), true);
  });

  await test('api.err.UnknownDevice counts as gone', () => {
    assertEqual(isDeviceAlreadyGone({ status: 400, body: { meta: { msg: 'api.err.UnknownDevice' } } }), true);
  });

  await test('api.err.NoSuchDevice counts as gone', () => {
    assertEqual(isDeviceAlreadyGone({ status: 400, body: { meta: { msg: 'api.err.NoSuchDevice' } } }), true);
  });

  await test('plain "not found" message counts as gone', () => {
    assertEqual(isDeviceAlreadyGone({ status: 400, body: { message: 'Device not found' } }), true);
  });

  await test('an unrelated failure does NOT count as gone', () => {
    assertEqual(isDeviceAlreadyGone({ status: 500, body: { meta: { msg: 'api.err.ServerError' } } }), false);
  });

  await test('a permission failure does NOT count as gone', () => {
    assertEqual(isDeviceAlreadyGone({ status: 403, body: { meta: { msg: 'api.err.NoPermission' } } }), false);
  });

  console.log('\nforgetDevice');

  await test('sitemgr success sends the batch form and does not fall back', async () => {
    const { fn, calls } = stubRequest([{ status: 200, body: { meta: { rc: 'ok' } } }]);
    await forgetDevice(config, 'AA:BB:CC:DD:EE:FF', fn);
    assertEqual(calls.length, 1, 'call count');
    assertEqual(calls[0].path, 'cmd/sitemgr', 'path');
    assertEqual(calls[0].payload, { cmd: 'delete-device', macs: ['aa:bb:cc:dd:ee:ff'] }, 'payload');
  });

  await test('falls back to devmgr when sitemgr fails outright', async () => {
    const { fn, calls } = stubRequest([
      { status: 400, body: { meta: { msg: 'api.err.InvalidPayload' } } },
      { status: 200, body: { meta: { rc: 'ok' } } },
    ]);
    await forgetDevice(config, 'aa:bb:cc:dd:ee:ff', fn);
    assertEqual(calls.length, 2, 'call count');
    assertEqual(calls[1].path, 'cmd/devmgr', 'fallback path');
    assertEqual(calls[1].payload, { cmd: 'delete-device', mac: 'aa:bb:cc:dd:ee:ff' }, 'fallback payload');
  });

  await test('already-gone on sitemgr resolves without falling back', async () => {
    const { fn, calls } = stubRequest([{ status: 400, body: { meta: { msg: 'api.err.UnknownDevice' } } }]);
    await forgetDevice(config, 'aa:bb:cc:dd:ee:ff', fn);
    assertEqual(calls.length, 1, 'call count');
  });

  await test('already-gone on the devmgr fallback resolves', async () => {
    const { fn } = stubRequest([
      { status: 400, body: { meta: { msg: 'api.err.InvalidPayload' } } },
      { status: 404, body: undefined },
    ]);
    await forgetDevice(config, 'aa:bb:cc:dd:ee:ff', fn);
  });

  await test('throws with both statuses when neither command works', async () => {
    const { fn } = stubRequest([
      { status: 500, body: { meta: { msg: 'api.err.ServerError' } } },
      { status: 503, body: { meta: { msg: 'api.err.Unavailable' } } },
    ]);
    let message = '';
    try {
      await forgetDevice(config, 'aa:bb:cc:dd:ee:ff', fn);
    } catch (error) {
      message = (error as Error).message;
    }
    if (!message.includes('500') || !message.includes('503')) {
      throw new Error(`expected both statuses in the error, got: ${message}`);
    }
  });

  await test('rejects an empty MAC before touching the controller', async () => {
    const { fn, calls } = stubRequest([]);
    let threw = false;
    try {
      await forgetDevice(config, '   ', fn);
    } catch {
      threw = true;
    }
    assertEqual(threw, true, 'threw');
    assertEqual(calls.length, 0, 'no controller calls');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

void main();
