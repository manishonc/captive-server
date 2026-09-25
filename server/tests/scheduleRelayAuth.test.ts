/**
 * Tests for the x-internal-secret guard on POST /schedule-sms and POST /schedule-email.
 *
 * Run: npx tsx tests/scheduleRelayAuth.test.ts   (from captive-server/server)
 *
 * No Firestore, no provider calls: the real routers are mounted on a throwaway
 * Express app, and the Twilio/Brevo credentials are removed first, so a request
 * that gets past the guard ends at "400 invalid body" or "503 not configured".
 *
 * WHY THIS FILE EXISTS
 *
 * Both routes send a message to ANY recipient with ANY text through HeidiFi's
 * Twilio and Brevo accounts. Without the guard they were open relays on the
 * public API. The load-bearing assertions: no secret, a wrong secret, or no
 * INTERNAL_API_SECRET configured at all → 401 — before the body is even read.
 */

import express from 'express';
import type { AddressInfo } from 'net';
import smsRoutes from '../src/routes/sms';
import emailRoutes from '../src/routes/email';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('TWILIO_') || key.startsWith('BREVO_')) delete process.env[key];
}
const SECRET = 'relay-test-secret';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(err as Error).message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label = 'value') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

const VALID = {
  '/schedule-sms': { to: '+41791234567', content: 'hello' },
  '/schedule-email': { to: 'guest@example.com', subject: 'Hi', body: 'hello' },
} as const;

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/schedule-sms', smsRoutes);
  app.use('/schedule-email', emailRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function post(path: keyof typeof VALID, body: unknown, secret?: string) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret !== undefined ? { 'x-internal-secret': secret } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  console.log('\nschedule relays: x-internal-secret guard\n');

  for (const path of Object.keys(VALID) as Array<keyof typeof VALID>) {
    await test(`${path}: no secret → 401, before the body is read`, async () => {
      process.env.INTERNAL_API_SECRET = SECRET;
      const r = await post(path, VALID[path]);
      assertEqual([r.status, r.json], [401, { success: false, message: 'Unauthorized' }], 'response');
      assertEqual((await post(path, {})).status, 401, 'an invalid body still gets 401, not 400');
    });

    await test(`${path}: wrong secret → 401`, async () => {
      process.env.INTERNAL_API_SECRET = SECRET;
      assertEqual((await post(path, VALID[path], 'not-the-secret')).status, 401, 'status');
      assertEqual((await post(path, VALID[path], '')).status, 401, 'empty header');
    });

    await test(`${path}: no INTERNAL_API_SECRET configured → closed for everyone`, async () => {
      delete process.env.INTERNAL_API_SECRET;
      assertEqual((await post(path, VALID[path], '')).status, 401, 'empty header');
      assertEqual((await post(path, VALID[path], 'undefined')).status, 401, '"undefined" header');
    });

    await test(`${path}: the right secret reaches the handler (400 bad body, 503 no provider)`, async () => {
      process.env.INTERNAL_API_SECRET = SECRET;
      assertEqual((await post(path, {}, SECRET)).status, 400, 'bad body');
      const r = await post(path, VALID[path], SECRET);
      assertEqual(r.status, 503, 'valid body, provider not configured — nothing sent');
    });
  }

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
