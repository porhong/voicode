import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentConfig, TunnelConfig } from '../config/config.js';
import type { AgentPaths } from '../config/paths.js';
import { fileExists, writeFileAtomic } from '../util/fs.js';
import type { Logger } from '../util/logger.js';

/**
 * Cloudflare Tunnel support. `cloudflared` keeps an outbound connection to Cloudflare,
 * which serves a publicly trusted certificate for the tunnel's host name and forwards
 * requests to the agent on loopback. Phones then need no certificate install.
 *
 * The leg from cloudflared to the agent stays verified: cloudflared is given the agent's
 * local CA as its origin CA pool instead of `--no-tls-verify`.
 */

export const INSTALL_HINT =
  process.platform === 'win32'
    ? 'Install it with `winget install --id Cloudflare.cloudflared`, then open a new terminal'
    : 'Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const CONNECTED_RE = /Registered tunnel connection/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
/** `tunnel run` logs "Generated Connector ID: <uuid>": one ID per cloudflared process. */
const CONNECTOR_RE = new RegExp(`Connector ID: (${UUID_RE.source})`);

/** Where `cloudflared` is: the configured path, PATH, or its default install location. */
export function findCloudflared(override?: string): string | undefined {
  if (override) return existsSync(override) ? override : undefined;
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    // winget/MSI install location; PATH only picks it up in terminals opened afterwards.
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
      if (base) dirs.push(path.join(base, 'cloudflared'));
    }
  } else {
    dirs.push('/usr/local/bin', '/usr/bin', path.join(os.homedir(), '.local', 'bin'));
  }
  for (const dir of dirs) {
    const candidate = path.join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a short cloudflared management command (`tunnel create`, `route dns`, …). */
export function runCloudflared(exe: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: 120_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout, stderr: stderr || (err && !stdout ? err.message : '') });
    });
  });
}

export async function cloudflaredVersion(exe: string): Promise<string | undefined> {
  const res = await runCloudflared(exe, ['--version']);
  return /version (\S+)/.exec(res.stdout + res.stderr)?.[1];
}

/** `cloudflared tunnel login` stores its account certificate here unless overridden. */
export function originCertPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TUNNEL_ORIGIN_CERT ?? path.join(os.homedir(), '.cloudflared', 'cert.pem');
}

export function parseTunnelId(output: string): string | undefined {
  return UUID_RE.exec(output)?.[0];
}

/**
 * The ID of the tunnel called `name` in `cloudflared tunnel list --output json`. An account
 * without tunnels prints `null` there, not `[]`.
 */
export function findTunnelId(listJson: string, name: string): string | undefined {
  const list: unknown = JSON.parse(listJson.trim() || 'null');
  if (!Array.isArray(list)) return undefined;
  const match = (list as Array<{ id?: unknown; name?: unknown } | null>).find(
    (t) => t?.name === name && typeof t.id === 'string',
  );
  return match ? (match.id as string) : undefined;
}

/**
 * The tunnel name `tunnel setup` uses on this PC. Every PC needs a tunnel of its own: two
 * cloudflared processes running one tunnel are replicas of it, and Cloudflare hands each
 * request to either of them whatever host name it is for. A second PC on a shared tunnel
 * therefore breaks the first one's host name (its requests land on the other PC, whose
 * ingress answers 404), which is what the old fixed default name `voicecode` led to.
 */
export function defaultTunnelName(machine: string = os.hostname()): string {
  const slug = machine
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return slug ? `voicecode-${slug}` : 'voicecode';
}

/**
 * The connectors (one per cloudflared process) that are connected to a tunnel, from
 * `cloudflared tunnel info --output json`. Connectors without open connections are gone.
 */
export function parseConnectorIds(infoJson: string): string[] {
  const info: unknown = JSON.parse(infoJson.trim() || 'null');
  const conns = (info as { conns?: unknown } | null)?.conns;
  if (!Array.isArray(conns)) return [];
  return (conns as Array<{ id?: unknown; conns?: unknown } | null>)
    .filter((c) => typeof c?.id === 'string' && Array.isArray(c.conns) && c.conns.length > 0)
    .map((c) => c!.id as string);
}

/**
 * The connectors running a tunnel, or undefined when that can't be read: it needs the
 * account certificate from `cloudflared tunnel login` (a token-only setup has none) and
 * a reachable Cloudflare API.
 */
export async function tunnelConnectors(
  exe: string,
  tunnelId: string,
): Promise<string[] | undefined> {
  if (!existsSync(originCertPath())) return undefined;
  const res = await runCloudflared(exe, ['tunnel', 'info', '--output', 'json', tunnelId]);
  if (res.code !== 0) return undefined;
  try {
    return parseConnectorIds(res.stdout);
  } catch {
    return undefined;
  }
}

/** The tunnel a named or token setup runs. */
export async function configuredTunnelId(
  tunnel: TunnelConfig,
  paths: AgentPaths,
): Promise<string | undefined> {
  if (tunnel.mode === 'named') return tunnel.tunnelId;
  if (tunnel.mode !== 'token') return undefined;
  const token = await readFile(paths.tunnelToken, 'utf8').catch(() => '');
  return decodeTunnelToken(token.trim())?.t;
}

