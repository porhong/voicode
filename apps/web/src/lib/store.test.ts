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
  sessions: [{ id: 's1', projectId: 'p1', state: 'idle', createdAt: 1 }],
  mouse: { available: true, driver: 'fake' },
});

const request: PermissionRequest = {
  sessionId: 's1',
  requestId: 'r1',
  toolName: 'Bash',
  title: 'Claude wants to run a command',
  detail: 'npm test',
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

  it('replaces the project list when the agent reloads it', () => {
    const s = apply(apply(initialState, welcome()), {
      type: 'projects',
      projects: [{ id: 'p2', name: 'other', path: '/other' }],
    });
    expect(s.projects.map((p) => p.id)).toEqual(['p2']);
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
