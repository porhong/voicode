import { EventEmitter } from 'node:events';
import type { ErrorCode, MouseButton, MouseStatus } from '@voicecode/protocol';
import type { Logger } from '../util/logger.js';
import type { DriverInfo, MouseDriver } from './driver.js';
import type { DriverCandidate } from './resolve-driver.js';

export interface ClientIdentity {
  connectionId: string;
  deviceId: string;
  deviceName: string;
}

export type RouterResult = { ok: true } | { ok: false; code: ErrorCode; message: string };

const OK: RouterResult = { ok: true };
const MAX_RESTARTS = 5;

/**
 * Routes mouse input from browser clients to the active driver.
 *
 * - Exactly one connection holds the control lease at a time; input from anyone else
 *   is rejected. A lease is released when its connection closes, when the holder
 *   releases it, or after `leaseIdleMs` without input, and can be taken over with
 *   `force`.
 * - Relative movement is coalesced and flushed at most every `flushIntervalMs`, so a
 *   burst of small touch deltas becomes one OS input event.
 * - Buttons pressed through the lease are tracked and always released when the lease
 *   ends, so a dropped connection can never leave a button stuck down.
 */
export class InputRouter extends EventEmitter<{ status: [] }> {
  private driver: MouseDriver | undefined;
  private driverName = 'none';
  private driverInfo: DriverInfo | undefined;
  private unavailableReason: string | undefined = 'not started';
  private lease: { holder: ClientIdentity; lastActivity: number } | undefined;
  private readonly pressed = new Set<MouseButton>();
  private pending = { dx: 0, dy: 0 };
  private flushTimer: NodeJS.Timeout | undefined;
  private lastFlush = 0;
  private readonly sweepTimer: NodeJS.Timeout;
  private restarts = 0;
  private stopped = false;

  constructor(
    private readonly logger: Logger,
    private readonly options: { leaseIdleMs: number; flushIntervalMs?: number; now?: () => number },
  ) {
    super();
    this.sweepTimer = setInterval(() => this.expireIdleLease(), 5_000);
    this.sweepTimer.unref();
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Tries each candidate backend in order and keeps the first that starts. */
  async start(candidates: DriverCandidate[], unavailableReason?: string): Promise<void> {
    const failures: string[] = [];
    for (const candidate of candidates) {
      const driver = candidate.create();
      try {
        const info = await driver.start();
        this.attach(driver, info, candidate);
        return;
      } catch (err) {
        failures.push(`${candidate.name}: ${(err as Error).message}`);
        this.logger.warn({ err, driver: candidate.name }, 'mouse driver failed to start');
      }
    }
    this.unavailableReason = failures.length ? failures.join('; ') : unavailableReason;
    this.emit('status');
  }

  /** Attaches an already-started driver (also used by tests). */
  attach(driver: MouseDriver, info: DriverInfo, candidate?: DriverCandidate): void {
    this.driver = driver;
    this.driverName = driver.name;
    this.driverInfo = info;
    this.unavailableReason = undefined;
    this.logger.info({ driver: driver.name, ...info.details }, 'mouse driver ready');
    driver.onExit((error) => {
      this.logger.error({ err: error }, 'mouse driver exited');
      this.driver = undefined;
      this.unavailableReason = error.message;
      this.pressed.clear();
      this.lease = undefined;
      this.emit('status');
      if (candidate && !this.stopped && this.restarts < MAX_RESTARTS) {
        const delay = 500 * 2 ** this.restarts++;
        setTimeout(() => void this.start([candidate], error.message), delay).unref();
      }
    });
    this.emit('status');
  }

  get info(): DriverInfo | undefined {
    return this.driverInfo;
  }

  status(): MouseStatus {
    return {
      available: this.driver !== undefined,
      driver: this.driverName,
      reason: this.unavailableReason,
      holder: this.lease
        ? { deviceId: this.lease.holder.deviceId, deviceName: this.lease.holder.deviceName }
        : undefined,
    };
  }

  holds(client: ClientIdentity): boolean {
    return this.lease?.holder.connectionId === client.connectionId;
  }

  acquire(client: ClientIdentity, force = false): RouterResult {
    if (!this.driver) {
      return {
        ok: false,
        code: 'mouse_unavailable',
        message: this.unavailableReason ?? 'unavailable',
      };
    }
    if (this.holds(client)) return OK;
    if (this.lease && !force) {
      return {
        ok: false,
        code: 'mouse_lease_held',
        message: `Mouse is controlled by ${this.lease.holder.deviceName}`,
      };
    }
    if (this.lease) this.endLease('taken over');
    this.lease = { holder: client, lastActivity: this.now };
    this.logger.info({ device: client.deviceName }, 'mouse lease granted');
    this.emit('status');
    return OK;
  }

  release(client: ClientIdentity): RouterResult {
    if (this.holds(client)) this.endLease('released');
    return OK;
  }

  /** Must be called when a client connection closes. */
  disconnect(client: ClientIdentity): void {
    if (this.holds(client)) this.endLease('disconnected');
  }

  move(client: ClientIdentity, dx: number, dy: number): RouterResult {
    const check = this.touch(client);
    if (!check.ok) return check;
    this.pending.dx += dx;
    this.pending.dy += dy;
    const interval = this.options.flushIntervalMs ?? 8;
    const since = this.now - this.lastFlush;
    if (since >= interval) {
      this.flushMoves();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushMoves(), interval - since);
    }
    return OK;
  }

