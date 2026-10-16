import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionRequest } from '@voicecode/protocol';
import { ApprovalBroker } from '../claude/approval-broker.js';
import { ConfigSchema } from '../config/config.js';
import { encodeProjectDir } from '../sessions/pc-sessions.js';
import { silentLogger } from '../util/logger.js';
import type { DesktopDriver, DesktopState } from './desktop-helper.js';
import { DesktopSession } from './desktop-session.js';

/** Plays Claude Desktop's window: tests set what it shows and read what was done. */
class FakeDesktop implements DesktopDriver {
  screen: DesktopState = {
    window: true,
    minimized: false,
    shown: true,
    pane: { code: true, title: 'Fix the login', busy: false, promptEmpty: true, mode: 'Manual' },
  };
  calls: string[] = [];
  async state(): Promise<DesktopState> {
    return structuredClone(this.screen);
  }
  async open(title: string): Promise<void> {
    this.calls.push(`open ${title}`);
  }
  async prompt(title: string, text: string): Promise<void> {
    this.calls.push(`prompt ${title}: ${text}`);
  }
  async stop(): Promise<void> {
    this.calls.push('stop');
  }
  async mode(_title: string, label: string): Promise<string> {
    this.calls.push(`mode ${label}`);
    this.screen.pane!.mode = label;
    return label;
  }
  async model(_title: string, label: string): Promise<string> {
    this.calls.push(`model ${label}`);
    return label;
  }
  async models(): Promise<string[]> {
    return ['Opus 5.5', 'Haiku 5.5'];
  }
  close(): void {}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
};

const SESSION_ID = '3cb79c7e-76d3-441c-a618-94d3df1cfb90';
const COMMAND = { command: 'Set-Content -Path note.txt -Value hi', description: 'Write it' };
let home: string;
let transcript: string;
let desktop: FakeDesktop;
let broker: ApprovalBroker;
let requests: PermissionRequest[];
let session: DesktopSession | undefined;

const line = (entry: unknown) => appendFile(transcript, `${JSON.stringify(entry)}\n`);
const toolUse = (id: string) =>
  line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'PowerShell', input: COMMAND }] },
  });
const toolResult = (id: string) =>
  line({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
  });

async function start(config: Record<string, unknown> = {}): Promise<DesktopSession> {
  const parsed = ConfigSchema.parse({
    version: 1,
    projects: [{ id: 'p1', name: 'app', path: home }],
    claude: config,
  });
  session = new DesktopSession({
    id: 'phone-1',
    project: parsed.projects[0]!,
    config: parsed.claude,
    broker,
    logger: silentLogger(),
    driver: desktop,
    pc: { pid: process.pid, claudeSessionId: SESSION_ID },
    claudeDir: path.join(home, 'claude'),
    pollMs: 20,
  });
  broker.on('request', () => session!.setAwaitingPermission(true));
  await session.start();
  return session;
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'voicecode-desktop-'));
  const dir = path.join(home, 'claude', 'projects', encodeProjectDir(home));
  await mkdir(dir, { recursive: true });
  transcript = path.join(dir, `${SESSION_ID}.jsonl`);
  await line({ type: 'user', message: { content: 'hello' } });
  await line({ type: 'custom-title', customTitle: 'Fix the login', sessionId: SESSION_ID });
  desktop = new FakeDesktop();
  broker = new ApprovalBroker({ timeoutMs: 60_000 });
  requests = [];
  broker.on('request', (r) => requests.push(r));
});

afterEach(async () => {
  session?.close();
  session = undefined;
  await rm(home, { recursive: true, force: true });
});

