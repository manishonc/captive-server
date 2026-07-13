import * as os from 'os';

export interface Ipv4Interface {
  name: string;
  address: string;
  netmask: string;
  broadcast: string;
}

/** Subnet broadcast address for an IPv4 address + netmask pair. */
export function computeBroadcast(address: string, netmask: string): string {
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  return a.map((oct, i) => (oct & m[i]) | (~m[i] & 0xff)).join('.');
}

/** All non-internal IPv4 interfaces, excluding link-local (169.254.x.x). */
export function listIPv4Interfaces(): Ipv4Interface[] {
  const out: Ipv4Interface[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal || addr.family !== 'IPv4') continue;
      if (addr.address.startsWith('169.254.')) continue;
      out.push({
        name,
        address: addr.address,
        netmask: addr.netmask,
        broadcast: computeBroadcast(addr.address, addr.netmask),
      });
    }
  }
  return out;
}
