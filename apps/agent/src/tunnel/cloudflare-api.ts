import { readFile } from 'node:fs/promises';

/**
 * The few Cloudflare API calls cloudflared has no command for. `cloudflared tunnel route
 * dns` adds a host name's CNAME but nothing removes it, and a record left behind after its
 * tunnel is deleted answers every visitor with error 1016. The API token is the one
 * `cloudflared tunnel login` stored in its certificate (the same one cloudflared uses to
 * add the record), scoped to the zone picked at login.
 */

const API = 'https://api.cloudflare.com/client/v4';
const TIMEOUT_MS = 15_000;

export interface OriginCertToken {
  zoneID: string;
  accountID: string;
  apiToken: string;
}

/** The token block of `cert.pem`: base64 JSON with the zone, account and API token. */
export function parseOriginCert(pem: string): OriginCertToken | undefined {
  const block = /-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]*?)-----END ARGO TUNNEL TOKEN-----/.exec(
    pem,
  );
  if (!block) return undefined;
  try {
    const data = JSON.parse(
      Buffer.from(block[1]!.replace(/\s/g, ''), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    const { zoneID, accountID, apiToken } = data;
    if (typeof zoneID !== 'string' || typeof apiToken !== 'string') return undefined;
    return { zoneID, accountID: typeof accountID === 'string' ? accountID : '', apiToken };
  } catch {
    return undefined;
  }
}

type Fetch = typeof fetch;

/**
 * Deletes the CNAME for `hostname` if, and only if, it points at `tunnelId`: a record
 * that was changed to point elsewhere is not ours to remove. Resolves with the number of
 * records deleted, or undefined when the zone can't be read (the host name is in another
 * zone than the login, no network, a revoked token).
 */
export async function deleteTunnelDnsRecord(
  certPath: string,
  hostname: string,
  tunnelId: string,
  fetchFn: Fetch = fetch,
): Promise<number | undefined> {
  const cert = parseOriginCert(await readFile(certPath, 'utf8').catch(() => ''));
  if (!cert) return undefined;
  const call = async (method: string, route: string) => {
    const res = await fetchFn(`${API}/zones/${encodeURIComponent(cert.zoneID)}${route}`, {
      method,
      headers: { authorization: `Bearer ${cert.apiToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: unknown };
    return res.ok && body.success ? body.result : undefined;
  };
  try {
    const query = `?type=CNAME&name=${encodeURIComponent(hostname)}`;
    const records = await call('GET', `/dns_records${query}`);
    if (!Array.isArray(records)) return undefined;
    const target = `${tunnelId}.cfargotunnel.com`;
    const ours = (records as Array<{ id?: unknown; name?: unknown; content?: unknown }>).filter(
      (r) => typeof r.id === 'string' && r.name === hostname && r.content === target,
    );
    let deleted = 0;
    for (const record of ours) {
      if (
        (await call('DELETE', `/dns_records/${encodeURIComponent(record.id as string)}`)) ===
        undefined
      ) {
        return undefined;
      }
      deleted++;
    }
    return deleted;
  } catch {
    return undefined;
  }
}

/** The zone (domain) the login on this PC is for, or undefined when it can't be read. */
export async function certZoneName(
  certPath: string,
  fetchFn: Fetch = fetch,
): Promise<string | undefined> {
  const cert = parseOriginCert(await readFile(certPath, 'utf8').catch(() => ''));
  if (!cert) return undefined;
  try {
    const res = await fetchFn(`${API}/zones/${encodeURIComponent(cert.zoneID)}`, {
      headers: { authorization: `Bearer ${cert.apiToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: { name?: unknown };
    };
    const name = res.ok && body.success ? body.result?.name : undefined;
    return typeof name === 'string' ? name.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
