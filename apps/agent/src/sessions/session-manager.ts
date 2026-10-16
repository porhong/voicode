import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { listSessions, type query } from '@anthropic-ai/claude-agent-sdk';
import type {
  EffortLevel,
  HistoricSession,
  ModelChoice,
  PcSession,
  PermissionRequest,
  SessionSummary,
  UsageReport,
} from '@voicecode/protocol';
import { MODEL_ALIASES } from '../claude/models.js';
import type { Attachment } from '../storage/attachments.js';
import { UNSAFE_PERMISSION_MODES, type PermissionModeName } from '@voicecode/protocol';

const UNSAFE_MODE_SET = new Set<string>(UNSAFE_PERMISSION_MODES);
import type { AgentConfig, ProjectConfig } from '../config/config.js';
import type { Logger } from '../util/logger.js';
import { ApprovalBroker, ApprovalError, type ResolvedEvent } from '../claude/approval-broker.js';
import { ClaudeSession, type SessionEventRecord } from '../claude/claude-session.js';
import { UsageMeter } from '../claude/usage.js';
import { HookServer, type HookDecision, type PreToolUseEvent } from '../claude/hook-server.js';
import { attachConsole, consoleAttachStatus } from '../claude/console-attach.js';
import {
  DesktopHelper,
  desktopControlStatus,
  type DesktopDriver,
} from '../desktop/desktop-helper.js';
import { DesktopSession } from '../desktop/desktop-session.js';
import {
  desktopHookInstalled,
  removeHookEndpoint,
  writeHookEndpoint,
} from '../desktop/approval-hook.js';
import {
  hookCommandLine,
  VoiceSession,
  type PtyHandle,
  type PtySpawn,
} from '../claude/pty-session.js';

/**
 * A phone session: driven through the SDK, hosted in (or attached to) a terminal, or a
 * Claude Desktop session taken over through its window.
 */
