import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { WebSocket } from 'ws';
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type FolderListing,
  type ServerMessage,
} from '@voicecode/protocol';
import type { InputRouter, ClientIdentity, RouterResult } from '../mouse/input-router.js';
import type { DeviceRegistry, PublicDevice } from '../pairing/device-registry.js';
import type { ProjectConfig } from '../config/config.js';
import type { PcSessionWatcher } from '../sessions/pc-sessions.js';
import { SessionError, type SessionManager } from '../sessions/session-manager.js';
import type { Logger } from '../util/logger.js';
import { VERSION } from '../util/version.js';
import type { MicRouter } from '../voice/mic-router.js';
import { TokenBucket } from './token-bucket.js';

const HEARTBEAT_MS = 15_000;
/** Close codes in the 4000-4999 application range. */
export const CLOSE_REVOKED = 4001;
export const CLOSE_SHUTDOWN = 4002;

interface Connection {
  identity: ClientIdentity;
  device: PublicDevice;
  socket: WebSocket;
  bucket: TokenBucket;
  alive: boolean;
  /** Last time an error of a given code was sent, to avoid flooding the client. */
  lastErrorAt: Map<ErrorCode, number>;
  /** Set when the device is revoked: the socket may linger while closing, input must not. */
  revoked: boolean;
  /** The PC session whose transcript this client is following, if any. */
  pcSubscription?: string;
  /** The voice session whose terminal this client has open, if any. */
  terminal?: string;
}

/**
 * Authenticated WebSocket connections from paired devices. Validates every inbound
 * message, applies per-connection rate limits, dispatches to the mouse router, the
 * microphone router and the session manager, and broadcasts their state changes to all
 * devices. Binary frames carry microphone audio and are only accepted from the
 * connection that holds the microphone lease.
 */
