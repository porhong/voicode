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
}

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
      new Promise<PermissionResult>((resolve) => {
        const requestId = randomUUID();
        const now = Date.now();
        // Only "allow" rules scoped to this session may be remembered; never anything
        // that writes settings files or changes the permission mode.
        const rememberable = options.suppressAlwaysAllowRule
          ? []
          : (options.suggestions ?? [])
              .filter(
                (s): s is Extract<PermissionUpdate, { type: 'addRules' }> =>
                  s.type === 'addRules' && s.behavior === 'allow',
              )
              .map((s) => ({ ...s, destination: 'session' as const }));

        const request: PermissionRequest = {
          sessionId,
          requestId,
          toolName,
          title: options.title ?? describeToolTitle(toolName, input, options.displayName),
          description: options.description ?? options.decisionReason,
          detail: describeToolInput(toolName, input),
          canRemember: rememberable.length > 0,
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
    });
    return true;
  }
}
