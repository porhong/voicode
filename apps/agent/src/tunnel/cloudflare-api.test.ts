import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { certZoneName, deleteTunnelDnsRecord, parseOriginCert } from './cloudflare-api.js';

const TUNNEL_ID = '6ff42ae2-765d-4adf-8112-31c55c1551ef';
const token = { zoneID: 'zone1', accountID: 'acct1', apiToken: 'secret-token' };
const pem =
  '-----BEGIN ARGO TUNNEL TOKEN-----\n' +
  Buffer.from(JSON.stringify(token))
    .toString('base64')
    .replace(/(.{64})/g, '$1\n') +
  '\n-----END ARGO TUNNEL TOKEN-----\n';

let dir: string;
let certPath: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'voicecode-cf-'));
  certPath = path.join(dir, 'cert.pem');
  await writeFile(certPath, pem);
});

afterAll(() => rm(dir, { recursive: true, force: true }));

/** A Cloudflare API stand-in that records the calls made to it. */
function fakeApi(records: Array<{ id: string; name: string; content: string }>, zone = 'x.dev') {
  const calls: Array<{ method: string; url: string; auth: string | null }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      auth: new Headers(init?.headers).get('authorization'),
    });
    const json = (result: unknown) =>
      new Response(JSON.stringify({ success: true, result }), { status: 200 });
    if (url.endsWith('/zones/zone1')) return json({ name: zone });
    if (method === 'GET') {
      const name = new URL(url).searchParams.get('name');
      return json(records.filter((r) => r.name === name));
    }
    return json({ id: url.split('/').pop() });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('Cloudflare API', () => {
  it('reads the token block of the login certificate', () => {
    expect(parseOriginCert(pem)).toEqual(token);
    expect(parseOriginCert('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----')).toBe(
      undefined,
    );
  });

  it('deletes only the record that points at this tunnel', async () => {
    const { calls, fetchFn } = fakeApi([
      { id: 'r1', name: 'pc1.x.dev', content: `${TUNNEL_ID}.cfargotunnel.com` },
      { id: 'r2', name: 'pc2.x.dev', content: `${TUNNEL_ID}.cfargotunnel.com` },
    ]);
    expect(await deleteTunnelDnsRecord(certPath, 'pc1.x.dev', TUNNEL_ID, fetchFn)).toBe(1);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    expect(calls[1]!.url).toBe('https://api.cloudflare.com/client/v4/zones/zone1/dns_records/r1');
    expect(calls.every((c) => c.auth === 'Bearer secret-token')).toBe(true);
  });

  it('leaves a record that was pointed elsewhere', async () => {
    const { calls, fetchFn } = fakeApi([
      {
        id: 'r1',
        name: 'pc1.x.dev',
        content: '11111111-765d-4adf-8112-31c55c1551ef.cfargotunnel.com',
      },
    ]);
    expect(await deleteTunnelDnsRecord(certPath, 'pc1.x.dev', TUNNEL_ID, fetchFn)).toBe(0);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('reports unknown when the zone cannot be read', async () => {
    const failing = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    expect(await deleteTunnelDnsRecord(certPath, 'pc1.x.dev', TUNNEL_ID, failing)).toBe(undefined);
    expect(await deleteTunnelDnsRecord(path.join(dir, 'missing.pem'), 'a.x.dev', TUNNEL_ID)).toBe(
      undefined,
    );
  });

  it("names the login's zone", async () => {
    expect(await certZoneName(certPath, fakeApi([], 'Example.COM').fetchFn)).toBe('example.com');
  });
});