  button(client: ClientIdentity, button: MouseButton, down: boolean): RouterResult {
    const check = this.touch(client);
    if (!check.ok) return check;
    this.flushMoves();
    if (down) {
      if (this.pressed.has(button)) return OK;
      this.pressed.add(button);
    } else {
      if (!this.pressed.has(button)) return OK;
      this.pressed.delete(button);
    }
    this.driver!.button(button, down);
    return OK;
  }

  click(client: ClientIdentity, button: MouseButton, count = 1): RouterResult {
    const check = this.touch(client);
    if (!check.ok) return check;
    this.flushMoves();
    if (this.pressed.has(button)) {
      this.driver!.button(button, false);
      this.pressed.delete(button);
    }
    for (let i = 0; i < count; i++) {
      this.driver!.button(button, true);
      this.driver!.button(button, false);
    }
    return OK;
  }

  scroll(client: ClientIdentity, dx: number, dy: number): RouterResult {
    const check = this.touch(client);
    if (!check.ok) return check;
    this.flushMoves();
    this.driver!.scroll(dx, dy);
    return OK;
  }

  async position(): Promise<{ x: number; y: number }> {
    if (!this.driver) throw new Error(this.unavailableReason ?? 'mouse unavailable');
    return this.driver.position();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweepTimer);
    if (this.lease) this.endLease('shutdown');
    await this.driver?.stop();
    this.driver = undefined;
  }

  private touch(client: ClientIdentity): RouterResult {
    if (!this.driver) {
      return {
        ok: false,
        code: 'mouse_unavailable',
        message: this.unavailableReason ?? 'unavailable',
      };
    }
    if (!this.holds(client)) {
      return {
        ok: false,
        code: 'mouse_not_leased',
        message: 'Acquire the mouse before sending input',
      };
    }
    this.lease!.lastActivity = this.now;
    return OK;
  }

  private flushMoves(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const { dx, dy } = this.pending;
    if (dx === 0 && dy === 0) return;
    this.pending = { dx: 0, dy: 0 };
    this.lastFlush = this.now;
    this.driver?.move(dx, dy);
  }

  private endLease(reason: string): void {
    this.flushMoves();
    for (const button of this.pressed) this.driver?.button(button, false);
    this.pressed.clear();
    this.logger.info({ device: this.lease?.holder.deviceName, reason }, 'mouse lease ended');
    this.lease = undefined;
    this.emit('status');
  }

  private expireIdleLease(): void {
    if (this.lease && this.now - this.lease.lastActivity > this.options.leaseIdleMs) {
      this.endLease('idle');
    }
  }
}