describe('DesktopSession', () => {
  it('opens the session by its Desktop title and follows its transcript', async () => {
    const s = await start();
    expect(desktop.calls).toContain('open Fix the login');
    expect(s.summary()).toMatchObject({
      kind: 'desktop',
      attached: true,
      title: 'Fix the login',
      permissionMode: 'default',
      state: 'idle',
    });
    await until(() => s.events().some((e) => e.event.kind === 'user_prompt'));
    expect(s.events()[0]!.event).toMatchObject({
      kind: 'user_prompt',
      deviceName: 'Claude Desktop',
    });
  });

  it('refuses a session Desktop has not named yet', async () => {
    await rm(transcript);
    await line({ type: 'user', message: { content: 'hello' } });
    await expect(start()).rejects.toThrow(/not named/);
  });

  it('types prompts into Desktop and names the phone as their author', async () => {
    const s = await start();
    await s.sendPrompt('add a test', 'Pixel', ['C:\\img\\a.png']);
    expect(desktop.calls.at(-1)).toBe(
      'prompt Fix the login: add a test\n\nAttached image: C:\\img\\a.png',
    );
    await line({
      type: 'user',
      message: { content: 'add a test\n\nAttached image: C:\\img\\a.png' },
    });
    const byPhone = () =>
      s.events().find((e) => e.event.kind === 'user_prompt' && e.event.deviceName === 'Pixel');
    await until(() => byPhone() !== undefined);
    expect(byPhone()!.event).toMatchObject({ text: 'add a test', images: 1 });
  });

  it('asks the phone for a permission request with the full input and returns its answer', async () => {
    const s = await start();
    await toolUse('t1');
    const answer = s.askPermission('PowerShell', COMMAND);
    await until(() => requests.length === 1);
    expect(requests[0]).toMatchObject({ toolName: 'PowerShell', complete: true });
    expect(requests[0]!.detail).toContain('Set-Content -Path note.txt -Value hi');
    expect(s.summary().state).toBe('awaiting_permission');
    broker.respond(requests[0]!.requestId, 'allow');
    expect(await answer).toEqual({ decision: 'allow' });
  });

  it('stops Claude on a bare rejection and passes feedback on instead of stopping', async () => {
    const s = await start();
    const bare = s.askPermission('PowerShell', COMMAND);
    await until(() => requests.length === 1);
    broker.respond(requests[0]!.requestId, 'deny');
    expect(await bare).toMatchObject({ decision: 'deny', interrupt: true });

    const withNote = s.askPermission('PowerShell', COMMAND);
    await until(() => requests.length === 2);
    broker.respond(requests[1]!.requestId, 'deny', { message: 'use a branch' });
    expect(await withNote).toEqual({ decision: 'deny', reason: 'use a branch' });
  });

  it('withdraws the phone request when it is answered on the PC first', async () => {
    const s = await start();
    await toolUse('t2');
    const answer = s.askPermission('PowerShell', COMMAND);
    await until(() => requests.length === 1);
    const resolved: string[] = [];
    broker.on('resolved', (e) => resolved.push(e.reason));
    // Allowed in Desktop: the call's result reaches the transcript.
    await toolResult('t2');
    expect(await answer).toBeUndefined();
    expect(resolved).toEqual(['cancelled']);
  });

  it('withdraws it too when the call and its answer reach the transcript at once', async () => {
    const s = await start();
    const answer = s.askPermission('PowerShell', COMMAND);
    await until(() => requests.length === 1);
    await toolUse('t3');
    await toolResult('t3');
    expect(await answer).toBeUndefined();
  });

  it('decides nothing once the phone lets go', async () => {
    const s = await start();
    const answer = s.askPermission('PowerShell', COMMAND);
    await until(() => requests.length === 1);
    s.close();
    expect(await answer).toBeUndefined();
    expect(await s.askPermission('PowerShell', COMMAND)).toBeUndefined();
  });

  it('puts Desktop back to Manual while modes that skip approvals are off', async () => {
    desktop.screen.pane!.mode = 'Bypass permissions';
    const s = await start();
    await until(() => desktop.calls.includes('mode Manual'));
    await until(() => s.summary().permissionMode === 'default');
    expect(s.modes()).toEqual(['default', 'acceptEdits', 'plan']);
    await expect(s.setMode('bypassPermissions')).rejects.toThrow(/off on this PC/);
  });

  it('leaves an unsafe mode alone when the PC allows them', async () => {
    desktop.screen.pane!.mode = 'Auto';
    const s = await start({ allowUnsafeModes: true });
    await sleep(100);
    expect(desktop.calls).not.toContain('mode Manual');
    expect(s.summary().permissionMode).toBe('auto');
  });

  it('mirrors what Desktop shows, and the sidebar while another session is on screen', async () => {
    const s = await start();
    desktop.screen.pane!.busy = true;
    await until(() => s.summary().state === 'running');
    desktop.screen.pane!.permission = { text: 'Allow Claude to run …', buttons: [] };
    await until(() => s.summary().state === 'awaiting_permission');
    desktop.screen = { window: true, minimized: false, shown: false, rowStatus: 'Idle' };
    await until(() => s.summary().state === 'idle');
    desktop.screen = { window: true, minimized: false, shown: false, rowStatus: 'Working' };
    await until(() => s.summary().state === 'running');
  });

  it('goes by the transcript while Desktop is minimized', async () => {
    const s = await start();
    // Minimized: the window still shows the Stop button from before; it is stale.
    desktop.screen = {
      window: true,
      minimized: true,
      shown: true,
      pane: { ...desktop.screen.pane!, busy: true },
    };
    await line({ type: 'user', message: { content: 'run the tests' } });
    await until(() => s.summary().state === 'running');
    await line({
      type: 'assistant',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All green.' }] },
    });
    await until(() => s.summary().state === 'idle');
  });

  it('switches models by the names Desktop offers', async () => {
    const s = await start();
    expect((await s.models()).map((m) => m.value)).toEqual(['Opus 5.5', 'Haiku 5.5']);
    await s.setModel('Haiku 5.5');
    expect(desktop.calls.at(-1)).toBe('model Haiku 5.5');
    expect(s.summary().model).toBe('Haiku 5.5');
  });
});
