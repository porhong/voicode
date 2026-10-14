import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionRequest, SessionSummary } from '@voicecode/protocol';
import { forwardPreToolUse } from '../cli/commands/hook.js';
import type { PtyHandle } from '../claude/pty-session.js';
import { addProject, ConfigSchema } from '../config/config.js';
import { silentLogger } from '../util/logger.js';
import { encodeProjectDir } from './pc-sessions.js';
import { SessionManager } from './session-manager.js';

class FakePty implements PtyHandle {
  pid = 4242;
  written = '';
  private dataListener: ((data: string) => void) | undefined;
  private exitListener: ((e: { exitCode: number }) => void) | undefined;
  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(listener: (e: { exitCode: number }) => void): void {
    this.exitListener = listener;
  }
  write(data: string): void {
    this.written += data;
  }
  resize(): void {}
  kill(): void {
    this.exitListener?.({ exitCode: 137 });
  }
  /** Claude Code output; `\x1b[2J\x1b[H` first clears the screen. */
  show(screen: string): void {
    this.dataListener?.(`\x1b[2J\x1b[H${screen}`);
  }
  exit(code: number): void {
    this.exitListener?.({ exitCode: code });
  }
}

let home: string;
let claudeDir: string;
let manager: SessionManager;
let pty: FakePty;
let spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
const summaries: SessionSummary[] = [];
const requests: PermissionRequest[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
};

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'voicecode-voice-'));
  claudeDir = path.join(home, 'claude');
  await mkdir(path.join(claudeDir, 'sessions'), { recursive: true });
  const config = ConfigSchema.parse({ version: 1 });
  await addProject(config, home, 'proj');
  config.projects[0]!.id = 'p1';
  pty = new FakePty();
  manager = new SessionManager(config, silentLogger(), undefined, {
    claudeDir,
    claudePath: 'C:/fake/claude.exe',
    spawn: (file, args, options) => {
      spawned = { file, args, env: options.env };
      return pty;
    },
  });
  manager.on('session', (s) => summaries.push(s));
  manager.on('permissionRequest', (r) => requests.push(r));
});

afterAll(async () => {
  manager.closeAll();
  await rm(home, { recursive: true, force: true });
});

describe('voice sessions', () => {
  let id: string;
  let claudeId: string;

  it('starts Claude Code in a pty with dictation and the approval hook configured', async () => {
    const session = await manager.startVoice('p1');
    id = session.id;
    claudeId = session.summary().claudeSessionId!;
    expect(session.summary()).toMatchObject({ kind: 'voice', state: 'starting' });
    expect(spawned?.file).toBe('C:/fake/claude.exe');
    const args = spawned!.args;
    expect(args.slice(0, 2)).toEqual(['--session-id', claudeId]);
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!) as {
      voice: { enabled: boolean; mode: string };
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; timeout: number }> }> };
    };
    expect(settings.voice).toEqual({ enabled: true, mode: 'tap' });
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toContain('hook pre-tool-use');
    expect(spawned!.env.VOICECODE_HOOK_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(spawned!.env.VOICECODE_HOOK_TOKEN).toHaveLength(48);
  });

  it('is ready once the dictation hint shows, and the registry says what Claude is doing', async () => {
    pty.show('> \n  hold space to speak');
    await until(() => manager.get(id).summary().voice?.state === 'idle');
    expect(manager.get(id).summary().state).toBe('idle');

    await writeFile(
      path.join(claudeDir, 'sessions', '4242.json'),
      JSON.stringify({ pid: 4242, sessionId: claudeId, cwd: home, status: 'busy' }),
    );
    await until(() => manager.get(id).summary().state === 'running');
  });

  it('presses the dictation key on push-to-talk and releases after the audio drained', async () => {
    const summary = () => manager.get(id).summary();
    manager.ptt(id, true, 'Phone');
    await until(() => pty.written === ' ');
    expect(summary().voice?.state).toBe('starting');
    pty.show('> \n  ● REC · tap to send');
    await until(() => summary().voice?.state === 'recording');

    manager.ptt(id, false, 'Phone');
    await until(() => summary().voice?.state === 'finalizing');
    expect(pty.written).toBe(' ');
    await until(() => pty.written === '  ', 2_000);
    pty.show('> refactor the auth middleware\n  hold space to speak');
    await until(() => summary().voice?.state === 'idle');
  });

  it('reports when Claude Code did not start recording', async () => {
    pty.written = '';
    manager.ptt(id, true, 'Phone');
    await until(() => manager.get(id).summary().voice?.state === 'error', 4_000);
    expect(manager.get(id).summary().voice?.detail).toMatch(/did not start recording/);
  });

  it('follows the transcript and labels dictated prompts with the speaker', async () => {
    const transcript = path.join(
      claudeDir,
      'projects',
      encodeProjectDir(home),
      `${claudeId}.jsonl`,
    );
    await mkdir(path.dirname(transcript), { recursive: true });
    const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
    await appendFile(
      transcript,
      line({
        type: 'user',
        timestamp: '2026-10-14T10:00:00Z',
        message: { role: 'user', content: 'refactor the auth middleware' },
      }) +
        line({
          type: 'assistant',
          timestamp: '2026-10-14T10:00:05Z',
          message: { content: [{ type: 'text', text: 'On it.' }] },
        }),
    );
    await until(() => manager.get(id).events().length >= 2);
    expect(
      manager
        .get(id)
        .events()
        .map((e) => e.event),
    ).toEqual([
      { kind: 'user_prompt', text: 'refactor the auth middleware', deviceName: 'Phone' },
      { kind: 'assistant_text', text: 'On it.' },
    ]);
    expect(manager.get(id).summary().title).toBe('refactor the auth middleware');
  });

  it('routes hook tool calls to the phone for approval and lets reads through', async () => {
    const { VOICECODE_HOOK_URL: url, VOICECODE_HOOK_TOKEN: token } = spawned!.env;
    const call = (tool_name: string) =>
      forwardPreToolUse(
        url!,
        token!,
        JSON.stringify({ session_id: claudeId, tool_name, tool_input: { command: 'npm test' } }),
      );
    expect(await call('Read')).toBeUndefined();
    expect(await call('Glob')).toBeUndefined();

    const pending = call('Bash');
    await until(() => requests.length === 1);
    expect(requests[0]).toMatchObject({ sessionId: id, toolName: 'Bash', detail: 'npm test' });
    expect(manager.get(id).summary().state).toBe('awaiting_permission');
    manager.respond(id, requests[0]!.requestId, 'allow', { deviceName: 'Phone' });
    expect(await pending).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });

    const denied = call('Write');
    await until(() => requests.length === 2);
    manager.respond(id, requests[1]!.requestId, 'deny', {
      deviceName: 'Phone',
      message: 'not yet',
    });
    expect(await denied).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'not yet' },
    });
    // A session id the agent does not host is left to Claude Code's own prompt.
    expect(
      await forwardPreToolUse(
        url!,
        token!,
        JSON.stringify({ session_id: 'someone-else', tool_name: 'Bash', tool_input: {} }),
      ),
    ).toBeUndefined();
  });

  it('types prompts as a paste and closes with /exit', async () => {
    pty.written = '';
    manager.prompt(id, 'run the tests', 'Phone');
    await until(() => pty.written.endsWith('\r'));
    expect(pty.written).toBe('\x1b[200~run the tests\x1b[201~\r');

    manager.close(id);
    expect(pty.written).toContain('/exit\r');
    pty.exit(0);
    expect(summaries.at(-1)).toMatchObject({ id, state: 'closed' });
  });
});
