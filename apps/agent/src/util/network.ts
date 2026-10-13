import dgram from 'node:dgram';
import os from 'node:os';
import { isPermittedIp } from '@voicecode/security';

export interface LanAddress {
  iface: string;
  address: string;
}

/** Adapters that are rarely the network the phone is on. */
const VIRTUAL_INTERFACE =
  /(vethernet|virtualbox|vmware|docker|br-|veth|wsl|hyper-v|loopback|tailscale|zerotier|utun|local area connection\*)/i;

function score(a: LanAddress): number {
  let s = 0;
  if (VIRTUAL_INTERFACE.test(a.iface)) s += 10;
  if (a.address.startsWith('100.')) s += 5; // CGNAT / overlay VPNs
  if (a.address.startsWith('192.168.56.')) s += 5; // VirtualBox host-only default
  if (a.address.startsWith('192.168.137.')) s += 5; // Windows hotspot / ICS
  return s;
}

/**
 * Private IPv4 addresses of this machine, likeliest LAN first (physical adapters
 * before virtual ones and VPN overlays). Loopback and link-local are excluded.
 */
export function lanAddresses(): LanAddress[] {
  const result: LanAddress[] = [];
  for (const [iface, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (!isPermittedIp(info.address) || info.address.startsWith('169.254.')) continue;
      result.push({ iface, address: info.address });
    }
  }
  return result.sort((a, b) => score(a) - score(b));
}

/**
 * The local address the OS would use for its default route. Connecting a UDP socket
 * only selects a route; no packet is sent.
 */
export function defaultRouteAddress(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = (address?: string) => {
      socket.close();
      resolve(address);
    };
    socket.once('error', () => done());
    socket.connect(53, '192.0.2.1', () => {
      try {
        done(socket.address().address);
      } catch {
        done();
      }
    });
  });
}

/** `lanAddresses()` with the default-route address (if private) moved to the front. */
export async function rankedLanAddresses(): Promise<LanAddress[]> {
  const addresses = lanAddresses();
  const primary = await defaultRouteAddress();
  const index = addresses.findIndex((a) => a.address === primary);
  if (index > 0) addresses.unshift(...addresses.splice(index, 1));
  return addresses;
}

export function formatUrl(host: string, port: number): string {
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}