export type ManagedSession = ClaudeSession | VoiceSession | DesktopSession;

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
  private readonly usageMeter: UsageMeter;
  private readonly sessions = new Map<string, ManagedSession>();
  private hooks: HookServer | undefined;
  private hooksStarting: Promise<HookServer> | undefined;
  /** One helper drives the one Claude Desktop window for every session taken over. */
  private desktopDriver: DesktopDriver | undefined;

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
      desktop?: () => DesktopDriver;
      /** Where the hook server's address is written for Desktop's hook processes. */
      hookEndpointFile?: string;
    } = {},
    /** Folder of images from the phone; hosted terminal sessions may read it. */
    private readonly attachmentsDir?: string,
  ) {
    super();
    this.usageMeter = new UsageMeter({
      liveQuery: () => {
        for (const s of this.sessions.values()) {
          if (s instanceof ClaudeSession && s.liveQuery) return s.liveQuery;
        }
        return undefined;
      },
      logger,
      queryFn,
    });
    this.broker = new ApprovalBroker({ timeoutMs: config.claude.approvalTimeoutMs });
    this.broker.on('request', (request) => {
      this.sessions.get(request.sessionId)?.setAwaitingPermission(true);
      this.emit('permissionRequest', request);
    });
    this.broker.on('resolved', (event) => {
      const session = this.sessions.get(event.sessionId);
      if (event.interrupted) session?.markRejected();
      if (event.remembered.some((u) => u.type === 'setMode' && u.mode === 'acceptEdits')) {
        if (session && 'observeMode' in session) session.observeMode('acceptEdits');
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
  async startVoice(
    projectId: string,
    resume?: string,
    model?: string,
    effort?: EffortLevel,
  ): Promise<VoiceSession> {
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
      model,
      effort,
      readDirs: this.attachmentsDir ? [this.attachmentsDir] : [],
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
      attach: {
        pid: pc.pid,
        claudeSessionId: pc.sessionId,
        handle,
        title: pc.name ?? pc.lastPrompt ?? `Terminal in ${pc.folder}`,
      },
      claudeDir: this.voiceDeps.claudeDir,
    });
    this.track(session);
    session.on('terminal', (data) => this.emit('terminal', session.id, data));
    session.on('exit', (code) => this.emit('terminalExit', session.id, code));
    session.start();
    this.logger.info({ project: project.path, pid: pc.pid }, 'took control of a terminal session');
    return session;
  }

  /** Whether `controlDesktop` can work on this PC. */
  desktopControlStatus(): { available: boolean; reason?: string } {
    if (this.voiceDeps.desktop) return { available: true };
    const status = desktopControlStatus();
    if (!status.available) return status;
    // Approvals come through Claude Code's PermissionRequest hook, set up on the PC.
    return desktopHookInstalled()
      ? status
      : {
          available: false,
          reason: 'run `voicecode-agent desktop enable` on the PC to control Claude Desktop',
        };
  }

  /**
   * Takes control of a Claude Code session of the Claude Desktop app: prompts are typed
   * into Desktop's window and its permission requests are answered from the phone.
   * Closing only lets go; the session carries on in Desktop.
   */
  async controlDesktop(pc: PcSession): Promise<DesktopSession> {
    const status = this.desktopControlStatus();
    if (!status.available) throw new SessionError('bad_request', status.reason ?? 'unavailable');
    const project = this.projectForFolder(pc.cwd);
    if (!project)
      throw new SessionError('folder_not_allowed', `${pc.cwd} is not an allowed folder`);
    const taken = [...this.sessions.values()].some(
      (s) => !s.isClosed && s.summary().claudeSessionId === pc.sessionId,
    );
    if (taken) throw new SessionError('session_busy', 'That session is already controlled');
    this.checkCapacity();
    await this.ensureHooks();
    this.desktopDriver ??=
      this.voiceDeps.desktop?.() ??
      new DesktopHelper(this.logger.child({ component: 'desktop-helper' }));
    const session = new DesktopSession({
      id: randomUUID(),
      project,
      config: this.config.claude,
      broker: this.broker,
      logger: this.logger.child({ session: project.name, kind: 'desktop', pid: pc.pid }),
      driver: this.desktopDriver,
      pc: { pid: pc.pid, claudeSessionId: pc.sessionId },
      claudeDir: this.voiceDeps.claudeDir,
    });
    try {
      await session.start();
    } catch (err) {
      session.close();
      throw new SessionError(
        'bad_request',
        `Could not take control in Claude Desktop: ${(err as Error).message}`,
      );
    }
    this.track(session);
    session.touch();
    return session;
  }

  private ensureHooks(): Promise<HookServer> {
    if (this.hooks) return Promise.resolve(this.hooks);
    this.hooksStarting ??= (async () => {
      const server = new HookServer(
        {
          preToolUse: (event) => this.decideHook(event),
          permissionRequest: (event) => this.decidePermissionRequest(event),
        },
        this.logger,
      );
      await server.start();
      this.hooks = server;
      const file = this.voiceDeps.hookEndpointFile;
      if (file) {
        await writeHookEndpoint(file, { url: server.url, token: server.token }).catch(
          (err: unknown) => this.logger.warn({ err }, 'could not write the hook endpoint'),
        );
      }
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
    const mode = event.permission_mode ?? session.currentMode ?? this.config.claude.permissionMode;
    if (mode === 'acceptEdits' && EDIT_TOOLS.has(event.tool_name)) return undefined;
    // Modes that skip approvals are left to Claude Code only when the PC allows them;
    // otherwise the phone still decides, whatever mode the terminal was put in.
    if (this.config.claude.allowUnsafeModes && UNSAFE_MODE_SET.has(mode)) return undefined;
    return this.broker.ask(session.id, event.tool_name, event.tool_input);
  }

  /**
   * A permission request Claude Code is about to show (the hook `desktop enable` adds):
   * answered from the phone for a Claude Desktop session the phone controls, and left to
   * Claude Code's own dialog for every other session.
   */
  async decidePermissionRequest(event: PreToolUseEvent): Promise<HookDecision | undefined> {
    const session = [...this.sessions.values()].find(
      (s): s is DesktopSession =>
        s instanceof DesktopSession && s.summary().claudeSessionId === event.session_id,
    );
    if (!session || session.isClosed) return undefined;
    return session.askPermission(event.tool_name, event.tool_input);
  }

  /** Push-to-talk for a voice session. */
  ptt(sessionId: string, pressed: boolean, deviceName: string): void {
    void this.getVoice(sessionId).pressPtt(pressed, deviceName);
  }

  start(
    projectId: string,
    resume?: string,
    opts: { fork?: boolean; model?: string; effort?: EffortLevel } = {},
  ): ClaudeSession {
    const project = this.project(projectId);
    this.checkCapacity(resume, opts.fork);

    const session = new ClaudeSession({
      id: randomUUID(),
      project,
      resume,
      fork: opts.fork,
      model: opts.model,
      effort: opts.effort,
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

  /** A prompt from the phone, with any images it attached (already stored). */
  async prompt(
    sessionId: string,
    text: string,
    deviceName: string,
    images: Attachment[] = [],
  ): Promise<void> {
    const session = this.get(sessionId);
    if (session instanceof VoiceSession) {
      // Claude Code in a terminal is told where the files are and reads them itself.
      session.sendPrompt(
        text,
        deviceName,
        images.map((i) => i.path),
      );
      return;
    }
    if (session instanceof DesktopSession) {
      try {
        await session.sendPrompt(
          text,
          deviceName,
          images.map((i) => i.path),
        );
      } catch (err) {
        throw new SessionError('bad_request', (err as Error).message);
      }
      return;
    }
    const blocks = await Promise.all(
      images.map(async (image) => ({
        mediaType: image.mediaType,
        data: (await readFile(image.path)).toString('base64'),
      })),
    );
    session.sendPrompt(text, deviceName, blocks);
  }

  async interrupt(sessionId: string): Promise<void> {
    try {
      await this.get(sessionId).interrupt();
    } catch (err) {
      if (err instanceof SessionError) throw err;
      throw new SessionError('bad_request', (err as Error).message);
    }
  }

  rename(sessionId: string, title: string): void {
    this.get(sessionId).rename(title);
  }

  async setModel(sessionId: string, model: string | null): Promise<void> {
    const session = this.get(sessionId);
    try {
      await session.setModel(model);
    } catch (err) {
      throw new SessionError('bad_request', (err as Error).message);
    }
  }

  /** Phone (SDK) sessions only: a terminal's `/effort` would also rewrite the PC's settings. */
  async setMode(sessionId: string, mode: PermissionModeName): Promise<void> {
    const session = this.get(sessionId);
    try {
      await session.setMode(mode);
    } catch (err) {
      throw new SessionError('bad_request', (err as Error).message);
    }
    this.logger.info({ session: sessionId, mode }, 'permission mode changed from the phone');
  }

  /**
   * Applies `modes allow-unsafe` / `safe-only` from the PC. Turning unsafe modes off
   * moves every session that is in one back to manual (default) mode.
   */
  async setUnsafeModesAllowed(allowed: boolean): Promise<void> {
    this.config.claude.allowUnsafeModes = allowed;
    for (const session of this.sessions.values()) {
      if (session.isClosed) continue;
      const mode = session.currentMode;
      if (!allowed && mode && UNSAFE_MODE_SET.has(mode)) {
        await session.setMode('default').catch((err: unknown) => {
          this.logger.warn({ err, session: session.id }, 'could not leave an unsafe mode');
        });
      }
      session.touch();
    }
    this.logger.info({ allowed }, 'unsafe permission modes setting changed');
  }

  async setEffort(sessionId: string, effort: EffortLevel | null): Promise<void> {
    const session = this.get(sessionId);
    if (session instanceof VoiceSession) {
      throw new SessionError(
        'bad_request',
        'Terminal sessions take the effort when they start; start a new one to change it.',
      );
    }
    if (session instanceof DesktopSession) {
      throw new SessionError('bad_request', 'Set the effort in Claude Desktop itself.');
    }
    try {
      await session.setEffort(effort);
    } catch (err) {
      throw new SessionError('bad_request', (err as Error).message);
    }
  }

  /** What the phone's model picker offers, for a session or in general. */
  async models(sessionId?: string): Promise<{ models: ModelChoice[]; persistsDefault: boolean }> {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (session instanceof VoiceSession) return { models: session.models(), persistsDefault: true };
    if (session instanceof DesktopSession) {
      try {
        return { models: await session.models(), persistsDefault: false };
      } catch (err) {
        throw new SessionError('bad_request', (err as Error).message);
      }
    }
    if (session) return { models: await session.models(), persistsDefault: false };
    return { models: MODEL_ALIASES, persistsDefault: false };
  }

  /** The Claude plan's usage limits (shared by every session on this PC). */
  usage(refresh = false): Promise<UsageReport> {
    return this.usageMeter.get(refresh);
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
    this.usageMeter.close();
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    void this.hooks?.stop();
    if (this.hooks && this.voiceDeps.hookEndpointFile) {
      void removeHookEndpoint(this.voiceDeps.hookEndpointFile).catch(() => undefined);
    }
    this.hooks = undefined;
    this.desktopDriver?.close();
    this.desktopDriver = undefined;
  }
}
