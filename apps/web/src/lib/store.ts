import {
  PROTOCOL_VERSION,
  type ClaudeEvent,
  type FolderListing,
  type HistoricSession,
  type ModelChoice,
  type MouseStatus,
  type PcSession,
  type PermissionRequest,
  type ProjectInfo,
  type ServerMessage,
  type SessionSummary,
  type VoiceMicStatus,
} from '@voicecode/protocol';

export interface EventItem {
  seq: number;
  at: number;
  event: Exclude<ClaudeEvent, { kind: 'assistant_text_delta' }>;
}

/** "Task finished" notice for a session other than the one on screen. */
export interface Toast {
  id: number;
  source: 'agent' | 'pc';
  sessionId: string;
  place: string;
  title?: string;
  isError: boolean;
}

/** Most toasts shown at once; older ones are dropped. */
const TOAST_LIMIT = 3;

export interface AppState {
  device?: { id: string; name: string };
  agent?: { version: string; hostname: string; platform: string };
  projects: ProjectInfo[];
  /** Workspace folders on the PC whose subfolders can be opened from here. */
  roots: string[];
  /** The latest folder-browser listing (one level). */
  folders?: FolderListing;
  sessions: Record<string, SessionSummary>;
  activeSessionId?: string;
  events: Record<string, EventItem[]>;
  /** Assistant text currently streaming in, per session. */
  streaming: Record<string, string>;
  permissions: Record<string, PermissionRequest>;
  mouse: { status: MouseStatus; youHoldLease: boolean };
  /** The PC's virtual microphone for Claude Code dictation, and whether we stream to it. */
  voiceMic: { status: VoiceMicStatus; youHoldLease: boolean };
  /** Whether the agent can take over a Claude Code running in a terminal on the PC. */
  pcControl: { available: boolean; reason?: string };
  history: Record<string, HistoricSession[]>;
  /** The latest model list the agent sent (for a session, or in general). */
  models?: { sessionId?: string; models: ModelChoice[]; persistsDefault: boolean };
  /** Claude sessions running elsewhere on the PC (terminals), read-only. */
  pcSessions: PcSession[];
  pcEvents: Record<string, EventItem[]>;
  /** Set while a PC session is on screen instead of a phone session. */
  activePcSessionId?: string;
  toasts: Toast[];
  error?: { message: string; at: number };
  /** The agent speaks a different protocol version than this (cached) page. */
  protocolMismatch: boolean;
}

export const initialState: AppState = {
  projects: [],
  roots: [],
  sessions: {},
  events: {},
  streaming: {},
  permissions: {},
  mouse: { status: { available: false, driver: 'none' }, youHoldLease: false },
  voiceMic: { status: { available: false, driver: 'none' }, youHoldLease: false },
  pcControl: { available: false },
  history: {},
  pcSessions: [],
  pcEvents: {},
  toasts: [],
  protocolMismatch: false,
};

export type Action =
  | { type: 'server'; message: ServerMessage }
  | { type: 'selectSession'; sessionId: string | undefined }
  | { type: 'selectPcSession'; sessionId: string }
  | { type: 'dismissToast'; id: number }
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
      return { ...state, activeSessionId: action.sessionId, activePcSessionId: undefined };
    case 'selectPcSession':
      return { ...state, activePcSessionId: action.sessionId };
    case 'dismissToast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
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
        roots: msg.roots ?? [],
        sessions,
        activeSessionId: active,
        pcSessions: msg.pcSessions ?? [],
        mouse: { status: msg.mouse, youHoldLease: false },
        voiceMic: {
          status: msg.voiceMic ?? { available: false, driver: 'none', reason: 'older agent' },
          youHoldLease: false,
        },
        pcControl: msg.pcControl ?? { available: false, reason: 'older agent' },
        // Permissions are re-sent right after welcome.
        permissions: {},
        protocolMismatch: msg.protocolVersion !== PROTOCOL_VERSION,
      };
    }
    case 'pong':
      return state;
    case 'projects':
      return { ...state, projects: msg.projects, roots: msg.roots ?? state.roots };
    case 'folders.list': {
      const { type: _type, ...listing } = msg;
      return { ...state, folders: listing };
    }
    case 'error':
      return { ...state, error: { message: msg.message, at: Date.now() } };

    case 'mouse.status':
      return { ...state, mouse: { status: msg.status, youHoldLease: msg.youHoldLease } };
    case 'mouse.position':
      return state;
    case 'voice.mic.status':
      return { ...state, voiceMic: { status: msg.status, youHoldLease: msg.youHoldLease } };
    // Terminal bytes are delivered to the terminal view directly, never kept here.
    case 'terminal.snapshot':
    case 'terminal.data':
    case 'terminal.exit':
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
        // Starting, continuing or opening a phone session takes over the screen.
        activeSessionId: msg.session.id,
        activePcSessionId: undefined,
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
    case 'claude.models': {
      const { type: _type, ...models } = msg;
      return { ...state, models };
    }

    case 'claude.task.done': {
      const onScreen =
        msg.source === 'pc'
          ? state.activePcSessionId === msg.sessionId
          : !state.activePcSessionId && state.activeSessionId === msg.sessionId;
      if (onScreen) return state;
      const toast: Toast = {
        id: (state.toasts[0]?.id ?? 0) + 1,
        source: msg.source,
        sessionId: msg.sessionId,
        place: msg.place,
        title: msg.title,
        isError: msg.isError,
      };
      return { ...state, toasts: [toast, ...state.toasts].slice(0, TOAST_LIMIT) };
    }

    case 'pc.sessions':
      return { ...state, pcSessions: msg.sessions };
    case 'pc.session.snapshot':
      return {
        ...state,
        pcEvents: {
          ...state.pcEvents,
          [msg.sessionId]: msg.events.filter(
            (e): e is EventItem => e.event.kind !== 'assistant_text_delta',
          ),
        },
      };
    case 'pc.session.event': {
      if (msg.event.kind === 'assistant_text_delta') return state;
      const item: EventItem = { seq: msg.seq, at: msg.at, event: msg.event };
      return {
        ...state,
        pcEvents: {
          ...state.pcEvents,
          [msg.sessionId]: appendEvent(state.pcEvents[msg.sessionId], item),
        },
      };
    }
  }
}
