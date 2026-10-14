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

export interface TailResult {
  /** The file was rewritten from scratch (compaction or a new file); earlier events are stale. */
  reset: boolean;
  items: Array<{ at: number; event: ClaudeEvent }>;
  /** The latest `last-prompt` entry seen, if any. */
  lastPrompt?: string;
}

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

  constructor(readonly file: string) {}

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
      const e = entry as { type?: string; lastPrompt?: unknown; timestamp?: unknown };
      if (e.type === 'last-prompt' && typeof e.lastPrompt === 'string') {
        result.lastPrompt = e.lastPrompt.slice(0, 200);
      }
      const at =
        typeof e.timestamp === 'string' ? Date.parse(e.timestamp) || Date.now() : Date.now();
      for (const event of transcriptEvents(entry)) result.items.push({ at, event });
    }
    return result;
  }
}
