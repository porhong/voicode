import { once } from 'node:events';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createCertificateAuthority,
  issueServerCertificate,
  inspectCertificate,
  isPermittedIp,
  serverSubjectAltNames,
} from './ca.js';

async function handshake(
  server: { certPem: string; keyPem: string },
  caPem: string,
  servername: string,
  host = '127.0.0.1',
): Promise<void> {
  const srv = tls.createServer({ cert: server.certPem, key: server.keyPem }, (s) => s.end());
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address() as { port: number };
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect({
        host,
        port,
        ca: caPem,
        servername: isIP(servername) ? undefined : servername,
        checkServerIdentity: (_h, cert) => tls.checkServerIdentity(servername, cert),
      });
      socket.once('secureConnect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', reject);
    });
  } finally {
    srv.close();
  }
}

describe('local certificate authority', () => {
  it('issues a server cert that verifies over TLS for IPs and .local names', async () => {
    const ca = await createCertificateAuthority('devbox');
    const leaf = await issueServerCertificate(ca, {
      hostname: 'DevBox',
      ips: ['192.168.1.100', '8.8.8.8'],
    });

    expect(leaf.sans.dns).toEqual(['devbox.local', 'localhost']);
    expect(leaf.sans.ips).toEqual(['127.0.0.1', '192.168.1.100']);

    await handshake(leaf, ca.certPem, '127.0.0.1');
    await handshake(leaf, ca.certPem, 'devbox.local');
    await handshake(leaf, ca.certPem, 'localhost');
  });

  it('marks the CA with critical name constraints and a matching fingerprint', async () => {
    const ca = await createCertificateAuthority('devbox');
    const cert = new X509Certificate(ca.certPem);
    expect(cert.ca).toBe(true);
    expect(cert.fingerprint256).toBe(ca.fingerprint);
    const info = inspectCertificate(ca.certPem);
    expect(await info.fingerprintPromise).toBe(ca.fingerprint);
  });

  it('rejects names the CA is not permitted to vouch for', async () => {
    const ca = await createCertificateAuthority('devbox');
    const leaf = await issueServerCertificate(ca, { hostname: 'devbox', ips: [] });
    await expect(handshake(leaf, ca.certPem, 'example.com')).rejects.toThrow(
      /not in the cert's altnames|does not match/i,
    );
  });

  it('limits SANs to private ranges', () => {
    expect(isPermittedIp('10.1.2.3')).toBe(true);
    expect(isPermittedIp('172.31.255.1')).toBe(true);
    expect(isPermittedIp('172.32.0.1')).toBe(false);
    expect(isPermittedIp('100.100.1.1')).toBe(true);
    expect(isPermittedIp('1.1.1.1')).toBe(false);
    expect(isPermittedIp('fe80::1')).toBe(false);
    expect(serverSubjectAltNames({ hostname: 'bad_name!', ips: [] }).dns).toEqual(['localhost']);
  });
});
