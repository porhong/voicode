import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MouseButton } from '@voicecode/protocol';
import type { Logger } from '../util/logger.js';
import { MouseUnavailableError, type DriverInfo, type MouseDriver } from './driver.js';

const run = promisify(execFile);

type Action =
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'button'; button: MouseButton; down: boolean }
  | { kind: 'scroll'; dx: number; dy: number };

/** Maps abstract actions to argv for an external CLI tool. */
export interface CommandDialect {
  name: string;
  binary: string;
  probeArgs: string[];
  argv(action: Action): string[][];
  positionArgs?: string[];
  parsePosition?(stdout: string): { x: number; y: number };
}

/**
 * Fallback driver that shells out to an input tool once per action. Process spawn
 * latency (~5-15 ms) caps throughput, so consecutive moves queued while a command is
 * running are merged into one. Prefer the native helper drivers where available.
 */
export class CommandDriver implements MouseDriver {
  readonly name: string;
  private queue: Action[] = [];
  private running = false;
  private scrollRemainder = { x: 0, y: 0 };

  constructor(
    private readonly dialect: CommandDialect,
    private readonly logger: Logger,
  ) {
    this.name = dialect.name;
  }

  async start(): Promise<DriverInfo> {
    try {
      const { stdout } = await run(this.dialect.binary, this.dialect.probeArgs, { timeout: 5_000 });
      return { details: { version: stdout.trim().split('\n')[0] ?? '' } };
    } catch (err) {
      throw new MouseUnavailableError(
        `${this.dialect.binary} is not usable: ${(err as Error).message}`,
      );
    }
  }

  move(dx: number, dy: number): void {
    const last = this.queue.at(-1);
    if (last?.kind === 'move') {
      last.dx += dx;
      last.dy += dy;
    } else {
      this.queue.push({ kind: 'move', dx, dy });
    }
    this.pump();
  }

  button(button: MouseButton, down: boolean): void {
    this.queue.push({ kind: 'button', button, down });
    this.pump();
  }

  scroll(dx: number, dy: number): void {
    // CLI tools scroll in whole notches; carry the fractional remainder forward.
    this.scrollRemainder.x += dx;
    this.scrollRemainder.y += dy;
    const nx = Math.trunc(this.scrollRemainder.x / 120);
    const ny = Math.trunc(this.scrollRemainder.y / 120);
    if (nx === 0 && ny === 0) return;
    this.scrollRemainder.x -= nx * 120;
    this.scrollRemainder.y -= ny * 120;
    this.queue.push({ kind: 'scroll', dx: nx, dy: ny });
    this.pump();
  }

  async position(): Promise<{ x: number; y: number }> {
    if (!this.dialect.positionArgs || !this.dialect.parsePosition) {
      throw new MouseUnavailableError(`${this.name} cannot report the pointer position`);
    }
    const { stdout } = await run(this.dialect.binary, this.dialect.positionArgs, {
      timeout: 2_000,
    });
    return this.dialect.parsePosition(stdout);
  }

  /**
   * Drops pending movement but lets queued button events (notably the releases the
   * router sends when a lease ends) finish, so no button is left held down.
   */
  async stop(): Promise<void> {
    this.queue = this.queue.filter((a) => a.kind === 'button');
    this.pump();
    const deadline = Date.now() + 2_000;
    while ((this.running || this.queue.length) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    this.queue = [];
  }

  onExit(): void {
    // Stateless: nothing long-lived can exit.
  }

  private pump(): void {
    if (this.running) return;
    const action = this.queue.shift();
    if (!action) return;
    this.running = true;
    void (async () => {
      try {
        for (const argv of this.dialect.argv(action)) {
          await run(this.dialect.binary, argv, { timeout: 2_000 });
        }
      } catch (err) {
        this.logger.warn({ err, driver: this.name }, 'mouse command failed');
      } finally {
        this.running = false;
        this.pump();
      }
    })();
  }
}

const X11_BUTTONS: Record<MouseButton, string> = { left: '1', middle: '2', right: '3' };

export const xdotoolDialect: CommandDialect = {
  name: 'xdotool',
  binary: 'xdotool',
  probeArgs: ['version'],
  argv(action) {
    switch (action.kind) {
      case 'move':
        return [['mousemove_relative', '--', String(action.dx), String(action.dy)]];
      case 'button':
        return [[action.down ? 'mousedown' : 'mouseup', X11_BUTTONS[action.button]]];
      case 'scroll': {
        const out: string[][] = [];
        if (action.dy)
          out.push(['click', '--repeat', String(Math.abs(action.dy)), action.dy > 0 ? '5' : '4']);
        if (action.dx)
          out.push(['click', '--repeat', String(Math.abs(action.dx)), action.dx > 0 ? '7' : '6']);
        return out;
      }
    }
  },
  positionArgs: ['getmouselocation', '--shell'],
  parsePosition(stdout) {
    const x = /X=(-?\d+)/.exec(stdout)?.[1];
    const y = /Y=(-?\d+)/.exec(stdout)?.[1];
    return { x: Number(x), y: Number(y) };
  },
};

/** ydotool ≥ 1.0 (requires the ydotoold daemon and access to /dev/uinput). */
const YDOTOOL_BUTTONS: Record<MouseButton, number> = { left: 0x00, right: 0x01, middle: 0x02 };

export const ydotoolDialect: CommandDialect = {
  name: 'ydotool',
  binary: 'ydotool',
  probeArgs: ['help'],
  argv(action) {
    switch (action.kind) {
      case 'move':
        return [['mousemove', '-x', String(action.dx), '-y', String(action.dy)]];
      case 'button': {
        const code = YDOTOOL_BUTTONS[action.button] | (action.down ? 0x40 : 0x80);
        return [['click', `0x${code.toString(16).padStart(2, '0')}`]];
      }
      case 'scroll':
        // ydotool's wheel axis is inverted relative to DOM deltaY.
        return [['mousemove', '--wheel', '-x', String(action.dx), '-y', String(-action.dy)]];
    }
  },
};
