import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { PcSession, PcSessionStatus } from '@voicecode/protocol';
import type { Logger } from '../util/logger.js';
import type { SessionEventRecord } from '../claude/claude-session.js';
import { findTranscript, TranscriptTail } from './transcript-tail.js';

export { encodeProjectDir, transcriptEvents } from './transcript-tail.js';

/**
 * Claude Code sessions running anywhere on this PC, including ones started in a
 * terminal. Claude Code registers each live process in `<config>/sessions/<pid>.json`
 * (with a busy/idle status) and appends the conversation to
 * `<config>/projects/<encoded cwd>/<session id>.jsonl`; both are read here, never
 * written. The formats are Claude Code internals, so everything is parsed leniently and
 * anything unexpected is skipped rather than trusted.
 */

const RegistrySchema = z.object({
  pid: z.number().int().positive(),
  sessionId: z.string().min(1).max(128),
  cwd: z.string().min(1).max(4096),
  name: z.string().max(200).optional(),
  status: z.string().max(64).optional(),
  startedAt: z.number().optional(),
  updatedAt: z.number().optional(),
  statusUpdatedAt: z.number().optional(),
});

/** Events kept per PC session for clients that open it. */
const EVENT_LIMIT = 300;
const MAX_SESSIONS = 32;

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

export function mapStatus(status: string | undefined): PcSessionStatus {
  if (!status) return 'unknown';
  if (status === 'busy') return 'working';
  if (status === 'idle') return 'idle';
  if (/wait|input|permission|block/i.test(status)) return 'waiting';
  return 'unknown';
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Tracked {
  info: PcSession;
  tail?: TranscriptTail;
  seq: number;
  events: SessionEventRecord[];
}

export interface PcSessionWatcherOptions {
  logger: Logger;
  /** Sessions the agent itself runs; they are shown as phone sessions instead. */
  isOwnSession: (claudeSessionId: string) => boolean;
  /** The allow-listed project for a folder, if any. */
  projectFor: (cwd: string) => string | undefined;
  claudeDir?: string;
  intervalMs?: number;
}

export class PcSessionWatcher extends EventEmitter<{
  changed: [sessions: PcSession[]];
  event: [sessionId: string, record: SessionEventRecord];
  /** A session went from working to idle: its task finished. */
  done: [session: PcSession];
}> {
  private readonly tracked = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private lastList = '';
  private readonly dir: string;

  constructor(private readonly opts: PcSessionWatcherOptions) {
    super();
    this.dir = opts.claudeDir ?? claudeConfigDir();
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs ?? 2_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  list(): PcSession[] {
    return [...this.tracked.values()]
      .map((t) => t.info)
      .sort((a, b) => (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0));
  }

  get(sessionId: string): PcSession | undefined {
    return this.tracked.get(sessionId)?.info;
  }

  events(sessionId: string): SessionEventRecord[] {
    return [...(this.tracked.get(sessionId)?.events ?? [])];
  }

  /** One scan; overlapping scans are skipped. Exposed for tests. */
  poll(): Promise<void> {
    this.running ??= this.scan()
      .catch((err: unknown) => this.opts.logger.warn({ err }, 'scanning PC sessions failed'))
      .finally(() => (this.running = undefined));
    return this.running;
  }

  private async scan(): Promise<void> {
    const seen = new Set<string>();
    for (const entry of await this.readRegistry()) {
      if (seen.size >= MAX_SESSIONS) break;
      if (this.opts.isOwnSession(entry.sessionId) || !isAlive(entry.pid)) continue;
      seen.add(entry.sessionId);

      const status = mapStatus(entry.status);
      const previous = this.tracked.get(entry.sessionId);
      const previousStatus = previous?.info.status;
      const tracked: Tracked = previous ?? {
        info: { sessionId: entry.sessionId } as PcSession,
        seq: 0,
        events: [],
      };
      tracked.info = {
        sessionId: entry.sessionId,
        pid: entry.pid,
        cwd: entry.cwd,
        folder: path.basename(entry.cwd) || entry.cwd,
        name: entry.name,
        status,
        lastPrompt: previous?.info.lastPrompt,
        startedAt: entry.startedAt,
        updatedAt: entry.statusUpdatedAt ?? entry.updatedAt,
        projectId: this.opts.projectFor(entry.cwd),
      };
      this.tracked.set(entry.sessionId, tracked);
      await this.tail(tracked);
      if (previousStatus === 'working' && status === 'idle') this.emit('done', tracked.info);
    }
    for (const id of this.tracked.keys()) if (!seen.has(id)) this.tracked.delete(id);

    const list = this.list();
    const key = JSON.stringify(list);
    if (key !== this.lastList) {
      this.lastList = key;
      this.emit('changed', list);
    }
  }

  private async readRegistry(): Promise<Array<z.infer<typeof RegistrySchema>>> {
    const dir = path.join(this.dir, 'sessions');
    const files = await readdir(dir).catch(() => [] as string[]);
    const entries = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed = RegistrySchema.safeParse(
          JSON.parse(await readFile(path.join(dir, file), 'utf8')),
        );
        if (parsed.success) entries.push(parsed.data);
      } catch {
        // Being rewritten or removed as we read it; the next scan will see it.
      }
    }
    return entries;
  }

  /** Reads what was appended to the transcript since the last scan. */
  private async tail(t: Tracked): Promise<void> {
    t.tail ??= await findTranscript(this.dir, t.info.cwd, t.info.sessionId).then((f) =>
      f ? new TranscriptTail(f) : undefined,
    );
    if (!t.tail) return;
    const result = await t.tail.read();
    if (result.reset) t.events = [];
    if (result.lastPrompt) t.info.lastPrompt = result.lastPrompt;
    for (const item of result.items) {
      const record = { seq: ++t.seq, at: item.at, event: item.event };
      t.events.push(record);
      if (t.events.length > EVENT_LIMIT) t.events.shift();
      this.emit('event', t.info.sessionId, record);
    }
  }
}
