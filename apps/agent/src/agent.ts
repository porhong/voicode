import type http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { PairingCode } from '@voicecode/security';
import { loadConfig, type AgentConfig, type ProjectConfig } from './config/config.js';
import type { AgentPaths } from './config/paths.js';
import { startControlServer } from './ipc/control.js';
import { InputRouter } from './mouse/input-router.js';
import { driverCandidates } from './mouse/resolve-driver.js';
import { DeviceRegistry, type PublicDevice } from './pairing/device-registry.js';
import { PairingService } from './pairing/pairing-service.js';
import { buildServer } from './server/app.js';
import { WsGateway } from './server/ws-gateway.js';
import { SessionManager } from './sessions/session-manager.js';
import { ensureTls, type TlsMaterial } from './tls/certificates.js';
import type { Logger } from './util/logger.js';
import { formatUrl, rankedLanAddresses } from './util/network.js';
import { packageRoot, VERSION } from './util/version.js';

export interface AgentRuntimeInfo {
  urls: string[];
  caFingerprint: string;
  mouse: ReturnType<InputRouter['status']> & { details?: Record<string, string> };
  projects: ProjectConfig[];
  pairingCode: PairingCode;
}

/**
 * Composition root: TLS, device registry and pairing, the mouse router, Claude
 * sessions, the HTTPS/WebSocket server and the local control channel.
 */
export class Agent extends EventEmitter<{
  paired: [device: PublicDevice];
  pairingFailed: [reason: string, remoteAddress: string];
  connections: [count: number];
  stopped: [];
}> {
  private registry!: DeviceRegistry;
  private pairing!: PairingService;
  private router!: InputRouter;
  private sessions!: SessionManager;
  private gateway!: WsGateway;
  private app: Awaited<ReturnType<typeof buildServer>> | undefined;
  private control: http.Server | undefined;
  private tls!: TlsMaterial;
  private urls: string[] = [];
  private startedAt = 0;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly config: AgentConfig,
    private readonly paths: AgentPaths,
    private readonly logger: Logger,
  ) {
    super();
  }

  /** Starts every component; if any step fails, whatever already started is torn down. */
  async start(): Promise<AgentRuntimeInfo> {
    try {
      return await this.startComponents();
    } catch (err) {
      await this.stop().catch(() => undefined);
      throw err;
    }
  }

  private async startComponents(): Promise<AgentRuntimeInfo> {
    const { config, paths, logger } = this;
    const addresses = await rankedLanAddresses();
    this.tls = await ensureTls(
      paths,
      addresses.map((a) => a.address),
      logger,
    );

    this.registry = await DeviceRegistry.open(paths.devices);
    this.pairing = new PairingService(this.registry, {
      ttlMs: config.pairing.codeTtlMs,
      maxAttempts: config.pairing.maxAttempts,
    });
    this.pairing.on('paired', (d) => this.emit('paired', d));
    this.pairing.on('failed', (reason, addr) => this.emit('pairingFailed', reason, addr));

    this.router = new InputRouter(logger.child({ component: 'mouse' }), {
      leaseIdleMs: config.mouse.leaseIdleMs,
    });
    const { candidates, unavailableReason } = driverCandidates(config, logger, {
      stateDir: paths.home,
    });
    await this.router.start(candidates, unavailableReason);

    this.sessions = new SessionManager(config, logger.child({ component: 'claude' }));
    this.gateway = new WsGateway({
      router: this.router,
      sessions: this.sessions,
      registry: this.registry,
      logger: logger.child({ component: 'ws' }),
      onConnectionsChanged: (n) => this.emit('connections', n),
    });

    this.app = await buildServer({
      tls: this.tls,
      logger: logger.child({ component: 'http' }),
      registry: this.registry,
      pairing: this.pairing,
      gateway: this.gateway,
      webRoot: path.join(packageRoot(), 'dist', 'web'),
      extraOrigins: (process.env.VOICECODE_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    });
    await this.app.listen({ host: config.server.host, port: config.server.port });

    this.control = await startControlServer(paths, this.controlRoutes(), logger);

    const hosts = addresses.map((a) => a.address).filter((ip) => this.tls.names.includes(ip));
    this.urls = (hosts.length ? hosts : ['localhost']).map((h) => formatUrl(h, config.server.port));
    this.startedAt = Date.now();
    logger.info({ urls: this.urls, version: VERSION }, 'agent started');
    return {
      urls: this.urls,
      caFingerprint: this.tls.caFingerprint,
      mouse: { ...this.router.status(), details: this.router.info?.details },
      projects: config.projects,
      pairingCode: this.pairing.issueCode(),
    };
  }

  issuePairingCode(): PairingCode {
    return this.pairing.issueCode();
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.logger.info('agent stopping');
      this.sessions?.closeAll();
      this.gateway?.closeAll();
      await this.router?.stop();
      await this.app?.close();
      await new Promise<void>((resolve) =>
        this.control ? this.control.close(() => resolve()) : resolve(),
      );
      await this.registry?.close();
      this.emit('stopped');
    })();
    return this.stopping;
  }

  private controlRoutes() {
    return {
      'GET /status': () => ({
        version: VERSION,
        pid: process.pid,
        startedAt: this.startedAt,
        urls: this.urls,
        connections: this.gateway.devicesOnline(),
        mouse: this.router.status(),
        sessions: this.sessions.list(),
        projects: this.config.projects,
      }),
      'POST /pair': () => {
        const code = this.pairing.issueCode();
        return { code: code.display, raw: code.code, expiresAt: code.expiresAt, url: this.urls[0] };
      },
      'GET /devices': () => ({
        devices: this.registry.list(),
        online: this.gateway.devicesOnline().map((d) => d.deviceId),
      }),
      'POST /devices/revoke': async (body: unknown) => {
        const id = (body as { id?: unknown } | undefined)?.id;
        if (id === 'all') return { revoked: await this.registry.revokeAll() };
        if (typeof id !== 'string') throw new Error('id is required');
        const match = this.registry.list().filter((d) => d.id.startsWith(id));
        if (match.length !== 1)
          throw new Error(match.length ? 'ambiguous device id' : 'no such device');
        await this.registry.revoke(match[0]!.id);
        return { revoked: 1, device: match[0] };
      },
      'GET /sessions': () => ({ sessions: this.sessions.list() }),
      // Re-reads the project allow-list after `voicecode-agent projects add/remove`.
      'POST /projects/reload': async () => {
        const fresh = await loadConfig(this.paths.config);
        if (!fresh) throw new Error('config file is missing');
        this.config.projects = fresh.projects;
        this.gateway.broadcastProjects(fresh.projects);
        this.logger.info({ projects: fresh.projects.map((p) => p.path) }, 'projects reloaded');
        return { projects: fresh.projects };
      },
      'POST /stop': () => {
        setTimeout(() => void this.stop(), 50);
        return { stopping: true };
      },
    };
  }
}
