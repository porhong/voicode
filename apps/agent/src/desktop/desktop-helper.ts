import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { Logger } from '../util/logger.js';
import { packageRoot } from '../util/version.js';

/**
 * Talks to `voicecode-desktop.ps1`, the PowerShell helper that drives the Code tab of
 * the Claude Desktop app through Windows UI Automation. One request at a time, JSON
 * lines both ways; the helper is started on first use and again after it exits.
 */

const READY_TIMEOUT_MS = 15_000;
/** Opening a menu and pressing in it takes about a second; a hung Desktop much longer. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Where the helper script is: shipped next to the native helpers, or in the sources. */
export function desktopHelperScript(): string | undefined {
  const root = packageRoot();
  return [
    path.join(root, 'native-bin', 'win32', 'voicecode-desktop.ps1'),
    path.join(root, '..', '..', 'native', 'windows', 'voicecode-desktop.ps1'),
  ].find((p) => existsSync(p));
}

/** Whether a Claude Desktop session can be taken over on this PC. */
export function desktopControlStatus(): { available: boolean; reason?: string } {
  if (process.platform !== 'win32') {
    return { available: false, reason: 'Claude Desktop control is only available on Windows' };
  }
  return desktopHelperScript()
    ? { available: true }
    : { available: false, reason: 'the Claude Desktop helper (voicecode-desktop.ps1) is missing' };
}

const PermissionSchema = z.object({
  name: z.string().max(500).optional(),
  text: z.string().max(20_000).default(''),
  buttons: z.array(z.string().max(200)).max(20).default([]),
});

const PaneSchema = z.object({
  code: z.boolean().default(false),
  title: z.string().max(500).optional(),
  busy: z.boolean().default(false),
  promptEmpty: z.boolean().default(true),
  mode: z.string().max(100).optional(),
  model: z.string().max(200).optional(),
  permission: PermissionSchema.optional(),
});

export const DesktopStateSchema = z.object({
  window: z.boolean().default(false),
  /** Minimized: what the window shows may be stale (Chromium stops updating it). */
  minimized: z.boolean().default(false),
  /** The session asked about is the one Desktop shows. */
  shown: z.boolean().default(false),
  pane: PaneSchema.optional(),
  /** The sidebar's state word for the session when it is not the one shown ("Idle"). */
  rowStatus: z.string().max(100).optional(),
});

export type DesktopState = z.infer<typeof DesktopStateSchema>;
export type DesktopPermission = z.infer<typeof PermissionSchema>;

/** The operations a `DesktopSession` needs; tests substitute a fake. */
export interface DesktopDriver {
  state(title: string): Promise<DesktopState>;
  open(title: string): Promise<void>;
  prompt(title: string, text: string): Promise<void>;
  stop(title: string): Promise<void>;
  mode(title: string, label: string): Promise<string>;
  model(title: string, label: string): Promise<string>;
  models(title: string): Promise<string[]>;
  close(): void;
}

export class DesktopHelperError extends Error {}

export class DesktopHelper implements DesktopDriver {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<ChildProcessWithoutNullStreams> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private readonly waiting = new Map<number, (reply: Record<string, unknown>) => void>();

  constructor(
    private readonly logger: Logger,
    private readonly script = desktopHelperScript(),
  ) {}

  async state(title: string): Promise<DesktopState> {
    return DesktopStateSchema.parse(await this.request({ op: 'state', title }));
  }

  async open(title: string): Promise<void> {
    await this.request({ op: 'open', title });
  }

  async prompt(title: string, text: string): Promise<void> {
    await this.request({ op: 'prompt', title, text });
  }

  async stop(title: string): Promise<void> {
    await this.request({ op: 'stop', title });
  }

  async mode(title: string, label: string): Promise<string> {
    return String((await this.request({ op: 'mode', title, label })).mode ?? label);
  }

  async model(title: string, label: string): Promise<string> {
    return String((await this.request({ op: 'model', title, label })).model ?? label);
  }

  async models(title: string): Promise<string[]> {
    const reply = await this.request({ op: 'models', title });
    return z.array(z.string().max(200)).max(50).catch([]).parse(reply.models);
  }

  close(): void {
    this.child?.stdin.end();
    this.child = undefined;
  }

  /** Requests run one after another: the helper drives a single window. */
  private request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = this.queue.then(() => this.send(body));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = await this.ensure();
    const id = this.nextId++;
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new DesktopHelperError('Claude Desktop did not respond in time.'));
        // A stuck helper is restarted on the next request.
        child.kill();
      }, REQUEST_TIMEOUT_MS);
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    });
    if (reply.ok !== true) {
      throw new DesktopHelperError(String(reply.error ?? 'Claude Desktop helper failed'));
    }
    return reply;
  }

  private ensure(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child) return Promise.resolve(this.child);
    this.starting ??= this.spawn().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private spawn(): Promise<ChildProcessWithoutNullStreams> {
    const script = this.script;
    if (!script) return Promise.reject(new DesktopHelperError('voicecode-desktop.ps1 is missing'));
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      const timer = setTimeout(() => {
        child.kill();
        reject(new DesktopHelperError('The Claude Desktop helper did not start.'));
      }, READY_TIMEOUT_MS);
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2_000);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new DesktopHelperError(`Could not start PowerShell: ${err.message}`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (this.child === child) this.child = undefined;
        for (const [id, settle] of this.waiting) {
          this.waiting.delete(id);
          settle({ ok: false, error: 'The Claude Desktop helper stopped.' });
        }
        if (code) this.logger.warn({ code, stderr: stderr.trim() }, 'desktop helper exited');
        reject(new DesktopHelperError('The Claude Desktop helper stopped.'));
      });
      createInterface({ input: child.stdout }).on('line', (line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.ready === true) {
          clearTimeout(timer);
          this.child = child;
          resolve(child);
          return;
        }
        const settle = this.waiting.get(Number(msg.id));
        if (settle) {
          this.waiting.delete(Number(msg.id));
          settle(msg);
        }
      });
    });
  }
}
