// Tests for the failure-mapping helpers in src/main/lib/api-errors.ts.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mapFailure, parseRetryAfter, statusToCode } from '../src/main/lib/api-errors';

test('server codes map ahead of HTTP status', () => {
  assert.equal(mapFailure(400, { code: 'invalid_code' }), 'BAD_CODE');
  assert.equal(mapFailure(429, { code: 'too_many_requests' }), 'RATE_LIMITED');
  assert.equal(mapFailure(409, { code: 'mac_registered_elsewhere' }), 'MAC_CONFLICT');
});

test('the 502 trio maps to SERVER_ERROR explicitly', () => {
  assert.equal(mapFailure(502, { code: 'lookup_failed' }), 'SERVER_ERROR');
  assert.equal(mapFailure(502, { code: 'status_failed' }), 'SERVER_ERROR');
  assert.equal(mapFailure(502, { code: 'claim_failed' }), 'SERVER_ERROR');
});

test('a bare 404 still means "this app is too old", never "bad code"', () => {
  assert.equal(statusToCode(404, false), 'VERSION_UNSUPPORTED');
  assert.equal(mapFailure(404, null), 'VERSION_UNSUPPORTED');
  assert.equal(mapFailure(404, { code: 'venue_not_found' }), 'VENUE_GONE');
});

test('parseRetryAfter prefers the header over the body', () => {
  assert.equal(parseRetryAfter('30', { retryAfterSeconds: 90 }), 30);
});

test('parseRetryAfter falls back to the body when the header is absent or junk', () => {
  assert.equal(parseRetryAfter(null, { retryAfterSeconds: 90 }), 90);
  assert.equal(parseRetryAfter('soon', { retryAfterSeconds: 90 }), 90);
});

test('parseRetryAfter clamps to something a person can survive', () => {
  assert.equal(parseRetryAfter('99999', null), 600);
  assert.equal(parseRetryAfter('0.2', null), 1);
});

test('parseRetryAfter yields undefined when nothing usable was sent', () => {
  assert.equal(parseRetryAfter(null, null), undefined);
  assert.equal(parseRetryAfter(null, {}), undefined);
  assert.equal(parseRetryAfter('-5', { retryAfterSeconds: 'nope' }), undefined);
  assert.equal(parseRetryAfter(null, { retryAfterSeconds: 0 }), undefined);
});
