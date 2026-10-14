import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import type { PermissionRequest } from '@voicecode/protocol';
import { describeToolInput, describeToolTitle } from './tool-summary.js';

type ResolveReason = 'user' | 'timeout' | 'cancelled' | 'shutdown';

interface Pending {
  request: PermissionRequest;
  input: Record<string, unknown>;
  rememberable: PermissionUpdate[];
  timer: NodeJS.Timeout;
  settle: (result: PermissionResult) => void;
}

export interface ResolvedEvent {
  sessionId: string;
  requestId: string;
  decision: 'allow' | 'deny';
  reason: ResolveReason;
  deviceName?: string;
  /** True when the denial told the SDK to stop the current turn. */
  interrupted: boolean;
  /** Permission updates applied for the rest of the session, if the user chose that. */
  remembered: PermissionUpdate[];
}

/**
 * What "always allow this session" may apply: Claude's suggested allow rules and a
 * switch to `acceptEdits`, both forced to session scope so nothing is written to
 * settings files. Modes that skip approvals for commands (`bypassPermissions`,
 * `auto`, `dontAsk`) are never applied.
 */
export function rememberableUpdates(suggestions: PermissionUpdate[]): PermissionUpdate[] {
  return suggestions.flatMap((s): PermissionUpdate[] => {
    if (s.type === 'addRules' && s.behavior === 'allow') return [{ ...s, destination: 'session' }];
    if (s.type === 'setMode' && s.mode === 'acceptEdits') return [{ ...s, destination: 'session' }];
    return [];
  });
}

export class ApprovalError extends Error {}

/**
 * Bridges the Agent SDK's `canUseTool` callback to browser clients.
 *
 * Each permission check becomes a pending request that is broadcast to every
 * connected device; the first device to answer wins. Unanswered requests are denied
 * after a timeout, and all pending requests are denied when a session closes or the
 * agent shuts down, so Claude never runs a tool without an explicit "allow".
 */
export class ApprovalBroker extends EventEmitter<{
  request: [request: PermissionRequest];
  resolved: [event: ResolvedEvent];
}> {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: { timeoutMs: number }) {
    super();
  }

  /** Creates the `canUseTool` callback for one session. */
  forSession(sessionId: string): CanUseTool {
    return (toolName, input, options) =>
      this.enqueue(sessionId, toolName, input, {
        signal: options.signal,
        suggestions: options.suppressAlwaysAllowRule ? [] : options.suggestions,
        title: options.title,
        description: options.description ?? options.decisionReason,
        displayName: options.displayName,
      });
  }

  /**
   * A permission check that did not come through the SDK (a Claude Code hook): the same
   * phone approval, answered as a plain decision. Nothing can be "remembered" here, since
   * hooks carry no rule suggestions.
   */
  async ask(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ decision: 'allow' | 'deny'; reason?: string }> {
    const result = await this.enqueue(sessionId, toolName, input, {
      signal: new AbortController().signal,
    });
    return result.behavior === 'allow'
      ? { decision: 'allow' }
      : { decision: 'deny', reason: result.message };
  }

  private enqueue(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      title?: string;
      description?: string;
      displayName?: string;
    },
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID();
      const now = Date.now();
      const rememberable = rememberableUpdates(options.suggestions ?? []);
      const acceptsEdits = rememberable.some((u) => u.type === 'setMode');

      const { detail, complete } = describeToolInput(toolName, input);
      const request: PermissionRequest = {
        sessionId,
        requestId,
        toolName,
        title: options.title ?? describeToolTitle(toolName, input, options.displayName),
        description: options.description,
        detail,
        complete,
        // Never offer a standing approval for something the user could not fully see.
        canRemember: complete && rememberable.length > 0,
        rememberLabel: acceptsEdits ? 'Allow all edits this session' : undefined,
        createdAt: now,
        expiresAt: now + this.options.timeoutMs,
      };

      const timer = setTimeout(
        () => this.settle(requestId, 'deny', 'timeout', 'No response from the user in time.'),
        this.options.timeoutMs,
      );
      timer.unref();

      this.pending.set(requestId, { request, input, rememberable, timer, settle: resolve });
      options.signal.addEventListener(
        'abort',
        () => this.settle(requestId, 'deny', 'cancelled', 'Request was cancelled.'),
        { once: true },
      );
      this.emit('request', request);
    });
  }

  respond(
    requestId: string,
    decision: 'allow' | 'deny',
    opts: { rememberForSession?: boolean; message?: string; deviceName?: string } = {},
  ): boolean {
    // Enforced here, not just in the UI: input too long to display cannot be allowed.
    if (decision === 'allow' && this.pending.get(requestId)?.request.complete === false) {
      throw new ApprovalError('This request is too long to review on the phone; reject it.');
    }
    return this.settle(
      requestId,
      decision,
      'user',
      opts.message,
      opts.deviceName,
      opts.rememberForSession,
    );
  }

  pendingFor(sessionId?: string): PermissionRequest[] {
    return [...this.pending.values()]
      .map((p) => p.request)
      .filter((r) => sessionId === undefined || r.sessionId === sessionId);
  }

  get(requestId: string): PermissionRequest | undefined {
    return this.pending.get(requestId)?.request;
  }

  cancelSession(sessionId: string, reason: 'cancelled' | 'shutdown' = 'cancelled'): void {
    for (const p of [...this.pending.values()]) {
      if (p.request.sessionId === sessionId) {
        this.settle(p.request.requestId, 'deny', reason, 'Session closed.');
      }
    }
  }

  cancelAll(reason: 'shutdown' = 'shutdown'): void {
    for (const id of [...this.pending.keys()])
      this.settle(id, 'deny', reason, 'Agent is shutting down.');
  }

  private settle(
    requestId: string,
    decision: 'allow' | 'deny',
    reason: ResolveReason,
    message?: string,
    deviceName?: string,
    remember?: boolean,
  ): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    clearTimeout(p.timer);

    // A bare user rejection stops the turn so Claude waits for new instructions;
    // a rejection with feedback lets Claude adjust and carry on.
    const interrupted = decision === 'deny' && reason === 'user' && !message;
    if (decision === 'allow') {
      p.settle({
        behavior: 'allow',
        updatedInput: p.input,
        ...(remember && p.rememberable.length ? { updatedPermissions: p.rememberable } : {}),
      });
    } else {
      p.settle({
        behavior: 'deny',
        message: message ?? `The user rejected this ${p.request.toolName} call.`,
        interrupt: interrupted,
      });
    }
    this.emit('resolved', {
      sessionId: p.request.sessionId,
      requestId,
      decision,
      reason,
      deviceName,
      interrupted,
      remembered: decision === 'allow' && remember ? p.rememberable : [],
    });
    return true;
  }
}