export class WsGateway {
  private readonly connections = new Map<string, Connection>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly deps: {
      router: InputRouter;
      mic: MicRouter;
      sessions: SessionManager;
      registry: DeviceRegistry;
      logger: Logger;
      onConnectionsChanged?: (count: number) => void;
      /** Claude sessions elsewhere on the PC; omitted in tests that don't need them. */
      pcSessions?: PcSessionWatcher;
      /** Adds a folder to the allow-list (after the user confirmed it on the phone). */
      allowFolder?: (dir: string, deviceName: string) => Promise<ProjectConfig>;
      /** Workspace roots a device may browse and open folders in; omitted in tests. */
      folders?: {
        roots: () => string[];
        list: (dir?: string) => Promise<FolderListing>;
        /** Resolves a folder inside a root and allows it as a project. */
        open: (dir: string, deviceName: string) => Promise<ProjectConfig>;
      };
    },
  ) {
    const { router, mic, sessions, registry, pcSessions } = deps;

    router.on('status', () => {
      const status = router.status();
      for (const c of this.connections.values()) {
        this.send(c, { type: 'mouse.status', status, youHoldLease: router.holds(c.identity) });
      }
    });
    mic.on('status', () => {
      const status = mic.status();
      for (const c of this.connections.values()) {
        this.send(c, { type: 'voice.mic.status', status, youHoldLease: mic.holds(c.identity) });
      }
    });

    sessions.on('session', (session) => this.broadcast({ type: 'claude.session', session }));
    sessions.on('event', (sessionId, r) => {
      this.broadcast({ type: 'claude.event', sessionId, seq: r.seq, at: r.at, event: r.event });
      if (r.event.kind === 'result') {
        const session = sessions.get(sessionId);
        this.broadcast({
          type: 'claude.task.done',
          source: 'agent',
          sessionId,
          place: session.project.name,
          title: session.summary().title,
          isError: r.event.isError,
        });
      }
    });

    pcSessions?.on('changed', (list) => this.broadcast({ type: 'pc.sessions', sessions: list }));
    pcSessions?.on('event', (sessionId, r) => {
      for (const c of this.connections.values()) {
        if (c.pcSubscription !== sessionId) continue;
        this.send(c, { type: 'pc.session.event', sessionId, ...r });
      }
    });
    pcSessions?.on('done', (pc) =>
      this.broadcast({
        type: 'claude.task.done',
        source: 'pc',
        sessionId: pc.sessionId,
        place: pc.folder,
        title: pc.lastPrompt ?? pc.name,
        isError: false,
      }),
    );
    sessions.on('delta', (sessionId, r) =>
      this.broadcast({ type: 'claude.event', sessionId, seq: r.seq, at: r.at, event: r.event }),
    );
    sessions.on('terminal', (sessionId, data) => {
      const encoded = Buffer.from(data, 'utf8').toString('base64');
      for (const c of this.connections.values()) {
        if (c.terminal === sessionId)
          this.send(c, { type: 'terminal.data', sessionId, data: encoded });
      }
    });
    sessions.on('terminalExit', (sessionId, code) => {
      for (const c of this.connections.values()) {
        if (c.terminal === sessionId) this.send(c, { type: 'terminal.exit', sessionId, code });
      }
    });
    sessions.on('permissionRequest', (request) =>
      this.broadcast({ type: 'claude.permission.request', request }),
    );
    sessions.on('permissionResolved', ({ sessionId, requestId, decision, reason, deviceName }) =>
      this.broadcast({
        type: 'claude.permission.resolved',
        sessionId,
        requestId,
        decision,
        reason,
        deviceName,
      }),
    );

    registry.on('revoked', (deviceId) => {
      for (const c of this.connections.values()) {
        if (c.device.id !== deviceId) continue;
        c.revoked = true;
        this.deps.router.disconnect(c.identity);
        this.deps.mic.disconnect(c.identity);
        c.socket.close(CLOSE_REVOKED, 'device revoked');
        // A client that ignores the close frame is cut off instead of lingering.
        setTimeout(() => c.socket.terminate(), 1_000).unref();
      }
    });

    this.heartbeat = setInterval(() => {
      for (const c of this.connections.values()) {
        if (!c.alive) {
          c.socket.terminate();
          continue;
        }
        c.alive = false;
        c.socket.ping();
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get count(): number {
    return this.connections.size;
  }

  devicesOnline(): Array<{ deviceId: string; deviceName: string; connectionId: string }> {
    return [...this.connections.values()].map((c) => ({
      deviceId: c.device.id,
      deviceName: c.device.name,
      connectionId: c.identity.connectionId,
    }));
  }

  handle(socket: WebSocket, device: PublicDevice): void {
    const { router, mic, sessions, logger } = this.deps;
    const identity: ClientIdentity = {
      connectionId: randomUUID(),
      deviceId: device.id,
      deviceName: device.name,
    };
    const conn: Connection = {
      identity,
      device,
      socket,
      // Mouse moves arrive at up to ~120 Hz; allow bursts well above that.
      bucket: new TokenBucket(400, 200),
      alive: true,
      lastErrorAt: new Map(),
      revoked: false,
    };
    this.connections.set(identity.connectionId, conn);
    this.deps.onConnectionsChanged?.(this.count);
    logger.info({ device: device.name }, 'device connected');

    socket.on('pong', () => (conn.alive = true));
    socket.on('message', (data, isBinary) => {
      if (conn.revoked) return;
      conn.alive = true;
      if (!conn.bucket.take()) return this.error(conn, 'rate_limited', 'Too many messages');
      if (isBinary) {
        // Microphone audio; the router checks that this connection holds the lease.
        return this.check(conn, mic.write(identity, Buffer.isBuffer(data) ? data : toBuffer(data)));
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return this.error(conn, 'bad_request', 'Invalid JSON');
      }
      const result = ClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        return this.error(
          conn,
          'bad_request',
          result.error.issues[0]?.message ?? 'Invalid message',
        );
      }
      this.dispatch(conn, result.data).catch((err: unknown) => {
        if (err instanceof SessionError) return this.error(conn, err.code, err.message);
        logger.error({ err }, 'message handling failed');
        this.error(conn, 'internal', 'Internal error');
      });
    });
    socket.on('close', () => {
      this.connections.delete(identity.connectionId);
      router.disconnect(identity);
      mic.disconnect(identity);
      this.deps.onConnectionsChanged?.(this.count);
      logger.info({ device: device.name }, 'device disconnected');
    });
    socket.on('error', (err) => logger.debug({ err }, 'websocket error'));

    this.send(conn, {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      device: { id: device.id, name: device.name },
      agent: { version: VERSION, hostname: os.hostname(), platform: process.platform },
      projects: sessions.projects.map(({ id, name, path }) => ({ id, name, path })),
      roots: this.deps.folders?.roots() ?? [],
      sessions: sessions.list(),
      pcSessions: this.deps.pcSessions?.list() ?? [],
      mouse: router.status(),
      voiceMic: mic.status(),
      pcControl: sessions.pcControlStatus(),
    });
    for (const request of sessions.broker.pendingFor()) {
      this.send(conn, { type: 'claude.permission.request', request });
    }
  }

  broadcastProjects(projects: Array<{ id: string; name: string; path: string }>): void {
    this.broadcast({
      type: 'projects',
      projects: projects.map(({ id, name, path }) => ({ id, name, path })),
      roots: this.deps.folders?.roots() ?? [],
    });
  }

  closeAll(): void {
    clearInterval(this.heartbeat);
    for (const c of this.connections.values())
      c.socket.close(CLOSE_SHUTDOWN, 'agent shutting down');
  }

  private async dispatch(conn: Connection, msg: ClientMessage): Promise<void> {
    const { router, mic, sessions } = this.deps;
    const id = conn.identity;

    switch (msg.type) {
      case 'ping':
        return this.send(conn, { type: 'pong', t: msg.t, serverTime: Date.now() });

      case 'mouse.acquire':
        this.check(conn, router.acquire(id, msg.force));
        return this.send(conn, {
          type: 'mouse.status',
          status: router.status(),
          youHoldLease: router.holds(id),
        });
      case 'mouse.release':
        return this.check(conn, router.release(id));
      case 'mouse.move':
        return this.check(conn, router.move(id, msg.dx, msg.dy));
      case 'mouse.button.down':
        return this.check(conn, router.button(id, msg.button, true));
      case 'mouse.button.up':
        return this.check(conn, router.button(id, msg.button, false));
      case 'mouse.click':
        return this.check(conn, router.click(id, msg.button, msg.count));
      case 'mouse.scroll':
        return this.check(conn, router.scroll(id, msg.dx, msg.dy));
      case 'mouse.position': {
        if (!router.holds(id))
          return this.error(conn, 'mouse_not_leased', 'Acquire the mouse first');
        const { x, y } = await router.position();
        return this.send(conn, { type: 'mouse.position', x, y });
      }

      case 'voice.mic.start':
        this.check(conn, mic.acquire(id));
        return this.send(conn, {
          type: 'voice.mic.status',
          status: mic.status(),
          youHoldLease: mic.holds(id),
        });
      case 'voice.mic.stop':
        return this.check(conn, mic.release(id));
      case 'voice.session.start': {
        const session = await sessions.startVoice(msg.projectId, msg.resume);
        return this.sendSnapshot(conn, session.id);
      }
      case 'voice.ptt':
        return sessions.ptt(msg.sessionId, msg.pressed, conn.device.name);

      case 'terminal.subscribe': {
        const session = sessions.getVoice(msg.sessionId);
        session.resize(msg.cols, msg.rows);
        conn.terminal = msg.sessionId;
        const snapshot = session.snapshot();
        return this.send(conn, {
          type: 'terminal.snapshot',
          sessionId: msg.sessionId,
          data: Buffer.from(snapshot.data, 'utf8').toString('base64'),
          cols: snapshot.cols,
          rows: snapshot.rows,
        });
      }
      case 'terminal.unsubscribe':
        conn.terminal = undefined;
        return;
      case 'terminal.input':
        if (conn.terminal !== msg.sessionId) {
          throw new SessionError('bad_request', 'Open the terminal first');
        }
        return sessions.getVoice(msg.sessionId).writeInput(msg.data);
      case 'terminal.resize':
        if (conn.terminal !== msg.sessionId) {
          throw new SessionError('bad_request', 'Open the terminal first');
        }
        return sessions.getVoice(msg.sessionId).resize(msg.cols, msg.rows);

      case 'claude.session.start': {
        const session = sessions.start(msg.projectId, msg.resume);
        return this.sendSnapshot(conn, session.id);
      }
      case 'claude.session.subscribe':
        return this.sendSnapshot(conn, msg.sessionId);
      case 'claude.session.close':
        return sessions.close(msg.sessionId);
      case 'claude.sessions.history':
        return this.send(conn, {
          type: 'claude.sessions.history',
          projectId: msg.projectId,
          sessions: await sessions.history(msg.projectId),
        });
      case 'claude.prompt':
        return sessions.prompt(msg.sessionId, msg.text, conn.device.name);
      case 'claude.interrupt':
        return sessions.interrupt(msg.sessionId);
      case 'pc.session.subscribe': {
        const pc = this.deps.pcSessions;
        if (!pc?.get(msg.sessionId)) {
          throw new SessionError('not_found', 'That session is no longer running on the PC');
        }
        conn.pcSubscription = msg.sessionId;
        return this.send(conn, {
          type: 'pc.session.snapshot',
          sessionId: msg.sessionId,
          events: pc.events(msg.sessionId),
        });
      }
      case 'pc.session.unsubscribe':
        conn.pcSubscription = undefined;
        return;
      case 'pc.session.continue': {
        const pc = this.deps.pcSessions?.get(msg.sessionId);
        if (!pc) throw new SessionError('not_found', 'That session is no longer running on the PC');
        if (pc.status === 'working' || pc.status === 'waiting') {
          // Two Claudes editing the same folder at once would trip over each other.
          throw new SessionError(
            'session_busy',
            'It is still working on the PC. Continue once it has finished.',
          );
        }
        let project = sessions.projectForFolder(pc.cwd);
        if (!project) {
          if (!msg.allowFolder || !this.deps.allowFolder) {
            throw new SessionError('folder_not_allowed', `${pc.cwd} is not an allowed folder`);
          }
          project = await this.deps.allowFolder(pc.cwd, conn.device.name);
        }
        conn.pcSubscription = undefined;
        const session = sessions.start(project.id, pc.sessionId, { fork: true });
        return this.sendSnapshot(conn, session.id);
      }

      case 'pc.session.control': {
        const pc = this.deps.pcSessions?.get(msg.sessionId);
        if (!pc) throw new SessionError('not_found', 'That session is no longer running on the PC');
        if (!sessions.projectForFolder(pc.cwd)) {
          if (!msg.allowFolder || !this.deps.allowFolder) {
            throw new SessionError('folder_not_allowed', `${pc.cwd} is not an allowed folder`);
          }
          await this.deps.allowFolder(pc.cwd, conn.device.name);
        }
        conn.pcSubscription = undefined;
        const session = await sessions.controlPc(pc);
        return this.sendSnapshot(conn, session.id);
      }

      case 'folders.list': {
        const folders = this.deps.folders;
        if (!folders)
          throw new SessionError('folder_not_allowed', 'No workspace folders are set up');
        try {
          return this.send(conn, { type: 'folders.list', ...(await folders.list(msg.path)) });
        } catch (err) {
          throw new SessionError('folder_not_allowed', (err as Error).message);
        }
      }
      case 'claude.folder.start': {
        const folders = this.deps.folders;
        if (!folders)
          throw new SessionError('folder_not_allowed', 'No workspace folders are set up');
        let project: ProjectConfig;
        try {
          project = await folders.open(msg.path, conn.device.name);
        } catch (err) {
          throw new SessionError('folder_not_allowed', (err as Error).message);
        }
        conn.pcSubscription = undefined;
        const session = sessions.start(project.id);
        return this.sendSnapshot(conn, session.id);
      }

      case 'claude.permission.respond':
        return sessions.respond(msg.sessionId, msg.requestId, msg.decision, {
          rememberForSession: msg.rememberForSession,
          message: msg.message,
          deviceName: conn.device.name,
        });
    }
  }

  private sendSnapshot(conn: Connection, sessionId: string): void {
    const session = this.deps.sessions.get(sessionId);
    this.send(conn, {
      type: 'claude.session.snapshot',
      session: session.summary(),
      events: session.events(),
      pendingPermissions: this.deps.sessions.broker.pendingFor(sessionId),
    });
  }

  private check(conn: Connection, result: RouterResult): void {
    if (!result.ok) this.error(conn, result.code, result.message);
  }

  private error(conn: Connection, code: ErrorCode, message: string): void {
    const now = Date.now();
    if (now - (conn.lastErrorAt.get(code) ?? 0) < 1_000) return;
    conn.lastErrorAt.set(code, now);
    this.send(conn, { type: 'error', code, message });
  }

  private send(conn: Connection, message: ServerMessage): void {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(JSON.stringify(message));
  }

  private broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const c of this.connections.values()) {
      if (c.socket.readyState === c.socket.OPEN) c.socket.send(data);
    }
  }
}

/** `ws` delivers a Buffer by default; cover the other RawData shapes anyway. */
function toBuffer(data: ArrayBuffer | Buffer[]): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}
