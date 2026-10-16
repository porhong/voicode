import { EventEmitter } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import {
  UNSAFE_PERMISSION_MODES,
  type ClaudeEvent,
  type ModelChoice,
  type PermissionModeName,
  type SessionState,
  type SessionSummary,
} from '@voicecode/protocol';
import type { AgentConfig, ProjectConfig } from '../config/config.js';
import type { ApprovalBroker } from '../claude/approval-broker.js';
import type { SessionEventRecord } from '../claude/claude-session.js';
import type { HookDecision } from '../claude/hook-server.js';
import { withoutImageMentions } from '../claude/pty-session.js';
import { claudeConfigDir, isAlive } from '../sessions/pc-sessions.js';
import { findTranscript, TranscriptTail } from '../sessions/transcript-tail.js';
import type { Logger } from '../util/logger.js';
import type { DesktopDriver, DesktopState } from './desktop-helper.js';

const HISTORY_LIMIT = 500;
const POLL_MS = 1_000;
/** The transcript is read whole once, for a title older than the tail's first read. */
const MAX_TITLE_SCAN_BYTES = 64 * 1024 * 1024;

/** Claude Desktop's names for the permission modes, as its mode menu shows them. */
const MODE_LABELS: Record<PermissionModeName, string> = {
  default: 'Manual',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
};
const UNSAFE = new Set<string>(UNSAFE_PERMISSION_MODES);

export function modeFromLabel(label: string | undefined): PermissionModeName | undefined {
  return (Object.entries(MODE_LABELS) as Array<[PermissionModeName, string]>).find(
    ([, l]) => l === label,
  )?.[0];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The latest `custom-title` / `ai-title` in a transcript: what Desktop's sidebar shows. */
export async function readTranscriptTitle(file: string): Promise<string | undefined> {
  const size = await stat(file).then(
    (s) => s.size,
    () => 0,
  );
  if (!size || size > MAX_TITLE_SCAN_BYTES) return undefined;
  const text = await readFile(file, 'utf8');
  let title: string | undefined;
  let aiTitle: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.includes('-title"')) continue;
    try {
      const e = JSON.parse(line) as { type?: string; customTitle?: unknown; aiTitle?: unknown };
      if (e.type === 'custom-title' && typeof e.customTitle === 'string') title = e.customTitle;
      if (e.type === 'ai-title' && typeof e.aiTitle === 'string') aiTitle = e.aiTitle;
    } catch {
      // Skip a malformed line.
    }
  }
  return (title ?? aiTitle)?.slice(0, 200);
}

export interface DesktopSessionOptions {
  id: string;
  project: ProjectConfig;
  config: AgentConfig['claude'];
  broker: ApprovalBroker;
  logger: Logger;
  driver: DesktopDriver;
  /** The Claude Code process Claude Desktop runs for this session. */
  pc: { pid: number; claudeSessionId: string };
  claudeDir?: string;
  pollMs?: number;
}

/** A permission request from the hook, shown on the phone until someone answers it. */
interface HookAsk {
  toolName: string;
  /** The tool call it is about, once the transcript has it: its result ends the ask. */
  toolUseId?: string;
  /** Where the transcript's answered calls stood when the hook asked. */
  mark: number;
  abort: AbortController;
}

/**
 * A Claude Code session of the Claude Desktop app, controlled from the phone. Desktop
 * runs Claude Code as a child process (registered in `~/.claude/sessions` with
 * `entrypoint: "claude-desktop"`) and shows it in its Code tab.
 *
 * - The conversation is followed through the transcript, like a terminal session's.
 * - Permission requests reach the phone through Claude Code's `PermissionRequest` hook
 *   (`voicecode-agent desktop enable`), with the complete tool input; the phone's answer
 *   is the hook's decision, so approvals don't depend on Desktop's window. An answer
 *   given on the PC first wins, and the phone's request is then withdrawn.
 * - Prompts, Stop, the mode and the model go through Desktop's window with UI Automation
 *   (`voicecode-desktop.ps1`), which brings the window up first.
 *
 * Desktop shows one session at a time and names sessions by their title, so the agent
 * opens this session (by title) before acting on it.
 */
