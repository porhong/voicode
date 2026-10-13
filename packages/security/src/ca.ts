import 'reflect-metadata';
import { randomBytes, webcrypto } from 'node:crypto';
import { isIPv4 } from 'node:net';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNING_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Leaf certificates are kept under Apple's 398-day limit for TLS server certificates. */
export const LEAF_VALIDITY_DAYS = 397;
export const CA_VALIDITY_DAYS = 5 * 365;

/**
 * Networks the local CA is allowed to vouch for. The CA certificate carries these as a
 * critical X.509 Name Constraints extension, so even if the CA private key leaked it
 * could not be used to impersonate public internet sites to a device that trusts it.
 */
export const PERMITTED_IPV4_NETWORKS: ReadonlyArray<readonly [string, number]> = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  // Carrier-grade NAT range, used by Tailscale and similar overlay VPNs.
  ['100.64.0.0', 10],
];
export const PERMITTED_DNS_SUFFIXES: readonly string[] = ['localhost', 'local'];

export interface PemKeyPair {
  certPem: string;
  keyPem: string;
}

export interface CertificateAuthority extends PemKeyPair {
  /** SHA-256 fingerprint of the CA certificate, colon separated hex. */
  fingerprint: string;
}

export interface IssuedCertificate extends PemKeyPair {
  sans: { dns: string[]; ips: string[] };
  notAfter: Date;
}

export async function createCertificateAuthority(
  hostname: string,
  now = new Date(),
): Promise<CertificateAuthority> {
  const keys = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: `CN=VoiceCode Local CA (${escapeDnValue(hostname)}), O=VoiceCode`,
    notBefore: backdate(now),
    notAfter: new Date(now.getTime() + CA_VALIDITY_DAYS * DAY_MS),
    signingAlgorithm: SIGNING_ALGORITHM,
    keys: keys as unknown as CryptoKeyPair,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      new x509.Extension('2.5.29.30', true, new Uint8Array(encodeNameConstraints())),
      // Limits the CA to TLS server certificates even if it is imported as a general
      // trusted root on a desktop (no code signing, no S/MIME).
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey as unknown as CryptoKey),
    ],
  });
  return {
    certPem: cert.toString('pem'),
    keyPem: await exportPrivateKeyPem(keys.privateKey as unknown as CryptoKey),
    fingerprint: await fingerprintOf(cert),
  };
}

/**
 * Issues a TLS server certificate for the given host names / IP addresses, signed by the
 * local CA. Names outside the CA's permitted networks are dropped, because clients would
 * reject a certificate that violates the CA's name constraints anyway.
 */
export async function issueServerCertificate(
  ca: PemKeyPair,
  names: { hostname: string; ips: string[] },
  now = new Date(),
): Promise<IssuedCertificate> {
  const caCert = new x509.X509Certificate(ca.certPem);
  const caKey = await importPrivateKeyPem(ca.keyPem);
  const keys = await webcrypto.subtle.generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);

  const sans = serverSubjectAltNames(names);
  const notAfter = new Date(now.getTime() + LEAF_VALIDITY_DAYS * DAY_MS);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: `CN=${escapeDnValue(sans.dns[0] ?? 'localhost')}`,
    issuer: caCert.subject,
    notBefore: backdate(now),
    notAfter,
    signingAlgorithm: SIGNING_ALGORITHM,
    publicKey: keys.publicKey as unknown as CryptoKey,
    signingKey: caKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension([
        ...sans.dns.map((value) => ({ type: 'dns' as const, value })),
        ...sans.ips.map((value) => ({ type: 'ip' as const, value })),
      ]),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey as unknown as CryptoKey),
      await x509.AuthorityKeyIdentifierExtension.create(caCert),
    ],
  });

  return {
    certPem: cert.toString('pem'),
    keyPem: await exportPrivateKeyPem(keys.privateKey as unknown as CryptoKey),
    sans,
    notAfter,
  };
}

