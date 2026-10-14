import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { listSessions, type query } from '@anthropic-ai/claude-agent-sdk';
import type {
  HistoricSession,
  PcSession,
  PermissionRequest,
  SessionSummary,
} from '@voicecode/protocol';
import type { AgentConfig, ProjectConfig } from '../config/config.js';
import type { Logger } from '../util/logger.js';
import { ApprovalBroker, ApprovalError, type ResolvedEvent } from '../claude/approval-broker.js';
import { ClaudeSession, type SessionEventRecord } from '../claude/claude-session.js';
import { HookServer, type HookDecision, type PreToolUseEvent } from '../claude/hook-server.js';
import { attachConsole, consoleAttachStatus } from '../claude/console-attach.js';
import {
  hookCommandLine,
  VoiceSession,
  type PtyHandle,
  type PtySpawn,
} from '../claude/pty-session.js';

/** A phone session, driven through the SDK or hosted in a terminal for dictation. */
export type ManagedSession = ClaudeSession | VoiceSession;

/**
 * Tools Claude Code runs without asking anyway (reads, bookkeeping); a hook that asked
 * the phone for each of these would interrupt far more than the SDK path does.
 */
const PASSTHROUGH_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'TodoRead',
  'TodoWrite',
  'Task',
  'NotebookRead',
  'BashOutput',
  'KillShell',
  'TaskOutput',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export class SessionError extends Error {
  constructor(
    readonly code: 'not_found' | 'session_busy' | 'bad_request' | 'folder_not_allowed',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Owns the live Claude Code sessions and the approval broker, and fans their events
 * out as a single stream for the WebSocket gateway to broadcast.
 */
export class SessionManager extends EventEmitter<{
  session: [summary: SessionSummary];
  event: [sessionId: string, record: SessionEventRecord];
  delta: [sessionId: string, record: SessionEventRecord];
  permissionRequest: [request: PermissionRequest];
  permissionResolved: [event: ResolvedEvent];
  /** Raw terminal output of a voice session. */
  terminal: [sessionId: string, data: string];
  terminalExit: [sessionId: string, code: number];
}> {
  readonly broker: ApprovalBroker;
  private readonly sessions = new Map<string, ManagedSession>();
  private hooks: HookServer | undefined;
  private hooksStarting: Promise<HookServer> | undefined;

  constructor(
    private readonly config: AgentConfig,
    private readonly logger: Logger,
    private readonly queryFn?: typeof query,
    /** Injection points for tests of voice sessions. */
    private readonly voiceDeps: {
      spawn?: PtySpawn;
      claudePath?: string;
      claudeDir?: string;
      attach?: (pid: number) => Promise<PtyHandle>;
    } = {},
  ) {
    super();
    this.broker = new ApprovalBroker({ timeoutMs: config.claude.approvalTimeoutMs });
    this.broker.on('request', (request) => {
      this.sessions.get(request.sessionId)?.setAwaitingPermission(true);
      this.emit('permissionRequest', request);
    });
    this.broker.on('resolved', (event) => {
      const session = this.sessions.get(event.sessionId);
      if (event.interrupted) session?.markRejected();
      if (event.remembered.some((u) => u.type === 'setMode' && u.mode === 'acceptEdits')) {
        session?.noteStatus(
          'File edits will be accepted automatically for the rest of this session.',
        );
      }
      session?.setAwaitingPermission(this.broker.pendingFor(event.sessionId).length > 0);
      this.emit('permissionResolved', event);
    });
  }

  get projects(): ProjectConfig[] {
    return this.config.projects;
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => s.summary());
  }

  get(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError('not_found', `Unknown session ${id}`);
    return session;
  }

  /** A voice session, for the operations only a terminal-hosted session has. */
  getVoice(id: string): VoiceSession {
    const session = this.get(id);
    if (!(session instanceof VoiceSession)) {
      throw new SessionError('bad_request', 'That session is not a Claude Code voice session');
    }
    return session;
  }

  private checkCapacity(resume?: string, fork?: boolean): void {
    const live = [...this.sessions.values()].filter((s) => !s.isClosed);
    if (live.length >= this.config.claude.maxConcurrentSessions) {
      throw new SessionError('session_busy', 'Too many concurrent sessions; close one first');
    }
    if (resume && !fork && live.some((s) => s.summary().claudeSessionId === resume)) {
      throw new SessionError('session_busy', 'That Claude session is already open');
    }
  }

  private project(projectId: string): ProjectConfig {
    const project = this.config.projects.find((p) => p.id === projectId);
    if (!project) throw new SessionError('not_found', 'Project is not in the allowed list');
    return project;
  }

  private track(session: ManagedSession): void {
    session.on('state', (summary) => this.emit('session', summary));
    session.on('event', (record) => this.emit('event', session.id, record));
    session.on('delta', (record) => this.emit('delta', session.id, record));
    this.sessions.set(session.id, session);
  }

  /**
   * An interactive Claude Code in a pseudo-terminal, for dictation through Claude Code's
   * own `/voice`. Its tool calls come back through the hook server for phone approval.
   */
  async startVoice(projectId: string, resume?: string): Promise<VoiceSession> {
    const project = this.project(projectId);
    this.checkCapacity(resume);
    const hooks = await this.ensureHooks();
    const session = new VoiceSession({
      id: randomUUID(),
      project,
      resume,
      config: this.config.claude,
      broker: this.broker,
      logger: this.logger.child({ session: project.name, kind: 'voice' }),
      hook: { url: hooks.url, token: hooks.token, command: hookCommandLine() },
      spawn: this.voiceDeps.spawn,
      claudePath: this.voiceDeps.claudePath,
      claudeDir: this.voiceDeps.claudeDir,
    });
    this.track(session);
    session.on('terminal', (data) => this.emit('terminal', session.id, data));
    session.on('exit', (code) => this.emit('terminalExit', session.id, code));
    session.start();
    this.logger.info({ project: project.path, resume }, 'claude voice session started');
    return session;
  }

  /** Whether `controlPc` can work on this PC. */
  pcControlStatus(): { available: boolean; reason?: string } {
    return this.voiceDeps.attach ? { available: true } : consoleAttachStatus();
  }

  /**
   * Takes control of a Claude Code running in the user's terminal: the phone's dictation,
   * prompts and keys go to that process through its console, and its transcript is
   * followed like a hosted session's. Nothing is forked; closing only detaches.
   */
  async controlPc(pc: PcSession): Promise<VoiceSession> {
    const status = this.pcControlStatus();
    if (!status.available) throw new SessionError('bad_request', status.reason ?? 'unavailable');
    const project = this.projectForFolder(pc.cwd);
    if (!project)
      throw new SessionError('folder_not_allowed', `${pc.cwd} is not an allowed folder`);
    const taken = [...this.sessions.values()].some(
      (s) => !s.isClosed && s.summary().claudeSessionId === pc.sessionId,
    );
    if (taken)
      throw new SessionError('session_busy', 'That terminal session is already controlled');
    this.checkCapacity();
    const attach = this.voiceDeps.attach ?? ((pid) => attachConsole(pid, this.logger));
    let handle: PtyHandle;
    try {
      handle = await attach(pc.pid);
    } catch (err) {
      throw new SessionError(
        'bad_request',
        `Could not attach to the terminal: ${(err as Error).message}`,
      );
    }
    const session = new VoiceSession({
      id: randomUUID(),
      project,
      config: this.config.claude,
      broker: this.broker,
      logger: this.logger.child({ session: project.name, kind: 'voice', pid: pc.pid }),
      attach: { pid: pc.pid, claudeSessionId: pc.sessionId, handle },
      claudeDir: this.voiceDeps.claudeDir,
    });
    this.track(session);
    session.on('terminal', (data) => this.emit('terminal', session.id, data));
    session.on('exit', (code) => this.emit('terminalExit', session.id, code));
    session.start();
    this.logger.info({ project: project.path, pid: pc.pid }, 'took control of a terminal session');
    return session;
  }

  private ensureHooks(): Promise<HookServer> {
    if (this.hooks) return Promise.resolve(this.hooks);
    this.hooksStarting ??= (async () => {
      const server = new HookServer((event) => this.decideHook(event), this.logger);
      await server.start();
      this.hooks = server;
      return server;
    })().finally(() => (this.hooksStarting = undefined));
    return this.hooksStarting;
  }

  /** A tool call from a hosted Claude Code; `undefined` leaves it to the CLI's own prompt. */
  async decideHook(event: PreToolUseEvent): Promise<HookDecision | undefined> {
    const session = [...this.sessions.values()].find(
      (s): s is VoiceSession =>
        s instanceof VoiceSession && s.summary().claudeSessionId === event.session_id,
    );
    if (!session || session.isClosed) return undefined;
    if (PASSTHROUGH_TOOLS.has(event.tool_name)) return undefined;
    if (this.config.claude.permissionMode === 'acceptEdits' && EDIT_TOOLS.has(event.tool_name)) {
      return undefined;
    }
    return this.broker.ask(session.id, event.tool_name, event.tool_input);
  }

  /** Push-to-talk for a voice session. */
  ptt(sessionId: string, pressed: boolean, deviceName: string): void {
    void this.getVoice(sessionId).pressPtt(pressed, deviceName);
  }

  start(projectId: string, resume?: string, opts: { fork?: boolean } = {}): ClaudeSession {
    const project = this.project(projectId);
    this.checkCapacity(resume, opts.fork);

    const session = new ClaudeSession({
      id: randomUUID(),
      project,
      resume,
      fork: opts.fork,
      config: this.config.claude,
      broker: this.broker,
      logger: this.logger.child({ session: project.name }),
      queryFn: this.queryFn,
    });
    this.track(session);
    session.start();
    this.logger.info({ project: project.path, resume, fork: opts.fork }, 'claude session started');
    return session;
  }

  /** Whether a Claude Code session id belongs to one of the agent's own sessions. */
  owns(claudeSessionId: string): boolean {
    for (const s of this.sessions.values()) {
      if (s.summary().claudeSessionId === claudeSessionId) return true;
    }
    return false;
  }

  /**
   * The allow-listed project whose folder is `dir`. Both sides are resolved to their
   * canonical form first: Claude Code may report a folder through a symlink or a
   * Windows short (8.3) name that differs from the stored realpath.
   */
  projectForFolder(dir: string): ProjectConfig | undefined {
    const norm = (p: string) => {
      let resolved = path.resolve(p);
      try {
        resolved = realpathSync.native(resolved);
      } catch {
        // A folder that no longer exists can only match textually.
      }
      resolved = resolved.replace(/[\\/]+$/, '');
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const wanted = norm(dir);
    return this.config.projects.find((p) => norm(p.path) === wanted);
  }

  prompt(sessionId: string, text: string, deviceName: string): void {
    this.get(sessionId).sendPrompt(text, deviceName);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.get(sessionId).interrupt();
  }

  close(sessionId: string): void {
    const session = this.get(sessionId);
    session.close();
    this.sessions.delete(sessionId);
  }

  respond(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'deny',
    opts: { rememberForSession?: boolean; message?: string; deviceName: string },
  ): void {
    const request = this.broker.get(requestId);
    if (!request || request.sessionId !== sessionId) {
      throw new SessionError('not_found', 'That approval request is no longer pending');
    }
    try {
      this.broker.respond(requestId, decision, opts);
    } catch (err) {
      if (err instanceof ApprovalError) throw new SessionError('bad_request', err.message);
      throw err;
    }
  }

  /** Earlier Claude Code sessions for a project, newest first, for resuming. */
  async history(projectId: string): Promise<HistoricSession[]> {
    const project = this.config.projects.find((p) => p.id === projectId);
    if (!project) throw new SessionError('not_found', 'Project is not in the allowed list');
    const sessions = await listSessions({ dir: project.path, limit: 20 });
    return sessions.map((s) => ({
      claudeSessionId: s.sessionId,
      summary: s.customTitle ?? s.summary,
      lastModified: s.lastModified,
      gitBranch: s.gitBranch,
    }));
  }

  closeAll(): void {
    this.broker.cancelAll('shutdown');
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    void this.hooks?.stop();
    this.hooks = undefined;
  }
}
