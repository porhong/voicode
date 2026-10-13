import { describe, expect, it } from 'vitest';
import { PairingCodeManager } from './pairing.js';
import { generateSecret, hashSecret, verifySecret } from './tokens.js';

describe('PairingCodeManager', () => {
  it('issues six-digit codes with a display form', () => {
    const codes = new PairingCodeManager().issue();
    expect(codes.code).toMatch(/^\d{6}$/);
    expect(codes.display).toBe(`${codes.code.slice(0, 3)}-${codes.code.slice(3)}`);
  });

  it('accepts the right code exactly once', () => {
    const mgr = new PairingCodeManager();
    const { code } = mgr.issue();
    expect(mgr.verify(code)).toEqual({ ok: true });
    expect(mgr.verify(code)).toEqual({ ok: false, reason: 'no_code' });
  });

  it('expires codes', () => {
    let now = 0;
    const mgr = new PairingCodeManager({ ttlMs: 1000, now: () => now });
    const { code } = mgr.issue();
    now = 1000;
    expect(mgr.active()).toBeUndefined();
    expect(mgr.verify(code)).toEqual({ ok: false, reason: 'expired' });
  });

  it('burns the code after too many wrong guesses', () => {
    const mgr = new PairingCodeManager({ maxAttempts: 3 });
    const { code } = mgr.issue();
    const wrong = code === '000000' ? '111111' : '000000';
    expect(mgr.verify(wrong).ok).toBe(false);
    expect(mgr.verify(wrong).ok).toBe(false);
    expect(mgr.verify(wrong)).toEqual({ ok: false, reason: 'locked' });
    expect(mgr.verify(code)).toEqual({ ok: false, reason: 'no_code' });
  });
});

describe('secrets', () => {
  it('verifies against stored hashes only', () => {
    const secret = generateSecret();
    const stored = hashSecret(secret);
    expect(stored).not.toContain(secret);
    expect(verifySecret(secret, stored)).toBe(true);
    expect(verifySecret(generateSecret(), stored)).toBe(false);
  });
});