/** Shown wherever a running tunnel turns out to be shared with another PC. */
export function sharedTunnelWarning(others: number): string {
  const who = others === 1 ? 'another cloudflared' : `${others} other cloudflared processes`;
  return (
    `also run by ${who} (another PC?), so requests are split between them. ` +
    'Give each PC its own tunnel: `voicecode-agent tunnel setup <hostname>`'
  );
}

/**
 * A tunnel token is base64 JSON with the account tag (`a`), tunnel ID (`t`) and secret
 * (`s`): the same fields as a credentials file.
 */
export function decodeTunnelToken(token: string): { a: string; t: string; s: string } | undefined {
  try {
    const data = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    const { a, t, s } = data;
    if (typeof a !== 'string' || typeof s !== 'string' || typeof t !== 'string') return undefined;
    return parseTunnelId(t) === t ? { a, t, s } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The agent's address as cloudflared should dial it. A wildcard bind is reached over
 * IPv4 loopback (which the server certificate always covers); a specific bind address
 * is used as is, since the server is not listening on loopback then.
 */
export function originUrl(server: AgentConfig['server']): string {
  const host = ['0.0.0.0', '::', ''].includes(server.host) ? '127.0.0.1' : server.host;
  return `https://${host.includes(':') ? `[${host}]` : host}:${server.port}`;
}

/** The public host name requests arrive with, when it is known before the tunnel runs. */
export function staticTunnelHost(tunnel: TunnelConfig): string | undefined {
  return tunnel.mode === 'named' || tunnel.mode === 'token' ? tunnel.hostname : undefined;
}

/** YAML is a superset of JSON, so JSON strings quote Windows paths safely. */
const q = (value: string) => JSON.stringify(value);

/**
 * The cloudflared config written for every run. An explicit `--config` also keeps a
 * user's own `~/.cloudflared/config.yml` from changing what the agent's tunnel does.
 */
export function cloudflaredConfig(
  config: AgentConfig,
  paths: AgentPaths,
): { yaml: string; args: string[] } {
  const { tunnel } = config;
  const origin = originUrl(config.server);
  const common = ['tunnel', '--no-autoupdate', '--config', paths.tunnelConfig];
  const header = '# Generated by voicecode-agent on every start; edits are overwritten.\n';

  switch (tunnel.mode) {
    case 'quick':
      // Quick tunnels only take an origin through --url, not ingress rules.
      return {
        yaml: header,
        args: [...common, '--url', origin, '--origin-ca-pool', paths.caCert],
      };
    case 'named': {
      if (!tunnel.hostname || !tunnel.tunnelId) {
        throw new Error('The named tunnel is not set up. Run `voicecode-agent tunnel setup`.');
      }
      const yaml =
        header +
        `tunnel: ${q(tunnel.tunnelId)}\n` +
        `credentials-file: ${q(paths.tunnelCredentials)}\n` +
        'ingress:\n' +
        `  - hostname: ${q(tunnel.hostname)}\n` +
        `    service: ${q(origin)}\n` +
        '    originRequest:\n' +
        `      caPool: ${q(paths.caCert)}\n` +
        // Anything else that reaches this tunnel is refused rather than proxied.
        '  - service: http_status:404\n';
      return { yaml, args: [...common, 'run'] };
    }
    case 'token':
      if (!tunnel.hostname) {
        throw new Error('The tunnel host name is missing. Run `voicecode-agent tunnel token`.');
      }
      // Ingress comes from the dashboard; the token is read from a file, never argv.
      return { yaml: header, args: [...common, 'run', '--token-file', paths.tunnelToken] };
    case 'off':
      throw new Error('The tunnel is off');
  }
}

/** Checks the files a mode needs, so `start` and `doctor` report the same problem. */
export async function tunnelSetupProblem(
  tunnel: TunnelConfig,
  paths: AgentPaths,
): Promise<string | undefined> {
  if (tunnel.mode === 'named') {
    if (!tunnel.hostname || !tunnel.tunnelId) return 'not set up';
    if (!(await fileExists(paths.tunnelCredentials))) return 'tunnel credentials are missing';
  }
  if (tunnel.mode === 'token') {
    if (!tunnel.hostname) return 'host name is missing';
    const token = await readFile(paths.tunnelToken, 'utf8').catch(() => '');
    if (!token.trim()) return 'tunnel token is missing';
  }
  return undefined;
}

export type TunnelState =
  | { state: 'connecting' }
  | { state: 'ready'; url: string }
  | { state: 'down'; reason: string; retryInMs: number };

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** A run that stayed up this long resets the backoff. */
const STABLE_MS = 60_000;

/**
 * Supervises one cloudflared process: reports the public URL once a connection to
 * Cloudflare is registered, and restarts it with exponential backoff if it exits. A
 * restarted quick tunnel gets a new URL, which is reported as a new `ready` state.
 */
export class CloudflaredTunnel extends EventEmitter<{ state: [TunnelState] }> {
  private child: ChildProcess | undefined;
  private stopped = false;
  private backoffMs = MIN_BACKOFF_MS;
  private retryTimer: NodeJS.Timeout | undefined;
  private current: TunnelState = { state: 'connecting' };
  private connector: string | undefined;
  private readonly killOnExit = () => this.child?.kill();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly logger: Logger,
    /** Known up front for named/token tunnels; quick tunnels learn it from the log. */
    private readonly fixedUrl?: string,
  ) {
    super();
  }

  get status(): TunnelState {
    return this.current;
  }

  /** This run's connector ID, which tells our connections apart from other PCs'. */
  get connectorId(): string | undefined {
    return this.connector;
  }

  start(): void {
    this.stopped = false;
    this.spawnOnce();
  }

  /** Resolves with the public URL, or undefined if it is not up within `timeoutMs`. */
  waitReady(timeoutMs: number): Promise<string | undefined> {
    if (this.current.state === 'ready') return Promise.resolve(this.current.url);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('state', onState);
        resolve(undefined);
      }, timeoutMs);
      const onState = (s: TunnelState) => {
        if (s.state !== 'ready') return;
        clearTimeout(timer);
        this.off('state', onState);
        resolve(s.url);
      };
      this.on('state', onState);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 3_000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.kill();
    });
  }

  private setState(state: TunnelState): void {
    this.current = state;
    this.emit('state', state);
  }

  private spawnOnce(): void {
    const startedAt = Date.now();
    let url = this.fixedUrl;
    let lastError = '';
    this.connector = undefined;
    this.setState({ state: 'connecting' });

    const child = spawn(this.command, this.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    process.once('exit', this.killOnExit);

    const onLine = (line: string) => {
      const text = line.trim();
      if (!text) return;
      if (/\b(ERR|FTL)\b/.test(text)) {
        lastError = text.replace(/^\S+\s+(ERR|FTL)\s+/, '');
        this.logger.warn({ line: text }, 'cloudflared');
      } else {
        this.logger.debug({ line: text }, 'cloudflared');
      }
      url ??= QUICK_URL_RE.exec(text)?.[0];
      this.connector ??= CONNECTOR_RE.exec(text)?.[1];
      if (url && CONNECTED_RE.test(text) && this.current.state !== 'ready') {
        this.logger.info({ url }, 'tunnel connected');
        this.setState({ state: 'ready', url });
      }
    };
    createInterface({ input: child.stdout! }).on('line', onLine);
    createInterface({ input: child.stderr! }).on('line', onLine);

    child.on('error', (err) => {
      lastError = err.message;
    });
    child.on('exit', (code, signal) => {
      process.off('exit', this.killOnExit);
      if (this.child === child) this.child = undefined;
      if (this.stopped) return;
      if (Date.now() - startedAt > STABLE_MS) this.backoffMs = MIN_BACKOFF_MS;
      const retryInMs = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      const reason = lastError || `cloudflared exited (${signal ?? `code ${code}`})`;
      this.logger.warn({ code, signal, reason, retryInMs }, 'tunnel down');
      this.setState({ state: 'down', reason, retryInMs });
      this.retryTimer = setTimeout(() => this.spawnOnce(), retryInMs);
      this.retryTimer.unref();
    });
  }
}