export class DesktopSession extends EventEmitter<{
  event: [record: SessionEventRecord];
  delta: [record: SessionEventRecord];
  state: [summary: SessionSummary];
}> {
  readonly id: string;
  readonly project: ProjectConfig;
  readonly createdAt = Date.now();
  readonly kind = 'desktop' as const;
  private state: SessionState = 'starting';
  /** The title Desktop shows, which is how its sidebar and window name the session. */
  private desktopTitle: string | undefined;
  /** A name given on the phone; Desktop's own title stays as it is. */
  private phoneTitle: string | undefined;
  private model: string | undefined;
  private permissionMode: PermissionModeName | undefined;
  private readonly history: SessionEventRecord[] = [];
  private seq = 0;
  private tail: TranscriptTail | undefined;
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private readonly asks = new Set<HookAsk>();
  private lastTyped: { text: string; deviceName: string } | undefined;
  private windowMissing = false;
  /** Whether Claude's turn is running, by the transcript (true while one has started). */
  private turnRunning = false;

  constructor(private readonly opts: DesktopSessionOptions) {
    super();
    this.id = opts.id;
    this.project = opts.project;
  }

  /** Finds the session's title and opens it in Claude Desktop. */
  async start(): Promise<void> {
    const dir = this.opts.claudeDir ?? claudeConfigDir();
    const file = await findTranscript(dir, this.project.path, this.opts.pc.claudeSessionId);
    if (!file)
      throw new Error('Claude Desktop has not saved this session yet; send it a prompt first.');
    this.desktopTitle = await readTranscriptTitle(file);
    if (!this.desktopTitle) {
      throw new Error('Claude Desktop has not named this session yet; try again in a moment.');
    }
    await this.opts.driver.open(this.desktopTitle);
    this.tail = new TranscriptTail(file);
    await this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? POLL_MS);
    this.timer.unref();
    this.opts.logger.info(
      { session: this.id, pid: this.opts.pc.pid, title: this.desktopTitle },
      'took control of a Claude Desktop session',
    );
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      projectId: this.project.id,
      state: this.state,
      claudeSessionId: this.opts.pc.claudeSessionId,
      createdAt: this.createdAt,
      title: this.phoneTitle ?? this.desktopTitle,
      kind: 'desktop',
      attached: true,
      model: this.model,
      permissionMode: this.permissionMode,
      modes: this.modes(),
    };
  }

  events(): SessionEventRecord[] {
    return [...this.history];
  }

  get isClosed(): boolean {
    return this.state === 'closed' || this.state === 'error';
  }

  get currentMode(): PermissionModeName | undefined {
    return this.permissionMode;
  }

  /** The modes Desktop's mode menu offers that the phone may pick. */
  modes(): PermissionModeName[] {
    const safe: PermissionModeName[] = ['default', 'acceptEdits', 'plan'];
    return this.opts.config.allowUnsafeModes ? [...safe, 'auto', 'bypassPermissions'] : safe;
  }

  touch(): void {
    this.emitState();
  }

  /**
   * A permission request Claude Code is about to show in Desktop (from the hook): asked
   * on the phone with the complete tool input. `undefined` (no decision) when the
   * request is answered on the PC first or the phone lets go of the session.
   */
  async askPermission(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<HookDecision | undefined> {
    if (this.isClosed) return undefined;
    // Claude Code writes the call to the transcript before asking: link the two now.
    await this.poll();
    const pending = this.tail?.pendingToolUse();
    const ask: HookAsk = {
      toolName,
      toolUseId: pending?.name === toolName ? pending.id : undefined,
      mark: this.tail?.answeredMark() ?? 0,
      abort: new AbortController(),
    };
    this.asks.add(ask);
    try {
      const answer = await this.opts.broker.ask(this.id, toolName, input, {
        signal: ask.abort.signal,
      });
      if (ask.abort.signal.aborted) return undefined;
      if (answer.decision === 'allow') return { decision: 'allow' };
      // A bare rejection stops Claude; one with feedback lets it adjust, as on the SDK path.
      return answer.feedback
        ? { decision: 'deny', reason: answer.feedback }
        : { decision: 'deny', reason: answer.reason, interrupt: true };
    } finally {
      this.asks.delete(ask);
    }
  }

  /**
   * A prompt from the phone, typed into Desktop's prompt box. Images are named by path
   * (Claude reads them with its own tools, which may ask for approval like any read).
   */
  async sendPrompt(text: string, deviceName: string, imagePaths: string[] = []): Promise<void> {
    const title = this.requireTitle();
    await this.enforceSafeMode();
    const files = imagePaths.map((p) => `Attached image: ${p}`).join('\n');
    const full = [text || (imagePaths.length ? 'Look at the attached image.' : ''), files]
      .filter(Boolean)
      .join('\n\n');
    this.lastTyped = { text: full, deviceName };
    await this.opts.driver.prompt(title, full);
    this.setState('running');
  }

  async interrupt(): Promise<void> {
    await this.opts.driver.stop(this.requireTitle());
  }

  async setMode(mode: PermissionModeName): Promise<void> {
    if (!this.modes().includes(mode)) {
      throw new Error(
        'Modes that skip approvals are off on this PC (voicecode-agent modes allow-unsafe).',
      );
    }
    const label = await this.opts.driver.mode(this.requireTitle(), MODE_LABELS[mode]);
    this.permissionMode = modeFromLabel(label) ?? mode;
    this.record({ kind: 'status', message: `Permission mode: ${label}.` });
    this.emitState();
  }

  async setModel(model: string | null): Promise<void> {
    if (!model) throw new Error('Pick one of the models Claude Desktop offers.');
    this.model = await this.opts.driver.model(this.requireTitle(), model);
    this.record({ kind: 'status', message: `Model switched to ${this.model} in Claude Desktop.` });
    this.emitState();
  }

  /** What Desktop's model menu offers (its names are what `setModel` takes). */
  async models(): Promise<ModelChoice[]> {
    const names = await this.opts.driver.models(this.requireTitle());
    if (this.model && !names.includes(this.model)) names.push(this.model);
    return names.map((name) => ({ value: name, label: name }));
  }

  rename(title: string): void {
    this.phoneTitle = title;
    this.emitState();
  }

  noteStatus(message: string): void {
    this.record({ kind: 'status', message });
  }

  markRejected(): void {
    // The hook's denial (with `interrupt`) stops the turn; nothing to track here.
  }

  setAwaitingPermission(awaiting: boolean): void {
    if (this.isClosed) return;
    if (awaiting) this.setState('awaiting_permission');
    else if (this.state === 'awaiting_permission') this.setState('running');
  }

  /** Lets go of the session; it carries on in Claude Desktop, whose dialogs decide again. */
  close(): void {
    if (this.isClosed) return;
    clearInterval(this.timer);
    for (const ask of this.asks) ask.abort.abort();
    this.opts.broker.cancelSession(this.id, 'cancelled');
    this.setState('closed');
  }

  // --- Following Desktop ------------------------------------------------------

  private requireTitle(): string {
    if (this.isClosed) throw new Error('This session is closed');
    if (!this.desktopTitle) throw new Error('Claude Desktop has not named this session yet');
    return this.desktopTitle;
  }

  private poll(): Promise<void> {
    this.polling ??= this.pollOnce()
      .catch((err: unknown) => this.opts.logger.debug({ err }, 'desktop session poll failed'))
      .finally(() => (this.polling = undefined));
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    if (this.isClosed) return;
    if (!isAlive(this.opts.pc.pid)) {
      this.record({ kind: 'status', message: 'The Claude Desktop session ended.' });
      this.close();
      return;
    }
    await this.readTranscript();
    this.settleAnsweredAsks();
    if (!this.desktopTitle) return;
    const screen = await this.opts.driver.state(this.desktopTitle);
    this.follow(screen);
  }

  /**
   * A request answered on the PC shows in the transcript as the tool call's result (or
   * the call's end); the phone's request for it is withdrawn then.
   */
  private settleAnsweredAsks(): void {
    const tail = this.tail;
    if (!tail) return;
    const pending = tail.pendingToolUse();
    for (const ask of this.asks) {
      if (ask.toolUseId) {
        if (!tail.isPending(ask.toolUseId)) ask.abort.abort();
      } else if (tail.answeredSince(ask.mark, ask.toolName)) {
        // Its call came and got its answer between two reads.
        ask.abort.abort();
      } else if (pending?.name === ask.toolName) {
        ask.toolUseId = pending.id;
      }
    }
  }

  private async readTranscript(): Promise<void> {
    if (!this.tail) return;
    const result = await this.tail.read();
    if (result.reset) this.history.length = 0;
    if (result.turn) this.turnRunning = result.turn === 'started';
    if (result.title && result.title !== this.desktopTitle) {
      // Renamed in Desktop: the sidebar and window now go by the new title.
      this.desktopTitle = result.title;
      this.emitState();
    }
    for (const item of result.items) {
      let event: ClaudeEvent = item.event;
      if (event.kind === 'user_prompt') {
        const prompt = withoutImageMentions(event.text);
        const typed =
          this.lastTyped &&
          norm(withoutImageMentions(this.lastTyped.text).text) === norm(prompt.text)
            ? this.lastTyped.deviceName
            : undefined;
        if (prompt.images) event = { ...event, text: prompt.text, images: prompt.images };
        event = { ...event, deviceName: typed ?? 'Claude Desktop' };
      }
      this.record(event, item.at);
    }
  }

  /** Mirrors what Desktop shows: working, waiting on a request, idle; mode and model. */
  private follow(screen: DesktopState): void {
    if (!screen.window) {
      if (!this.windowMissing) {
        this.windowMissing = true;
        this.record({
          kind: 'status',
          message: 'Claude Desktop is closed or in the tray; open it on the PC to send prompts.',
        });
      }
      return;
    }
    this.windowMissing = false;
    if (screen.minimized) {
      // The window's picture is stale while minimized: go by the transcript.
      if (this.asks.size === 0) this.setState(this.turnRunning ? 'running' : 'idle');
      return;
    }
    const pane = screen.shown ? screen.pane : undefined;
    if (!pane) {
      // Another session is on screen: the sidebar still says whether this one works.
      if (screen.rowStatus && this.asks.size === 0) {
        this.setState(/^idle\b/i.test(screen.rowStatus) ? 'idle' : 'running');
      }
      return;
    }
    const mode = modeFromLabel(pane.mode);
    if (mode && mode !== this.permissionMode) {
      this.permissionMode = mode;
      this.emitState();
      void this.enforceSafeMode().catch((err: unknown) =>
        this.record({ kind: 'error', message: (err as Error).message }),
      );
    }
    if (pane.model && pane.model !== this.model) {
      this.model = pane.model;
      this.emitState();
    }
    // A phone approval in progress decides the state; otherwise the window does.
    if (this.asks.size > 0) return;
    if (pane.permission) this.setState('awaiting_permission');
    else if (pane.busy) this.setState('running');
    else this.setState('idle');
  }

  /**
   * With unsafe modes off on this PC, a session the phone drives never skips approvals:
   * if Desktop is in such a mode it is put back to Manual, as `modes safe-only` does.
   */
  private async enforceSafeMode(): Promise<void> {
    const mode = this.permissionMode;
    if (!mode || !UNSAFE.has(mode) || this.opts.config.allowUnsafeModes || !this.desktopTitle) {
      return;
    }
    try {
      await this.opts.driver.mode(this.desktopTitle, MODE_LABELS.default);
      this.permissionMode = 'default';
      this.record({
        kind: 'status',
        message: `Claude Desktop was in ${MODE_LABELS[mode]}; switched to Manual, since modes that skip approvals are off on this PC.`,
      });
      this.emitState();
    } catch (err) {
      throw new Error(
        `Claude Desktop is in ${MODE_LABELS[mode]} and could not be switched to Manual: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  private record(event: ClaudeEvent, at = Date.now()): void {
    const record = { seq: ++this.seq, at, event };
    this.history.push(record);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.emit('event', record);
  }

  private setState(state: SessionState): void {
    if (this.state === state || this.isClosed) return;
    this.state = state;
    this.emitState();
  }

  private emitState(): void {
    this.emit('state', this.summary());
  }
}
