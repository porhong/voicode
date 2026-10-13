import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '@voicecode/protocol';
import {
  ApprovalBroker,
  ApprovalError,
  rememberableUpdates,
  type ResolvedEvent,
} from './approval-broker.js';

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

  it('can switch the session to acceptEdits when the user allows all edits', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 60_000 });
    const pending = nextRequest(broker);
    const resolved = new Promise<ResolvedEvent>((r) => broker.once('resolved', r));
    const result = broker.forSession('s1')(
      'Write',
      { file_path: 'a.txt', content: 'x' },
      {
        signal: new AbortController().signal,
        toolUseID: 't1',
        requestId: 'r1',
        suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      },
    );
    const request = await pending;
    expect(request).toMatchObject({
      canRemember: true,
      rememberLabel: 'Allow all edits this session',
      title: 'Claude wants to create a.txt',
    });
    broker.respond(request.requestId, 'allow', { rememberForSession: true });
    const decision = await result;
    const applied = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
    expect(decision?.behavior === 'allow' ? decision.updatedPermissions : undefined).toEqual(
      applied,
    );
    expect((await resolved).remembered).toEqual(applied);
  });

  it('never remembers modes that skip command approvals or write settings', () => {
    expect(
      rememberableUpdates([
        { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        { type: 'setMode', mode: 'auto', destination: 'session' },
        { type: 'setMode', mode: 'dontAsk', destination: 'session' },
        { type: 'setMode', mode: 'acceptEdits', destination: 'userSettings' },
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'deny',
          destination: 'session',
        },
        { type: 'addDirectories', directories: ['/'], destination: 'session' },
      ]),
    ).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
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

describe('ApprovalBroker with incomplete details', () => {
  it('refuses to allow, and never offers remembering, input too long to show', async () => {
    const broker = new ApprovalBroker({ timeoutMs: 60_000 });
    const pending = nextRequest(broker);
    const result = broker.forSession('s1')(
      'Bash',
      { command: 'x'.repeat(70_000) },
      {
        signal: new AbortController().signal,
        toolUseID: 't1',
        requestId: 'r1',
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash' }],
            behavior: 'allow',
            destination: 'session',
          },
        ],
      },
    );
    const request = await pending;
    expect(request).toMatchObject({ complete: false, canRemember: false });
    expect(() => broker.respond(request.requestId, 'allow')).toThrow(ApprovalError);
    expect(broker.pendingFor()).toHaveLength(1);
    broker.respond(request.requestId, 'deny');
    await expect(result).resolves.toMatchObject({ behavior: 'deny' });
  });
});
