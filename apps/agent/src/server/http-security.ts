import type { FastifyReply, FastifyRequest } from 'fastify';
import { DEVICE_COOKIE } from '@voicecode/protocol';

const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * The device credential lives in an HttpOnly, Secure, SameSite=Strict `__Host-` cookie:
 * page scripts cannot read it (limits XSS impact), it is never sent cross-site, and it
 * is attached automatically to the WebSocket upgrade request.
 */
export function setDeviceCookie(reply: FastifyReply, credential: string): void {
  reply.header(
    'set-cookie',
    `${DEVICE_COOKIE}=${encodeURIComponent(credential)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}`,
  );
}

export function clearDeviceCookie(reply: FastifyReply): void {
  reply.header(
    'set-cookie',
    `${DEVICE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
  );
}

/**
 * Accepts a request only when its Host is one of the names in our certificate and,
 * for state-changing requests and WebSocket upgrades, its Origin is that same host.
 * This blocks cross-site WebSocket hijacking and CSRF from other origins on the LAN.
 */
export function createOriginGuard(allowedHosts: Iterable<string>, extraOrigins: Iterable<string>) {
  const hosts = new Set([...allowedHosts].map((h) => h.toLowerCase()));
  const extras = new Set(extraOrigins);

  const hostAllowed = (request: FastifyRequest): string | undefined => {
    const host = request.headers.host?.toLowerCase();
    if (!host) return undefined;
    const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]!;
    return hosts.has(hostname) ? host : undefined;
  };

  return {
    hostAllowed: (request: FastifyRequest) => hostAllowed(request) !== undefined,
    originAllowed(request: FastifyRequest): boolean {
      const origin = request.headers.origin;
      if (!origin) return false;
      if (extras.has(origin)) return true;
      const host = hostAllowed(request);
      return host !== undefined && origin.toLowerCase() === `https://${host}`;
    },
  };
}

export type OriginGuard = ReturnType<typeof createOriginGuard>;