/** Builds the SAN list: loopback, `<hostname>.local`, and every permitted IPv4 address. */
export function serverSubjectAltNames(names: { hostname: string; ips: string[] }): {
  dns: string[];
  ips: string[];
} {
  const host = names.hostname.toLowerCase().replace(/\.local$/, '');
  const dns = ['localhost'];
  if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) dns.unshift(`${host}.local`);
  const ips = [...new Set(['127.0.0.1', ...names.ips])].filter(isPermittedIp);
  return { dns, ips };
}

export function isPermittedIp(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const value = ipv4ToInt(ip);
  return PERMITTED_IPV4_NETWORKS.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) >>> 0 === (ipv4ToInt(network) & mask) >>> 0;
  });
}

/** Parses the certificate and reports its SANs and expiry, for rotation decisions. */
export function inspectCertificate(certPem: string): {
  notAfter: Date;
  dns: string[];
  ips: string[];
  fingerprintPromise: Promise<string>;
} {
  const cert = new x509.X509Certificate(certPem);
  const san = cert.getExtension(x509.SubjectAlternativeNameExtension);
  const dns: string[] = [];
  const ips: string[] = [];
  for (const name of san?.names.items ?? []) {
    if (name.type === 'dns') dns.push(name.value);
    if (name.type === 'ip') ips.push(name.value);
  }
  return { notAfter: cert.notAfter, dns, ips, fingerprintPromise: fingerprintOf(cert) };
}

// --- helpers ---------------------------------------------------------------

async function fingerprintOf(cert: x509.X509Certificate): Promise<string> {
  const digest = Buffer.from(await cert.getThumbprint('SHA-256'));
  return [...digest].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', key as never));
  return x509.PemConverter.encode(der, 'PRIVATE KEY');
}

async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  const der = x509.PemConverter.decodeFirst(pem);
  return (await webcrypto.subtle.importKey('pkcs8', der, KEY_ALGORITHM, false, [
    'sign',
  ])) as unknown as CryptoKey;
}

function randomSerial(): string {
  const bytes = randomBytes(16);
  bytes[0] = bytes[0]! & 0x7f; // keep the INTEGER positive
  return bytes.toString('hex');
}

/** Small clock-skew allowance so a phone whose clock is slightly behind accepts new certs. */
function backdate(now: Date): Date {
  return new Date(now.getTime() - 60 * 60 * 1000);
}

function escapeDnValue(value: string): string {
  return value.replace(/[,+="\\<>;#]/g, (c) => `\\${c}`);
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

/*
 * DER encoding of:
 *   NameConstraints ::= SEQUENCE { permittedSubtrees [0] IMPLICIT GeneralSubtrees }
 *   GeneralSubtree  ::= SEQUENCE { base GeneralName }
 *   GeneralName     ::= dNSName [2] IA5String | iPAddress [7] OCTET STRING (address ‖ mask)
 */
function encodeNameConstraints(): Uint8Array {
  const subtrees: Uint8Array[] = [
    ...PERMITTED_DNS_SUFFIXES.map((name) => der(0x30, der(0x82, Buffer.from(name, 'ascii')))),
    ...PERMITTED_IPV4_NETWORKS.map(([network, prefix]) => {
      const address = ipv4ToInt(network);
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      const bytes = Buffer.alloc(8);
      bytes.writeUInt32BE(address, 0);
      bytes.writeUInt32BE(mask, 4);
      return der(0x30, der(0x87, bytes));
    }),
  ];
  return der(0x30, der(0xa0, Buffer.concat(subtrees)));
}

function der(tag: number, content: Uint8Array): Uint8Array {
  const length = content.length;
  let header: number[];
  if (length < 0x80) header = [tag, length];
  else if (length < 0x100) header = [tag, 0x81, length];
  else header = [tag, 0x82, length >> 8, length & 0xff];
  return Buffer.concat([Buffer.from(header), content]);
}
