import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '@voicecode/protocol';
import { ApprovalBroker } from './approval-broker.js';

function ask(broker: ApprovalBroker, extra: Record<string, unknown> = {}) {
  const controller = new AbortController();
  const canUseTool = broker.forSession('s1');
  const result = canUseTool(
    'Bash',
    { command: 'rm -rf build' },
    {
      signal: controller.signal,
      toolUseID: 't1',
      requestId: 'r1',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'projectSettings',
        },
        { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      ],
      ...extra,
    },
  );
  return { result, controller };
}

function nextRequest(broker: ApprovalBroker): Promise<PermissionRequest> {
  return new Promise((resolve) => broker.once('request', resolve));
}

describe('ApprovalBroker', () => {
  it('turns canUseTool into a pending request and resolves on allow', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 60_000 });
    const pending = nextRequest(broker);
    const { result } = ask(broker);
    const request = await pending;

    expect(request).toMatchObject({ sessionId: 's1', toolName: 'Bash', canRemember: true });
    expect(request.detail).toContain('rm -rf build');
    expect(broker.pendingFor('s1')).toHaveLength(1);

    broker.respond(request.requestId, 'allow');
    await expect(result).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'rm -rf build' },
    });
    expect(broker.pendingFor()).toHaveLength(0);
  });

  it('only remembers allow rules, scoped to the session', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 60_000 });
    const pending = nextRequest(broker);
    const { result } = ask(broker);
    broker.respond((await pending).requestId, 'allow', { rememberForSession: true });
    const decision = await result;
    expect(decision?.behavior === 'allow' ? decision.updatedPermissions : undefined).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash' }],
        behavior: 'allow',
        destination: 'session',
      },
    ]);
  });

  it('does not offer remembering when the SDK suppresses it', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 60_000 });
    const pending = nextRequest(broker);
    ask(broker, { suppressAlwaysAllowRule: true });
    expect((await pending).canRemember).toBe(false);
  });

  it('a bare rejection interrupts, a rejection with feedback does not', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 60_000 });
    let pending = nextRequest(broker);
    let { result } = ask(broker);
    broker.respond((await pending).requestId, 'deny');
    await expect(result).resolves.toMatchObject({ behavior: 'deny', interrupt: true });

    pending = nextRequest(broker);
    ({ result } = ask(broker));
    broker.respond((await pending).requestId, 'deny', { message: 'use pnpm instead' });
    await expect(result).resolves.toMatchObject({
      behavior: 'deny',
      interrupt: false,
      message: 'use pnpm instead',
    });
  });

  it('denies on timeout, abort and session cancel', async () => {
    vi.useFakeTimers();
    try {
      const broker = new ApprovalBroker({ timeoutMs: 1_000 });
      const resolved = vi.fn();
      broker.on('resolved', resolved);

      const timedOut = ask(broker).result;
      vi.advanceTimersByTime(1_000);
      await expect(timedOut).resolves.toMatchObject({ behavior: 'deny' });

      const aborted = ask(broker);
      aborted.controller.abort();
      await expect(aborted.result).resolves.toMatchObject({ behavior: 'deny' });

      const cancelled = ask(broker).result;
      broker.cancelSession('s1');
      await expect(cancelled).resolves.toMatchObject({ behavior: 'deny' });

      expect(resolved.mock.calls.map(([e]) => e.reason)).toEqual([
        'timeout',
        'cancelled',
        'cancelled',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores answers for unknown or already-settled requests', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 60_000 });
    const pending = nextRequest(broker);
    ask(broker);
    const { requestId } = await pending;
    expect(broker.respond(requestId, 'allow')).toBe(true);
    expect(broker.respond(requestId, 'deny')).toBe(false);
    expect(broker.respond('nope', 'allow')).toBe(false);
  });
});
