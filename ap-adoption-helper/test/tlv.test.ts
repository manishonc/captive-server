import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseDiscoveryPacket, formatMac } from '../src/main/lib/tlv';

function tlv(type: number, value: Buffer): Buffer {
  const header = Buffer.alloc(3);
  header[0] = type;
  header.writeUInt16BE(value.length, 1);
  return Buffer.concat([header, value]);
}

function packet(version: number, tlvs: Buffer[]): Buffer {
  const payload = Buffer.concat(tlvs);
  const head = Buffer.from([version, 0x00, 0x00, 0x00]);
  head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

const MAC = Buffer.from([0x74, 0xfa, 0x29, 0x11, 0x22, 0x33]);
const IP = Buffer.from([192, 168, 2, 6]);

test('parses a full v1 reply (mac+ip, hostname, model, firmware)', () => {
  const buf = packet(0x01, [
    tlv(0x02, Buffer.concat([MAC, IP])),
    tlv(0x0b, Buffer.from('U6-Pro-Office')),
    tlv(0x0c, Buffer.from('U6P')),
    tlv(0x14, Buffer.from('U6-Pro')),
    tlv(0x03, Buffer.from('BZ.qca9563.v6.6.55')),
  ]);
  const parsed = parseDiscoveryPacket(buf, '10.0.0.99');
  assert.ok(parsed);
  assert.equal(parsed.mac, '74:fa:29:11:22:33');
  assert.equal(parsed.ip, '192.168.2.6');
  assert.equal(parsed.hostname, 'U6-Pro-Office');
  assert.equal(parsed.model, 'U6-Pro'); // 0x14 full model preferred over 0x0c
  assert.equal(parsed.firmware, 'BZ.qca9563.v6.6.55');
});

test('accepts a v2 header', () => {
  const buf = packet(0x02, [tlv(0x02, Buffer.concat([MAC, IP]))]);
  const parsed = parseDiscoveryPacket(buf, '10.0.0.99');
  assert.ok(parsed);
  assert.equal(parsed.mac, '74:fa:29:11:22:33');
  assert.equal(parsed.ip, '192.168.2.6');
});

test('short model (0x0c) used when full model absent', () => {
  const buf = packet(0x01, [tlv(0x02, Buffer.concat([MAC, IP])), tlv(0x0c, Buffer.from('U6P'))]);
  const parsed = parseDiscoveryPacket(buf, '10.0.0.99');
  assert.ok(parsed);
  assert.equal(parsed.model, 'U6P');
});

test('mac-only TLV falls back to the packet source IP', () => {
  const buf = packet(0x01, [tlv(0x01, MAC)]);
  const parsed = parseDiscoveryPacket(buf, '192.168.1.20');
  assert.ok(parsed);
  assert.equal(parsed.mac, '74:fa:29:11:22:33');
  assert.equal(parsed.ip, '192.168.1.20');
});

test('truncated TLV keeps earlier fields and does not throw', () => {
  const good = tlv(0x02, Buffer.concat([MAC, IP]));
  const truncated = Buffer.from([0x0b, 0xff, 0xff, 0x41]); // claims 65535 bytes, has 1
  const buf = Buffer.concat([packet(0x01, [good]), truncated]);
  const parsed = parseDiscoveryPacket(buf, '10.0.0.99');
  assert.ok(parsed);
  assert.equal(parsed.mac, '74:fa:29:11:22:33');
  assert.equal(parsed.hostname, undefined);
});

test('garbage and undersized packets return null without throwing', () => {
  assert.equal(parseDiscoveryPacket(Buffer.alloc(0), '1.2.3.4'), null);
  assert.equal(parseDiscoveryPacket(Buffer.from([0x01]), '1.2.3.4'), null);
  assert.equal(parseDiscoveryPacket(Buffer.from([0x7f, 0x00, 0x00, 0x00]), '1.2.3.4'), null);
  const random = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256));
  random[0] = 0x99; // not a discovery version byte
  assert.equal(parseDiscoveryPacket(random, '1.2.3.4'), null);
});

test('reply carrying no mac/ip TLV returns null', () => {
  const buf = packet(0x01, [tlv(0x0b, Buffer.from('hostname-only'))]);
  assert.equal(parseDiscoveryPacket(buf, '10.0.0.99'), null);
});

test('formatMac zero-pads each byte', () => {
  assert.equal(formatMac(Buffer.from([0x00, 0x0a, 0xff, 0x01, 0x02, 0x03])), '00:0a:ff:01:02:03');
});
