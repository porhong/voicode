import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { nativeHelperCandidates } from '../mouse/resolve-driver.js';
import type { Logger } from '../util/logger.js';
import type { PtyHandle } from './pty-session.js';

export const WINDOWS_CONSOLE_HELPER = 'voicecode-console.exe';
const READY_TIMEOUT_MS = 10_000;
const SCREEN_POLL_MS = 250;

/** Where the Windows console helper is, if it was built or shipped. */
export function windowsConsoleHelper(): string | undefined {
  return nativeHelperCandidates(WINDOWS_CONSOLE_HELPER, 'windows').find((p) => existsSync(p));
}

/** Whether a Claude Code running in the user's own terminal can be taken over here. */
export function consoleAttachStatus(): { available: boolean; reason?: string } {
  if (process.platform !== 'win32') {
    return {
      available: false,
      reason: 'taking control of a terminal session is only available on Windows for now',
    };
  }
  return windowsConsoleHelper()
    ? { available: true }
    : { available: false, reason: 'the console helper (voicecode-console.exe) is missing' };
}

export type ConsoleCommand = { kind: 'key'; key: string } | { kind: 'text'; text: string };

const KEY_SEQUENCES: Array<[sequence: string, key: string]> = [
  // Shift+Tab (cycles Claude Code's permission modes) before the bare Esc below.
  ['\x1b[Z', 'shift-tab'],
  ['\x1b[A', 'up'],
  ['\x1b[B', 'down'],
  ['\x1b[C', 'right'],
  ['\x1b[D', 'left'],
  ['\x1b', 'esc'],
  ['\r', 'enter'],
  ['\n', 'enter'],
  ['\t', 'tab'],
  ['\x03', 'c-c'],
];

/**
 * Turns what a pty would be written (keys from the terminal view, the dictation Space,
 * pasted prompts) into the helper's commands. Text is typed character by character, so
 * a pasted prompt's newlines become spaces rather than early Enters.
 */
export function translateInput(data: string): ConsoleCommand[] {
  const out: ConsoleCommand[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ kind: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < data.length) {
    if (data.startsWith('\x1b[200~', i)) {
      const end = data.indexOf('\x1b[201~', i);
      const pasted = data.slice(i + 6, end < 0 ? undefined : end);
      text += pasted.replace(/\r\n|\r|\n/g, ' ');
      i = end < 0 ? data.length : end + 6;
      continue;
    }
    const match = KEY_SEQUENCES.find(([seq]) => data.startsWith(seq, i));
    if (match) {
      flush();
      out.push({ kind: 'key', key: match[1] });
      i += match[0].length;
      continue;
    }
    if (data[i] === ' ' && data.length === 1) {
      // A lone Space is the dictation tap, not text.
      out.push({ kind: 'key', key: 'space' });
      i++;
      continue;
    }
    text += data[i];
    i++;
  }
  flush();
  return out;
}

export interface ScreenSnapshot {
  rows: number;
  cols: number;
  cursorRow: number;
  cursorCol: number;
  lines: string[];
}

export function parseScreen(line: string): ScreenSnapshot | undefined {
  const [, rows, cols, cursorRow, cursorCol, b64 = ''] = line.split(' ');
  if (!rows || !cols) return undefined;
  const text = Buffer.from(b64, 'base64').toString('utf8');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return {
    rows: Number(rows),
    cols: Number(cols),
    cursorRow: Number(cursorRow),
    cursorCol: Number(cursorCol),
    lines,
  };
}

/** The terminal bytes that redraw a whole screen snapshot. */
export function repaint(screen: ScreenSnapshot): string {
  // Control characters in the captured text would be interpreted by the terminal view.
  // eslint-disable-next-line no-control-regex
  const body = screen.lines.map((l) => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')).join('\r\n');
  return `\x1b[2J\x1b[H${body}\x1b[${screen.cursorRow + 1};${screen.cursorCol + 1}H`;
}

/**
 * A `PtyHandle` over a Claude Code that the user started in their own terminal, through
 * the console helper: keys go into that console's input buffer and the screen is polled
 * and redrawn in full, so the rest of the voice session works unchanged. Closing only
 * detaches; the user's Claude Code keeps running.
 */
export class ConsoleAttachHandle implements PtyHandle {
  private child: ChildProcessWithoutNullStreams | undefined;
  private dataListener: ((data: string) => void) | undefined;
  private exitListener: ((e: { exitCode: number }) => void) | undefined;
  private sizeListener: ((cols: number, rows: number) => void) | undefined;
  private poll: NodeJS.Timeout | undefined;
  private lastRepaint = '';
  private lastSize = '';
  private detaching = false;

  constructor(
    readonly pid: number,
    private readonly helper: string,
    private readonly logger: Logger,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.helper, [String(this.pid)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      let ready = false;
      const timer = setTimeout(() => {
        reject(new Error('the console helper did not attach in time'));
        child.kill();
      }, READY_TIMEOUT_MS);
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.startsWith('ready')) {
          if (!ready) {
            ready = true;
            clearTimeout(timer);
            resolve();
          }
        } else if (line.startsWith('screen ')) {
          const screen = parseScreen(line);
          if (screen) this.deliver(screen);
        } else if (line.startsWith('err')) {
          const message = line.slice(4);
          if (!ready) {
            clearTimeout(timer);
            reject(new Error(message));
            child.kill();
          } else {
            this.logger.warn({ pid: this.pid, message }, 'console helper error');
          }
        }
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        if (!ready) reject(err);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        this.child = undefined;
        clearInterval(this.poll);
        if (!ready) reject(new Error(`the console helper exited (code ${code})`));
        else if (!this.detaching) this.exitListener?.({ exitCode: code ?? 0 });
      });
      child.stdin.on('error', (err) => this.logger.debug({ err }, 'console helper stdin error'));
    });
  }

  private deliver(screen: ScreenSnapshot): void {
    const size = `${screen.cols}x${screen.rows}`;
    if (size !== this.lastSize) {
      this.lastSize = size;
      this.sizeListener?.(screen.cols, screen.rows);
    }
    const data = repaint(screen);
    if (data === this.lastRepaint) return;
    this.lastRepaint = data;
    this.dataListener?.(data);
  }

  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
    this.poll ??= setInterval(() => this.send('s'), SCREEN_POLL_MS);
    this.send('s');
  }

  onExit(listener: (e: { exitCode: number }) => void): void {
    this.exitListener = listener;
  }

  onSize(listener: (cols: number, rows: number) => void): void {
    this.sizeListener = listener;
  }

  write(data: string): void {
    for (const command of translateInput(data)) {
      if (command.kind === 'key') this.send(`k ${command.key}`);
      else this.send(`t ${Buffer.from(command.text, 'utf8').toString('base64')}`);
    }
  }

  resize(): void {
    // The user's terminal decides its own size.
  }

  kill(): void {
    this.detaching = true;
    clearInterval(this.poll);
    const child = this.child;
    if (!child) return;
    this.send('q');
    child.stdin.end();
    setTimeout(() => child.kill(), 1_000).unref();
  }

  private send(line: string): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(`${line}\n`);
  }
}

/** Attaches to the console of `pid`; rejects when that is not possible here. */
export async function attachConsole(pid: number, logger: Logger): Promise<ConsoleAttachHandle> {
  const status = consoleAttachStatus();
  if (!status.available) throw new Error(status.reason);
  const handle = new ConsoleAttachHandle(pid, windowsConsoleHelper()!, logger);
  await handle.start();
  return handle;
}
