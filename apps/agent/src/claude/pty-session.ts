import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { SerializeAddon } from '@xterm/addon-serialize/lib/addon-serialize.mjs';
import { Terminal } from '@xterm/headless/lib-headless/xterm-headless.mjs';
import type {
  ClaudeEvent,
  EffortLevel,
  PermissionModeName,
  ModelChoice,
  SessionState,
  SessionSummary,
  VoiceState,
} from '@voicecode/protocol';
import type { AgentConfig, ProjectConfig } from '../config/config.js';
import { claudeConfigDir, isAlive, mapStatus } from '../sessions/pc-sessions.js';
import { findTranscript, TranscriptTail } from '../sessions/transcript-tail.js';
import type { Logger } from '../util/logger.js';
import type { MicGate } from '../voice/mic-router.js';
import { isStandalone } from '../util/standalone.js';
import { packageRoot } from '../util/version.js';
import type { ApprovalBroker } from './approval-broker.js';
import { interactiveClaudePath } from './claude-binary.js';
import { isDefaultModel, MODEL_ALIASES } from './models.js';
import type { SessionEventRecord } from './claude-session.js';
import {
  readMenu,
  readPermissionMode,
  readVoiceScreen,
  type ScreenMenu,
  type VoiceScreen,
} from './voice-screen.js';

const HISTORY_LIMIT = 500;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
/** Claude Code must show `REC` within this long of the Space tap, else the tap did not take. */
const RECORD_START_TIMEOUT_MS = 2_500;
/**
 * After the phone's audio has been handed to the cable, Claude Code still needs this long
 * to hear the end of it (device buffers, its own streaming).
 */
const RELEASE_DELAY_MS = 600;
/** Longest wait on release for the phone's audio to arrive and play out. */
const PLAYOUT_TIMEOUT_MS = 10_000;
const RECORD_STOP_TIMEOUT_MS = 6_000;
/**
 * After a recording with images typed in, the prompt must stay unchanged this long
 * (transcription done, not sent by Claude Code) before the agent sends it itself.
 */
const SETTLE_MS = 2_000;
const SETTLE_TIMEOUT_MS = 12_000;
/** Hold mode: Space is repeated this often while the phone holds, like key-repeat. */
const HOLD_REPEAT_MS = 30;
/** How long Claude Code may take to turn pasted image paths into attachments. */
const IMAGE_ATTACH_TIMEOUT_MS = 2_000;
/** A menu is answered only once it has been on screen this long (see answerQuestion). */
const MENU_SETTLE_MS = 600;
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
  /** Attached consoles report their own size; a pty takes ours. */
  onSize?(listener: (cols: number, rows: number) => void): void;
}

export type PtySpawn = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; name: string },
) => PtyHandle;

/**
 * Loads node-pty on first use, so a missing binary only breaks voice sessions. The npm
 * package has it as a dependency; the standalone executable carries the platform
 * package in its embedded assets (`node-pty/`, see build-sea.mjs) and loads it from the
 * extracted runtime directory.
 */
export function loadPtySpawn(): PtySpawn {
  const require = createRequire(import.meta.url);
  const entry = isStandalone()
    ? path.join(packageRoot(), 'node-pty', 'lib', 'index.js')
    : '@lydell/node-pty';
  const pty = require(entry) as {
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
      // On Windows the pid arrives once the ConPTY connection is up; read it live.
      get pid() {
        return handle.pid;
      },
      onData: (cb) => void handle.onData(cb),
      onExit: (cb) => void handle.onExit(cb),
      write: (data) => handle.write(data),
      resize: (cols, rows) => handle.resize(cols, rows),
      kill: () => handle.kill(),
    };
  };
}

/**
 * The shell command Claude Code runs as a hook: this very program, in whatever form it
 * is running (standalone binary, installed package, or sources), with `hook <event>`.
 */
export function hookCommandLine(
  event: 'pre-tool-use' | 'permission-request' = 'pre-tool-use',
): string {
  const q = (s: string) => `"${s}"`;
  if (isStandalone()) return `${q(process.execPath)} hook ${event}`;
  const script = process.argv[1] ?? '';
  if (/\.[cm]?ts$/.test(script)) {
    return `${q(process.execPath)} --import tsx ${q(script)} hook ${event}`;
  }
  return `${q(process.execPath)} ${q(script)} hook ${event}`;
}