/**
 * Writes this run's cloudflared config and returns a supervisor for it, or the reason
 * the tunnel cannot start. A missing tunnel never stops the agent: the LAN still works.
 */
export async function prepareTunnel(
  config: AgentConfig,
  paths: AgentPaths,
  logger: Logger,
): Promise<
  | {
      tunnel: CloudflaredTunnel;
      /** How many other cloudflared processes run this tunnel; undefined when unknown. */
      otherConnectors?: () => Promise<number | undefined>;
    }
  | { error: string }
> {
  const exe = findCloudflared(config.tunnel.cloudflared);
  if (!exe) return { error: `cloudflared not found. ${INSTALL_HINT}.` };
  const problem = await tunnelSetupProblem(config.tunnel, paths);
  if (problem) return { error: `Tunnel ${problem}. Run \`voicecode-agent tunnel\` for help.` };
  const { yaml, args } = cloudflaredConfig(config, paths);
  await writeFileAtomic(paths.tunnelConfig, yaml);
  const host = staticTunnelHost(config.tunnel);
  const tunnel = new CloudflaredTunnel(exe, args, logger, host ? `https://${host}` : undefined);
  const tunnelId = await configuredTunnelId(config.tunnel, paths);
  if (!tunnelId) return { tunnel };
  return {
    tunnel,
    otherConnectors: async () => {
      const ids = await tunnelConnectors(exe, tunnelId);
      if (!ids) return undefined;
      const own = tunnel.connectorId;
      return own ? ids.filter((id) => id !== own).length : Math.max(0, ids.length - 1);
    },
  };
}
