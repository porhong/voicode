import type { MouseButton, SessionState } from './constants.js';

/*
 * Messages the agent sends to browser clients. These are produced by trusted code,
 * so they are plain TypeScript types rather than runtime-validated schemas.
 */

export interface ProjectInfo {
  id: string;
  name: string;
  /** Absolute path on the agent machine. */
  path: string;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  state: SessionState;
  /** Claude Code's own session id once known; usable with `resume`. */
  claudeSessionId?: string;
  createdAt: number;
  title?: string;
  model?: string;
  totalCostUsd?: number;
}

export interface HistoricSession {
  claudeSessionId: string;
  summary: string;
  lastModified: number;
  gitBranch?: string;
}

export type PcSessionStatus = 'working' | 'idle' | 'waiting' | 'unknown';

/** A Claude Code session running on the PC outside the agent (e.g. in a terminal). */
export interface PcSession {
  /** Claude Code's session id. */
  sessionId: string;
  pid: number;
  cwd: string;
  /** Last path segment of `cwd`. */
  folder: string;
  /** Claude Code's own name for the session, if it has one. */
  name?: string;
  status: PcSessionStatus;
  lastPrompt?: string;
  startedAt?: number;
  updatedAt?: number;
  /** The allow-listed project for `cwd`; continuing elsewhere needs the folder allowed. */
  projectId?: string;
}

export interface MouseStatus {
  available: boolean;
  driver: string;
  /** Explanation when unavailable. */
  reason?: string;
  holder?: { deviceId: string; deviceName: string };
}

export type ClaudeEvent =
  | { kind: 'user_prompt'; text: string; deviceName: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'assistant_text_delta'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; summary: string }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; summary: string }
  | {
      kind: 'result';
      subtype: string;
      isError: boolean;
      durationMs: number;
      totalCostUsd: number;
      numTurns: number;
    }
  | { kind: 'status'; message: string }
  | { kind: 'error'; message: string };

export interface PermissionRequest {
  sessionId: string;
  requestId: string;
  toolName: string;
  /** Human readable sentence, e.g. "Claude wants to run: npm test". */
  title: string;
  description?: string;
  /** Readable view of the tool input; hidden/control characters are shown escaped. */
  detail: string;
  /**
   * False when the input was too long to show in full. Such requests can only be
   * rejected — the agent refuses an "allow" for them.
   */
  complete: boolean;
  /** Whether "always allow for this session" may be offered. */
  canRemember: boolean;
  /** Button label for the remember option when it does more than allow this one tool. */
  rememberLabel?: string;
  createdAt: number;
  expiresAt?: number;
}

export type ServerMessage =
  | {
      type: 'welcome';
      protocolVersion: number;
      device: { id: string; name: string };
      agent: { version: string; hostname: string; platform: string };
      projects: ProjectInfo[];
      sessions: SessionSummary[];
      pcSessions: PcSession[];
      mouse: MouseStatus;
    }
  | { type: 'pong'; t: number; serverTime: number }
  | { type: 'projects'; projects: ProjectInfo[] }
  | { type: 'error'; code: ErrorCode; message: string; ref?: string }

  // --- Mouse ---------------------------------------------------------------
  | { type: 'mouse.status'; status: MouseStatus; youHoldLease: boolean }
  | { type: 'mouse.position'; x: number; y: number }

  // --- Claude Code ---------------------------------------------------------
  | { type: 'claude.session'; session: SessionSummary }
  | {
      type: 'claude.session.snapshot';
      session: SessionSummary;
      events: Array<{ seq: number; at: number; event: ClaudeEvent }>;
      pendingPermissions: PermissionRequest[];
    }
  | { type: 'claude.event'; sessionId: string; seq: number; at: number; event: ClaudeEvent }
  | { type: 'claude.permission.request'; request: PermissionRequest }
  | {
      type: 'claude.permission.resolved';
      sessionId: string;
      requestId: string;
      decision: 'allow' | 'deny';
      reason: 'user' | 'timeout' | 'cancelled' | 'shutdown';
      deviceName?: string;
    }
  | { type: 'claude.sessions.history'; projectId: string; sessions: HistoricSession[] }
  /** A turn finished, in a phone session (`agent`) or a session on the PC (`pc`). */
  | {
      type: 'claude.task.done';
      source: 'agent' | 'pc';
      sessionId: string;
      /** Where it ran: project or folder name. */
      place: string;
      title?: string;
      isError: boolean;
    }

  // --- Claude sessions elsewhere on the PC (read-only) ----------------------
  | { type: 'pc.sessions'; sessions: PcSession[] }
  | {
      type: 'pc.session.snapshot';
      sessionId: string;
      events: Array<{ seq: number; at: number; event: ClaudeEvent }>;
    }
  | { type: 'pc.session.event'; sessionId: string; seq: number; at: number; event: ClaudeEvent };

export type ServerMessageType = ServerMessage['type'];

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'rate_limited'
  | 'not_found'
  | 'mouse_unavailable'
  | 'mouse_lease_held'
  | 'mouse_not_leased'
  | 'session_busy'
  | 'folder_not_allowed'
  | 'internal';

export type { MouseButton };
