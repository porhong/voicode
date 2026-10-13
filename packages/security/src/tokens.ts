import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random secret encoded as base64url; used for device credentials and control tokens. */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Credentials are stored only as SHA-256 hashes. The secrets are high-entropy random
 * values, so a fast hash is appropriate (no password stretching needed).
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

/**
 * Constant-time string comparison. Hashing first gives equal-length buffers, so neither
 * content nor length leaks through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

/** Verifies a presented secret against a stored hash in constant time. */
export function verifySecret(presented: string, storedHash: string): boolean {
  return safeEqual(hashSecret(presented), storedHash);
}
