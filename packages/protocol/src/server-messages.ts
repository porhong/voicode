import type {
  EffortLevel,
  MouseButton,
  SessionState,
  StorageCategory,
  VoiceState,
  PermissionModeName,
} from './constants.js';

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

/** A folder in the workspace-root browser. */
export interface FolderEntry {
  name: string;
  /** Absolute, canonical path on the agent machine. */
  path: string;
  /** Already on the allow-list. */
  isProject: boolean;
  /** Has a `.git` folder: most likely a project. */
  isRepo: boolean;
}

export interface FolderListing {
  /** The folder listed; absent for the list of workspace roots themselves. */
  path?: string;
  /** One level up, when that is still inside a root. */
  parent?: string;
  entries: FolderEntry[];
  /** Some subfolders were left out (very large folder). */
  truncated: boolean;
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
  /** The reasoning effort chosen for the session; absent means the model's default. */
  effort?: EffortLevel;
  /** Claude Code's current permission mode, when known. */
  permissionMode?: PermissionModeName;
  /** The modes the phone may switch this session to, in display order. */
  modes?: PermissionModeName[];
  totalCostUsd?: number;
  /**
   * Absent for a session driven through the Agent SDK; `voice` for Claude Code in a
   * terminal (hosted or taken over), `desktop` for a session of the Claude Desktop app.
   */
  kind?: 'voice' | 'desktop';
  /** The Claude Code was started by the user (a terminal, Claude Desktop); we took control. */
  attached?: boolean;
  /** Voice sessions: what Claude Code's dictation is doing. */
  voice?: { state: VoiceState; detail?: string };
}

/** A model the phone can offer. */
export interface ModelChoice {
  /** What is sent back in `claude.model.set` (an alias or a model id). */
  value: string;
  label: string;
  description?: string;
  /** Effort levels the model takes: `[]` none, undefined when not known. */
  efforts?: EffortLevel[];
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
  /** The app running it, when not the terminal CLI. */
  app?: 'desktop';
}

export interface MouseStatus {
  available: boolean;
  driver: string;
  /** Explanation when unavailable. */
  reason?: string;
  holder?: { deviceId: string; deviceName: string };
}

/**
 * The virtual microphone the agent plays phone audio into, for Claude Code's own
 * dictation (`/voice`) on the PC. One device streams at a time.
 */
export interface VoiceMicStatus {
  available: boolean;
  driver: string;
  /** Explanation when unavailable (e.g. VB-CABLE not installed). */
  reason?: string;
  /** The output device or sink the audio is played into. */
  device?: string;
  holder?: { deviceId: string; deviceName: string };
}

export type ClaudeEvent =
  | {
      kind: 'user_prompt';
      text: string;
      deviceName: string;
      /** How many images came with the prompt. */
      images?: number;
    }
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

/**
 * What a usage limit counts: the rolling 5-hour session, the whole week, one model or
 * kind of use, or paid extra usage past the plan (its monthly spending cap).
 */
export type UsageScope = 'session' | 'week' | 'model' | 'apps' | 'extra';

/** One of the Claude plan's usage limits, as `/usage` reports it. */
export interface UsageLimit {
  /** Stable key, e.g. `five_hour`, `seven_day`, `model:Fable`, `extra`. */
  id: string;
  /** What the limit is, e.g. "Current session" or "Weekly · Opus". */
  label: string;
  /** A word or two for a small gauge, e.g. "5h" or "Opus". */
  short: string;
  scope: UsageScope;
  /** Percentage used, 0-100; null when Claude Code did not say. */
  utilization: number | null;
  /** When the window starts over (ms since epoch), if known. */
  resetsAt: number | null;
}

/** The Claude plan's usage limits; `available` is false for API keys and cloud providers. */
export interface UsageReport {
  available: boolean;
  /** 'pro', 'max', 'team', 'enterprise', or null. */
  plan: string | null;
  /** Tightest first is not implied: the order is session, weekly, per model, extra usage. */
  limits: UsageLimit[];
  fetchedAt: number;
  /** Why the limits could not be read, when they could not. */
  error?: string;
}

/** Disposable files on the PC and the automatic cleanup settings. */
export interface StorageInfo {
  categories: Array<{ category: StorageCategory; bytes: number; count: number }>;
  totalBytes: number;
  auto: boolean;
  maxCacheMb: number;
  lastCleanup?: CleanupResult;
}

export interface CleanupResult {
  at: number;
  trigger: 'manual' | 'auto';
  freedBytes: number;
  removed: number;
  /** Files still in use (e.g. by another running agent) are skipped and counted here. */
  failed: number;
}

export type ServerMessage =
  | {
      type: 'welcome';
      protocolVersion: number;
      device: { id: string; name: string };
      agent: { version: string; hostname: string; platform: string };
      projects: ProjectInfo[];
      /** Workspace roots; when not empty the device can browse them for a folder. */
      roots: string[];
      sessions: SessionSummary[];
      pcSessions: PcSession[];
      mouse: MouseStatus;
      voiceMic: VoiceMicStatus;
      /** Whether a terminal session can be taken over (keys and screen through its console). */
      pcControl: { available: boolean; reason?: string };
      /** Whether a Claude Desktop session can be taken over (through UI Automation). */
      desktopControl?: { available: boolean; reason?: string };
    }
  | { type: 'pong'; t: number; serverTime: number }
  | { type: 'projects'; projects: ProjectInfo[]; roots: string[] }
  | ({ type: 'folders.list' } & FolderListing)
  | { type: 'error'; code: ErrorCode; message: string; ref?: string }

  // --- Mouse ---------------------------------------------------------------
  | { type: 'mouse.status'; status: MouseStatus; youHoldLease: boolean }
  | { type: 'mouse.position'; x: number; y: number }

  // --- Microphone ----------------------------------------------------------
  | { type: 'voice.mic.status'; status: VoiceMicStatus; youHoldLease: boolean }

  // --- Terminal of a voice session (base64 of the raw bytes) ---------------
  | { type: 'terminal.snapshot'; sessionId: string; data: string; cols: number; rows: number }
  | { type: 'terminal.data'; sessionId: string; data: string }
  | { type: 'terminal.exit'; sessionId: string; code: number }

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
  | {
      type: 'claude.models';
      sessionId?: string;
      models: ModelChoice[];
      /** Switching also changes Claude Code's saved default on the PC (terminal sessions). */
      persistsDefault: boolean;
    }
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
  | { type: 'claude.usage'; usage: UsageReport }

  // --- Disposable files on the PC --------------------------------------------
  | { type: 'storage.info'; storage: StorageInfo }

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
  | 'mic_unavailable'
  | 'mic_lease_held'
  | 'mic_not_leased'
  | 'session_busy'
  | 'folder_not_allowed'
  | 'internal';

export type { MouseButton };
