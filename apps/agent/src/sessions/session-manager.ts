import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { listSessions, type query } from '@anthropic-ai/claude-agent-sdk';
import type { HistoricSession, PermissionRequest, SessionSummary } from '@voicecode/protocol';
import type { AgentConfig, ProjectConfig } from '../config/config.js';
import type { Logger } from '../util/logger.js';
import { ApprovalBroker, type ResolvedEvent } from '../claude/approval-broker.js';
import { ClaudeSession, type SessionEventRecord } from '../claude/claude-session.js';

export class SessionError extends Error {
  constructor(
    readonly code: 'not_found' | 'session_busy' | 'bad_request',
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
}> {
  readonly broker: ApprovalBroker;
  private readonly sessions = new Map<string, ClaudeSession>();

  constructor(
    private readonly config: AgentConfig,
    private readonly logger: Logger,
    private readonly queryFn?: typeof query,
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

  get(id: string): ClaudeSession {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError('not_found', `Unknown session ${id}`);
    return session;
  }

  start(projectId: string, resume?: string): ClaudeSession {
    const project = this.config.projects.find((p) => p.id === projectId);
    if (!project) throw new SessionError('not_found', 'Project is not in the allowed list');

    const live = [...this.sessions.values()].filter((s) => !s.isClosed);
    if (live.length >= this.config.claude.maxConcurrentSessions) {
      throw new SessionError('session_busy', 'Too many concurrent sessions; close one first');
    }
    if (resume && live.some((s) => s.summary().claudeSessionId === resume)) {
      throw new SessionError('session_busy', 'That Claude session is already open');
    }

    const session = new ClaudeSession({
      id: randomUUID(),
      project,
      resume,
      config: this.config.claude,
      broker: this.broker,
      logger: this.logger.child({ session: project.name }),
      queryFn: this.queryFn,
    });
    session.on('state', (summary) => this.emit('session', summary));
    session.on('event', (record) => this.emit('event', session.id, record));
    session.on('delta', (record) => this.emit('delta', session.id, record));
    this.sessions.set(session.id, session);
    session.start();
    this.logger.info({ project: project.path, resume }, 'claude session started');
    return session;
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
    this.broker.respond(requestId, decision, opts);
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
  }
}
