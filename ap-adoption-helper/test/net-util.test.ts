import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { computeBroadcast } from '../src/main/lib/net-util';

test('computeBroadcast for a /24', () => {
  assert.equal(computeBroadcast('192.168.2.6', '255.255.255.0'), '192.168.2.255');
});

test('computeBroadcast for a /16', () => {
  assert.equal(computeBroadcast('10.1.2.3', '255.255.0.0'), '10.1.255.255');
});

test('computeBroadcast for a /22', () => {
  assert.equal(computeBroadcast('172.16.5.9', '255.255.252.0'), '172.16.7.255');
});

test('computeBroadcast for a /32 is the address itself', () => {
  assert.equal(computeBroadcast('10.9.8.7', '255.255.255.255'), '10.9.8.7');
});
