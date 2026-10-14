import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PcSession } from '@voicecode/protocol';
import { silentLogger } from '../util/logger.js';
import { encodeProjectDir, mapStatus, PcSessionWatcher, transcriptEvents } from './pc-sessions.js';

describe('transcriptEvents', () => {
  it('maps typed prompts, replies and tool calls, and skips injected context', () => {
    expect(transcriptEvents({ type: 'user', message: { content: 'Fix the build' } })).toEqual([
      { kind: 'user_prompt', text: 'Fix the build', deviceName: 'PC' },
    ]);
    expect(
      transcriptEvents({
        type: 'user',
        message: { content: '<command-name>/clear</command-name>' },
      }),
    ).toEqual([]);
    expect(transcriptEvents({ type: 'user', isMeta: true, message: { content: 'x' } })).toEqual([]);
    expect(
      transcriptEvents({ type: 'assistant', isSidechain: true, message: { content: [] } }),
    ).toEqual([]);

    const events = transcriptEvents({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Running the tests.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    });
    expect(events.map((e) => e.kind)).toEqual(['assistant_text', 'tool_use']);
    expect(events[1]).toMatchObject({ toolUseId: 't1', name: 'Bash' });

    expect(
      transcriptEvents({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' },
            { type: 'text', text: '[Request interrupted by user]' },
          ],
        },
      }),
    ).toEqual([
      { kind: 'tool_result', toolUseId: 't1', isError: true, summary: 'boom' },
      { kind: 'status', message: 'Interrupted.' },
    ]);
    expect(transcriptEvents(null)).toEqual([]);
    expect(transcriptEvents({ type: 'last-prompt' })).toEqual([]);
  });

  it('maps registry statuses', () => {
    expect(mapStatus('busy')).toBe('working');
    expect(mapStatus('idle')).toBe('idle');
    expect(mapStatus('waiting_for_input')).toBe('waiting');
    expect(mapStatus(undefined)).toBe('unknown');
    expect(encodeProjectDir('D:\\Others\\voicode')).toBe('D--Others-voicode');
  });
});

describe('PcSessionWatcher', () => {
  let dir: string;
  const cwd = path.join(os.tmpdir(), 'some project');
  let transcript: string;

  const register = (status: string, sessionId = 'pc-1', pid = process.pid) =>
    writeFile(
      path.join(dir, 'sessions', `${pid}.json`),
      JSON.stringify({ pid, sessionId, cwd, name: 'proj-1', status, startedAt: 1, extra: true }),
    );
  const line = (entry: unknown) => appendFile(transcript, `${JSON.stringify(entry)}\n`);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'voicecode-pc-'));
    await mkdir(path.join(dir, 'sessions'));
    const projectDir = path.join(dir, 'projects', encodeProjectDir(cwd));
    await mkdir(projectDir, { recursive: true });
    transcript = path.join(projectDir, 'pc-1.jsonl');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  function watcher(own: string[] = []) {
    return new PcSessionWatcher({
      logger: silentLogger(),
      claudeDir: dir,
      isOwnSession: (id) => own.includes(id),
      projectFor: (folder) => (folder === cwd ? 'p1' : undefined),
    });
  }

  it('lists live sessions, follows their transcript and reports finished tasks', async () => {
    await register('busy');
    await line({ type: 'user', timestamp: '2026-10-14T08:00:00Z', message: { content: 'Hi' } });
    await line({ type: 'last-prompt', lastPrompt: 'Hi' });
    // A half-written line is held back until it is complete.
    await appendFile(transcript, '{"type":"assistant","message":{"content":[{"type":"te');

    const w = watcher();
    const changed: PcSession[][] = [];
    const done: PcSession[] = [];
    const events: string[] = [];
    w.on('changed', (list) => changed.push(list));
    w.on('done', (s) => done.push(s));
    w.on('event', (_id, r) => events.push(r.event.kind));

    await w.poll();
    expect(w.list()).toEqual([
      expect.objectContaining({
        sessionId: 'pc-1',
        folder: 'some project',
        status: 'working',
        lastPrompt: 'Hi',
        projectId: 'p1',
      }),
    ]);
    expect(events).toEqual(['user_prompt']);

    await appendFile(transcript, 'xt","text":"Hello!"}]}}\n');
    await register('idle');
    await w.poll();
    expect(events).toEqual(['user_prompt', 'assistant_text']);
    expect(w.events('pc-1').map((r) => r.seq)).toEqual([1, 2]);
    expect(done.map((s) => s.sessionId)).toEqual(['pc-1']);
    expect(changed.map((l) => l[0]?.status)).toEqual(['working', 'idle']);

    // Nothing changed: no new list is announced.
    await w.poll();
    expect(changed).toHaveLength(2);
  });

  it("skips the agent's own sessions and dead processes", async () => {
    await register('busy', 'mine');
    await writeFile(
      path.join(dir, 'sessions', '999999.json'),
      JSON.stringify({ pid: 2_147_000_000, sessionId: 'gone', cwd }),
    );
    await writeFile(path.join(dir, 'sessions', 'junk.json'), '{not json');
    const w = watcher(['mine']);
    await w.poll();
    expect(w.list()).toEqual([]);
  });
});
