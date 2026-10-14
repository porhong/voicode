import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { Terminal } from '@xterm/headless';
import type { ClaudeEvent, SessionState, SessionSummary, VoiceState } from '@voicecode/protocol';
import type { AgentConfig, ProjectConfig } from '../config/config.js';
import { claudeConfigDir, mapStatus } from '../sessions/pc-sessions.js';
import { findTranscript, TranscriptTail } from '../sessions/transcript-tail.js';
import type { Logger } from '../util/logger.js';
import { isStandalone } from '../util/standalone.js';
import type { ApprovalBroker } from './approval-broker.js';
import { interactiveClaudePath } from './claude-binary.js';
import type { SessionEventRecord } from './claude-session.js';
import { readVoiceScreen, type VoiceScreen } from './voice-screen.js';

const HISTORY_LIMIT = 500;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
/** Claude Code must show `REC` within this long of the Space tap, else the tap did not take. */
const RECORD_START_TIMEOUT_MS = 2_500;
/** After the phone stops streaming, the last audio needs this long to reach the cable. */
const RELEASE_DELAY_MS = 600;
const RECORD_STOP_TIMEOUT_MS = 6_000;
/** An error shown on the phone's mic button clears itself after this. */
const ERROR_SHOWN_MS = 5_000;
const POLL_MS = 1_000;

/** The slice of node-pty this session uses; tests substitute a fake. */
export interface PtyHandle {
  pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtySpawn = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; name: string },
) => PtyHandle;

// The xterm packages ship CommonJS bundles without ESM named exports; load them the
// CommonJS way (also what the standalone build does).
const require = createRequire(import.meta.url);
const xterm = require('@xterm/headless') as { Terminal: typeof Terminal };
const serialize = require('@xterm/addon-serialize') as { SerializeAddon: typeof SerializeAddon };

/** Loads `@lydell/node-pty` on first use, so a missing binary only breaks voice sessions. */
export function loadPtySpawn(): PtySpawn {
  const pty = require('@lydell/node-pty') as {
    spawn: (
      file: string,
      args: string[],
      options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; name: string },
    ) => {
      pid: number;
      onData: (cb: (data: string) => void) => unknown;
      onExit: (cb: (e: { exitCode: number }) => void) => unknown;
      write: (data: string) => void;
      resize: (cols: number, rows: number) => void;
      kill: () => void;
    };
  };
  return (file, args, options) => {
    const handle = pty.spawn(file, args, options);
    return {
      pid: handle.pid,
      onData: (cb) => void handle.onData(cb),
      onExit: (cb) => void handle.onExit(cb),
      write: (data) => handle.write(data),
      resize: (cols, rows) => handle.resize(cols, rows),
      kill: () => handle.kill(),
    };
  };
}

/**
 * The shell command Claude Code runs as the PreToolUse hook: this very program, in
 * whatever form it is running (standalone binary, installed package, or sources).
 */
export function hookCommandLine(): string {
  const q = (s: string) => `"${s}"`;
  if (isStandalone()) return `${q(process.execPath)} hook pre-tool-use`;
  const script = process.argv[1] ?? '';
  if (/\.[cm]?ts$/.test(script)) {
    return `${q(process.execPath)} --import tsx ${q(script)} hook pre-tool-use`;
  }
  return `${q(process.execPath)} ${q(script)} hook pre-tool-use`;
}

export interface VoiceSessionOptions {
  id: string;
  project: ProjectConfig;
  resume?: string;
  config: AgentConfig['claude'];
  broker: ApprovalBroker;
  logger: Logger;
  /** Where the hook subcommand reports tool calls. */
  hook: { url: string; token: string; command: string };
  /** Injection points for tests. */
  spawn?: PtySpawn;
  claudePath?: string;
  claudeDir?: string;
}

/**
 * An interactive Claude Code session the agent hosts in a pseudo-terminal, so the phone
 * can use Claude Code's own dictation: the phone's audio reaches the PC's virtual
 * microphone (see `voice/`), and this session presses the dictation key for it (tap
 * mode: one Space starts recording, another stops and sends). The conversation is read
 * from Claude Code's transcript file, like a terminal session's, and tool calls are
 * approved on the phone through a PreToolUse hook that calls back into the agent.
 * The raw terminal is streamed too, for whatever only the CLI can show or ask.
 */
