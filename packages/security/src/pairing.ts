import { randomInt } from 'node:crypto';
import { safeEqual } from './tokens.js';

export interface PairingCode {
  /** Six digits, no separators. */
  code: string;
  /** Display form, e.g. "482-917". */
  display: string;
  expiresAt: number;
}

export interface PairingCodeOptions {
  ttlMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

export type PairingVerdict =
  { ok: true } | { ok: false; reason: 'no_code' | 'expired' | 'mismatch' | 'locked' };

/**
 * One-time pairing code with an expiry and an attempt budget.
 *
 * A 6-digit code has 10^6 possibilities; with at most `maxAttempts` guesses before the
 * code is burned (and HTTP rate limiting in front), an attacker on the LAN has a
 * ~maxAttempts/10^6 chance per code the owner generates.
 */
export class PairingCodeManager {
  private current: (PairingCode & { attempts: number }) | undefined;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(options: PairingCodeOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.now = options.now ?? Date.now;
  }

  /** Issues a fresh code, invalidating any previous one. */
  issue(): PairingCode {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    this.current = {
      code,
      display: `${code.slice(0, 3)}-${code.slice(3)}`,
      expiresAt: this.now() + this.ttlMs,
      attempts: 0,
    };
    return this.active()!;
  }

  /** The currently valid code, if any. */
  active(): PairingCode | undefined {
    if (!this.current || this.now() >= this.current.expiresAt) return undefined;
    const { code, display, expiresAt } = this.current;
    return { code, display, expiresAt };
  }

  /**
   * Checks a candidate code. A correct code is consumed (single use); exhausting the
   * attempt budget burns the code so the owner has to issue a new one.
   */
  verify(candidate: string): PairingVerdict {
    const current = this.current;
    if (!current) return { ok: false, reason: 'no_code' };
    if (this.now() >= current.expiresAt) {
      this.current = undefined;
      return { ok: false, reason: 'expired' };
    }
    if (current.attempts >= this.maxAttempts) return { ok: false, reason: 'locked' };

    current.attempts += 1;
    if (safeEqual(candidate, current.code)) {
      this.current = undefined;
      return { ok: true };
    }
    if (current.attempts >= this.maxAttempts) {
      this.current = undefined;
      return { ok: false, reason: 'locked' };
    }
    return { ok: false, reason: 'mismatch' };
  }

  revoke(): void {
    this.current = undefined;
  }
}
