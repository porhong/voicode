import { EventEmitter } from 'node:events';
import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeEvent, SessionState, SessionSummary } from '@voicecode/protocol';
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
import { summarizeToolResult, summarizeToolUse } from './tool-summary.js';

/** Events kept per session so reconnecting clients can catch up. */
const HISTORY_LIMIT = 500;

/** Modes that would let tools run without an approval reaching the user. */
const UNSAFE_MODES = new Set(['bypassPermissions', 'auto', 'dontAsk']);

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
  }

  start(): void {
    const { config, broker } = this.opts;
    const executable = this.opts.queryFn ? undefined : claudeExecutablePath();
    const options: Options = {
      cwd: this.project.path,
      abortController: this.abort,
      permissionMode: config.permissionMode,
      canUseTool: broker.forSession(this.id),
      includePartialMessages: true,
      // Load CLAUDE.md and project/user settings, like the interactive CLI does.
      settingSources: ['user', 'project', 'local'],
      // Structured multiple-choice questions need a UI we don't have; Claude asks in
      // plain text instead, which works naturally with voice replies.
      disallowedTools: ['AskUserQuestion'],
      stderr: (data) => this.opts.logger.debug({ session: this.id, data }, 'claude stderr'),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      ...(config.model ? { model: config.model } : {}),
      ...(config.maxBudgetUsd ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
      ...(this.opts.resume ? { resume: this.opts.resume } : {}),
      ...(this.opts.resume && this.opts.fork ? { forkSession: true } : {}),
    };

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

  summary(): SessionSummary {
    return {
      id: this.id,
      projectId: this.project.id,
      state: this.state,
      claudeSessionId: this.claudeSessionId,
      createdAt: this.createdAt,
      title: this.title,
      model: this.model,
      totalCostUsd: this.totalCostUsd,
    };
  }

  events(): SessionEventRecord[] {
    return [...this.history];
  }

  get isClosed(): boolean {
    return this.state === 'closed' || this.state === 'error';
  }

  sendPrompt(text: string, deviceName: string): void {
    if (this.isClosed) throw new Error('session is closed');
    this.title ??= text.slice(0, 80);
    this.record({ kind: 'user_prompt', text, deviceName });
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.setState('running');
  }

  async interrupt(): Promise<void> {
    this.stopReason = 'Stopped.';
    await this.q?.interrupt();
  }

  /** Adds an informational line to the transcript. */
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
            void this.q?.setPermissionMode(this.opts.config.permissionMode);
            this.record({
              kind: 'status',
              message: `Ignored permission mode "${message.permissionMode}" from settings; using "${this.opts.config.permissionMode}".`,
            });
          }
          this.emitState();
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
