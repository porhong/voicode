import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { AUDIO } from '@voicecode/protocol';
import type { Logger } from '../util/logger.js';
import {
  VirtualMicUnavailableError,
  type VirtualMicDriver,
  type VirtualMicInfo,
} from './driver.js';

const run = promisify(execFile);
const MAX_PENDING_BYTES = AUDIO.sampleRate * AUDIO.bytesPerSample;

/**
 * Linux virtual microphone on PipeWire (or PulseAudio): a null sink receives the phone's
 * audio from `pw-cat`, and the sink's monitor is made the default source while a phone
 * streams, so Claude Code (which records from the default input) hears the phone.
 * The previous default source is restored afterwards. `module-remap-source` would show
 * up as a "real" microphone, but it is known to misbehave as the default source, so the
 * monitor is used directly.
 */
export class PipeWireDriver implements VirtualMicDriver {
  readonly name = 'pipewire';
  private child: ChildProcessByStdio<Writable, null, Readable> | undefined;
  private exitListeners: Array<(error: Error) => void> = [];
  private stopping = false;
  private moduleId: string | undefined;
  private previousSource: string | undefined;
  private warnedBacklog = false;

  constructor(
    private readonly sink: string,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<VirtualMicInfo> {
    const pulse = await run('pactl', ['info'], { timeout: 5_000 }).catch((err: Error) => {
      throw new VirtualMicUnavailableError(`pactl is not usable: ${err.message.split('\n')[0]}`);
    });
    const server = /Server Name:\s*(.*)/.exec(pulse.stdout)?.[1]?.trim() ?? 'unknown';
    await run('pw-cat', ['--version'], { timeout: 5_000 }).catch((err: Error) => {
      throw new VirtualMicUnavailableError(`pw-cat is not usable: ${err.message.split('\n')[0]}`);
    });
    await this.ensureSink();
    await this.spawnPlayer();
    return { device: this.sink, details: { server } };
  }

  private async ensureSink(): Promise<void> {
    const { stdout } = await run('pactl', ['list', 'short', 'sinks'], { timeout: 5_000 });
    const exists = stdout.split('\n').some((line) => line.split('\t')[1] === this.sink);
    if (exists) return;
    const { stdout: id } = await run(
      'pactl',
      [
        'load-module',
        'module-null-sink',
        `sink_name=${this.sink}`,
        'sink_properties=device.description=VoiceCode-Phone-Mic',
      ],
      { timeout: 5_000 },
    );
    this.moduleId = id.trim() || undefined;
  }

  private spawnPlayer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'pw-cat',
        [
          '--playback',
          '--raw',
          `--rate=${AUDIO.sampleRate}`,
          `--channels=${AUDIO.channels}`,
          '--format=s16',
          `--target=${this.sink}`,
          '--media-role=Communication',
          '-',
        ],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
      this.child = child;
      let settled = false;
      const errors: string[] = [];
      child.stderr.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) errors.push(line);
        this.logger.debug({ line }, 'pw-cat stderr');
      });
      child.once('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      child.once('exit', (code, signal) => {
        this.child = undefined;
        const detail = errors.length ? `: ${errors.at(-1)}` : '';
        const error = new Error(`pw-cat exited (code=${code}, signal=${signal})${detail}`);
        if (!settled) {
          settled = true;
          reject(error);
        } else if (!this.stopping) for (const l of this.exitListeners) l(error);
      });
      child.stdin.on('error', (err) => this.logger.debug({ err }, 'pw-cat stdin error'));
      // pw-cat prints nothing on success; give it a moment to fail on a bad target.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 300);
    });
  }

  async activate(): Promise<void> {
    const { stdout } = await run('pactl', ['get-default-source'], { timeout: 5_000 });
    const current = stdout.trim();
    const monitor = `${this.sink}.monitor`;
    if (current && current !== monitor) this.previousSource = current;
    await run('pactl', ['set-default-source', monitor], { timeout: 5_000 });
  }

  async deactivate(): Promise<void> {
    const previous = this.previousSource;
    this.previousSource = undefined;
    if (previous) await run('pactl', ['set-default-source', previous], { timeout: 5_000 });
  }

  write(pcm: Buffer): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    if (child.stdin.writableLength > MAX_PENDING_BYTES) {
      if (!this.warnedBacklog) {
        this.warnedBacklog = true;
        this.logger.warn('pw-cat is not keeping up; dropping audio');
      }
      return;
    }
    this.warnedBacklog = false;
    child.stdin.write(pcm);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.deactivate().catch(() => undefined);
    const child = this.child;
    if (child) {
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
    if (this.moduleId) {
      await run('pactl', ['unload-module', this.moduleId], { timeout: 5_000 }).catch(
        () => undefined,
      );
      this.moduleId = undefined;
    }
  }

  onExit(listener: (error: Error) => void): void {
    this.exitListeners.push(listener);
  }
}
