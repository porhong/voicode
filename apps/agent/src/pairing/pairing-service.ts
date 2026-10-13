import { EventEmitter } from 'node:events';
import { normalizePairingCode } from '@voicecode/protocol';
import { PairingCodeManager, type PairingCode } from '@voicecode/security';
import type { DeviceRegistry, PublicDevice } from './device-registry.js';

export type PairOutcome =
  | { ok: true; device: PublicDevice; credential: string }
  | { ok: false; reason: 'no_code' | 'expired' | 'mismatch' | 'locked' | 'malformed' };

/** Exchanges a one-time pairing code shown on the PC for a long-lived device credential. */
export class PairingService extends EventEmitter<{
  paired: [device: PublicDevice];
  failed: [reason: string, remoteAddress: string];
  code: [code: PairingCode];
}> {
  private readonly codes: PairingCodeManager;

  constructor(
    private readonly registry: DeviceRegistry,
    options: { ttlMs: number; maxAttempts: number },
  ) {
    super();
    this.codes = new PairingCodeManager(options);
  }

  issueCode(): PairingCode {
    const code = this.codes.issue();
    this.emit('code', code);
    return code;
  }

  activeCode(): PairingCode | undefined {
    return this.codes.active();
  }

  async pair(
    rawCode: string,
    deviceName: string,
    meta: { userAgent?: string; remoteAddress: string },
  ): Promise<PairOutcome> {
    const code = normalizePairingCode(rawCode);
    if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'malformed' };

    const verdict = this.codes.verify(code);
    if (!verdict.ok) {
      this.emit('failed', verdict.reason, meta.remoteAddress);
      return verdict;
    }
    const { device, credential } = await this.registry.add(deviceName, meta.userAgent);
    this.emit('paired', device);
    return { ok: true, device, credential };
  }
}
