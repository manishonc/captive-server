/**
 * Tests for the pure, security-critical halves of guest verification.
 *
 * Run: npx tsx tests/verification.test.ts   (from captive-server/server)
 *
 * Covers phone.ts, verificationToken.ts and verificationConfig.ts — none of
 * which touch Firestore, so this runs with no credentials. The OTP store and the
 * routes need a live Firestore and are exercised by the curl checks in
 * docs/guest-verification.md.
 *
 * The token tests are the important ones. That token is the ONLY thing standing
 * between a guest and skipping verification with a single curl.
 */

process.env.GUEST_VERIFICATION_SIGNING_SECRET = 'test-secret-not-for-production';
process.env.GUEST_OTP_PEPPER = 'test-pepper';

import { normalizeE164, normalizeEmail, maskDestination } from '../src/services/phone';
import {
  mintVerificationToken,
  verifyVerificationToken,
  verificationSubsystemReady,
} from '../src/services/verificationToken';
import {
  mergeVerification,
  resolveVerification,
  VERIFICATION_PAGE_DEFAULTS,
} from '../src/services/verificationConfig';

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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

console.log('\nE.164 normalization (the two inputs the legacy toE164 mangles)');

test('strips the national trunk zero', () => {
  // Legacy toE164 produces +4407911123456 here, which is undeliverable. For
  // marketing that fails silently; for OTP the guest never gets online.
  assert(normalizeE164('+44', '07911 123456') === '+447911123456', normalizeE164('+44', '07911 123456') || 'null');
});

test('a typed "+" wins over the country selector', () => {
  assert(normalizeE164('+44', '+41791234567') === '+41791234567', 'must not double the country code');
});

test('handles the 00 international prefix', () => {
  assert(normalizeE164('+44', '0041791234567') === '+41791234567', '00 is an international prefix');
});

test('ordinary input still works', () => {
  assert(normalizeE164('+41', '79 123 45 67') === '+41791234567', 'spaces stripped');
  assert(normalizeE164('41', '791234567') === '+41791234567', 'bare country code');
});

test('refuses to guess when it cannot know the country', () => {
  assert(normalizeE164('', '791234567') === null, 'no cc, no + , no 00 → null');
  assert(normalizeE164('+41', '') === null, 'empty phone → null');
  assert(normalizeE164('+41', 'abc') === null, 'no digits → null');
});

test('rejects out-of-range lengths', () => {
  assert(normalizeE164('+1', '2') === null, 'too short');
  assert(normalizeE164('+1', '9'.repeat(20)) === null, 'over 15 digits');
});

test('a number that duplicates its cc without "+" is left alone', () => {
  // "41…" is a legitimate national number in several plans — unpicking it would
  // break valid input to fix invalid input.
  assert(normalizeE164('+41', '41791234567') === '+4141791234567', 'no clever de-duplication');
});

console.log('\nemail + masking');

test('normalizeEmail lowercases, trims and validates shape', () => {
  assert(normalizeEmail('  Guest@Example.COM ') === 'guest@example.com', 'normalized');
  assert(normalizeEmail('no-at-sign') === null, 'needs @');
  assert(normalizeEmail('a@b') === null, 'needs a dotted domain');
  assert(normalizeEmail(`${'x'.repeat(250)}@example.com`) === null, 'length capped');
});

test('maskDestination never echoes the full contact', () => {
  const masked = maskDestination('email', 'jonathan@example.com');
  assert(!masked.includes('onathan'), `leaked local part: ${masked}`);
  assert(masked.includes('@example.com'), 'domain kept for recognisability');
  const phone = maskDestination('sms', '+41791234567');
  assert(!phone.includes('791234'), `leaked digits: ${phone}`);
  assert(phone.endsWith('567'), 'last 3 kept for recognisability');
});

console.log('\nverification token — the anti-bypass control');

const SCOPE = 'venue:abc123';
const MAC = 'aa:bb:cc:dd:ee:ff';
const base = { scopeKey: SCOPE, mac: MAC, allowedChannels: ['email', 'sms'] as const };

test('subsystem reports ready with both secrets set', () => {
  assert(verificationSubsystemReady() === true, 'should be ready in this test env');
});

test('a freshly minted token verifies', () => {
  const token = mintVerificationToken({ channel: 'email', destination: 'a@x.com', scopeKey: SCOPE, mac: MAC })!;
  const verdict = verifyVerificationToken(token, { ...base, expectedDestination: 'a@x.com', allowedChannels: ['email'] });
  assert(verdict.ok, `expected ok, got ${!verdict.ok ? verdict.reason : ''}`);
});