export interface VoiceSessionOptions {
  id: string;
  project: ProjectConfig;
  resume?: string;
  config: AgentConfig['claude'];
  broker: ApprovalBroker;
  logger: Logger;
  /** Where the hook subcommand reports tool calls (hosted sessions only). */
  hook?: { url: string; token: string; command: string };
  /**
   * Take over a Claude Code the user started in a terminal instead of spawning one:
   * keys and screen go through `handle` (the console helper on Windows).
   */
  attach?: {
    pid: number;
    claudeSessionId: string;
    handle: PtyHandle;
    /** The terminal session's name as the PC list showed it, so the phone can tell it apart. */
    title?: string;
  };
  /** Model chosen on the phone for a new hosted session. */
  model?: string;
  /** The phone's microphone, held back until Claude Code records (see `MicGate`). */
  mic?: MicGate;
  /** Folders Claude Code may read without asking (`--add-dir`), e.g. phone images. */
  readDirs?: string[];
  /** Reasoning effort for a new hosted session (`--effort`). */
  effort?: EffortLevel;
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
  private model: string | undefined;
  private effort: EffortLevel | undefined;
  private permissionMode: PermissionModeName | undefined;
  private bypassCapable = false;
  /** Where the title came from: Claude Code's own name wins unless the user renamed here. */
  private titleSource: 'prompt' | 'registry' | 'user' | undefined;
  private readonly history: SessionEventRecord[] = [];
  private seq = 0;
  private pty: PtyHandle | undefined;
  private readonly term: Terminal;
  private readonly serializer = new SerializeAddon();
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
  /** The registry (not the broker) put the session into `awaiting_permission`. */
  private registryAwaiting = false;
  /** A dialog on the screen (folder safety check, a menu) is what the session waits on. */
  private dialogAwaiting: string | undefined;
  /** The menu Claude Code shows, if any: the phone shows it with a button per option. */
  private menu: ScreenMenu | undefined;
  /** When the menu on screen first appeared. */
  private menuSince = 0;
  /** The last question announced in the transcript, so a repainted one isn't repeated. */
  private announcedDialog: string | undefined;
  private lastTyped: { text: string; deviceName: string } | undefined;
  private pendingRelease = false;
  private exitCode: number | undefined;
  private closing = false;
  /** `/voice tap` was typed (once per session; the command is idempotent anyway). */
  private dictationRequested = false;
  /** The last voice error line seen on screen, so a persistent one is reported once. */
  private screenError: string | undefined;
  /** Hold mode: the timer repeating Space while the phone holds, and how many it typed. */
  private holdTimer: NodeJS.Timeout | undefined;
  private heldSpaces = 0;
  /** Text the agent typed before this recording (image lines), to take back on failure. */
  private typedForRecording = '';
  /** Tap mode: images to send right after the dictated prompt. */
  private followUpImages: string[] = [];
  /** The dictation mode Claude Code runs in for this session (see `dictationMode`). */
  private mode: 'tap' | 'hold' = 'hold';

  constructor(private readonly opts: VoiceSessionOptions) {
    super();
    this.id = opts.id;
    this.project = opts.project;
    this.claudeSessionId = opts.attach?.claudeSessionId ?? opts.resume ?? randomUUID();
    if (opts.attach?.title) {
      this.title = opts.attach.title;
      this.titleSource = 'registry';
    }
    this.term = new Terminal({
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      allowProposedApi: true,
      scrollback: 2_000,
    });
    this.term.loadAddon(this.serializer);
  }

