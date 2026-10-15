import type http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { PairingCode } from '@voicecode/security';
import {
  addProject,
  loadConfig,
  saveConfig,
  type AgentConfig,
  type ProjectConfig,
} from './config/config.js';
import type { AgentPaths } from './config/paths.js';
import { listRootFolder, resolveRootFolder } from './config/workspace-roots.js';
import { startControlServer } from './ipc/control.js';
import { InputRouter } from './mouse/input-router.js';
import { driverCandidates } from './mouse/resolve-driver.js';
import { DeviceRegistry, type PublicDevice } from './pairing/device-registry.js';
import { PairingService } from './pairing/pairing-service.js';
import { buildServer } from './server/app.js';
import { WsGateway } from './server/ws-gateway.js';
import { PcSessionWatcher } from './sessions/pc-sessions.js';
import { SessionManager } from './sessions/session-manager.js';
import { StorageJanitor, storageLocations } from './storage/janitor.js';
import { ensureTls, type TlsMaterial } from './tls/certificates.js';
import {
  prepareTunnel,
  staticTunnelHost,
  type CloudflaredTunnel,
  type TunnelState,
} from './tunnel/cloudflared.js';
import type { Logger } from './util/logger.js';
import { formatUrl, rankedLanAddresses } from './util/network.js';
import { packageRoot, VERSION } from './util/version.js';
import { MicRouter } from './voice/mic-router.js';
import { micDriverCandidates } from './voice/resolve-driver.js';

export interface AgentRuntimeInfo {
  urls: string[];
  caFingerprint: string;
  mouse: ReturnType<InputRouter['status']> & { details?: Record<string, string> };
  voiceMic: ReturnType<MicRouter['status']>;
  projects: ProjectConfig[];
  pairingCode: PairingCode;
  tunnel: AgentTunnelInfo;
}

export type AgentTunnelInfo =
  | { mode: 'off' }
  | { mode: AgentConfig['tunnel']['mode']; error: string }
  | ({ mode: AgentConfig['tunnel']['mode'] } & TunnelState);

/** How long `start` waits for the tunnel before printing without its URL. */
const TUNNEL_WAIT_MS = 30_000;

/**
 * Composition root: TLS, device registry and pairing, the mouse router, Claude
 * sessions, the HTTPS/WebSocket server and the local control channel.
 */
