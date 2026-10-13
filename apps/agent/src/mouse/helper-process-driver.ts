import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { MouseButton } from '@voicecode/protocol';
import type { Logger } from '../util/logger.js';
import type { DriverInfo, MouseDriver } from './driver.js';

const BUTTON_CODES: Record<MouseButton, string> = { left: 'l', right: 'r', middle: 'm' };
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const POSITION_TIMEOUT_MS = 2_000;

/**
 * Drives a small native helper over stdin/stdout using a line protocol shared by all
 * helpers (Win32 SendInput, PowerShell fallback, X11 XTest):
 *
 *   agent → helper:  m <dx> <dy> | d <l|r|m> | u <l|r|m> | s <dx> <dy> | p | q
 *   helper → agent:  ready key=value ... | pos <x> <y> | err <message>
 *
 * Keeping OS input injection in a separate process isolates native crashes from the
 * server and lets each platform use its most reliable API.
 */
export class HelperProcessDriver implements MouseDriver {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly positionWaiters: Array<{
    resolve: (p: { x: number; y: number }) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private exitListeners: Array<(error: Error) => void> = [];
  private stopping = false;

  constructor(
    readonly name: string,
    private readonly command: string,
    private readonly args: string[],
    private readonly logger: Logger,
    /** How long to wait for "ready" (longer when the OS shows a consent dialog). */
    private readonly readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  ) {}

  start(): Promise<DriverInfo> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      let ready = false;

      const timer = setTimeout(() => {
        reject(
          new Error(`${this.name} helper did not become ready within ${this.readyTimeoutMs}ms`),
        );
        child.kill();
      }, this.readyTimeoutMs);

      createInterface({ input: child.stdout }).on('line', (line) => {
        const [kind, ...rest] = line.trim().split(/\s+/);
        if (kind === 'ready' && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve({ details: parseKeyValues(rest) });
        } else if (kind === 'pos') {
          const waiter = this.positionWaiters.shift();
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve({ x: Number(rest[0]), y: Number(rest[1]) });
          }
        } else if (kind === 'err') {
          this.logger.warn({ driver: this.name, message: rest.join(' ') }, 'mouse helper error');
        }
      });
      createInterface({ input: child.stderr }).on('line', (line) => {
        if (line.trim()) this.logger.debug({ driver: this.name, line }, 'mouse helper stderr');
      });

      child.once('error', (err) => {
        clearTimeout(timer);
        if (!ready) reject(err);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        this.child = undefined;
        const error = new Error(`${this.name} helper exited (code=${code}, signal=${signal})`);
        for (const w of this.positionWaiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(error);
        }
        if (!ready) reject(error);
        else if (!this.stopping) for (const l of this.exitListeners) l(error);
      });
      // A dead helper must not crash the agent with EPIPE.
      child.stdin.on('error', (err) => this.logger.debug({ err }, 'mouse helper stdin error'));
    });
  }

  move(dx: number, dy: number): void {
    this.write(`m ${Math.trunc(dx)} ${Math.trunc(dy)}`);
  }

  button(button: MouseButton, down: boolean): void {
    this.write(`${down ? 'd' : 'u'} ${BUTTON_CODES[button]}`);
  }

  scroll(dx: number, dy: number): void {
    this.write(`s ${Math.trunc(dx)} ${Math.trunc(dy)}`);
  }

  position(): Promise<{ x: number; y: number }> {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error('mouse helper is not running'));
      const timer = setTimeout(() => {
        const i = this.positionWaiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.positionWaiters.splice(i, 1);
        reject(new Error('mouse helper did not report a position'));
      }, POSITION_TIMEOUT_MS);
      this.positionWaiters.push({ resolve, reject, timer });
      this.write('p');
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    // `q` makes the helper release any buttons it still holds before exiting.
    this.write('q');
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

  private write(line: string): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(`${line}\n`);
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
