import { EventEmitter } from 'node:events';
import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  EFFORT_LEVELS,
  type ClaudeEvent,
  type EffortLevel,
  type PermissionModeName,
  type ModelChoice,
  type SessionState,
  type SessionSummary,
} from '@voicecode/protocol';
import type { AgentConfig, ProjectConfig } from '../config/config.js';
import {
  describeAutoApprovals,
  hasAutoApprovals,
  inspectProjectSettings,
} from '../config/project-settings.js';
import type { Logger } from '../util/logger.js';
import type { ApprovalBroker } from './approval-broker.js';
import { AsyncQueue } from './async-queue.js';
import { claudeExecutablePath } from './claude-executable.js';
import { isDefaultModel, MODEL_ALIASES } from './models.js';
import { summarizeToolResult, summarizeToolUse } from './tool-summary.js';

/** Events kept per session so reconnecting clients can catch up. */
const HISTORY_LIMIT = 500;

/** Modes that would let tools run without an approval reaching the user. */
const UNSAFE_MODES = new Set(['bypassPermissions', 'auto', 'dontAsk']);
const SAFE_MODE_LIST: PermissionModeName[] = ['default', 'acceptEdits', 'plan'];

export interface SessionEventRecord {
  seq: number;
  at: number;
  event: ClaudeEvent;
}

export interface ClaudeSessionOptions {
  id: string;
  project: ProjectConfig;
  resume?: string;
  /** Resume into a new session id, leaving the original transcript untouched. */
  fork?: boolean;
  /** Model chosen on the phone for this session; overrides the configured one. */
  model?: string;
  /** Reasoning effort chosen on the phone; the model's default when absent. */
  effort?: EffortLevel;
  config: AgentConfig['claude'];
  broker: ApprovalBroker;
  logger: Logger;
  /** Injection point for tests. */
  queryFn?: typeof query;
}

/**
 * One live Claude Code session driven through the Agent SDK in streaming-input mode.
 * Prompts are pushed into an async queue that the SDK consumes, so the conversation
 * (and Claude Code's context) persists across voice instructions.
 */
