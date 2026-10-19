import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import { AUDIO, LIMITS, type VoiceMicStatus } from '@voicecode/protocol';
import type { ClientIdentity, RouterResult } from '../mouse/input-router.js';
import { TokenBucket } from '../server/token-bucket.js';
import type { Logger } from '../util/logger.js';
import type { VirtualMicDriver, VirtualMicInfo } from './driver.js';

export interface MicDriverCandidate {
  name: string;
  create(): VirtualMicDriver;
}

const OK: RouterResult = { ok: true };
const MAX_RESTARTS = 5;
const STABLE_AFTER_MS = 60_000;
const MAX_FRAME_BYTES =
  (AUDIO.sampleRate * AUDIO.channels * AUDIO.bytesPerSample * AUDIO.maxFrameMs) / 1000;
const BYTES_PER_MS = (AUDIO.sampleRate * AUDIO.channels * AUDIO.bytesPerSample) / 1000;
/** Held audio beyond this is dropped from the front: nobody waits that long to record. */
const MAX_QUEUED_MS = 15_000;
/** Queued audio goes to the driver this far ahead of real time (its own buffer is ~1 s). */
const PLAY_AHEAD_MS = 250;
const PUMP_MS = 20;
/** No frame for this long, with the lease still held, counts as the phone having stopped. */
const QUIET_MS = 500;

/**
 * What a dictation session needs from the microphone around Claude Code's recording: the
 * phone streams from the moment it is pressed, but Claude Code only records once it has
 * started (a second or more later), so the start of what is said would be lost. The
 * audio is held back until then and played in at real time; on release the session
 * waits for it to have played out before it stops the recording.
 */
export interface MicGate {
  /** Queue the phone's audio instead of playing it. */
  hold(): void;
  /** Play what was queued (at real time, ahead of anything new) and stop queuing. */
  resume(): void;
  /** Drop what was queued and stop queuing. */
  discard(): void;
  /** Resolves once the phone has stopped streaming and everything it sent has played. */
  played(timeoutMs: number): Promise<void>;
}

/**
 * Routes microphone audio from one browser client to the virtual-microphone driver.
 * Mirrors the mouse `InputRouter`: one connection holds the lease, everyone else is
 * refused, and a lease ends with its connection, on release, or after `leaseIdleMs`
 * without audio. Frames are bounded in size and rate so a client cannot flood the
 * sound device.
 */