export class Agent extends EventEmitter<{
  paired: [device: PublicDevice];
  pairingFailed: [reason: string, remoteAddress: string];
  connections: [count: number];
  tunnel: [info: AgentTunnelInfo];
  /** A paired device allowed a new project folder (to continue a PC session there). */
  folderAllowed: [dir: string, deviceName: string];
  stopped: [];
}> {
  private registry!: DeviceRegistry;
  private pairing!: PairingService;
  private router!: InputRouter;
  private mic!: MicRouter;
  private sessions!: SessionManager;
  private pcSessions: PcSessionWatcher | undefined;
  private gateway!: WsGateway;
  private janitor!: StorageJanitor;
  private app: Awaited<ReturnType<typeof buildServer>> | undefined;
  private control: http.Server | undefined;
  private tls!: TlsMaterial;
  private urls: string[] = [];
  private tunnel: CloudflaredTunnel | undefined;
  private tunnelInfo: AgentTunnelInfo = { mode: 'off' };
  /** Host names the tunnel serves; the server's origin guard reads this set live. */
  private readonly tunnelHosts = new Set<string>();
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

    this.mic = new MicRouter(logger.child({ component: 'mic' }), {
      leaseIdleMs: config.voice.leaseIdleMs,
    });
    const mic = micDriverCandidates(config, logger.child({ component: 'mic' }));
    await this.mic.start(mic.candidates, mic.unavailableReason);

    this.sessions = new SessionManager(config, logger.child({ component: 'claude' }));
    const sessions = this.sessions;
    this.pcSessions = new PcSessionWatcher({
      logger: logger.child({ component: 'pc-sessions' }),
      isOwnSession: (id) => sessions.owns(id),
      projectFor: (cwd) => sessions.projectForFolder(cwd)?.id,
    });
    this.pcSessions.start();
    this.janitor = new StorageJanitor({
      locations: storageLocations(paths),
      settings: () => this.config.cleanup,
      logger: logger.child({ component: 'storage' }),
    });
    this.janitor.start();
    this.gateway = new WsGateway({
      pcSessions: this.pcSessions,
      allowFolder: (dir, deviceName) => this.allowFolder(dir, deviceName),
      folders: {
        roots: () => this.config.roots,
        list: (dir) => listRootFolder(this.config, dir),
        open: async (dir, deviceName) => {
          const folder = await resolveRootFolder(dir, this.config.roots);
          return (
            this.sessions.projectForFolder(folder) ?? (await this.allowFolder(folder, deviceName))
          );
        },
      },
      storage: {
        info: () => this.janitor.info(),
        cleanNow: () => this.janitor.cleanNow(),
        configure: (settings) => this.configureCleanup(settings),
      },
      router: this.router,
      mic: this.mic,
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
      tunnelHosts: config.tunnel.mode === 'off' ? undefined : this.tunnelHosts,
    });
    await this.app.listen({ host: config.server.host, port: config.server.port });

    this.control = await startControlServer(paths, this.controlRoutes(), logger);

    const hosts = addresses.map((a) => a.address).filter((ip) => this.tls.names.includes(ip));
    this.urls = (hosts.length ? hosts : ['localhost']).map((h) => formatUrl(h, config.server.port));
    this.startedAt = Date.now();
    await this.startTunnel();
    logger.info({ urls: this.urls, version: VERSION, tunnel: this.tunnelInfo }, 'agent started');
    return {
      urls: this.urls,
      caFingerprint: this.tls.caFingerprint,
      mouse: { ...this.router.status(), details: this.router.info?.details },
      voiceMic: this.mic.status(),
      projects: config.projects,
      pairingCode: this.pairing.issueCode(),
      tunnel: this.tunnelInfo,
    };
  }

  /** The URL phones should open: the tunnel's when it is up, otherwise the LAN one. */
  get publicUrl(): string | undefined {
    return this.tunnelInfo.mode !== 'off' && 'url' in this.tunnelInfo
      ? this.tunnelInfo.url
      : undefined;
  }

  private async startTunnel(): Promise<void> {
    const { tunnel: settings } = this.config;
    if (settings.mode === 'off') return;
    const logger = this.logger.child({ component: 'tunnel' });
    const prepared = await prepareTunnel(this.config, this.paths, logger);
    if ('error' in prepared) {
      logger.warn({ error: prepared.error }, 'tunnel unavailable');
      this.tunnelInfo = { mode: settings.mode, error: prepared.error };
      return;
    }
    const fixedHost = staticTunnelHost(settings);
    if (fixedHost) this.tunnelHosts.add(fixedHost);
    this.tunnel = prepared.tunnel;
    this.tunnel.on('state', (state) => {
      if (state.state === 'ready' && !fixedHost) {
        // A restarted quick tunnel has a new name; the old one must stop working.
        this.tunnelHosts.clear();
        this.tunnelHosts.add(new URL(state.url).hostname);
      }
      this.tunnelInfo = { mode: settings.mode, ...state };
      this.emit('tunnel', this.tunnelInfo);
    });
    this.tunnel.start();
    await this.tunnel.waitReady(TUNNEL_WAIT_MS);
  }

  /** Adds a folder to the allow-list and tells every device and the terminal. */
  private async allowFolder(dir: string, deviceName: string): Promise<ProjectConfig> {
    // The running config carries this run's --port/--host/--tunnel overrides, so the
    // folder is added to the file on disk separately rather than saving it wholesale.
    const onDisk = await loadConfig(this.paths.config);
    if (onDisk) {
      await addProject(onDisk, dir);
      await saveConfig(this.paths.config, onDisk);
    }
    const project = await addProject(this.config, dir);
    this.gateway.broadcastProjects(this.config.projects);
    this.logger.info(
      { dir: project.path, device: deviceName },
      'project folder allowed from device',
    );
    this.emit('folderAllowed', project.path, deviceName);
    return project;
  }

  /** Changes the automatic cleanup (from a device or the CLI) and saves it to disk. */
  private async configureCleanup(settings: AgentConfig['cleanup']): Promise<void> {
    // Saved into the file on disk rather than wholesale, as in allowFolder().
    const onDisk = await loadConfig(this.paths.config);
    if (onDisk) {
      onDisk.cleanup = { ...settings };
      await saveConfig(this.paths.config, onDisk);
    }
    this.config.cleanup = { ...settings };
    this.logger.info(settings, 'cleanup settings changed');
    if (settings.auto) void this.janitor.autoCleanup().catch(() => undefined);
  }

  issuePairingCode(): PairingCode {
    return this.pairing.issueCode();
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.logger.info('agent stopping');
      this.janitor?.stop();
      this.sessions?.closeAll();
      this.gateway?.closeAll();
      await this.tunnel?.stop();
      await this.pcSessions?.stop();
      await this.router?.stop();
      await this.mic?.stop();
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
        tunnel: this.tunnelInfo,
        connections: this.gateway.devicesOnline(),
        mouse: this.router.status(),
        voiceMic: this.mic.status(),
        sessions: this.sessions.list(),
        projects: this.config.projects,
      }),
      'POST /pair': () => {
        const code = this.pairing.issueCode();
        return {
          code: code.display,
          raw: code.code,
          expiresAt: code.expiresAt,
          url: this.publicUrl ?? this.urls[0],
        };
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
        this.config.roots = fresh.roots;
        this.gateway.broadcastProjects(fresh.projects);
        this.logger.info(
          { projects: fresh.projects.map((p) => p.path), roots: fresh.roots },
          'projects reloaded',
        );
        return { projects: fresh.projects };
      },
      'GET /storage': () => this.janitor.info(),
      'POST /storage/cleanup': async () => ({
        result: await this.janitor.cleanNow(),
        storage: await this.janitor.info(),
      }),
      // Re-reads the cleanup settings after `voicecode-agent cleanup auto …`.
      'POST /storage/reload': async () => {
        const fresh = await loadConfig(this.paths.config);
        if (!fresh) throw new Error('config file is missing');
        await this.configureCleanup(fresh.cleanup);
        return this.janitor.info();
      },
      'POST /stop': () => {
        setTimeout(() => void this.stop(), 50);
        return { stopping: true };
      },
    };
  }
}
