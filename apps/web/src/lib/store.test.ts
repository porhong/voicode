import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type PermissionRequest, type ServerMessage } from '@voicecode/protocol';
import { initialState, reducer, type AppState } from './store';

const apply = (state: AppState, message: ServerMessage) =>
  reducer(state, { type: 'server', message });

const welcome = (protocolVersion = PROTOCOL_VERSION): ServerMessage => ({
  type: 'welcome',
  protocolVersion,
  device: { id: 'd1', name: 'Phone' },
  agent: { version: '0.1.0', hostname: 'pc', platform: 'win32' },
  projects: [{ id: 'p1', name: 'app', path: '/app' }],
  roots: ['/code'],
  sessions: [{ id: 's1', projectId: 'p1', state: 'idle', createdAt: 1 }],
  pcSessions: [{ sessionId: 'pc1', pid: 10, cwd: '/term', folder: 'term', status: 'working' }],
  mouse: { available: true, driver: 'fake' },
  voiceMic: { available: true, driver: 'fake-mic', device: 'Fake Cable' },
  pcControl: { available: true },
});

const request: PermissionRequest = {
  sessionId: 's1',
  requestId: 'r1',
  toolName: 'Bash',
  title: 'Claude wants to run a command',
  detail: 'npm test',
  complete: true,
  canRemember: false,
  createdAt: 1,
};

describe('app state', () => {
  it('selects the live session on welcome and flags protocol mismatches', () => {
    const s = apply(initialState, welcome());
    expect(s.activeSessionId).toBe('s1');
    expect(s.protocolMismatch).toBe(false);
    expect(apply(initialState, welcome(PROTOCOL_VERSION + 1)).protocolMismatch).toBe(true);
  });

  it('keeps the model list the agent sent', () => {
    const s = apply(initialState, {
      type: 'claude.models',
      sessionId: 's1',
      models: [{ value: 'opus', label: 'Opus' }],
      persistsDefault: true,
    });
    expect(s.models).toEqual({
      sessionId: 's1',
      models: [{ value: 'opus', label: 'Opus' }],
      persistsDefault: true,
    });
  });

  it('keeps the latest storage report', () => {
    const storage = {
      categories: [{ category: 'logs' as const, bytes: 300, count: 1 }],
      totalBytes: 300,
      auto: true,
      maxCacheMb: 250,
    };
    expect(apply(initialState, { type: 'storage.info', storage }).storage).toEqual(storage);
  });

  it('replaces the project list when the agent reloads it', () => {
    const s = apply(apply(initialState, welcome()), {
      type: 'projects',
      projects: [{ id: 'p2', name: 'other', path: '/other' }],
      roots: ['/code', '/work'],
    });
    expect(s.projects.map((p) => p.id)).toEqual(['p2']);
    expect(s.roots).toEqual(['/code', '/work']);
  });

  it('accumulates streamed text and clears it when the final message arrives', () => {
    let s = apply(initialState, welcome());
    const ev = (seq: number, event: Extract<ServerMessage, { type: 'claude.event' }>['event']) =>
      ({ type: 'claude.event', sessionId: 's1', seq, at: 0, event }) as ServerMessage;
    s = apply(s, ev(1, { kind: 'assistant_text_delta', text: 'Hel' }));
    s = apply(s, ev(1, { kind: 'assistant_text_delta', text: 'lo' }));
    expect(s.streaming.s1).toBe('Hello');
    s = apply(s, ev(2, { kind: 'assistant_text', text: 'Hello' }));
    expect(s.streaming.s1).toBe('');
    // Duplicate/old sequence numbers (e.g. after a snapshot) are ignored.
    s = apply(s, ev(2, { kind: 'assistant_text', text: 'Hello' }));
    expect(s.events.s1).toHaveLength(1);
  });

  it('follows PC sessions and toasts finished tasks that are not on screen', () => {
    let s = apply(initialState, welcome());
    expect(s.pcSessions.map((p) => p.sessionId)).toEqual(['pc1']);
    s = reducer(s, { type: 'selectPcSession', sessionId: 'pc1' });
    s = apply(s, {
      type: 'pc.session.snapshot',
      sessionId: 'pc1',
      events: [{ seq: 1, at: 0, event: { kind: 'user_prompt', text: 'Hi', deviceName: 'PC' } }],
    });
    s = apply(s, {
      type: 'pc.session.event',
      sessionId: 'pc1',
      seq: 2,
      at: 0,
      event: { kind: 'assistant_text', text: 'Hello' },
    });
    expect(s.pcEvents.pc1?.map((e) => e.seq)).toEqual([1, 2]);

    const done = (source: 'agent' | 'pc', sessionId: string): ServerMessage => ({
      type: 'claude.task.done',
      source,
      sessionId,
      place: 'app',
      isError: false,
    });
    // The PC session is on screen, so its own completion needs no toast.
    s = apply(s, done('pc', 'pc1'));
    expect(s.toasts).toEqual([]);
    s = apply(s, done('agent', 's1'));
    expect(s.toasts.map((t) => [t.source, t.sessionId])).toEqual([['agent', 's1']]);
    s = reducer(s, { type: 'dismissToast', id: s.toasts[0]!.id });
    expect(s.toasts).toEqual([]);

    // Opening a phone session leaves the PC view.
    s = reducer(s, { type: 'selectSession', sessionId: 's1' });
    expect(s.activePcSessionId).toBeUndefined();
  });

  it('tracks pending approvals until any device resolves them', () => {
    let s = apply(initialState, { type: 'claude.permission.request', request });
    expect(Object.keys(s.permissions)).toEqual(['r1']);
    s = apply(s, {
      type: 'claude.permission.resolved',
      sessionId: 's1',
      requestId: 'r1',
      decision: 'allow',
      reason: 'user',
    });
    expect(s.permissions).toEqual({});
  });
});
