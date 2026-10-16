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
  killed = false;
  kill(): void {
    this.killed = true;
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
let attached: FakePty;
let attachedPid: number | undefined;
let spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
const summaries: SessionSummary[] = [];
const requests: PermissionRequest[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms = 8_000) => {
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
  attached = new FakePty();
  attached.pid = 5151;
  manager = new SessionManager(
    config,
    silentLogger(),
    undefined,
    {
      claudeDir,
      claudePath: 'C:/fake/claude.exe',
      spawn: (file, args, options) => {
        spawned = { file, args, env: options.env };
        return pty;
      },
      attach: async (pid) => {
        attachedPid = pid;
        return attached;
      },
    },
    path.join(home, 'attachments'),
  );
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

  it('takes control of a terminal session: dictation on, waits shown, detach on close', async () => {
    expect(manager.pcControlStatus()).toEqual({ available: true });
    const pc = {
      sessionId: 'term-1',
      pid: 5151,
      cwd: home,
      folder: 'proj',
      status: 'idle' as const,
      projectId: 'p1',
      lastPrompt: 'add rate limiting',
    };
    // The fake process must look alive: a registry entry stands in for a real pid.
    await writeFile(
      path.join(claudeDir, 'sessions', '5151.json'),
      JSON.stringify({ pid: 5151, sessionId: 'term-1', cwd: home, status: 'idle' }),
    );
    const session = await manager.controlPc(pc);
    expect(attachedPid).toBe(5151);
    expect(session.summary()).toMatchObject({
      kind: 'voice',
      attached: true,
      claudeSessionId: 'term-1',
      title: 'add rate limiting',
    });
    await expect(manager.controlPc(pc)).rejects.toThrow(/already controlled/);

    // Dictation is off and the prompt is empty: the agent turns it on.
    attached.show('❯ Try "how does <filepath> work?"\n  ⏸ manual mode on · ? for shortcuts');
    await until(() => attached.written.includes('/voice tap\r'));
    attached.show('❯ /voice tap\n  ⎿  Voice mode enabled (tap). Tap space to start.\n❯\n');
    await until(() => session.summary().voice?.state === 'idle');

    // Claude Code's own name (/rename in the terminal) replaces the prompt-derived one…
    await writeFile(
      path.join(claudeDir, 'sessions', '5151.json'),
      JSON.stringify({
        pid: 5151,
        sessionId: 'term-1',
        cwd: home,
        name: 'auth-refactor',
        status: 'waiting_for_input',
      }),
    );
    await until(() => session.summary().state === 'awaiting_permission');
    expect(session.summary().title).toBe('auth-refactor');
    // …unless the phone renamed it.
    manager.rename(session.id, 'login work');
    expect(session.summary().title).toBe('login work');
    await writeFile(
      path.join(claudeDir, 'sessions', '5151.json'),
      JSON.stringify({ pid: 5151, sessionId: 'term-1', cwd: home, status: 'idle' }),
    );
    await until(() => session.summary().state === 'idle');

    attached.written = '';
    manager.close(session.id);
    expect(attached.written).not.toContain('/exit');
    expect(session.summary().state).toBe('closed');
  });

  it("switches the model by typing /model and reading Claude Code's answer", async () => {
    // Its own terminal, so the first session's fake and registry entry stay untouched.
    const first = pty;
    pty = new FakePty();
    pty.pid = 6262;
    const id2 = (await manager.startVoice('p1', undefined, 'haiku')).id;
    expect(spawned!.args).toContain('--model');
    expect(spawned!.args[spawned!.args.indexOf('--model') + 1]).toBe('haiku');
    pty.show('❯ /voice tap\n  ⎿  Voice mode enabled (tap).\n❯ ');
    await until(() => manager.get(id2).summary().state === 'idle');

    pty.written = '';
    const switching = manager.setModel(id2, 'sonnet');
    await until(() => pty.written.endsWith('\r'));
    expect(pty.written).toBe('/model sonnet\r');
    pty.show(
      '❯ /model sonnet\n  ⎿  Set model to Sonnet 5.5 and saved as your default for new sessions\n❯ ',
    );
    await switching;
    expect(manager.get(id2).summary().model).toBe('Sonnet 5.5');
    expect((await manager.models(id2)).persistsDefault).toBe(true);

    pty.written = '';
    const wrong = manager.setModel(id2, 'nonsense');
    await until(() => pty.written.endsWith('\r'));
    pty.show("❯ /model nonsense\n  ⎿  Model 'nonsense' not found\n❯ ");
    await expect(wrong).rejects.toThrow(/not found/);

    // Not while something is typed in the prompt.
    pty.show('❯ half a sentence');
    await sleep(100); // xterm parses writes asynchronously
    await expect(manager.setModel(id2, 'opus')).rejects.toThrow(/not empty/);
    manager.close(id2);
    pty.exit(0);
    pty = first;
  });

  it('cycles the terminal mode with Shift+Tab until the footer shows the chosen one', async () => {
    const first = pty;
    pty = new FakePty();
    pty.pid = 7272;
    const session = await manager.startVoice('p1');
    expect(spawned!.args).not.toContain('--allow-dangerously-skip-permissions');
    // Each Shift+Tab moves the fake's footer one step, as Claude Code does.
    const cycle = ['manual mode on', 'accept edits on', 'plan mode on', 'auto mode on'];
    let at = 0;
    const show = () => pty.show(`❯ \n  ⏸ ${cycle[at]} · ? for shortcuts`);
    const write = pty.write.bind(pty);
    pty.write = (data: string) => {
      write(data);
      if (data === '\x1b[Z') {
        at = (at + 1) % cycle.length;
        setTimeout(show, 30);
      }
    };
    show();
    await until(() => session.summary().permissionMode === 'default');
    expect(session.summary().modes).toEqual(['default', 'acceptEdits', 'plan']);

    await manager.setMode(session.id, 'plan');
    expect(session.summary().permissionMode).toBe('plan');
    expect(pty.written.split('\x1b[Z').length - 1).toBe(2);
    await expect(manager.setMode(session.id, 'bypassPermissions')).rejects.toThrow(
      /off on this PC/,
    );

    // While unsafe modes are off, the phone still decides even if the terminal bypasses.
    const { VOICECODE_HOOK_URL: url, VOICECODE_HOOK_TOKEN: token } = spawned!.env;
    const claudeId = session.summary().claudeSessionId!;
    const ask = (permission_mode: string) =>
      forwardPreToolUse(
        url!,
        token!,
        JSON.stringify({
          session_id: claudeId,
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          permission_mode,
        }),
      );
    const asked = ask('bypassPermissions');
    await until(() => requests.some((r) => r.sessionId === session.id));
    const request = requests.find((r) => r.sessionId === session.id)!;
    manager.respond(session.id, request.requestId, 'deny', { deviceName: 'Phone', message: 'no' });
    expect(await asked).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    // Allowed: Claude Code's own mode decides.
    await manager.setUnsafeModesAllowed(true);
    expect(await ask('bypassPermissions')).toBeUndefined();
    await manager.setUnsafeModesAllowed(false);

    manager.close(session.id);
    pty.exit(0);
    pty = first;
  });

  it('names attached images by path for Claude Code to read, and labels them in the transcript', async () => {
    const first = pty;
    pty = new FakePty();
    pty.pid = 8282;
    const session = await manager.startVoice('p1');
    expect(spawned!.args.join(' ')).toContain(`--add-dir ${path.join(home, 'attachments')}`);
    pty.show('❯ ');
    await until(() => session.summary().state === 'idle');
    const image = path.join(home, 'attachments', 'abc.jpg');
    pty.written = '';
    await manager.prompt(session.id, 'what is this?', 'Phone', [
      { id: 'abc', mediaType: 'image/jpeg', path: image, bytes: 3 },
    ]);
    await until(() => pty.written.includes('\r'));
    expect(pty.written).toBe(`\x1b[200~what is this?\n\nAttached image: ${image}\x1b[201~\r`);
    manager.close(session.id);
    pty.exit(0);
    pty = first;
  });

  it('shows a Claude Code menu as a question and answers it by its option', async () => {
    const before = summaries.length;
    pty.show(
      [
        '────────────────────────────────────────────────────────────────────────────────────────────────────',
        ' PowerShell command',
        ' Set-Content -Path menu.txt -Value hi',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. Yes, and always allow access to C:\\work from this project',
        '   3. No',
        '',
        ' Esc to cancel · Tab to amend',
      ].join('\r\n'),
    );
    await until(() => summaries.slice(before).some((s) => s.id === id && s.question));
    expect(manager.get(id).summary()).toMatchObject({
      state: 'awaiting_permission',
      question: {
        text: 'Do you want to proceed?',
        detail: ['PowerShell command', 'Set-Content -Path menu.txt -Value hi'],
        options: ['Yes', 'Yes, and always allow access to C:\\work from this project', 'No'],
      },
    });
    // An answer for an option the menu no longer has is refused.
    await expect(manager.answerQuestion(id, 2, 'Maybe')).rejects.toThrow(/no longer showing/);
    pty.written = '';
    const answered = manager.answerQuestion(id, 2, 'No');
    await until(() => pty.written.endsWith('\r'));
    expect(pty.written).toBe('\x1b[B\x1b[B\r');
    pty.show('❯ ');
    await answered;
    await until(() => manager.get(id).summary().question === undefined);
  });

  it('never presses its second Enter into a menu that opened after a prompt', async () => {
    pty.show('❯ ');
    pty.written = '';
    await manager.prompt(id, 'deploy it', 'Phone');
    await until(() => pty.written.endsWith('\r'));
    // A menu opens before the 900 ms check that re-presses Enter for a stuck prompt.
    pty.show(
      [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\r\n'),
    );
    await sleep(1_200);
    expect(pty.written).toBe('\x1b[200~deploy it\x1b[201~\r');
    pty.show('❯ ');
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