export class VoiceSession extends EventEmitter<{
  event: [record: SessionEventRecord];
  delta: [record: SessionEventRecord];
  state: [summary: SessionSummary];
  terminal: [data: string];
  exit: [code: number];
}> {
  readonly id: string;
  readonly project: ProjectConfig;
  readonly createdAt = Date.now();
  readonly kind = 'voice' as const;
  private state: SessionState = 'starting';
  private readonly claudeSessionId: string;
  private title: string | undefined;
  private readonly history: SessionEventRecord[] = [];
  private seq = 0;
  private pty: PtyHandle | undefined;
  private readonly term: Terminal;
  private readonly serializer = new serialize.SerializeAddon();
  private voice: VoiceState = 'off';
  private voiceDetail: string | undefined;
  private errorTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private scanTimer: NodeJS.Timeout | undefined;
  private tail: TranscriptTail | undefined;
  private readonly screenWaiters: Array<{
    pred: (s: VoiceScreen) => boolean;
    resolve: () => void;
  }> = [];
  private lastScreen: VoiceScreen = { recording: false, enabled: false };
  private lastSpeaker: string | undefined;
  private lastTyped: { text: string; deviceName: string } | undefined;
  private pendingRelease = false;
  private exitCode: number | undefined;
  private closing = false;

  constructor(private readonly opts: VoiceSessionOptions) {
    super();
    this.id = opts.id;
    this.project = opts.project;
    this.claudeSessionId = opts.resume ?? randomUUID();
    this.term = new xterm.Terminal({
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      allowProposedApi: true,
      scrollback: 2_000,
    });
    this.term.loadAddon(this.serializer);
  }

  start(): void {
    const { config, opts } = this;
    const claude = opts.claudePath ?? interactiveClaudePath();
    if (!claude) {
      this.fail('Claude Code is not installed on the PC (no `claude` executable found).');
      return;
    }
    const settings = {
      voice: { enabled: true, mode: 'tap' },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: opts.hook.command,
                timeout: Math.ceil(config.approvalTimeoutMs / 1000) + 30,
              },
            ],
          },
        ],
      },
    };
    const args = [
      ...(opts.resume ? ['--resume', opts.resume] : ['--session-id', this.claudeSessionId]),
      '--permission-mode',
      config.permissionMode,
      // Structured questions need the terminal; Claude asks in plain text instead.
      '--disallowedTools',
      'AskUserQuestion',
      '--settings',
      JSON.stringify(settings),
      ...(config.model ? ['--model', config.model] : []),
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      VOICECODE_HOOK_URL: opts.hook.url,
      VOICECODE_HOOK_TOKEN: opts.hook.token,
    };
    try {
      const spawn = opts.spawn ?? loadPtySpawn();
      this.pty = spawn(claude, args, {
        cwd: this.project.path,
        env,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        name: 'xterm-256color',
      });
    } catch (err) {
      this.fail(`Could not start Claude Code in a terminal: ${(err as Error).message}`);
      return;
    }
    opts.logger.info(
      { session: this.id, pid: this.pty.pid, claude, resume: opts.resume },
      'claude code started in a pty',
    );
    this.pty.onData((data) => {
      this.term.write(data);
      this.emit('terminal', data);
      this.scheduleScan();
    });
    this.pty.onExit(({ exitCode }) => this.handleExit(exitCode));
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    this.pollTimer.unref();
    void this.poll();
  }

  private get config(): AgentConfig['claude'] {
    return this.opts.config;
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      projectId: this.project.id,
      state: this.state,
      claudeSessionId: this.claudeSessionId,
      createdAt: this.createdAt,
      title: this.title,
      kind: 'voice',
      voice: { state: this.voice, detail: this.voiceDetail },
    };
  }

  events(): SessionEventRecord[] {
    return [...this.history];
  }

  get isClosed(): boolean {
    return this.state === 'closed' || this.state === 'error';
  }

  /** The current screen of the terminal, for a client that just opened the terminal view. */
  snapshot(): { data: string; cols: number; rows: number } {
    return { data: this.serializer.serialize(), cols: this.term.cols, rows: this.term.rows };
  }

  resize(cols: number, rows: number): void {
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
    this.pty?.resize(cols, rows);
  }

  /** Raw keystrokes from the phone's terminal view. */
  writeInput(data: string): void {
    this.pty?.write(data);
  }

  /** Typed text: pasted into the prompt (so newlines don't submit early), then Enter. */
  sendPrompt(text: string, deviceName: string): void {
    if (this.isClosed || !this.pty) throw new Error('session is closed');
    this.title ??= text.slice(0, 80);
    this.lastTyped = { text, deviceName };
    this.pty.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => this.pty?.write('\r'), 50);
  }

  async interrupt(): Promise<void> {
    this.pty?.write('\x1b');
  }

  /**
   * Push-to-talk from the phone. Press taps the dictation key and waits for Claude Code
   * to show it is recording; release waits for the phone's last audio to be played, then
   * taps again, which makes Claude Code finalize the transcript and send it.
   */
  async pressPtt(pressed: boolean, deviceName: string): Promise<void> {
    if (this.isClosed || !this.pty) return;
    if (pressed) {
      if (this.voice === 'starting' || this.voice === 'recording' || this.voice === 'finalizing') {
        return;
      }
      this.lastSpeaker = deviceName;
      this.pendingRelease = false;
      this.setVoice('starting');
      this.pty.write(' ');
      await this.waitForScreen(
        (s) => s.recording || s.error !== undefined,
        RECORD_START_TIMEOUT_MS,
      );
      const screen = this.lastScreen;
      if (this.isClosed) return;
      if (screen.error) return this.setVoice('error', screen.error);
      if (!screen.recording) {
        return this.setVoice(
          'error',
          'Claude Code did not start recording: the prompt on the PC may not be empty, or dictation is off there (/voice tap). Open the terminal to check.',
        );
      }
      this.setVoice('recording');
      if (this.pendingRelease) {
        this.pendingRelease = false;
        void this.pressPtt(false, deviceName);
      }
      return;
    }
    if (this.voice === 'starting') {
      // Released before recording began: finish the start, then stop.
      this.pendingRelease = true;
      return;
    }
    if (this.voice !== 'recording') return;
    this.setVoice('finalizing');
    await sleep(RELEASE_DELAY_MS);
    if (this.isClosed || !this.pty) return;
    this.pty.write(' ');
    await this.waitForScreen((s) => !s.recording || s.error !== undefined, RECORD_STOP_TIMEOUT_MS);
    if (this.isClosed) return;
    const screen = this.lastScreen;
    if (screen.error) this.setVoice('error', screen.error);
    else this.setVoice('idle');
  }

  noteStatus(message: string): void {
    this.record({ kind: 'status', message });
  }

  markRejected(): void {
    // A hook denial carries its reason to Claude; nothing to track here.
  }

  setAwaitingPermission(awaiting: boolean): void {
    if (this.isClosed) return;
    if (awaiting) this.setState('awaiting_permission');
    else if (this.state === 'awaiting_permission') this.setState('running');
  }

  close(): void {
    if (this.isClosed || this.closing) return;
    this.closing = true;
    this.opts.broker.cancelSession(this.id, 'cancelled');
    const pty = this.pty;
    if (!pty) return this.setState('closed');
    pty.write('/exit\r');
    const timer = setTimeout(() => {
      if (this.exitCode === undefined) pty.kill();
    }, 3_000);
    timer.unref();
  }

  private handleExit(exitCode: number): void {
    this.exitCode = exitCode;
    this.pty = undefined;
    clearInterval(this.pollTimer);
    clearTimeout(this.scanTimer);
    this.emit('exit', exitCode);
    this.opts.broker.cancelSession(this.id, 'cancelled');
    if (this.closing) {
      this.setState('closed');
    } else {
      this.opts.logger.warn({ session: this.id, exitCode }, 'claude code exited');
      this.record({ kind: 'error', message: `Claude Code exited (code ${exitCode}).` });
      this.setState(exitCode === 0 ? 'closed' : 'error');
    }
  }

  private fail(message: string): void {
    this.opts.logger.warn({ session: this.id, message }, 'voice session failed to start');
    this.record({ kind: 'error', message });
    this.setState('error');
  }

  // --- Screen ---------------------------------------------------------------

  private scheduleScan(): void {
    if (this.scanTimer) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      this.scan();
    }, 60);
  }

  private screenLines(): string[] {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.term.rows; i++) {
      lines.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '');
    }
    return lines;
  }

  private scan(): void {
    const screen = readVoiceScreen(this.screenLines());
    this.lastScreen = screen;
    if (this.voice === 'off' && screen.enabled) this.setVoice('idle');
    if (this.state === 'starting' && screen.enabled) this.setState('idle');
    for (const w of this.screenWaiters.splice(0)) {
      if (w.pred(screen)) w.resolve();
      else this.screenWaiters.push(w);
    }
  }

  private waitForScreen(pred: (s: VoiceScreen) => boolean, timeoutMs: number): Promise<void> {
    this.scan();
    if (pred(this.lastScreen)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { pred, resolve };
      this.screenWaiters.push(waiter);
      setTimeout(() => {
        const i = this.screenWaiters.indexOf(waiter);
        if (i >= 0) {
          this.screenWaiters.splice(i, 1);
          resolve();
        }
      }, timeoutMs).unref();
    });
  }

  // --- Transcript and status --------------------------------------------------

  private poll(): Promise<void> {
    this.polling ??= this.pollOnce()
      .catch((err: unknown) => this.opts.logger.debug({ err }, 'voice session poll failed'))
      .finally(() => (this.polling = undefined));
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const pid = this.pty?.pid;
    if (!pid || this.isClosed) return;
    const dir = this.opts.claudeDir ?? claudeConfigDir();
    const registry = await readFile(path.join(dir, 'sessions', `${pid}.json`), 'utf8')
      .then((text) => JSON.parse(text) as { status?: string; name?: string })
      .catch(() => undefined);
    if (registry) {
      if (this.state === 'starting') this.setState('idle');
      const status = mapStatus(registry.status);
      if (this.state !== 'awaiting_permission') {
        if (status === 'working') this.setState('running');
        else if (status === 'idle' && this.state === 'running') this.setState('idle');
      }
    }
    this.tail ??= await findTranscript(dir, this.project.path, this.claudeSessionId).then((f) =>
      f ? new TranscriptTail(f) : undefined,
    );
    if (!this.tail) return;
    const result = await this.tail.read();
    if (result.reset) this.history.length = 0;
    for (const item of result.items) {
      let event: ClaudeEvent = item.event;
      if (event.kind === 'user_prompt') {
        const typed = this.lastTyped?.text === event.text ? this.lastTyped.deviceName : undefined;
        event = { ...event, deviceName: typed ?? this.lastSpeaker ?? 'voice' };
        this.title ??= event.text.slice(0, 80);
      }
      this.record(event, item.at);
    }
  }

  // --- State ------------------------------------------------------------------

  private record(event: ClaudeEvent, at = Date.now()): void {
    const record = { seq: ++this.seq, at, event };
    this.history.push(record);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.emit('event', record);
  }

  private setVoice(state: VoiceState, detail?: string): void {
    clearTimeout(this.errorTimer);
    this.voice = state;
    this.voiceDetail = detail;
    if (state === 'error') {
      this.opts.logger.warn({ session: this.id, detail }, 'dictation problem');
      this.errorTimer = setTimeout(() => {
        if (this.voice === 'error') this.setVoice('idle');
      }, ERROR_SHOWN_MS);
      this.errorTimer.unref();
    }
    this.emitState();
  }

  private setState(state: SessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emitState();
  }

  private emitState(): void {
    this.emit('state', this.summary());
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
