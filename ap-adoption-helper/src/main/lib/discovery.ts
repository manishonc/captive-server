// LAN discovery of UniFi devices via the Ubiquiti discovery protocol:
// UDP probes to port 10001 from every active IPv4 interface.

import * as dgram from 'dgram';
import { parseDiscoveryPacket } from './tlv';
import { isUbiquitiMac } from './oui';
import { listIPv4Interfaces } from './net-util';
import { log } from './log';

const DISCOVERY_PORT = 10001;
const V1_PROBE = Buffer.from([0x01, 0x00, 0x00, 0x00]);
const V2_PROBE = Buffer.from([0x02, 0x08, 0x00, 0x00]);
const GLOBAL_BROADCAST = '255.255.255.255';
// Factory self-assigned fallback IP when the AP got no DHCP lease.
const FACTORY_IP = '192.168.1.20';
const PROBE_RESEND_DELAYS_MS = [0, 1000, 2000];

interface ScanSocket {
  sock: dgram.Socket;
  targets: string[];
}

function openSocket(
  bindAddress: string | undefined,
  targets: string[],
  onMessage: (msg: Buffer, rinfo: dgram.RemoteInfo) => void
): Promise<ScanSocket | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let bound = false;
    sock.on('error', (err) => {
      log(`Discovery socket error (${bindAddress ?? 'any'}): ${err.message}`);
      try {
        sock.close();
      } catch {
        // already closed
      }
      if (!bound) resolve(null);
    });
    sock.on('message', onMessage);
    try {
      sock.bind({ address: bindAddress, port: 0 }, () => {
        bound = true;
        try {
          sock.setBroadcast(true);
        } catch (err) {
          log(`setBroadcast failed (${bindAddress ?? 'any'}): ${(err as Error).message}`);
        }
        resolve({ sock, targets });
      });
    } catch (err) {
      log(`Discovery bind failed (${bindAddress ?? 'any'}): ${(err as Error).message}`);
      resolve(null);
    }
  });
}

/**
 * Broadcast discovery probes on every interface and collect replies for
 * windowMs. Malformed packets and per-socket errors never abort the scan.
 */
export async function scan(
  windowMs = 4000,
  onDevice?: (device: DiscoveredDevice) => void
): Promise<DiscoveredDevice[]> {
  const found = new Map<string, DiscoveredDevice>();
  const interfaces = listIPv4Interfaces();
  log(
    `Scanning from ${interfaces.length} interface(s): ` +
      (interfaces.map((i) => `${i.name} ${i.address}`).join(', ') || 'none')
  );

  const handleMessage = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    const parsed = parseDiscoveryPacket(msg, rinfo.address);
    if (!parsed || !parsed.mac) return;
    const existing = found.get(parsed.mac);
    if (existing) {
      // Merge fields discovered by other probes/interfaces.
      existing.hostname = existing.hostname || parsed.hostname;
      existing.model = existing.model || parsed.model;
      existing.firmware = existing.firmware || parsed.firmware;
      return;
    }
    const device: DiscoveredDevice = {
      mac: parsed.mac,
      ip: parsed.ip || rinfo.address,
      hostname: parsed.hostname,
      model: parsed.model,
      firmware: parsed.firmware,
      isUbiquitiOui: isUbiquitiMac(parsed.mac),
      raw: msg.toString('hex'),
    };
    found.set(device.mac, device);
    log(
      `Found device: ${device.model ?? 'unknown model'} at ${device.ip} ` +
        `(${device.mac}${device.hostname ? `, ${device.hostname}` : ''})`
    );
    try {
      onDevice?.(device);
    } catch {
      // UI callback failures must not break the scan
    }
  };

  const opens: Promise<ScanSocket | null>[] = interfaces.map((iface) =>
    openSocket(iface.address, [GLOBAL_BROADCAST, iface.broadcast, FACTORY_IP], handleMessage)
  );
  // Catch-all socket in case an interface-bound send is refused.
  opens.push(openSocket(undefined, [GLOBAL_BROADCAST, FACTORY_IP], handleMessage));

  const sockets = (await Promise.all(opens)).filter((s): s is ScanSocket => s !== null);
  if (sockets.length === 0) {
    log('No usable network interfaces for discovery');
    return [];
  }

  const sendProbes = () => {
    for (const { sock, targets } of sockets) {
      for (const target of targets) {
        for (const probe of [V1_PROBE, V2_PROBE]) {
          try {
            sock.send(probe, DISCOVERY_PORT, target, (err) => {
              if (err) log(`Probe to ${target} failed: ${err.message}`);
            });
          } catch (err) {
            log(`Probe to ${target} failed: ${(err as Error).message}`);
          }
        }
      }
    }
  };

  const timers: NodeJS.Timeout[] = [];
  for (const delay of PROBE_RESEND_DELAYS_MS) {
    if (delay === 0) sendProbes();
    else timers.push(setTimeout(sendProbes, delay));
  }

  await new Promise((resolve) => timers.push(setTimeout(resolve, windowMs)));

  for (const timer of timers) clearTimeout(timer);
  for (const { sock } of sockets) {
    try {
      sock.close();
    } catch {
      // already closed
    }
  }

  const devices = [...found.values()];
  log(`Scan finished: ${devices.length} device(s) found`);
  return devices;
}
