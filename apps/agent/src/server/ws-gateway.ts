import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { WebSocket } from 'ws';
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '@voicecode/protocol';
import type { InputRouter, ClientIdentity, RouterResult } from '../mouse/input-router.js';
import type { DeviceRegistry, PublicDevice } from '../pairing/device-registry.js';
import { SessionError, type SessionManager } from '../sessions/session-manager.js';
import type { Logger } from '../util/logger.js';
import { VERSION } from '../util/version.js';
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
}

/**
 * Authenticated WebSocket connections from paired devices. Validates every inbound
 * message, applies per-connection rate limits, dispatches to the mouse router and the
 * session manager, and broadcasts their state changes to all devices.
 */
export class WsGateway {
  private readonly connections = new Map<string, Connection>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly deps: {
      router: InputRouter;
      sessions: SessionManager;
      registry: DeviceRegistry;
      logger: Logger;
      onConnectionsChanged?: (count: number) => void;
    },
  ) {
    const { router, sessions, registry } = deps;

    router.on('status', () => {
      const status = router.status();
      for (const c of this.connections.values()) {
        this.send(c, { type: 'mouse.status', status, youHoldLease: router.holds(c.identity) });
      }
    });

    sessions.on('session', (session) => this.broadcast({ type: 'claude.session', session }));
    sessions.on('event', (sessionId, r) =>
      this.broadcast({ type: 'claude.event', sessionId, seq: r.seq, at: r.at, event: r.event }),
    );
    sessions.on('delta', (sessionId, r) =>
      this.broadcast({ type: 'claude.event', sessionId, seq: r.seq, at: r.at, event: r.event }),
    );
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
        if (c.device.id === deviceId) c.socket.close(CLOSE_REVOKED, 'device revoked');
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
    const { router, sessions, logger } = this.deps;
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
    };
    this.connections.set(identity.connectionId, conn);
    this.deps.onConnectionsChanged?.(this.count);
    logger.info({ device: device.name }, 'device connected');

    socket.on('pong', () => (conn.alive = true));
    socket.on('message', (data, isBinary) => {
      conn.alive = true;
      if (!conn.bucket.take()) return this.error(conn, 'rate_limited', 'Too many messages');
      if (isBinary) return this.error(conn, 'bad_request', 'Binary frames are not supported');
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
      sessions: sessions.list(),
      mouse: router.status(),
    });
    for (const request of sessions.broker.pendingFor()) {
      this.send(conn, { type: 'claude.permission.request', request });
    }
  }

  closeAll(): void {
    clearInterval(this.heartbeat);
    for (const c of this.connections.values())
      c.socket.close(CLOSE_SHUTDOWN, 'agent shutting down');
  }

  private async dispatch(conn: Connection, msg: ClientMessage): Promise<void> {
    const { router, sessions } = this.deps;
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