test('verifying one address and submitting another is REFUSED', () => {
  // The whole point of the token. Without this check a guest verifies their own
  // address and then registers anyone else's.
  const token = mintVerificationToken({ channel: 'email', destination: 'attacker@x.com', scopeKey: SCOPE, mac: MAC })!;
  const verdict = verifyVerificationToken(token, { ...base, expectedDestination: 'victim@y.com', allowedChannels: ['email'] });
  assert(!verdict.ok && verdict.reason === 'destination_mismatch', 'must reject a swapped destination');
});

test('a token from another venue is REFUSED', () => {
  const token = mintVerificationToken({ channel: 'email', destination: 'a@x.com', scopeKey: 'venue:OTHER', mac: MAC })!;
  const verdict = verifyVerificationToken(token, { ...base, expectedDestination: 'a@x.com', allowedChannels: ['email'] });
  assert(!verdict.ok && verdict.reason === 'scope_mismatch', 'cross-venue replay must fail');
});

test('a token for a channel the venue has since disabled is REFUSED', () => {
  const token = mintVerificationToken({ channel: 'sms', destination: '+41791234567', scopeKey: SCOPE, mac: MAC })!;
  const verdict = verifyVerificationToken(token, {
    ...base,
    expectedDestination: '+41791234567',
    allowedChannels: ['email'],
  });
  assert(!verdict.ok && verdict.reason === 'channel_disabled', 'revoking a channel invalidates its tokens');
});

test('a token minted for another device is REFUSED', () => {
  const token = mintVerificationToken({ channel: 'email', destination: 'a@x.com', scopeKey: SCOPE, mac: '11:22:33:44:55:66' })!;
  const verdict = verifyVerificationToken(token, { ...base, expectedDestination: 'a@x.com', allowedChannels: ['email'] });
  assert(!verdict.ok && verdict.reason === 'mac_mismatch', 'device binding must hold');
});

test('MAC binding is skipped when the vendor supplies none', () => {
  // Some Aruba firmware omits the client MAC; failing closed there would lock
  // out an entire vendor.
  const token = mintVerificationToken({ channel: 'email', destination: 'a@x.com', scopeKey: SCOPE, mac: null })!;
  const verdict = verifyVerificationToken(token, { ...base, mac: null, expectedDestination: 'a@x.com', allowedChannels: ['email'] });
  assert(verdict.ok, 'must still verify without a MAC on either side');
});

test('a tampered payload is REFUSED', () => {
  const token = mintVerificationToken({ channel: 'email', destination: 'a@x.com', scopeKey: SCOPE, mac: MAC })!;
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  payload.d = 'victim@y.com';
  const forged = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
  const verdict = verifyVerificationToken(forged, { ...base, expectedDestination: 'victim@y.com', allowedChannels: ['email'] });
  assert(!verdict.ok && verdict.reason === 'bad_signature', 're-signing must be required');
});

test('a version downgrade is REFUSED', () => {
  const token = mintVerificationToken({ channel: 'email', destination: 'a@x.com', scopeKey: SCOPE, mac: MAC })!;
  const downgraded = token.replace(/^hv1\./, 'hv0.');
  const verdict = verifyVerificationToken(downgraded, { ...base, expectedDestination: 'a@x.com', allowedChannels: ['email'] });
  assert(!verdict.ok && verdict.reason === 'malformed', 'the version is inside the signature');
});

test('missing / junk tokens are REFUSED', () => {
  for (const bad of ['', '   ', 'garbage', 'hv1.only-two', undefined, null, 42]) {
    const verdict = verifyVerificationToken(bad, { ...base, expectedDestination: 'a@x.com', allowedChannels: ['email'] });
    assert(!verdict.ok, `should reject: ${String(bad)}`);
  }
});

test('a bypass token is marked as a waiver, not as proof', () => {
  const token = mintVerificationToken({ channel: 'email', destination: 'a@x.com', scopeKey: SCOPE, mac: MAC, bypass: true })!;
  const verdict = verifyVerificationToken(token, { ...base, expectedDestination: 'a@x.com', allowedChannels: ['email'] });
  assert(verdict.ok && verdict.payload.b === 1, 'the waiver flag must survive the round trip');
});

