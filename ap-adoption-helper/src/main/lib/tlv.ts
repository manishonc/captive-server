// Parser for Ubiquiti discovery protocol responses (UDP port 10001).
// Pure functions, no I/O — unit tested in test/tlv.test.ts.

export interface ParsedDevice {
  mac?: string;
  ip?: string;
  hostname?: string;
  model?: string;
  firmware?: string;
}

// TLV types observed in v1/v2 discovery replies.
const TLV_MAC_IP_1 = 0x01; // 6-byte MAC (+ 4-byte IP on some firmware)
const TLV_MAC_IP_2 = 0x02; // 6-byte MAC + 4-byte IP, may repeat per interface
const TLV_FIRMWARE = 0x03;
const TLV_HOSTNAME = 0x0b;
const TLV_MODEL_SHORT = 0x0c;
const TLV_MODEL_FULL = 0x14;

export function formatMac(buf: Buffer): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
}

function tlvString(value: Buffer): string {
  return value.toString('utf8').replace(/\0+$/g, '').trim();
}

/**
 * Parse a discovery reply. Returns null when the packet is not a usable
 * discovery response. Never throws — malformed packets are skipped or
 * parsed as far as they are valid.
 */
export function parseDiscoveryPacket(buf: Buffer, sourceIp: string): ParsedDevice | null {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
    const version = buf[0];
    if (version !== 0x01 && version !== 0x02) return null;

    const out: ParsedDevice = {};
    let i = 4; // skip 4-byte header (version, cmd, u16 payload length)
    while (i + 3 <= buf.length) {
      const type = buf[i];
      const len = buf.readUInt16BE(i + 1);
      const start = i + 3;
      const end = start + len;
      if (end > buf.length) break; // truncated TLV — keep what we already have
      const value = buf.subarray(start, end);

      switch (type) {
        case TLV_MAC_IP_1:
        case TLV_MAC_IP_2:
          if (len >= 10) {
            if (!out.mac) out.mac = formatMac(value.subarray(0, 6));
            if (!out.ip) out.ip = Array.from(value.subarray(6, 10)).join('.');
          } else if (len >= 6 && !out.mac) {
            out.mac = formatMac(value.subarray(0, 6));
          }
          break;
        case TLV_HOSTNAME:
          if (!out.hostname && len > 0) out.hostname = tlvString(value);
          break;
        case TLV_MODEL_FULL:
          if (len > 0) out.model = tlvString(value); // preferred over short model
          break;
        case TLV_MODEL_SHORT:
          if (!out.model && len > 0) out.model = tlvString(value);
          break;
        case TLV_FIRMWARE:
          if (!out.firmware && len > 0) out.firmware = tlvString(value);
          break;
        default:
          break; // unknown TLV — skip
      }
      i = end;
    }

    if (!out.mac && !out.ip) return null;
    if (!out.ip) out.ip = sourceIp;
    return out;
  } catch {
    return null;
  }
}
