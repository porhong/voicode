import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ClaudeEvent } from '@voicecode/protocol';
import { summarizeToolResult, summarizeToolUse } from '../claude/tool-summary.js';

/** A first read of a long transcript starts this far from its end. */
const INITIAL_TAIL_BYTES = 512 * 1024;

/** How Claude Code names a project's transcript folder: every non-alphanumeric → "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** The transcript file of a Claude Code session, searched the way Claude Code lays it out. */
export async function findTranscript(
  claudeDir: string,
  cwd: string,
  sessionId: string,
): Promise<string | undefined> {
  const projects = path.join(claudeDir, 'projects');
  const direct = path.join(projects, encodeProjectDir(cwd), `${sessionId}.jsonl`);
  if (await exists(direct)) return direct;
  // Long paths are shortened differently; fall back to looking in every project.
  for (const dir of await readdir(projects).catch(() => [] as string[])) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (await exists(candidate)) return candidate;
  }
  return undefined;
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

/**
 * Where a transcript entry starts or ends Claude's turn: a prompt the user typed starts
 * it; a reply that ends the turn, the Stop hooks' summary, or an interruption ends it.
 */
function turnBoundary(e: {
  type?: string;
  subtype?: unknown;
  message?: { content?: unknown; stop_reason?: unknown };
}): 'started' | 'ended' | undefined {
  if (e.type === 'assistant' && e.message?.stop_reason === 'end_turn') return 'ended';
  if (e.type === 'system' && e.subtype === 'stop_hook_summary') return 'ended';
  if (e.type !== 'user') return undefined;
  const content = e.message?.content;
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? (content as Array<Record<string, unknown>>)
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text as string)
        : [];
  if (texts.some((t) => t.startsWith('[Request interrupted'))) return 'ended';
  return texts.some((t) => typedText(t)) ? 'started' : undefined;
}

export interface TailResult {
  /** The file was rewritten from scratch (compaction or a new file); earlier events are stale. */
  reset: boolean;
  items: Array<{ at: number; event: ClaudeEvent }>;
  /** The latest `last-prompt` entry seen, if any. */
  lastPrompt?: string;
  /** The model of the latest assistant reply, if any. */
  model?: string;
  /** The session's title as Claude Code shows it (`/rename`, or the one it generated). */
  title?: string;
  /** The latest turn boundary read: a typed prompt starts one, a final reply ends it. */
  turn?: 'started' | 'ended';
}

/** A tool call Claude made that has no result yet: it runs, or waits for approval. */
export interface PendingToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Tool calls kept while waiting for their results (parallel calls, long runs). */
const PENDING_LIMIT = 32;

/**
 * Incremental reader of one Claude Code transcript (JSONL, append-only). Each `read()`
 * returns the events appended since the previous one; the first read of a long file
 * starts near its end. Anything unparseable is skipped: the format is an internal of
 * Claude Code and is never trusted.
 */
export class TranscriptTail {
  private offset = 0;
  /** Bytes after the last complete line, waiting for the rest of it. */
  private partial = '';
  private readonly pending = new Map<string, PendingToolUse>();
  /** Tool calls that got their result, newest last, numbered in order (see `answeredSince`). */
  private readonly answered: Array<{ name: string; mark: number }> = [];
  private answeredCount = 0;

  constructor(readonly file: string) {}

  /**
   * The latest tool call without a result, with its complete input (what an approval
   * shows). Only main-conversation calls: a subagent's are its own business.
   */
  pendingToolUse(): PendingToolUse | undefined {
    return [...this.pending.values()].at(-1);
  }

  /** Whether this tool call still has no result. */
  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  /** A position in the stream of answered tool calls, for `answeredSince`. */
  answeredMark(): number {
    return this.answeredCount;
  }

  /** Whether a call of this tool got its result after `mark` (even one never seen pending). */
  answeredSince(mark: number, name: string): boolean {
    return this.answered.some((a) => a.mark > mark && a.name === name);
  }

  async read(): Promise<TailResult> {
    const result: TailResult = { reset: false, items: [] };
    const size = await stat(this.file).then(
      (s) => s.size,
      () => -1,
    );
    if (size < 0) return result;
    if (size < this.offset) {
      result.reset = true;
      this.offset = 0;
      this.partial = '';
      this.pending.clear();
    }
    let start = this.offset;
    let skipFirst = false;
    if (start === 0 && size > INITIAL_TAIL_BYTES) {
      start = size - INITIAL_TAIL_BYTES;
      skipFirst = true;
    }
    if (size === start) return result;

    const handle = await open(this.file, 'r');
    let chunk: string;
    try {
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      chunk = buffer.toString('utf8');
    } finally {
      await handle.close();
    }
    this.offset = size;

    const lines = (this.partial + chunk).split('\n');
    this.partial = lines.pop() ?? '';
    if (skipFirst) lines.shift();
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const e = entry as {
        type?: string;
        lastPrompt?: unknown;
        customTitle?: unknown;
        aiTitle?: unknown;
        timestamp?: unknown;
        isSidechain?: boolean;
        subtype?: unknown;
        message?: { model?: unknown; content?: unknown; stop_reason?: unknown };
      };
      if (e.type === 'last-prompt' && typeof e.lastPrompt === 'string') {
        result.lastPrompt = e.lastPrompt.slice(0, 200);
      }
      if (e.type === 'custom-title' && typeof e.customTitle === 'string') {
        result.title = e.customTitle.slice(0, 200);
      } else if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && !result.title) {
        result.title = e.aiTitle.slice(0, 200);
      }
      if (!e.isSidechain) {
        this.trackTools(e.type, e.message?.content);
        const turn = turnBoundary(e);
        if (turn) result.turn = turn;
      }
      const model = e.message?.model;
      if (
        e.type === 'assistant' &&
        !e.isSidechain &&
        typeof model === 'string' &&
        model !== '<synthetic>'
      ) {
        result.model = model.slice(0, 100);
      }
      const at =
        typeof e.timestamp === 'string' ? Date.parse(e.timestamp) || Date.now() : Date.now();
      for (const event of transcriptEvents(entry)) result.items.push({ at, event });
    }
    return result;
  }

  private trackTools(type: string | undefined, content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (type === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string') {
        const input = block.input;
        this.pending.set(String(block.id ?? ''), {
          id: String(block.id ?? ''),
          name: block.name,
          input: input && typeof input === 'object' ? (input as Record<string, unknown>) : {},
        });
        if (this.pending.size > PENDING_LIMIT) {
          this.pending.delete(this.pending.keys().next().value!);
        }
      } else if (type === 'user' && block.type === 'tool_result') {
        const id = String(block.tool_use_id ?? '');
        const call = this.pending.get(id);
        this.pending.delete(id);
        if (call) {
          this.answered.push({ name: call.name, mark: ++this.answeredCount });
          if (this.answered.length > PENDING_LIMIT) this.answered.shift();
        }
      }
    }
  }
}