test('with no signing secret, nothing mints and nothing verifies', () => {
  const saved = process.env.GUEST_VERIFICATION_SIGNING_SECRET;
  // The module reads the env lazily, so this is observable without a re-import.
  delete process.env.GUEST_VERIFICATION_SIGNING_SECRET;
  const token = mintVerificationToken({ channel: 'email', destination: 'a@x.com', scopeKey: SCOPE, mac: MAC });
  assert(token === null, 'must never mint an unsigned token');
  const verdict = verifyVerificationToken('hv1.x.y', { ...base, expectedDestination: 'a@x.com', allowedChannels: ['email'] });
  assert(!verdict.ok && verdict.reason === 'missing', 'must fail closed, not open');
  process.env.GUEST_VERIFICATION_SIGNING_SECRET = saved;
});

console.log('\nconfig resolution (fail-open rules)');

const ALL_FIELDS = { email: { enabled: true }, phone: { enabled: true } };

function withProviders<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k]!;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

test('a doc with no verificationPage merges to disabled', () => {
  assert(mergeVerification({}).enabled === false, 'must default off');
  assert(VERIFICATION_PAGE_DEFAULTS.enabled === false, 'the exported default must be false');
});

test('channels merge per-key, so an older doc keeps its other settings', () => {
  const merged = mergeVerification({ verificationPage: { channels: { sms: { enabled: true } } } });
  assert(merged.channels.sms.enabled === true, 'stored value applied');
  assert(merged.channels.email.enabled === true, 'default preserved for the absent key');
  assert(merged.channels.whatsapp.enabled === false, 'default preserved for the absent key');
});

test('a channel whose provider is unconfigured is subtracted', () => {
  withProviders(
    { BREVO_API_KEY: 'k', BREVO_SENDER_EMAIL: 'a@b.com', TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined },
    () => {
      const r = resolveVerification(
        { verificationPage: { enabled: true, channels: { email: { enabled: true }, sms: { enabled: true } } } },
        ALL_FIELDS,
      );
      assert(r.effective.channels.sms.enabled === false, 'sms dropped');
      assert(r.effective.channels.email.enabled === true, 'email kept');
      assert(r.channelsUnavailable.includes('sms'), 'reported as unavailable');
      assert(r.effective.enabled === true, 'still enabled via email');
    },
  );
});

test('a channel whose login field is hidden is subtracted', () => {
  withProviders({ TWILIO_ACCOUNT_SID: 's', TWILIO_AUTH_TOKEN: 't', TWILIO_PHONE_NUMBER: '+1' }, () => {
    const r = resolveVerification(
      { verificationPage: { enabled: true, channels: { email: { enabled: false }, sms: { enabled: true } } } },
      { email: { enabled: true }, phone: { enabled: false } },
    );
    assert(r.effective.enabled === false, 'no usable channel left');
    assert(r.degraded === 'fields_disabled', `expected fields_disabled, got ${r.degraded}`);
  });
});

test('every channel unusable fails OPEN, and never claims the guest is verified', () => {
  withProviders(
    {
      BREVO_API_KEY: undefined,
      BREVO_SENDER_EMAIL: undefined,
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      WHATSAPP_PHONE_NUMBER_ID: undefined,
      WHATSAPP_ACCESS_TOKEN: undefined,
    },
    () => {
      const r = resolveVerification({ verificationPage: { enabled: true, channels: { email: { enabled: true } } } }, ALL_FIELDS);
      // A misconfigured provider must never become a wifi outage for a venue.
      assert(r.effective.enabled === false, 'guests still connect');
      assert(r.degraded === 'no_channels', `expected no_channels, got ${r.degraded}`);
    },
  );
});

test('a missing signing secret disables verification estate-wide', () => {
  const saved = process.env.GUEST_VERIFICATION_SIGNING_SECRET;
  delete process.env.GUEST_VERIFICATION_SIGNING_SECRET;
  const r = resolveVerification({ verificationPage: { enabled: true, channels: { email: { enabled: true } } } }, ALL_FIELDS);
  assert(r.effective.enabled === false, 'cannot verify without a way to prove it');
  assert(r.degraded === 'not_configured', `expected not_configured, got ${r.degraded}`);
  process.env.GUEST_VERIFICATION_SIGNING_SECRET = saved;
});

test('resolution re-pins defaultChannel to what survived', () => {
  withProviders(
    { BREVO_API_KEY: 'k', BREVO_SENDER_EMAIL: 'a@b.com', TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined },
    () => {
      const r = resolveVerification(
        {
          verificationPage: {
            enabled: true,
            defaultChannel: 'sms',
            channels: { email: { enabled: true }, sms: { enabled: true } },
          },
        },
        ALL_FIELDS,
      );
      assert(r.effective.defaultChannel === 'email', `expected email, got ${r.effective.defaultChannel}`);
    },
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
