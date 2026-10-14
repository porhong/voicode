import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../config/config.js';
import { resolvePaths } from '../config/paths.js';
import { silentLogger } from '../util/logger.js';
import {
  cloudflaredConfig,
  CloudflaredTunnel,
  decodeTunnelToken,
  originUrl,
  type TunnelState,
} from './cloudflared.js';

const paths = resolvePaths('/home/u/.config/voicecode-agent');
const TUNNEL_ID = '6ff42ae2-765d-4adf-8112-31c55c1551ef';

function config(tunnel: Record<string, unknown>, server: Record<string, unknown> = {}) {
  return ConfigSchema.parse({ version: 1, tunnel, server });
}

describe('cloudflared configuration', () => {
  it('dials the agent over loopback unless it is bound to one address', () => {
    expect(originUrl(config({}).server)).toBe('https://127.0.0.1:8443');
    expect(originUrl(config({}, { host: '192.168.1.5', port: 9000 }).server)).toBe(
      'https://192.168.1.5:9000',
    );
  });

  it('runs a quick tunnel that verifies the origin against the local CA', () => {
    const { args, yaml } = cloudflaredConfig(config({ mode: 'quick' }), paths);
    expect(args).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--config',
      paths.tunnelConfig,
      '--url',
      'https://127.0.0.1:8443',
      '--origin-ca-pool',
      paths.caCert,
    ]);
    expect(args).not.toContain('--no-tls-verify');
    expect(yaml).not.toMatch(/ingress/);
  });

  it('writes ingress rules for a named tunnel and refuses other host names', () => {
    const c = config({ mode: 'named', hostname: 'code.example.com', tunnelId: TUNNEL_ID });
    const { args, yaml } = cloudflaredConfig(c, paths);
    expect(args.slice(-1)).toEqual(['run']);
    expect(yaml).toContain(`tunnel: "${TUNNEL_ID}"`);
    expect(yaml).toContain('hostname: "code.example.com"');
    expect(yaml).toContain('service: "https://127.0.0.1:8443"');
    expect(yaml).toContain(`caPool: ${JSON.stringify(paths.caCert)}`);
    expect(yaml.trimEnd().endsWith('- service: http_status:404')).toBe(true);
    expect(() => cloudflaredConfig(config({ mode: 'named' }), paths)).toThrow(/tunnel setup/);
  });

  it('passes a dashboard token by file, never on the command line', () => {
    const { args } = cloudflaredConfig(
      config({ mode: 'token', hostname: 'code.example.com' }),
      paths,
    );
    expect(args).toEqual(expect.arrayContaining(['run', '--token-file', paths.tunnelToken]));
  });

  it('rejects host names that are not public DNS names', () => {
    for (const hostname of ['localhost', 'Code.Example.com', 'a..b.com', 'https://x.com']) {
      expect(ConfigSchema.safeParse({ version: 1, tunnel: { hostname } }).success).toBe(false);
    }
  });

  it('decodes tunnel tokens and rejects anything else', () => {
    const token = Buffer.from(JSON.stringify({ a: 'acct', t: TUNNEL_ID, s: 'c2VjcmV0' })).toString(
      'base64',
    );
    expect(decodeTunnelToken(token)).toEqual({ a: 'acct', t: TUNNEL_ID, s: 'c2VjcmV0' });
    expect(decodeTunnelToken('not-a-token')).toBeUndefined();
    expect(decodeTunnelToken(Buffer.from('{"a":"x","t":"nope","s":"y"}').toString('base64'))).toBe(
      undefined,
    );
  });
});

/** A stand-in for cloudflared: a Node script that prints the given log lines. */
function fakeCloudflared(lines: string[], exitCode?: number): [string, string[]] {
  const script =
    `for (const l of ${JSON.stringify(lines)}) console.error(l);` +
    (exitCode === undefined ? 'setInterval(() => {}, 1000);' : `process.exit(${exitCode});`);
  return [process.execPath, ['-e', script]];
}

function nextState(tunnel: CloudflaredTunnel, wanted: TunnelState['state']) {
  return new Promise<TunnelState>((resolve) => {
    const onState = (s: TunnelState) => {
      if (s.state !== wanted) return;
      tunnel.off('state', onState);
      resolve(s);
    };
    tunnel.on('state', onState);
  });
}

describe('CloudflaredTunnel', () => {
  it('reports the quick tunnel URL once a connection is registered', async () => {
    const [cmd, args] = fakeCloudflared([
      'INF |  https://quiet-river-1234.trycloudflare.com   |',
      'INF Registered tunnel connection connIndex=0 location=sin01 protocol=quic',
    ]);
    const tunnel = new CloudflaredTunnel(cmd, args, silentLogger());
    tunnel.start();
    expect(await tunnel.waitReady(10_000)).toBe('https://quiet-river-1234.trycloudflare.com');
    expect(tunnel.status).toEqual({
      state: 'ready',
      url: 'https://quiet-river-1234.trycloudflare.com',
    });
    await tunnel.stop();
  });

  it('uses the configured host name for named tunnels', async () => {
    const [cmd, args] = fakeCloudflared(['INF Registered tunnel connection connIndex=0']);
    const tunnel = new CloudflaredTunnel(cmd, args, silentLogger(), 'https://code.example.com');
    tunnel.start();
    expect(await tunnel.waitReady(10_000)).toBe('https://code.example.com');
    await tunnel.stop();
  });

  it('reports why cloudflared exited and schedules a retry', async () => {
    const [cmd, args] = fakeCloudflared(
      ['2026-10-14T07:56:44Z ERR Unauthorized: Invalid tunnel secret'],
      1,
    );
    const tunnel = new CloudflaredTunnel(cmd, args, silentLogger());
    const down = nextState(tunnel, 'down');
    tunnel.start();
    expect(await down).toEqual({
      state: 'down',
      reason: 'Unauthorized: Invalid tunnel secret',
      retryInMs: 1_000,
    });
    await tunnel.stop();
  });
});