export class MicRouter extends EventEmitter<{ status: [] }> implements MicGate {
  private driver: VirtualMicDriver | undefined;
  private driverName = 'none';
  private info: VirtualMicInfo | undefined;
  private unavailableReason: string | undefined = 'not started';
  private lease: { holder: ClientIdentity; lastActivity: number; bytes: TokenBucket } | undefined;
  private readonly sweepTimer: NodeJS.Timeout;
  private restarts = 0;
  private stopped = false;
  private droppedSince = 0;
  /** Audio waiting for the driver: while held, and while held audio is played out. */
  private readonly queue: Buffer[] = [];
  private queuedBytes = 0;
  private holding = false;
  private pumpTimer: NodeJS.Timeout | undefined;
  /** When the audio given to the driver so far will have played. */
  private playingUntil = 0;
  private lastFrameAt = 0;
  /** A lease ended while its audio was still queued or playing; see `deactivateWhenPlayed`. */
  private deactivateTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly options: { leaseIdleMs: number; now?: () => number },
  ) {
    super();
    this.sweepTimer = setInterval(() => this.expireIdleLease(), 5_000);
    this.sweepTimer.unref();
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Tries each candidate backend in order and keeps the first that starts. */
  async start(candidates: MicDriverCandidate[], unavailableReason?: string): Promise<void> {
    const failures: string[] = [];
    for (const candidate of candidates) {
      const driver = candidate.create();
      try {
        const info = await driver.start();
        this.attach(driver, info, candidate);
        return;
      } catch (err) {
        failures.push(`${candidate.name}: ${(err as Error).message}`);
        this.logger.warn({ err, driver: candidate.name }, 'virtual microphone failed to start');
      }
    }
    this.unavailableReason = failures.length ? failures.join('; ') : unavailableReason;
    this.emit('status');
  }

  /** Attaches an already-started driver (also used by tests). */
  attach(driver: VirtualMicDriver, info: VirtualMicInfo, candidate?: MicDriverCandidate): void {
    this.driver = driver;
    this.driverName = driver.name;
    this.info = info;
    this.unavailableReason = undefined;
    this.logger.info({ driver: driver.name, device: info.device }, 'virtual microphone ready');
    driver.onExit((error) => {
      this.logger.error({ err: error }, 'virtual microphone exited');
      this.driver = undefined;
      this.unavailableReason = error.message;
      this.lease = undefined;
      this.emit('status');
      if (candidate) this.scheduleRestart(candidate, error.message);
    });
    if (candidate) {
      // A driver that has run for a while has earned a fresh restart budget.
      setTimeout(() => {
        if (this.driver === driver) this.restarts = 0;
      }, STABLE_AFTER_MS).unref();
    }
    this.emit('status');
  }

  private scheduleRestart(candidate: MicDriverCandidate, reason: string): void {
    if (this.stopped || this.restarts >= MAX_RESTARTS) return;
    const delay = 500 * 2 ** this.restarts++;
    setTimeout(() => {
      void this.start([candidate], reason).then(() => {
        if (!this.driver) this.scheduleRestart(candidate, reason);
      });
    }, delay).unref();
  }

  status(): VoiceMicStatus {
    return {
      available: this.driver !== undefined,
      driver: this.driverName,
      reason: this.unavailableReason,
      device: this.info?.device,
      holder: this.lease
        ? { deviceId: this.lease.holder.deviceId, deviceName: this.lease.holder.deviceName }
        : undefined,
    };
  }

  holds(client: ClientIdentity): boolean {
    return this.lease?.holder.connectionId === client.connectionId;
  }

  acquire(client: ClientIdentity, force = false): RouterResult {
    const driver = this.driver;
    if (!driver) {
      return {
        ok: false,
        code: 'mic_unavailable',
        message: `Virtual microphone unavailable: ${this.unavailableReason ?? 'unknown'}`,
      };
    }
    if (this.holds(client)) {
      this.lease!.lastActivity = this.now;
      return OK;
    }
    if (this.lease && !force) {
      return {
        ok: false,
        code: 'mic_lease_held',
        message: `${this.lease.holder.deviceName} is using the microphone`,
      };
    }
    this.lease = {
      holder: client,
      lastActivity: this.now,
      // Two seconds of audio may arrive in a burst (reconnects, jitter), then real time.
      bytes: new TokenBucket(
        2 * LIMITS.maxAudioBytesPerSecond,
        LIMITS.maxAudioBytesPerSecond,
        () => this.now,
      ),
    };
    this.droppedSince = 0;
    // The previous lease's restore is still pending: the device is switched already.
    const switched = this.deactivateTimer !== undefined;
    clearTimeout(this.deactivateTimer);
    this.deactivateTimer = undefined;
    if (!switched)
      driver.activate().catch((err: unknown) => {
        this.logger.warn({ err }, 'virtual microphone could not be activated');
      });
    this.logger.info({ device: client.deviceName }, 'microphone lease taken');
    this.emit('status');
    return OK;
  }

  release(client: ClientIdentity): RouterResult {
    if (!this.holds(client)) {
      return { ok: false, code: 'mic_not_leased', message: 'You do not hold the microphone' };
    }
    this.endLease('released');
    return OK;
  }

  /** Called when a connection closes. */
  disconnect(client: ClientIdentity): void {
    if (this.holds(client)) this.endLease('disconnected');
  }

  /** One frame of PCM in the wire format. */
  write(client: ClientIdentity, pcm: Buffer): RouterResult {
    const lease = this.lease;
    if (!lease || !this.holds(client)) {
      return { ok: false, code: 'mic_not_leased', message: 'Start the microphone first' };
    }
    if (!this.driver) return { ok: false, code: 'mic_unavailable', message: 'Microphone stopped' };
    if (
      pcm.length === 0 ||
      pcm.length % AUDIO.bytesPerSample !== 0 ||
      pcm.length > MAX_FRAME_BYTES
    ) {
      return { ok: false, code: 'bad_request', message: 'Invalid audio frame' };
    }
    lease.lastActivity = this.now;
    this.lastFrameAt = this.now;
    // Diagnostic: VOICECODE_MIC_DUMP=<file> keeps a raw copy of what the PC received
    // (play it with `ffplay -f s16le -ar 16000 -ac 1 <file>`).
    if (process.env.VOICECODE_MIC_DUMP) {
      try {
        appendFileSync(process.env.VOICECODE_MIC_DUMP, pcm);
      } catch {
        // Diagnostics never break the stream.
      }
    }
    if (!lease.bytes.take(pcm.length)) {
      // Faster than real time: drop rather than let a backlog delay the live audio.
      if (this.droppedSince === 0) {
        this.droppedSince = this.now;
        this.logger.warn({ device: client.deviceName }, 'audio arriving faster than real time');
      }
      return { ok: false, code: 'rate_limited', message: 'Audio is arriving too fast' };
    }
    if (this.holding || this.queue.length) this.enqueue(pcm);
    else this.play(pcm);
    return OK;
  }

  hold(): void {
    this.holding = true;
  }

  resume(): void {
    this.holding = false;
    this.pump();
  }

  discard(): void {
    this.holding = false;
    this.queue.length = 0;
    this.queuedBytes = 0;
  }

  async played(timeoutMs: number): Promise<void> {
    const deadline = this.now + timeoutMs;
    const streaming = () => this.lease !== undefined && this.now - this.lastFrameAt < QUIET_MS;
    while (
      this.now < deadline &&
      (streaming() || this.queue.length || this.now < this.playingUntil)
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private enqueue(pcm: Buffer): void {
    this.queue.push(pcm);
    this.queuedBytes += pcm.length;
    while (this.queuedBytes > MAX_QUEUED_MS * BYTES_PER_MS && this.queue.length > 1) {
      this.queuedBytes -= this.queue.shift()!.length;
    }
    this.pump();
  }

  /** Feeds queued audio to the driver no faster than it plays. */
  private pump(): void {
    if (this.holding || this.pumpTimer) return;
    while (this.queue.length && this.playingUntil - this.now < PLAY_AHEAD_MS) {
      const pcm = this.queue.shift()!;
      this.queuedBytes -= pcm.length;
      this.play(pcm);
    }
    if (!this.queue.length) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      this.pump();
    }, PUMP_MS);
    this.pumpTimer.unref();
  }

  private play(pcm: Buffer): void {
    this.driver?.write(pcm);
    this.playingUntil = Math.max(this.now, this.playingUntil) + pcm.length / BYTES_PER_MS;
  }

  private endLease(reason: string): void {
    const lease = this.lease;
    if (!lease) return;
    this.lease = undefined;
    this.logger.info({ device: lease.holder.deviceName, reason }, 'microphone lease ended');
    this.deactivateWhenPlayed(reason === 'shutdown');
    this.emit('status');
  }

  /**
   * Puts the PC's default input back only once the lease's audio has played: Claude Code
   * may not have started recording when the phone lets go, and would then open the
   * wrong microphone. Audio held for a recording that never came is given up on.
   */
  private deactivateWhenPlayed(now = false): void {
    clearTimeout(this.deactivateTimer);
    this.deactivateTimer = undefined;
    if (!now && (this.holding || this.queue.length || this.now < this.playingUntil)) {
      this.deactivateTimer = setTimeout(() => {
        if (this.holding && this.now - this.lastFrameAt > MAX_QUEUED_MS) this.discard();
        this.deactivateWhenPlayed();
      }, 250);
      this.deactivateTimer.unref();
      return;
    }
    if (this.lease) return;
    this.driver?.deactivate().catch((err: unknown) => {
      this.logger.warn({ err }, 'virtual microphone could not be deactivated');
    });
  }

  private expireIdleLease(): void {
    if (this.lease && this.now - this.lease.lastActivity > this.options.leaseIdleMs) {
      this.endLease('idle');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweepTimer);
    clearTimeout(this.pumpTimer);
    this.discard();
    this.endLease('shutdown');
    const driver = this.driver;
    this.driver = undefined;
    await driver?.stop();
  }
}