  start(): void {
    const { config, opts } = this;
    if (opts.attach) {
      this.pty = opts.attach.handle;
      this.wire();
      opts.logger.info({ session: this.id, pid: opts.attach.pid }, 'attached to a terminal claude');
      return;
    }
    if (!opts.hook) return this.fail('No hook endpoint for a hosted Claude Code session.');
    const hook = opts.hook;
    const claude = opts.claudePath ?? interactiveClaudePath();
    if (!claude) {
      this.fail('Claude Code is not installed on the PC (no `claude` executable found).');
      return;
    }
    const settings = {
      // Both spellings: `voiceEnabled` is the older key, `voice` the current object.
      voiceEnabled: true,
      // Hold mode: the transcript goes in at the cursor (after images typed first) and
      // waits for Enter, so a dictation is sent as one prompt with whatever it belongs to.
      voice: { enabled: true, mode: 'hold' },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: hook.command,
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
      ...(startModel(opts.model, config.model)
        ? ['--model', startModel(opts.model, config.model)!]
        : []),
      ...(opts.effort ? ['--effort', opts.effort] : []),
      ...(opts.readDirs ?? []).flatMap((dir) => ['--add-dir', dir]),
      // Only puts bypass into the Shift+Tab cycle; the session still starts in the
      // configured mode, and the hook keeps asking the phone unless unsafe modes are on.
      ...(config.allowUnsafeModes ? ['--allow-dangerously-skip-permissions'] : []),
    ];
    this.bypassCapable = config.allowUnsafeModes === true;
    this.permissionMode = config.permissionMode;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      // Claude Code updates itself by renaming its own executable; when that is a copy
      // the agent depends on (the SDK's), the agent loses its Claude Code.
      DISABLE_AUTOUPDATER: '1',
      VOICECODE_HOOK_URL: hook.url,
      VOICECODE_HOOK_TOKEN: hook.token,
    };
    // Markers an enclosing Claude Code leaves in the environment (e.g. when the agent
    // itself was started from one) would make this session a "child" with transcript
    // saving off, and the transcript is how the phone follows the conversation.
    for (const key of Object.keys(env)) {
      if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_CHILD_SESSION')) delete env[key];
    }
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
    this.model = startModel(opts.model, config.model);
    this.effort = opts.effort;
    opts.logger.info(
      { session: this.id, pid: this.pty.pid, claude, resume: opts.resume },
      'claude code started in a pty',
    );
    this.wire();
  }

  private wire(): void {
    const pty = this.pty!;
    pty.onSize?.((cols, rows) => {
      if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
    });
    pty.onData((data) => {
      this.term.write(data);
      this.emit('terminal', data);
      this.scheduleScan();
    });
    pty.onExit(({ exitCode }) => this.handleExit(exitCode));
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    this.pollTimer.unref();
    void this.poll();
  }

  get attached(): boolean {
    return this.opts.attach !== undefined;
  }

  /**
   * Hosted sessions get dictation (hold mode) from their `--settings`, which applies to
   * that session only. `/voice <mode>` is never typed there: Claude Code saves it to the
   * user's settings. A terminal taken over keeps the user's own mode; only when its
   * dictation is off is `/voice` typed, in the mode the user's settings name.
   */
  private ensureDictation(lines: string[]): void {
    if (this.dictationRequested || this.isClosed || !this.pty) return;
    const screen = this.lastScreen;
    if (!this.attached) {
      // Ready once Claude Code's prompt is on screen (not during its trust check, nor
      // while it draws its main screen after it): keys typed earlier would be lost.
      if (screen.dialog || this.menu || !promptIsEmpty(lines)) return;
      this.dictationRequested = true;
      if (this.voice === 'off') this.setVoice('idle');
      return;
    }
    const user = userVoiceSettings(this.opts.claudeDir ?? claudeConfigDir());
    this.mode = user.mode;
    if (user.enabled) {
      this.dictationRequested = true;
      if (this.voice === 'off') this.setVoice('idle');
      return;
    }
    if (screen.enabled || screen.dialog || !promptIsEmpty(lines)) return;
    this.dictationRequested = true;
    this.pty.write(`/voice ${this.mode}\r`);
    this.record({
      kind: 'status',
      message: `Turned on dictation in Claude Code (/voice ${this.mode}).`,
    });
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
      model: this.model,
      effort: this.effort,
      permissionMode: this.permissionMode,
      modes: this.modes(),
      attached: this.attached || undefined,
      voice: { state: this.voice, detail: this.voiceDetail },
      question: this.menu
        ? {
            text: this.menu.question,
            ...(this.menu.detail.length ? { detail: this.menu.detail } : {}),
            options: this.menu.options,
          }
        : undefined,
    };
  }

  /**
   * Picks option `index` of the menu on screen: the cursor is moved there and Enter
   * pressed. Only if that menu still offers `option` there, so an answer meant for one
   * question never lands on the next.
   */
  async answerQuestion(index: number, option: string): Promise<void> {
    if (this.isClosed || !this.pty) throw new Error('This session is closed');
    const menu = readMenu(this.screenLines());
    if (!menu || menu.options[index] !== option) {
      throw new Error('That question is no longer showing in the terminal.');
    }
    // A menu that has only just been drawn may not be reading keys yet, and a half-read
    // arrow (ESC [ B) counts as Esc, which cancels it (the trust check then exits).
    const age = Date.now() - this.menuSince;
    if (age < MENU_SETTLE_MS) await sleep(MENU_SETTLE_MS - age);
    const moves = index - menu.selected;
    for (let i = 0; i < Math.abs(moves); i++) {
      this.pty?.write(moves > 0 ? '\x1b[B' : '\x1b[A');
      await sleep(60);
    }
    await sleep(120);
    this.pty?.write('\r');
    const asked = menu.question;
    await this.waitFor(() => readMenu(this.screenLines())?.question !== asked, 3_000);
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
    // An attached console keeps the user's terminal size; the phone view fits to it.
    if (this.attached) return;
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
    this.pty?.resize(cols, rows);
  }

  /** Raw keystrokes from the phone's terminal view. */
  writeInput(data: string): void {
    this.pty?.write(data);
  }

  /**
   * Typed text: pasted into the prompt (so newlines don't submit early), then Enter.
   * Images are named by their file path, which Claude Code reads itself ("Provide an
   * image path" in its docs); not as `@path`, whose suggestion menu would take the Enter.
   * If the Enter was still taken by a menu (a typed `@` or `/`), it is pressed once more.
   */
  sendPrompt(text: string, deviceName: string, imagePaths: string[] = []): void {
    if (this.isClosed || !this.pty) throw new Error('session is closed');
    const files = imagePaths.map((p) => `Attached image: ${p}`).join('\n');
    const full = [text || (imagePaths.length ? 'Look at the attached image.' : ''), files]
      .filter(Boolean)
      .join('\n\n');
    this.title ??= (text || 'Image').slice(0, 80);
    this.lastTyped = { text: full, deviceName };
    this.pty.write(`\x1b[200~${full}\x1b[201~`);
    setTimeout(() => this.pty?.write('\r'), 50);
    setTimeout(() => {
      if (this.isClosed || !this.pty || this.lastScreen.dialog) return;
      const lines = this.screenLines();
      // Never into a menu that opened meanwhile: Enter would pick its option (a "Yes").
      if (readMenu(lines)) return;
      if (!promptIsEmpty(lines) && this.state !== 'running') this.pty.write('\r');
    }, 900);
  }

  async interrupt(): Promise<void> {
    this.pty?.write('\x1b');
  }

  /** The dictation mode in use: hold for hosted sessions, the user's for a taken-over one. */
  get dictationMode(): 'tap' | 'hold' {
    return this.attached ? this.mode : 'hold';
  }

  /**
   * Push-to-talk from the phone, sent as one prompt on release.
   *
   * Hold mode (hosted sessions): images are typed into the prompt first, then Space is
   * repeated like a held key while the phone holds; Claude Code inserts the transcript
   * after the images and waits, and the agent presses Enter once it has settled.
   *
   * Tap mode (a terminal taken over whose user dictates in tap mode): one tap starts,
   * another stops, and Claude Code sends the transcript itself. It needs an empty prompt
   * to start and drops the transcript if the prompt is edited meanwhile, so images go in
   * a second prompt right after.
   */
  async pressPtt(pressed: boolean, deviceName: string, imagePaths: string[] = []): Promise<void> {
    if (this.isClosed || !this.pty) return;
    const hold = this.dictationMode === 'hold';
    if (pressed) {
      if (this.voice === 'starting' || this.voice === 'recording' || this.voice === 'finalizing') {
        return;
      }
      this.lastSpeaker = deviceName;
      this.pendingRelease = false;
      this.followUpImages = hold ? [] : imagePaths;
      this.typedForRecording = '';
      this.setVoice('starting');
      // What is said before Claude Code records would be lost; it waits in the agent.
      this.opts.mic?.hold();
      if (hold) {
        if (imagePaths.length) {
          this.typedForRecording = `${imagePaths.map((p) => `Attached image: ${p}`).join('\n')}\n`;
          this.pty.write(`\x1b[200~${this.typedForRecording}\x1b[201~`);
          // Claude Code turns a pasted image path into an attachment ("[Image #1]") once
          // it has read the file; holding the key before that cuts the image off.
          const want = imagePaths.length;
          await this.waitFor(
            () =>
              (
                this.screenLines()
                  .join('\n')
                  .match(/\[Image #\d+\]/g) ?? []
              ).length >= want,
            IMAGE_ATTACH_TIMEOUT_MS,
          );
          await sleep(150);
        }
        this.startHolding();
      } else {
        this.pty.write(' ');
      }
      await this.waitForScreen(
        (s) => s.recording || s.error !== undefined,
        RECORD_START_TIMEOUT_MS,
      );
      const screen = this.lastScreen;
      if (this.isClosed) return this.opts.mic?.discard();
      if (!screen.recording) {
        this.opts.mic?.discard();
        this.stopHolding(true);
        if (imagePaths.length) {
          this.record({
            kind: 'status',
            message: `The ${imagePaths.length === 1 ? 'image was' : 'images were'} not sent, since dictation did not start; attach ${imagePaths.length === 1 ? 'it' : 'them'} again.`,
          });
        }
        this.followUpImages = [];
        if (screen.error) return this.setVoice('error', screen.error);
        return this.setVoice(
          'error',
          hold
            ? 'Claude Code did not start recording: dictation may be off there. Open the terminal to check.'
            : 'Claude Code did not start recording: the prompt on the PC may not be empty, or dictation is off there (/voice tap). Open the terminal to check.',
        );
      }
      this.opts.mic?.resume();
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
    // The phone may still be sending (it keeps listening a moment after the release), and
    // held audio plays behind real time: the recording stops only once all of it was heard.
    await this.opts.mic?.played(PLAYOUT_TIMEOUT_MS);
    await sleep(RELEASE_DELAY_MS);
    if (this.isClosed || !this.pty) return this.stopHolding(false);
    if (hold) this.stopHolding(false);
    else this.pty.write(' ');
    await this.waitForScreen((s) => !s.recording || s.error !== undefined, RECORD_STOP_TIMEOUT_MS);
    if (this.isClosed) return;
    const screen = this.lastScreen;
    if (screen.error) this.setVoice('error', screen.error);
    else this.setVoice('idle');
    if (hold) {
      await this.sendWhatStayed();
    } else if (this.followUpImages.length) {
      const images = this.followUpImages;
      this.followUpImages = [];
      await this.waitFor(() => promptIsEmpty(this.screenLines()), SETTLE_TIMEOUT_MS);
      if (!this.isClosed && promptIsEmpty(this.screenLines())) {
        this.sendPrompt('The image for my last message.', deviceName, images);
      }
    }
  }

  /** Hold mode: Space repeated like a held key, for as long as the phone holds. */
  private startHolding(): void {
    this.stopHolding(false);
    this.heldSpaces = 0;
    this.holdTimer = setInterval(() => {
      if (!this.pty) return this.stopHolding(false);
      this.pty.write(' ');
      this.heldSpaces++;
    }, HOLD_REPEAT_MS);
    this.holdTimer.unref();
  }

  /**
   * Lets go of the held key. `undo` (recording never started): the spaces it typed, and
   * what was typed before it (image lines), are taken back out of the prompt.
   */
  private stopHolding(undo: boolean): void {
    clearInterval(this.holdTimer);
    this.holdTimer = undefined;
    if (!undo || !this.pty) return;
    const typed = this.heldSpaces + [...this.typedForRecording].length;
    if (typed) this.pty.write('\x7f'.repeat(typed));
    this.heldSpaces = 0;
    this.typedForRecording = '';
  }

  /**
   * After a hold-mode recording the transcript waits in the prompt (after any images);
   * it is sent once the prompt has stayed the same for a while (Claude Code finalizes
   * the transcript after the key is let go). Not when the prompt is empty (sent already,
   * `autoSubmit` in the user's settings) or a menu has opened.
   */
  private async sendWhatStayed(): Promise<void> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let last = '';
    let since = Date.now();
    while (Date.now() < deadline && !this.isClosed && this.pty) {
      await sleep(250);
      const lines = this.screenLines();
      if (promptIsEmpty(lines) || readMenu(lines) || this.lastScreen.dialog) return;
      if (this.lastScreen.recording) return; // a new recording took over
      const now = lines.join('\n');
      if (now !== last) {
        last = now;
        since = Date.now();
      } else if (Date.now() - since >= SETTLE_MS) {
        this.pty.write('\r');
        return;
      }
    }
  }

  noteStatus(message: string): void {
    this.record({ kind: 'status', message });
  }

  /**
   * Switches the model by typing `/model <name>` into Claude Code, which answers on screen
   * ("Set model to …" or "Model '…' not found"). Claude Code also saves the choice as its
   * default for new sessions on the PC; the phone says so before switching.
   */
  async setModel(model: string | null): Promise<void> {
    if (this.isClosed || !this.pty) throw new Error('This session is closed');
    if (this.state === 'running' || this.state === 'awaiting_permission') {
      throw new Error('Claude is working; switch the model once it has finished.');
    }
    if (this.voice === 'recording' || this.voice === 'starting' || this.voice === 'finalizing') {
      throw new Error('Wait until dictation has finished.');
    }
    if (!promptIsEmpty(this.screenLines())) {
      throw new Error('The prompt in the terminal is not empty; clear it first.');
    }
    const name = isDefaultModel(model) ? 'default' : model!;
    const command = `/model ${name}`;
    this.pty.write(command);
    await sleep(200);
    this.pty?.write('\r');
    const answer = await this.waitForModelAnswer(command);
    if (answer?.error) throw new Error(answer.error);
    this.model = answer?.label ?? name;
    this.record({
      kind: 'status',
      message: answer?.label
        ? `Model switched to ${answer.label}. Claude Code also saved it as its default for new sessions on the PC.`
        : `Asked Claude Code to switch to ${name}.`,
    });
    this.emitState();
  }

  /**
   * The modes reachable with Shift+Tab: the safe ones, auto when the PC allows unsafe
   * modes, and bypass when Claude Code also started with it in the cycle (an agent-hosted
   * session after `modes allow-unsafe`; a taken-over terminal is tried, it may refuse).
   * "Don't ask" can only be chosen when Claude Code starts, so it is not offered here.
   */
  modes(): PermissionModeName[] {
    const safe: PermissionModeName[] = ['default', 'acceptEdits', 'plan'];
    if (!this.opts.config.allowUnsafeModes) return safe;
    return [
      ...safe,
      'auto',
      ...(this.bypassCapable || this.attached ? (['bypassPermissions'] as const) : []),
    ];
  }

  /** Re-sends the summary (the PC changed which modes are allowed). */
  touch(): void {
    this.emitState();
  }

  get currentMode(): PermissionModeName | undefined {
    return this.permissionMode;
  }

  /**
   * Cycles Claude Code's permission mode with Shift+Tab until the footer shows the one
   * asked for. The cycle has at most five stops, so a mode not reached in six presses is
   * not available in this Claude Code.
   */
  async setMode(mode: PermissionModeName): Promise<void> {
    if (this.isClosed || !this.pty) throw new Error('This session is closed');
    if (!this.modes().includes(mode)) {
      throw new Error(
        mode === 'dontAsk'
          ? "Don't ask can only be chosen when Claude Code starts."
          : 'Modes that skip approvals are off on this PC (voicecode-agent modes allow-unsafe).',
      );
    }
    if (this.lastScreen.dialog)
      throw new Error('Claude Code is asking something; answer it first.');
    this.scan();
    for (let press = 0; press < 6 && this.permissionMode !== mode; press++) {
      const before = this.permissionMode;
      this.pty?.write('\x1b[Z');
      await this.waitFor(() => this.permissionMode !== before, 1_500);
    }
    if (this.permissionMode !== mode) {
      throw new Error(
        mode === 'bypassPermissions'
          ? 'This Claude Code was not started with bypass permissions available (--allow-dangerously-skip-permissions).'
          : `Claude Code did not switch to ${mode}.`,
      );
    }
    this.record({ kind: 'status', message: `Permission mode: ${mode}.` });
    this.emitState();
  }

  private async waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred() && Date.now() < deadline && !this.isClosed) {
      await sleep(100);
      this.scan();
    }
  }

  /** The aliases Claude Code accepts; terminal sessions have no live list. */
  models(): ModelChoice[] {
    return MODEL_ALIASES;
  }

  private async waitForModelAnswer(
    command: string,
  ): Promise<{ label?: string; error?: string } | undefined> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !this.isClosed) {
      await sleep(150);
      const lines = this.screenLines();
      const at = lines.map((l) => l.includes(command)).lastIndexOf(true);
      if (at < 0) continue;
      const after = lines.slice(at + 1, at + 4).join('\n');
      const set = /Set model to (.+?)(?: and saved|$)/m.exec(after);
      if (set) return { label: set[1]!.replace(/\s*\(default\)\s*$/, ' (default)').trim() };
      const missing = /(Model '.*' not found[^\n]*|Invalid model[^\n]*)/i.exec(after);
      if (missing) return { error: missing[1]!.trim() };
    }
    return undefined;
  }

  /** A name chosen on the phone; it then stays even if Claude Code's own name changes. */
  rename(title: string): void {
    this.title = title;
    this.titleSource = 'user';
    this.emitState();
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
    if (this.attached) {
      // Only let go of the console; the user's Claude Code keeps running in its terminal.
      pty.kill();
      this.handleExit(0);
      return;
    }
    pty.write('/exit\r');
    const timer = setTimeout(() => {
      if (this.exitCode === undefined) pty.kill();
    }, 3_000);
    timer.unref();
  }

  private handleExit(exitCode: number): void {
    this.exitCode = exitCode;
    this.stopHolding(false);
    this.pty = undefined;
    clearInterval(this.pollTimer);
    clearTimeout(this.scanTimer);
    this.emit('exit', exitCode);
    this.opts.broker.cancelSession(this.id, 'cancelled');
    if (this.closing) {
      this.setState('closed');
    } else if (this.attached) {
      this.record({ kind: 'status', message: 'The terminal session ended.' });
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
    const lines = this.screenLines();
    const screen = readVoiceScreen(lines);
    this.lastScreen = screen;
    if (this.voice === 'off' && screen.enabled) this.setVoice('idle');
    if (this.state === 'starting' && (screen.enabled || promptIsEmpty(lines)))
      this.setState('idle');
    this.trackMenu(lines);
    this.trackDialog(screen);
    this.trackError(screen);
    const mode = readPermissionMode(lines);
    if (mode && mode !== this.permissionMode && !screen.dialog) {
      this.permissionMode = mode;
      this.emitState();
    }
    // Claude Code's banner names the model ("Haiku 5.5 · Claude Max"); replies refine it.
    if (!this.model) {
      const banner = lines
        .map((l) => /\b((?:Fable|Mythos|Opus|Sonnet|Haiku) \d+(?:\.\d+)?)\b[^\n]*·/.exec(l)?.[1])
        .find(Boolean);
      if (banner) {
        this.model = banner;
        this.emitState();
      }
    }
    if (this.state !== 'starting') this.ensureDictation(lines);
    for (const w of this.screenWaiters.splice(0)) {
      if (w.pred(screen)) w.resolve();
      else this.screenWaiters.push(w);
    }
  }

  /**
   * Questions only the terminal shows (Claude Code's folder safety check comes first on
   * a new project, and its default answer is "No, exit") put the session into
   * `awaiting_permission` so the phone opens the terminal view; they are answered there.
   */
  private trackMenu(lines: string[]): void {
    const menu = readMenu(lines);
    const key = (m: ScreenMenu | undefined) => (m ? JSON.stringify([m.question, m.options]) : '');
    const changed = key(menu) !== key(this.menu);
    this.menu = menu;
    if (changed) {
      this.menuSince = Date.now();
      this.emitState();
    }
  }

  private trackDialog(screen: VoiceScreen): void {
    if (this.isClosed) return;
    const dialog = this.menu?.question ?? screen.dialog;
    if (dialog && this.dialogAwaiting !== dialog) {
      this.dialogAwaiting = dialog;
      // A menu repainted (or reopened) says the same thing; it's announced once.
      if (this.announcedDialog !== dialog) {
        this.announcedDialog = dialog;
        this.record({
          kind: 'status',
          message: this.menu
            ? `Claude Code is asking: "${dialog}" Answer it here.`
            : `Claude Code is asking in the terminal: "${dialog}". Answer it from the terminal view (↓ and Enter pick an option).`,
        });
      }
      this.setState('awaiting_permission');
    } else if (!dialog && this.dialogAwaiting) {
      this.dialogAwaiting = undefined;
      if (this.state === 'awaiting_permission') this.setState('idle');
    }
  }

  /** A voice error line that appears later (after a release, say) still reaches the phone. */
  private trackError(screen: VoiceScreen): void {
    if (screen.error === this.screenError) return;
    this.screenError = screen.error;
    if (!screen.error) return;
    if (this.voice === 'idle' || this.voice === 'finalizing' || this.voice === 'off') {
      this.setVoice('error', screen.error);
    }
    if (/Unknown command: \/voice|requires a Claude\.ai account/i.test(screen.error)) {
      this.record({
        kind: 'status',
        message: `Claude Code dictation is unavailable: ${screen.error}`,
      });
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
      // Claude Code's own session name (`/rename` in the terminal) names it here too.
      if (registry.name && this.titleSource !== 'user' && registry.name !== this.title) {
        this.title = registry.name;
        this.titleSource = 'registry';
        this.emitState();
      }
      const status = mapStatus(registry.status);
      if (status === 'waiting') {
        // A prompt only the terminal shows (hosted: one the hook did not cover).
        this.setState('awaiting_permission');
      } else if (this.dialogAwaiting) {
        // The screen dialog decides until it is gone.
      } else if (this.state === 'awaiting_permission' && this.registryAwaiting) {
        this.setState(status === 'working' ? 'running' : 'idle');
      } else if (this.state !== 'awaiting_permission') {
        if (status === 'working') this.setState('running');
        else if (status === 'idle' && this.state === 'running') this.setState('idle');
      }
      this.registryAwaiting = status === 'waiting';
    } else if (this.attached && !isAlive(pid)) {
      this.pty?.kill();
      this.handleExit(0);
      return;
    }
    this.tail ??= await findTranscript(dir, this.project.path, this.claudeSessionId).then((f) =>
      f ? new TranscriptTail(f) : undefined,
    );
    if (!this.tail) return;
    const result = await this.tail.read();
    if (result.reset) this.history.length = 0;
    if (result.model && result.model !== this.model) {
      this.model = result.model;
      this.emitState();
    }
    for (const item of result.items) {
      let event: ClaudeEvent = item.event;
      if (event.kind === 'user_prompt') {
        const prompt = withoutImageMentions(event.text);
        const typed =
          this.lastTyped && withoutImageMentions(this.lastTyped.text).text === prompt.text
            ? this.lastTyped.deviceName
            : undefined;
        if (prompt.images) event = { ...event, text: prompt.text, images: prompt.images };
        event = { ...event, deviceName: typed ?? this.lastSpeaker ?? 'voice' };
        if (!this.title) {
          this.title = event.text.slice(0, 80);
          this.titleSource = 'prompt';
        }
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

/** The model a new hosted session starts with: the phone's choice, else the config. */
function startModel(
  chosen: string | undefined,
  configured: string | undefined,
): string | undefined {
  if (chosen) return isDefaultModel(chosen) ? undefined : chosen;
  return configured;
}

/**
 * Whether Claude Code's input line shows nothing typed (so a tap starts dictation). The
 * prompt is `❯` (or `>` in older versions); a `Try "…"` suggestion is placeholder text.
 */
/**
 * The prompt as the phone should show it, without the image references `sendPrompt`
 * added. Claude Code turns a pasted image path into an `[Image #N]` token and keeps
 * the rest of the line, so a transcript has "[Image #1]text\nAttached image:".
 */
export function withoutImageMentions(text: string): { text: string; images: number } {
  const tokens = (text.match(/\[Image #\d+\]/g) ?? []).length;
  const withoutTokens = text.replace(/\[Image #\d+\] ?/g, '');
  const paths = (withoutTokens.match(/^Attached image:/gm) ?? []).length;
  return {
    text: withoutTokens
      // A line that only names an image goes; a label with words after it (a dictation
      // landed on the line Claude Code left) loses just the label.
      .replace(/^Attached image:[ \t]*(?:\S+\.(?:png|jpe?g|gif|webp))?[ \t]*$/gim, '')
      .replace(/^Attached image:[ \t]*/gim, '')
      .trim(),
    images: Math.max(paths, tokens),
  };
}

export function promptIsEmpty(lines: string[]): boolean {
  // Earlier prompts stay on screen as `❯ …` history; the input line is the last one.
  const prompt = lines.findLast((l) => /^[\s│|]*[>❯](\s|$)/.test(l));
  if (!prompt) return false;
  return /^[\s│|]*[>❯]\s*(Try\s+".*)?[\s│|]*$/.test(prompt);
}

/**
 * Dictation as the user's Claude Code settings have it (a terminal taken over runs with
 * them). Claude Code's default mode is hold.
 */
export function userVoiceSettings(claudeDir: string): { enabled: boolean; mode: 'tap' | 'hold' } {
  try {
    const settings = JSON.parse(readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')) as {
      voice?: { enabled?: unknown; mode?: unknown };
      voiceEnabled?: unknown;
    };
    return {
      enabled: settings.voice?.enabled === true || settings.voiceEnabled === true,
      mode: settings.voice?.mode === 'tap' ? 'tap' : 'hold',
    };
  } catch {
    return { enabled: false, mode: 'hold' };
  }
}