export class ClaudeSession extends EventEmitter<{
  event: [record: SessionEventRecord];
  /** Live-only text deltas; not stored in history. */
  delta: [record: SessionEventRecord];
  state: [summary: SessionSummary];
}> {
  readonly id: string;
  readonly project: ProjectConfig;
  readonly createdAt = Date.now();
  private state: SessionState = 'starting';
  private claudeSessionId: string | undefined;
  private model: string | undefined;
  private effort: EffortLevel | undefined;
  private permissionMode: PermissionModeName | undefined;
  /** Started with `allowDangerouslySkipPermissions`, which bypass mode needs. */
  private bypassCapable = false;
  private title: string | undefined;
  private totalCostUsd: number | undefined;
  private readonly history: SessionEventRecord[] = [];
  private seq = 0;
  private readonly input = new AsyncQueue<SDKUserMessage>();
  private readonly abort = new AbortController();
  private q: Query | undefined;
  /** Why the current turn is expected to end early, if the user stopped it. */
  private stopReason: string | undefined;

  constructor(private readonly opts: ClaudeSessionOptions) {
    super();
    this.id = opts.id;
    this.project = opts.project;
    // A fork gets its own id from the init message.
    this.claudeSessionId = opts.fork ? undefined : opts.resume;
    this.effort = opts.effort;
  }

  start(): void {
    const { config, broker } = this.opts;
    const executable = this.opts.queryFn ? undefined : claudeExecutablePath();
    const options: Options = {
      cwd: this.project.path,
      abortController: this.abort,
      permissionMode: config.permissionMode,
      // Bypass mode can only be entered later when the session starts able to.
      ...(config.allowUnsafeModes ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: broker.forSession(this.id),
      includePartialMessages: true,
      // Load CLAUDE.md and project/user settings, like the interactive CLI does.
      settingSources: ['user', 'project', 'local'],
      // Structured multiple-choice questions need a UI we don't have; Claude asks in
      // plain text instead, which works naturally with voice replies.
      disallowedTools: ['AskUserQuestion'],
      stderr: (data) => this.opts.logger.debug({ session: this.id, data }, 'claude stderr'),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      ...(this.startModel ? { model: this.startModel } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(config.maxBudgetUsd ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
      ...(this.opts.resume ? { resume: this.opts.resume } : {}),
      ...(this.opts.resume && this.opts.fork ? { forkSession: true } : {}),
    };

    this.bypassCapable = config.allowUnsafeModes === true;
    this.permissionMode = config.permissionMode;
    this.q = (this.opts.queryFn ?? query)({ prompt: this.input, options });
    void this.consume(this.q);
    this.setState('idle');
    void this.announceProjectAutoApprovals();
  }

  /** Tells the phone what this project lets run without asking (see project-settings.ts). */
  private async announceProjectAutoApprovals(): Promise<void> {
    const approvals = await inspectProjectSettings(this.project.path);
    if (hasAutoApprovals(approvals)) {
      this.record({ kind: 'status', message: describeAutoApprovals(approvals) });
    }
  }

  private get startModel(): string | undefined {
    const chosen = this.opts.model;
    if (chosen) return isDefaultModel(chosen) ? undefined : chosen;
    return this.opts.config.model;
  }

  /**
   * Switches the model for the following replies (the SDK's `setModel`, this session
   * only; nothing is saved on the PC).
   */
  async setModel(model: string | null): Promise<void> {
    if (this.isClosed || !this.q) throw new Error('This session is closed');
    const target = isDefaultModel(model) ? undefined : model!;
    await this.q.setModel(target);
    this.model = target ?? this.opts.config.model ?? this.model;
    this.record({
      kind: 'status',
      message: target
        ? `Model switched to ${target} for the next replies.`
        : 'Model switched back to the default for the next replies.',
    });
    this.emitState();
  }

  /**
   * Changes the reasoning effort for the following replies. It goes into the session's
   * flag settings layer, so nothing is written to the settings files on the PC; `max`
   * runs as `high` on a model without it.
   */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    if (this.isClosed || !this.q) throw new Error('This session is closed');
    await this.q.applyFlagSettings({ effortLevel: effort });
    this.effort = effort ?? undefined;
    this.record({
      kind: 'status',
      message: effort
        ? `Effort set to ${effort} for the next replies.`
        : 'Effort back to the model default for the next replies.',
    });
    this.emitState();
  }

  /** The models this Claude Code offers, as the SDK reports them. */
  async models(): Promise<ModelChoice[]> {
    if (this.isClosed || !this.q) return MODEL_ALIASES;
    try {
      const list = await this.q.supportedModels();
      if (!list.length) return MODEL_ALIASES;
      return list.map((m) => ({
        value: m.value,
        label: m.displayName,
        description: m.description,
        ...effortsOf(m),
      }));
    } catch {
      return MODEL_ALIASES;
    }
  }

  /** The live SDK query, while the session runs (the usage meter asks it for limits). */
  get liveQuery(): Query | undefined {
    return this.isClosed ? undefined : this.q;
  }

  /** The modes the phone may pick: the safe ones, plus the others when the PC allows. */
  modes(): PermissionModeName[] {
    if (!this.opts.config.allowUnsafeModes) return [...SAFE_MODE_LIST];
    return [
      ...SAFE_MODE_LIST,
      'auto',
      'dontAsk',
      ...(this.bypassCapable ? (['bypassPermissions'] as const) : []),
    ];
  }

  /** Switches the permission mode (the SDK's `setPermissionMode`, takes effect at once). */
  async setMode(mode: PermissionModeName): Promise<void> {
    if (this.isClosed || !this.q) throw new Error('This session is closed');
    if (!this.modes().includes(mode)) {
      throw new Error(
        UNSAFE_MODES.has(mode) && !this.opts.config.allowUnsafeModes
          ? 'Modes that skip approvals are off on this PC (voicecode-agent modes allow-unsafe).'
          : 'Bypass permissions needs a session started after unsafe modes were allowed.',
      );
    }
    await this.q.setPermissionMode(mode);
    this.observeMode(mode, true);
  }

  /** The mode changed (by the phone, an approval or Claude leaving plan mode). */
  observeMode(mode: PermissionModeName, announce = false): void {
    if (mode === this.permissionMode) return;
    this.permissionMode = mode;
    if (announce) this.record({ kind: 'status', message: `Permission mode: ${MODE_NAMES[mode]}.` });
    this.emitState();
  }

  /** Re-sends the summary (the PC changed which modes are allowed). */
  touch(): void {
    this.emitState();
  }

  get currentMode(): PermissionModeName | undefined {
    return this.permissionMode;
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      projectId: this.project.id,
      state: this.state,
      claudeSessionId: this.claudeSessionId,
      createdAt: this.createdAt,
      title: this.title,
      model: this.model,
      effort: this.effort,
      permissionMode: this.permissionMode,
      modes: this.modes(),
      totalCostUsd: this.totalCostUsd,
    };
  }

  events(): SessionEventRecord[] {
    return [...this.history];
  }

  get isClosed(): boolean {
    return this.state === 'closed' || this.state === 'error';
  }

  /**
   * A prompt from the phone. Images go in as image blocks ahead of the text, which is how
   * the Messages API expects a question about them; text alone stays a plain string.
   */
  sendPrompt(
    text: string,
    deviceName: string,
    images: Array<{ mediaType: string; data: string }> = [],
  ): void {
    if (this.isClosed) throw new Error('session is closed');
    const shown = text || (images.length === 1 ? 'Image' : `${images.length} images`);
    this.title ??= shown.slice(0, 80);
    this.record({
      kind: 'user_prompt',
      text,
      deviceName,
      ...(images.length ? { images: images.length } : {}),
    });
    const content = images.length
      ? [
          ...images.map((image) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: image.mediaType as
                'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
              data: image.data,
            },
          })),
          ...(text ? [{ type: 'text' as const, text }] : []),
        ]
      : text;
    this.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    });
    this.setState('running');
  }

  async interrupt(): Promise<void> {
    this.stopReason = 'Stopped.';
    await this.q?.interrupt();
  }

  /** Adds an informational line to the transcript. */
  /** A name chosen on the phone; it replaces the first-prompt title. */
  rename(title: string): void {
    this.title = title;
    this.emitState();
  }

  noteStatus(message: string): void {
    this.record({ kind: 'status', message });
  }

  /** The user rejected a tool call without feedback, which ends the turn. */
  markRejected(): void {
    this.stopReason = 'Stopped: you rejected the tool call. Say what to do instead.';
  }

  /** Called by the session manager when the approval broker's pending set changes. */
  setAwaitingPermission(awaiting: boolean): void {
    if (this.isClosed) return;
    if (awaiting) this.setState('awaiting_permission');
    else if (this.state === 'awaiting_permission') this.setState('running');
  }

  close(): void {
    if (this.isClosed) return;
    this.opts.broker.cancelSession(this.id, 'cancelled');
    this.input.end();
    this.q?.close();
    this.abort.abort();
    this.setState('closed');
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const message of q) this.handle(message);
      if (!this.isClosed) this.setState('closed');
    } catch (err) {
      if (this.isClosed) return;
      this.opts.logger.error({ err, session: this.id }, 'claude session failed');
      this.record({ kind: 'error', message: (err as Error).message });
      this.setState('error');
    } finally {
      this.opts.broker.cancelSession(this.id, 'cancelled');
    }
  }

  private handle(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.claudeSessionId = message.session_id;
          this.model = message.model;
          if (UNSAFE_MODES.has(message.permissionMode)) {
            // Project settings can set a default mode; never let one skip approvals.
            // (Only the phone may choose such a mode, and only when the PC allows it.)
            void this.q?.setPermissionMode(this.opts.config.permissionMode);
            this.record({
              kind: 'status',
              message: `Ignored permission mode "${message.permissionMode}" from settings; using "${this.opts.config.permissionMode}".`,
            });
            this.permissionMode = this.opts.config.permissionMode;
          } else if (isModeName(message.permissionMode)) {
            this.permissionMode = message.permissionMode;
          }
          this.emitState();
        } else if (message.subtype === 'status') {
          if (isModeName(message.permissionMode)) this.observeMode(message.permissionMode);
        } else if (message.subtype === 'api_retry') {
          this.record({
            kind: 'status',
            message: `API error, retrying (attempt ${message.attempt}/${message.max_retries})…`,
          });
        }
        return;

      case 'stream_event': {
        if (message.parent_tool_use_id) return;
        const event = message.event;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          this.emit('delta', {
            seq: this.seq,
            at: Date.now(),
            event: { kind: 'assistant_text_delta', text: event.delta.text },
          });
        }
        return;
      }

      case 'assistant': {
        if (message.parent_tool_use_id) return;
        // The model that actually answered (after a switch, an alias resolves to an id).
        const answered = (message.message as { model?: unknown }).model;
        if (typeof answered === 'string' && answered !== '<synthetic>' && answered !== this.model) {
          this.model = answered;
          this.emitState();
        }
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            this.record({ kind: 'assistant_text', text: block.text });
          } else if (block.type === 'tool_use') {
            const input = (block.input ?? {}) as Record<string, unknown>;
            this.record({
              kind: 'tool_use',
              toolUseId: block.id,
              name: block.name,
              summary: summarizeToolUse(block.name, input),
            });
          }
        }
        return;
      }

      case 'user': {
        if (message.parent_tool_use_id || typeof message.message.content === 'string') return;
        for (const block of message.message.content) {
          if (block.type === 'tool_result') {
            this.record({
              kind: 'tool_result',
              toolUseId: block.tool_use_id,
              isError: block.is_error === true,
              summary: summarizeToolResult(block.content),
            });
          }
        }
        return;
      }

      case 'result':
        this.totalCostUsd = message.total_cost_usd;
        this.record({
          kind: 'result',
          subtype: message.subtype,
          isError: message.is_error,
          durationMs: message.duration_ms,
          totalCostUsd: message.total_cost_usd,
          numTurns: message.num_turns,
        });
        if (message.subtype === 'error_during_execution' && this.stopReason) {
          // A stop the user asked for (Stop button or a bare Reject) is not an error.
          this.record({ kind: 'status', message: this.stopReason });
        } else if (message.subtype !== 'success') {
          const errors = 'errors' in message ? message.errors : [];
          this.record({ kind: 'error', message: errors.join('\n') || message.subtype });
        }
        this.stopReason = undefined;
        this.setState('idle');
        return;

      default:
        return;
    }
  }

  private record(event: ClaudeEvent): void {
    const record = { seq: ++this.seq, at: Date.now(), event };
    this.history.push(record);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.emit('event', record);
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

/** A model's effort levels as the SDK lists them, in order; unknown levels are dropped. */
function effortsOf(m: { supportsEffort?: boolean; supportedEffortLevels?: readonly string[] }): {
  efforts?: EffortLevel[];
} {
  if (m.supportsEffort === false) return { efforts: [] };
  if (!Array.isArray(m.supportedEffortLevels)) return {};
  const levels = new Set(m.supportedEffortLevels);
  return { efforts: EFFORT_LEVELS.filter((level) => levels.has(level)) };
}

const MODE_NAMES: Record<PermissionModeName, string> = {
  default: 'manual (asks before each tool)',
  acceptEdits: 'accept edits',
  plan: 'plan',
  auto: 'auto',
  dontAsk: "don't ask",
  bypassPermissions: 'bypass permissions (no approvals)',
};

function isModeName(value: unknown): value is PermissionModeName {
  return typeof value === 'string' && value in MODE_NAMES;
}
