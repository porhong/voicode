import { EventEmitter } from 'node:events';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ClaudeEvent, PcSession, PcSessionStatus } from '@voicecode/protocol';
import { summarizeToolResult, summarizeToolUse } from '../claude/tool-summary.js';
import type { Logger } from '../util/logger.js';
import type { SessionEventRecord } from '../claude/claude-session.js';

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
/** A first read of a long transcript starts this far from its end. */
const INITIAL_TAIL_BYTES = 512 * 1024;
const MAX_SESSIONS = 32;

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

/** How Claude Code names a project's transcript folder: every non-alphanumeric → "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function mapStatus(status: string | undefined): PcSessionStatus {
  if (!status) return 'unknown';
  if (status === 'busy') return 'working';
  if (status === 'idle') return 'idle';
  if (/wait|input|permission|block/i.test(status)) return 'waiting';
  return 'unknown';
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Text a user typed, as opposed to command wrappers and injected context. */
function typedText(text: string): string | undefined {
  const t = text.trim();
  return t && !t.startsWith('<') ? t : undefined;
}

/** Turns one transcript line into phone transcript events (often none). */
export function transcriptEvents(entry: unknown): ClaudeEvent[] {
  if (!entry || typeof entry !== 'object') return [];
  const e = entry as {
    type?: string;
    isMeta?: boolean;
    isSidechain?: boolean;
    message?: { content?: unknown };
  };
  // Subagent chatter and injected context are not part of the visible conversation.
  if (e.isMeta || e.isSidechain) return [];
  const content = e.message?.content;
  const out: ClaudeEvent[] = [];

  if (e.type === 'user') {
    if (typeof content === 'string') {
      const text = typedText(content);
      if (text) out.push({ kind: 'user_prompt', text, deviceName: 'PC' });
      return out;
    }
    if (!Array.isArray(content)) return out;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = typedText(block.text);
        if (!text) continue;
        out.push(
          text.startsWith('[Request interrupted')
            ? { kind: 'status', message: 'Interrupted.' }
            : { kind: 'user_prompt', text, deviceName: 'PC' },
        );
      } else if (block.type === 'tool_result') {
        out.push({
          kind: 'tool_result',
          toolUseId: String(block.tool_use_id ?? ''),
          isError: block.is_error === true,
          summary: summarizeToolResult(block.content),
        });
      }
    }
    return out;
  }

  if (e.type === 'assistant' && Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ kind: 'assistant_text', text: block.text });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        out.push({
          kind: 'tool_use',
          toolUseId: String(block.id ?? ''),
          name: block.name,
          summary: summarizeToolUse(block.name, (block.input ?? {}) as Record<string, unknown>),
        });
      }
    }
  }
  return out;
}

interface Tracked {
  info: PcSession;
  transcript?: string;
  offset: number;
  /** Bytes after the last complete line, waiting for the rest of it. */
  partial: string;
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
        offset: 0,
        partial: '',
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

  private async findTranscript(info: PcSession): Promise<string | undefined> {
    const projects = path.join(this.dir, 'projects');
    const direct = path.join(projects, encodeProjectDir(info.cwd), `${info.sessionId}.jsonl`);
    if (
      await stat(direct).then(
        () => true,
        () => false,
      )
    )
      return direct;
    // Long paths are shortened differently; fall back to looking in every project.
    for (const dir of await readdir(projects).catch(() => [] as string[])) {
      const candidate = path.join(projects, dir, `${info.sessionId}.jsonl`);
      if (
        await stat(candidate).then(
          () => true,
          () => false,
        )
      )
        return candidate;
    }
    return undefined;
  }

  /** Reads what was appended to the transcript since the last scan. */
  private async tail(t: Tracked): Promise<void> {
    t.transcript ??= await this.findTranscript(t.info);
    if (!t.transcript) return;
    const size = await stat(t.transcript).then(
      (s) => s.size,
      () => -1,
    );
    if (size < 0) return;
    if (size < t.offset) {
      // Rewritten from scratch (compaction or a new file): start over.
      t.offset = 0;
      t.partial = '';
      t.events = [];
    }
    let start = t.offset;
    let skipFirst = false;
    if (start === 0 && size > INITIAL_TAIL_BYTES) {
      start = size - INITIAL_TAIL_BYTES;
      skipFirst = true;
    }
    if (size === start) return;

    const handle = await open(t.transcript, 'r');
    let chunk: string;
    try {
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      chunk = buffer.toString('utf8');
    } finally {
      await handle.close();
    }
    t.offset = size;

    const lines = (t.partial + chunk).split('\n');
    t.partial = lines.pop() ?? '';
    if (skipFirst) lines.shift();
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const e = entry as { type?: string; lastPrompt?: unknown; timestamp?: unknown };
      if (e.type === 'last-prompt' && typeof e.lastPrompt === 'string') {
        t.info.lastPrompt = e.lastPrompt.slice(0, 200);
      }
      const at =
        typeof e.timestamp === 'string' ? Date.parse(e.timestamp) || Date.now() : Date.now();
      for (const event of transcriptEvents(entry)) {
        const record = { seq: ++t.seq, at, event };
        t.events.push(record);
        if (t.events.length > EVENT_LIMIT) t.events.shift();
        this.emit('event', t.info.sessionId, record);
      }
    }
  }
}
