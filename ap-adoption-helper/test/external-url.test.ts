import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isAllowedExternal } from '../src/main/lib/external-url';

const HOME = 'https://heidifi.ai/';
const DASH = 'https://cms.heidifi.ai/captive-venue';
const ALLOWED = [HOME, DASH];

test('allows the configured URLs themselves', () => {
  assert.equal(isAllowedExternal('https://heidifi.ai/', ALLOWED), true);
  assert.equal(isAllowedExternal('https://cms.heidifi.ai/captive-venue', ALLOWED), true);
});

test('allows deeper paths under an allowed prefix', () => {
  // The whole reason this replaced exact-string matching: the "continue on your dashboard"
  // button points at a per-venue deep link.
  assert.equal(
    isAllowedExternal('https://cms.heidifi.ai/captive-venue?view=venues&venueId=abc', ALLOWED),
    true,
  );
  assert.equal(isAllowedExternal('https://cms.heidifi.ai/captive-venue/abc', ALLOWED), true);
});

test('a bare origin entry allows anything on that origin', () => {
  assert.equal(isAllowedExternal('https://heidifi.ai/docs/unifi-setup', ALLOWED), true);
});

test('rejects a sibling path that merely shares a string prefix', () => {
  assert.equal(isAllowedExternal('https://cms.heidifi.ai/captive-venue-other', ALLOWED), false);
});

test('rejects a different origin', () => {
  assert.equal(isAllowedExternal('https://evil.com/captive-venue', ALLOWED), false);
  assert.equal(isAllowedExternal('https://other.heidifi.ai/captive-venue', ALLOWED), false);
});

test('rejects prefix-confusion domains', () => {
  // `https://heidifi.ai.evil.com` has `https://heidifi.ai` as a string prefix — a naive
  // startsWith check hands the user's browser to the attacker.
  assert.equal(isAllowedExternal('https://heidifi.ai.evil.com/', ALLOWED), false);
  assert.equal(isAllowedExternal('https://cms.heidifi.ai.evil.com/captive-venue', ALLOWED), false);
});

test('rejects non-https schemes', () => {
  assert.equal(isAllowedExternal('http://heidifi.ai/', ALLOWED), false);
  assert.equal(isAllowedExternal('file:///etc/passwd', ALLOWED), false);
  assert.equal(isAllowedExternal('javascript:alert(1)', ALLOWED), false);
});

test('a URL that merely mentions an allowed one is rejected', () => {
  assert.equal(isAllowedExternal('https://evil.com/?next=https://heidifi.ai/', ALLOWED), false);
});

test('rejects junk without throwing', () => {
  assert.equal(isAllowedExternal('', ALLOWED), false);
  assert.equal(isAllowedExternal('not a url', ALLOWED), false);
  assert.equal(isAllowedExternal(null, ALLOWED), false);
  assert.equal(isAllowedExternal(undefined, ALLOWED), false);
});

test('an unparseable allowlist entry is ignored, not fatal', () => {
  assert.equal(isAllowedExternal('https://heidifi.ai/', ['', 'nonsense', HOME]), true);
  assert.equal(isAllowedExternal('https://heidifi.ai/', ['nonsense']), false);
});

test('an empty allowlist allows nothing', () => {
  assert.equal(isAllowedExternal('https://heidifi.ai/', []), false);
});
