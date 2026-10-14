import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AUDIO } from '@voicecode/protocol';
import type { Logger } from '../util/logger.js';
import type { VirtualMicDriver, VirtualMicInfo } from './driver.js';

const READY_TIMEOUT_MS = 10_000;
/** Audio queued in the pipe beyond this is dropped: it would only play late. */
const MAX_PENDING_BYTES = AUDIO.sampleRate * AUDIO.bytesPerSample; // one second

/**
 * Plays PCM through a small native helper (Windows: `voicecode-audio-out.exe`, waveOut).
 * The helper prints `ready key=value…` once its device is open, then reads raw s16le
 * audio from stdin until EOF; problems come back as `err …` lines on stdout.
 */
export class HelperAudioDriver implements VirtualMicDriver {
  private child: ChildProcessWithoutNullStreams | undefined;
  private exitListeners: Array<(error: Error) => void> = [];
  private stopping = false;
  private warnedBacklog = false;

  constructor(
    readonly name: string,
    private readonly command: string,
    private readonly args: string[],
    private readonly logger: Logger,
  ) {}

  start(): Promise<VirtualMicInfo> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      let ready = false;
      const timer = setTimeout(() => {
        reject(new Error(`${this.name} helper did not become ready within ${READY_TIMEOUT_MS}ms`));
        child.kill();
      }, READY_TIMEOUT_MS);

      createInterface({ input: child.stdout }).on('line', (line) => {
        const [kind, ...rest] = line.trim().split(/\s+/);
        if (kind === 'ready' && !ready) {
          ready = true;
          clearTimeout(timer);
          const details = parseKeyValues(rest);
          resolve({ device: details.device?.replaceAll('_', ' ') ?? 'unknown', details });
        } else if (kind === 'err') {
          const message = rest.join(' ');
          if (!ready) {
            clearTimeout(timer);
            reject(new Error(message));
            child.kill();
          } else {
            this.logger.warn({ driver: this.name, message }, 'audio helper error');
          }
        }
      });
      createInterface({ input: child.stderr }).on('line', (line) => {
        if (line.trim()) this.logger.debug({ driver: this.name, line }, 'audio helper stderr');
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        if (!ready) reject(err);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        this.child = undefined;
        const error = new Error(`${this.name} helper exited (code=${code}, signal=${signal})`);
        if (!ready) reject(error);
        else if (!this.stopping) for (const l of this.exitListeners) l(error);
      });
      // A dead helper must not crash the agent with EPIPE.
      child.stdin.on('error', (err) => this.logger.debug({ err }, 'audio helper stdin error'));
    });
  }

  async activate(): Promise<void> {
    // Windows: nothing to switch; the user makes the cable the default recording device.
  }

  async deactivate(): Promise<void> {}

  write(pcm: Buffer): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    if (child.stdin.writableLength > MAX_PENDING_BYTES) {
      if (!this.warnedBacklog) {
        this.warnedBacklog = true;
        this.logger.warn({ driver: this.name }, 'audio device is not keeping up; dropping audio');
      }
      return;
    }
    this.warnedBacklog = false;
    child.stdin.write(pcm);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  onExit(listener: (error: Error) => void): void {
    this.exitListeners.push(listener);
  }
}

function parseKeyValues(parts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}
