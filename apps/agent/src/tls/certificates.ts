import { readFile } from 'node:fs/promises';
import os from 'node:os';
import {
  createCertificateAuthority,
  inspectCertificate,
  issueServerCertificate,
  serverSubjectAltNames,
} from '@voicecode/security';
import type { AgentPaths } from '../config/paths.js';
import { fileExists, writeFileAtomic } from '../util/fs.js';
import type { Logger } from '../util/logger.js';

/** Reissue the server certificate when it has less than this long left. */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

export interface TlsMaterial {
  key: string;
  cert: string;
  caCert: string;
  caFingerprint: string;
  /** Host names and IPs the server certificate is valid for. */
  names: string[];
}

export async function ensureCertificateAuthority(
  paths: AgentPaths,
  options: { force?: boolean } = {},
): Promise<{ certPem: string; keyPem: string; fingerprint: string; created: boolean }> {
  if (!options.force && (await fileExists(paths.caCert)) && (await fileExists(paths.caKey))) {
    const certPem = await readFile(paths.caCert, 'utf8');
    const keyPem = await readFile(paths.caKey, 'utf8');
    const fingerprint = await inspectCertificate(certPem).fingerprintPromise;
    return { certPem, keyPem, fingerprint, created: false };
  }
  const ca = await createCertificateAuthority(os.hostname());
  await writeFileAtomic(paths.caKey, ca.keyPem);
  await writeFileAtomic(paths.caCert, ca.certPem, 0o644);
  return { ...ca, created: true };
}

/**
 * Loads the TLS material, creating the local CA on first run and (re)issuing the
 * server certificate when it is missing, close to expiry, or no longer covers the
 * machine's current LAN addresses (e.g. after DHCP handed out a new IP).
 */
export async function ensureTls(
  paths: AgentPaths,
  ips: string[],
  logger: Logger,
  options: { forceCa?: boolean } = {},
): Promise<TlsMaterial> {
  const ca = await ensureCertificateAuthority(paths, { force: options.forceCa });
  if (ca.created)
    logger.info({ fingerprint: ca.fingerprint }, 'created local certificate authority');

  const wanted = serverSubjectAltNames({ hostname: os.hostname(), ips });
  let reason: string | undefined = ca.created ? 'new CA' : undefined;

  if (!reason && !((await fileExists(paths.serverCert)) && (await fileExists(paths.serverKey)))) {
    reason = 'missing';
  }
  if (!reason) {
    const current = inspectCertificate(await readFile(paths.serverCert, 'utf8'));
    if (current.notAfter.getTime() - Date.now() < RENEW_BEFORE_MS) reason = 'expiring';
    else if (!wanted.ips.every((ip) => current.ips.includes(ip))) reason = 'addresses changed';
    else if (!wanted.dns.every((d) => current.dns.includes(d))) reason = 'hostname changed';
  }

  if (reason) {
    const leaf = await issueServerCertificate(ca, { hostname: os.hostname(), ips });
    await writeFileAtomic(paths.serverKey, leaf.keyPem);
    await writeFileAtomic(paths.serverCert, leaf.certPem, 0o644);
    logger.info({ reason, sans: leaf.sans }, 'issued server certificate');
  }

  const cert = await readFile(paths.serverCert, 'utf8');
  const info = inspectCertificate(cert);
  return {
    key: await readFile(paths.serverKey, 'utf8'),
    cert,
    caCert: ca.certPem,
    caFingerprint: ca.fingerprint,
    names: [...info.dns, ...info.ips],
  };
}
