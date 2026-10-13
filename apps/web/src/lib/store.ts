import {
  PROTOCOL_VERSION,
  type ClaudeEvent,
  type HistoricSession,
  type MouseStatus,
  type PermissionRequest,
  type ProjectInfo,
  type ServerMessage,
  type SessionSummary,
} from '@voicecode/protocol';

export interface EventItem {
  seq: number;
  at: number;
  event: Exclude<ClaudeEvent, { kind: 'assistant_text_delta' }>;
}

export interface AppState {
  device?: { id: string; name: string };
  agent?: { version: string; hostname: string; platform: string };
  projects: ProjectInfo[];
  sessions: Record<string, SessionSummary>;
  activeSessionId?: string;
  events: Record<string, EventItem[]>;
  /** Assistant text currently streaming in, per session. */
  streaming: Record<string, string>;
  permissions: Record<string, PermissionRequest>;
  mouse: { status: MouseStatus; youHoldLease: boolean };
  history: Record<string, HistoricSession[]>;
  error?: { message: string; at: number };
  /** The agent speaks a different protocol version than this (cached) page. */
  protocolMismatch: boolean;
}

export const initialState: AppState = {
  projects: [],
  sessions: {},
  events: {},
  streaming: {},
  permissions: {},
  mouse: { status: { available: false, driver: 'none' }, youHoldLease: false },
  history: {},
  protocolMismatch: false,
};

export type Action =
  | { type: 'server'; message: ServerMessage }
  | { type: 'selectSession'; sessionId: string | undefined }
  | { type: 'dismissError' }
  | { type: 'reset' };

function appendEvent(list: EventItem[] = [], item: EventItem): EventItem[] {
  if (list.length && list[list.length - 1]!.seq >= item.seq) return list;
  return [...list, item];
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'reset':
      return initialState;
    case 'selectSession':
      return { ...state, activeSessionId: action.sessionId };
    case 'dismissError':
      return { ...state, error: undefined };
    case 'server':
      return applyServerMessage(state, action.message);
  }
}

function applyServerMessage(state: AppState, msg: ServerMessage): AppState {
  switch (msg.type) {
    case 'welcome': {
      const sessions = Object.fromEntries(msg.sessions.map((s) => [s.id, s]));
      const active =
        state.activeSessionId && sessions[state.activeSessionId]
          ? state.activeSessionId
          : msg.sessions.find((s) => s.state !== 'closed')?.id;
      return {
        ...state,
        device: msg.device,
        agent: msg.agent,
        projects: msg.projects,
        sessions,
        activeSessionId: active,
        mouse: { status: msg.mouse, youHoldLease: false },
        // Permissions are re-sent right after welcome.
        permissions: {},
        protocolMismatch: msg.protocolVersion !== PROTOCOL_VERSION,
      };
    }
    case 'pong':
      return state;
    case 'projects':
      return { ...state, projects: msg.projects };
    case 'error':
      return { ...state, error: { message: msg.message, at: Date.now() } };

    case 'mouse.status':
      return { ...state, mouse: { status: msg.status, youHoldLease: msg.youHoldLease } };
    case 'mouse.position':
      return state;

    case 'claude.session': {
      const sessions = { ...state.sessions, [msg.session.id]: msg.session };
      const streaming =
        msg.session.state === 'idle'
          ? { ...state.streaming, [msg.session.id]: '' }
          : state.streaming;
      return { ...state, sessions, streaming };
    }
    case 'claude.session.snapshot': {
      const permissions = { ...state.permissions };
      for (const p of msg.pendingPermissions) permissions[p.requestId] = p;
      return {
        ...state,
        sessions: { ...state.sessions, [msg.session.id]: msg.session },
        events: {
          ...state.events,
          [msg.session.id]: msg.events.filter(
            (e): e is EventItem => e.event.kind !== 'assistant_text_delta',
          ),
        },
        activeSessionId: msg.session.id,
        permissions,
      };
    }
    case 'claude.event': {
      const { sessionId, event } = msg;
      if (event.kind === 'assistant_text_delta') {
        return {
          ...state,
          streaming: {
            ...state.streaming,
            [sessionId]: (state.streaming[sessionId] ?? '') + event.text,
          },
        };
      }
      const streaming =
        event.kind === 'assistant_text' || event.kind === 'result' || event.kind === 'tool_use'
          ? { ...state.streaming, [sessionId]: '' }
          : state.streaming;
      return {
        ...state,
        streaming,
        events: {
          ...state.events,
          [sessionId]: appendEvent(state.events[sessionId], { seq: msg.seq, at: msg.at, event }),
        },
      };
    }
    case 'claude.permission.request':
      return {
        ...state,
        permissions: { ...state.permissions, [msg.request.requestId]: msg.request },
      };
    case 'claude.permission.resolved': {
      const { [msg.requestId]: _resolved, ...rest } = state.permissions;
      return { ...state, permissions: rest };
    }
    case 'claude.sessions.history':
      return { ...state, history: { ...state.history, [msg.projectId]: msg.sessions } };
  }
}
