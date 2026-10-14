import https from 'node:https';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@voicecode/protocol';
import { addProject, ConfigSchema } from '../config/config.js';
import { resolvePaths } from '../config/paths.js';
import { listRootFolder, resolveRootFolder } from '../config/workspace-roots.js';
import { InputRouter } from '../mouse/input-router.js';
import { DeviceRegistry } from '../pairing/device-registry.js';
import { PairingService } from '../pairing/pairing-service.js';
import { encodeProjectDir, PcSessionWatcher } from '../sessions/pc-sessions.js';
import { SessionManager } from '../sessions/session-manager.js';
import { createFakeQuery, FakeMicDriver, FakeMouseDriver } from '../test-utils/fakes.js';
import { ensureTls, type TlsMaterial } from '../tls/certificates.js';
import { silentLogger } from '../util/logger.js';
import { MicRouter } from '../voice/mic-router.js';
import { buildServer } from './app.js';
import { CLOSE_REVOKED, WsGateway } from './ws-gateway.js';

let home: string;
let tls: TlsMaterial;
let app: Awaited<ReturnType<typeof buildServer>>;
let base: string;
let pairing: PairingService;
let registry: DeviceRegistry;
let router: InputRouter;
let mic: MicRouter;
let sessions: SessionManager;
const tunnelHosts = new Set<string>();
// A Claude session running in a terminal, in a folder that is not allow-listed.
let pcWatcher: PcSessionWatcher;
let pcCwd: string;
let workspace: string;
let pcTranscript: string;
let registerPc: (status: string) => Promise<void>;
/** A device paired by the tunnel test, reused where a separate device isn't needed. */
let tunnelCookie: string;
const driver = new FakeMouseDriver();
const micDriver = new FakeMicDriver();
const fake = createFakeQuery({ permissionMode: 'bypassPermissions' });

function request(
  method: string,
  route: string,
  opts: {
    body?: unknown;
    cookie?: string;
    origin?: string | null;
    host?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: Record<string, unknown>; setCookie?: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.host) headers.host = opts.host;
    if (payload) headers['content-type'] = 'application/json';
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.origin !== null) headers.origin = opts.origin ?? base;
    // A custom Host would otherwise become the TLS server name; the cert covers localhost.
    const servername = opts.host ? 'localhost' : undefined;
    const options = { method, ca: tls.caCert, headers, servername };
    const req = https.request(`${base}${route}`, options, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: text ? JSON.parse(text) : {},
          setCookie: res.headers['set-cookie']?.[0],
        }),
      );
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function pairDevice(name: string): Promise<string> {
  const { code } = pairing.issueCode();
  const res = await request('POST', '/api/pair', { body: { code, deviceName: name } });
  expect(res.status).toBe(200);
  return res.setCookie!.split(';')[0]!;
}

class Client {
  readonly messages: ServerMessage[] = [];
  private waiters: Array<{
    pred: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
  }> = [];
  readonly ws: WebSocket;

  constructor(cookie?: string, origin = base) {
    this.ws = new WebSocket(`${base.replace('https', 'wss')}/ws`, {
      ca: tls.caCert,
      headers: { origin, ...(cookie ? { cookie } : {}) },
    });
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => (w.pred(msg) ? (w.resolve(msg), false) : true));
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendBinary(data: Buffer): void {
    this.ws.send(data, { binary: true });
  }

  waitFor<T extends ServerMessage['type']>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const match = (m: ServerMessage) =>
      m.type === type && pred(m as Extract<ServerMessage, { type: T }>);
    const existing = this.messages.find(match);
    if (existing) return Promise.resolve(existing as Extract<ServerMessage, { type: T }>);
    return new Promise((resolve) =>
      this.waiters.push({ pred: match, resolve: resolve as (m: ServerMessage) => void }),
    );
  }

  rejection(): Promise<number> {
    return new Promise((resolve) =>
      this.ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)),
    );
  }

  closed(): Promise<number> {
    return new Promise((resolve) => this.ws.on('close', (code) => resolve(code)));
  }
}

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'voicecode-test-'));
  const paths = resolvePaths(home);
  const logger = silentLogger();
  tls = await ensureTls(paths, ['127.0.0.1'], logger);
  registry = await DeviceRegistry.open(paths.devices);
  pairing = new PairingService(registry, { ttlMs: 60_000, maxAttempts: 5 });
  router = new InputRouter(logger, { leaseIdleMs: 60_000, flushIntervalMs: 0 });
  router.attach(driver, { details: {} });
  mic = new MicRouter(logger, { leaseIdleMs: 60_000 });
  mic.attach(micDriver, { device: 'Fake Cable' });
  const config = ConfigSchema.parse({
    version: 1,
    projects: [{ id: 'p1', name: 'proj', path: home }],
  });
  sessions = new SessionManager(config, logger, fake.queryFn);

  const claudeDir = path.join(home, 'claude-config');
  pcCwd = path.join(home, 'terminal-project');
  await mkdir(path.join(claudeDir, 'sessions'), { recursive: true });
  await mkdir(pcCwd);
  const transcriptDir = path.join(claudeDir, 'projects', encodeProjectDir(pcCwd));
  await mkdir(transcriptDir, { recursive: true });
  pcTranscript = path.join(transcriptDir, 'term-1.jsonl');
  await writeFile(
    pcTranscript,
    `${JSON.stringify({ type: 'user', message: { content: 'Hi' } })}
`,
  );
  registerPc = (status) =>
    writeFile(
      path.join(claudeDir, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: 'term-1', cwd: pcCwd, status }),
    );
  await registerPc('busy');

  // A workspace root with one repo, a plain folder and a hidden one.
  workspace = path.join(home, 'workspace');
  await mkdir(path.join(workspace, 'app-a', '.git'), { recursive: true });
  await mkdir(path.join(workspace, 'notes'));
  await mkdir(path.join(workspace, '.secrets'));
  config.roots = [await realpath(workspace)];
  const sessionsRef = sessions;
  pcWatcher = new PcSessionWatcher({
    logger,
    claudeDir,
    isOwnSession: (id) => sessionsRef.owns(id),
    projectFor: (cwd) => sessionsRef.projectForFolder(cwd)?.id,
  });
  await pcWatcher.poll();

  const gateway = new WsGateway({
    router,
    mic,
    sessions,
    registry,
    logger,
    pcSessions: pcWatcher,
    allowFolder: (dir) => addProject(config, dir),
    folders: {
      roots: () => config.roots,
      list: (dir) => listRootFolder(config, dir),
      open: async (dir) => addProject(config, await resolveRootFolder(dir, config.roots)),
    },
  });
  app = await buildServer({ tls, logger, registry, pairing, gateway, tunnelHosts });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `https://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

afterAll(async () => {
  sessions.closeAll();
  await router.stop();
  await app.close();
  await registry.close();
  await rm(home, { recursive: true, force: true });
});

describe('HTTPS API', () => {
  it('reports unpaired status and serves the CA certificate', async () => {
    expect((await request('GET', '/api/info')).body).toMatchObject({
      name: 'voicecode-agent',
      paired: false,
    });
    const ca = await new Promise<string>((resolve) =>
      https.get(`${base}/voicecode-ca.crt`, { ca: tls.caCert }, (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve(t));
      }),
    );
    expect(ca).toBe(tls.caCert);
  });

  it('rejects wrong codes and foreign origins, then pairs with a hardened cookie', async () => {
    const { code } = pairing.issueCode();
    const wrong = code === '000000' ? '111111' : '000000';
    expect(
      (await request('POST', '/api/pair', { body: { code: wrong, deviceName: 'x' } })).status,
    ).toBe(401);
    expect(
      (
        await request('POST', '/api/pair', {
          body: { code, deviceName: 'x' },
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);

    const res = await request('POST', '/api/pair', { body: { code, deviceName: 'Phone' } });
    expect(res.status).toBe(200);
    expect(res.setCookie).toMatch(/^__Host-vc_device=/);
    expect(res.setCookie).toMatch(/HttpOnly/);
    expect(res.setCookie).toMatch(/Secure/);
    expect(res.setCookie).toMatch(/SameSite=Strict/);

    const cookie = res.setCookie!.split(';')[0]!;
    expect((await request('GET', '/api/info', { cookie })).body).toMatchObject({ paired: true });
  });

  it('rejects requests for host names outside the certificate', async () => {
    const status = await new Promise<number>((resolve) =>
      https
        .request(
          `${base}/api/info`,
          { ca: tls.caCert, headers: { host: 'attacker.example' }, servername: '127.0.0.1' },
          (res) => resolve(res.statusCode ?? 0),
        )
        .end(),
    );
    expect(status).toBe(421);
  });
});

describe('Cloudflare Tunnel host', () => {
  const host = 'quiet-river-1234.trycloudflare.com';

  it('is refused until the tunnel reports it, then needs its own origin', async () => {
    expect((await request('GET', '/api/info', { host })).status).toBe(421);

    tunnelHosts.add(host);
    try {
      const info = await request('GET', '/api/info', { host });
      expect(info.status).toBe(200);
      // Strangers on the internet don't learn the PC's name.
      expect(info.body.hostname).toBeUndefined();
      const { code } = pairing.issueCode();
      const body = { code, deviceName: 'Tunnel phone' };
      // The LAN origin is not valid for a request addressed to the tunnel host.
      expect((await request('POST', '/api/pair', { host, body })).status).toBe(403);
      const res = await request('POST', '/api/pair', { host, body, origin: `https://${host}` });
      expect(res.status).toBe(200);
      expect(res.setCookie).toMatch(/^__Host-vc_device=/);
      const cookie = res.setCookie!.split(';')[0]!;
      expect((await request('GET', '/api/info', { host, cookie })).body.hostname).toBeTruthy();
      tunnelCookie = cookie;
    } finally {
      tunnelHosts.delete(host);
    }
    expect((await request('GET', '/api/info', { host })).status).toBe(421);
  });

  it('reports the visitor address from CF-Connecting-IP for pairing failures', async () => {
    tunnelHosts.add(host);
    const failures: string[] = [];
    const onFailed = (_reason: string, address: string) => failures.push(address);
    pairing.on('failed', onFailed);
    try {
      const { code } = pairing.issueCode();
      await request('POST', '/api/pair', {
        host,
        origin: `https://${host}`,
        headers: { 'cf-connecting-ip': '203.0.113.7' },
        body: { code: code === '000000' ? '111111' : '000000', deviceName: 'x' },
      });
      expect(failures).toEqual(['203.0.113.7']);
    } finally {
      pairing.off('failed', onFailed);
      tunnelHosts.delete(host);
    }
  });
});

describe('WebSocket gateway', () => {
  it('refuses unauthenticated and cross-origin upgrades', async () => {
    const anon = new Client();
    expect(await anon.rejection()).toBe(401);
    const cookie = await pairDevice('Tablet');
    const foreign = new Client(cookie, 'https://evil.example');
    expect(await foreign.rejection()).toBe(403);
  });

  it('drives the mouse through an exclusive lease and releases on disconnect', async () => {
    const cookie = await pairDevice('Phone');
    const client = new Client(cookie);
    const welcome = await client.waitFor('welcome');
    expect(welcome.mouse.available).toBe(true);
    expect(welcome.projects).toEqual([{ id: 'p1', name: 'proj', path: home }]);

    client.send({ type: 'mouse.move', dx: 1, dy: 1 });
    await client.waitFor('error', (m) => m.code === 'mouse_not_leased');

    client.send({ type: 'mouse.acquire' });
    await client.waitFor('mouse.status', (m) => m.youHoldLease);
    driver.calls.length = 0;
    client.send({ type: 'mouse.move', dx: 12, dy: -8 });
    client.send({ type: 'mouse.button.down', button: 'left' });
    client.send({ type: 'mouse.scroll', dx: 0, dy: 120 });
    client.send({ type: 'mouse.position' });
    expect(await client.waitFor('mouse.position')).toMatchObject({ x: 10, y: 20 });
    expect(driver.calls).toEqual(['move 12 -8', 'down left', 'scroll 0 120']);

    client.send({ type: 'mouse.move', dx: 99_999, dy: 0 });
    await client.waitFor('error', (m) => m.code === 'bad_request');

    const closed = client.closed();
    client.ws.close();
    await closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(driver.calls.at(-1)).toBe('up left');
    expect(router.status().holder).toBeUndefined();
  });

  it('follows a terminal session and continues it from the phone as a fork', async () => {
    // The fake query is shared; later tests count its calls from zero.
    onTestFinished(() => {
      fake.control.permissionModeSets.length = 0;
    });
    // Pairing is rate limited per IP; reuse the device paired by the tunnel test.
    const client = new Client(tunnelCookie);
    const welcome = await client.waitFor('welcome');
    expect(welcome.pcSessions).toEqual([
      expect.objectContaining({
        sessionId: 'term-1',
        status: 'working',
        folder: 'terminal-project',
      }),
    ]);
    expect(welcome.pcSessions[0]!.projectId).toBeUndefined();

    client.send({ type: 'pc.session.subscribe', sessionId: 'term-1' });
    const snapshot = await client.waitFor('pc.session.snapshot');
    expect(snapshot.events.map((r) => r.event)).toEqual([
      { kind: 'user_prompt', text: 'Hi', deviceName: 'PC' },
    ]);
    await appendFile(
      pcTranscript,
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } })}
`,
    );
    await pcWatcher.poll();
    await client.waitFor('pc.session.event', (m) => m.event.kind === 'assistant_text');

    // Not while the terminal is still working on it.
    client.send({ type: 'pc.session.continue', sessionId: 'term-1' });
    await client.waitFor('error', (m) => m.code === 'session_busy');

    await registerPc('idle');
    await pcWatcher.poll();
    await client.waitFor(
      'claude.task.done',
      (m) => m.source === 'pc' && m.place === 'terminal-project',
    );

    // Its folder is not allowed yet: the phone has to confirm adding it.
    client.send({ type: 'pc.session.continue', sessionId: 'term-1' });
    await client.waitFor('error', (m) => m.code === 'folder_not_allowed');
    client.send({ type: 'pc.session.continue', sessionId: 'term-1', allowFolder: true });
    const started = await client.waitFor('claude.session.snapshot');
    expect(fake.control.options).toMatchObject({
      cwd: await realpath(pcCwd),
      resume: 'term-1',
      forkSession: true,
    });
    expect(sessions.projectForFolder(pcCwd)?.id).toBe(started.session.projectId);
    sessions.close(started.session.id);
  });

  it('browses workspace folders and starts Claude in one of them', async () => {
    // The fake query is shared; later tests count its calls from zero.
    onTestFinished(() => {
      fake.control.permissionModeSets.length = 0;
    });
    const client = new Client(tunnelCookie);
    const welcome = await client.waitFor('welcome');
    const root = await realpath(workspace);
    expect(welcome.roots).toEqual([root]);

    client.send({ type: 'folders.list' });
    const roots = await client.waitFor('folders.list');
    expect(roots.entries.map((e) => e.path)).toEqual([root]);

    client.send({ type: 'folders.list', path: root });
    const listing = await client.waitFor('folders.list', (m) => m.path === root);
    expect(listing.parent).toBeUndefined();
    expect(listing.entries).toEqual([
      expect.objectContaining({ name: 'app-a', isRepo: true, isProject: false }),
      expect.objectContaining({ name: 'notes', isRepo: false }),
    ]);

    // Outside the roots is refused (hidden folders too: see workspace-roots.test.ts).
    client.send({ type: 'folders.list', path: home });
    await client.waitFor('error', (m) => m.code === 'folder_not_allowed');

    client.send({ type: 'claude.folder.start', path: path.join(root, 'app-a') });
    const started = await client.waitFor('claude.session.snapshot');
    expect(fake.control.options).toMatchObject({ cwd: path.join(root, 'app-a') });
    expect(sessions.projectForFolder(path.join(root, 'app-a'))?.id).toBe(started.session.projectId);
    sessions.close(started.session.id);
  });

  it('runs a Claude turn with a remote approval', async () => {
    const client = new Client(await pairDevice('Phone'));
    await client.waitFor('welcome');

    client.send({ type: 'claude.session.start', projectId: 'p1' });
    const snapshot = await client.waitFor('claude.session.snapshot');
    const sessionId = snapshot.session.id;
    expect(fake.control.options).toMatchObject({ cwd: home, permissionMode: 'default' });
    expect(fake.control.options?.disallowedTools).toContain('AskUserQuestion');

    // Project settings asked for bypassPermissions; the agent must force it back.
    await client.waitFor('claude.event', (m) => m.event.kind === 'status');
    expect(fake.control.permissionModeSets).toEqual(['default']);

    client.send({ type: 'claude.prompt', sessionId, text: 'run the tests' });
    const { request: approval } = await client.waitFor('claude.permission.request');
    expect(approval).toMatchObject({ sessionId, toolName: 'Bash', canRemember: true });
    expect(approval.detail).toContain('npm test');
    await client.waitFor('claude.session', (m) => m.session.state === 'awaiting_permission');

    client.send({
      type: 'claude.permission.respond',
      sessionId,
      requestId: approval.requestId,
      decision: 'allow',
    });
    await client.waitFor(
      'claude.permission.resolved',
      (m) => m.decision === 'allow' && m.deviceName === 'Phone',
    );
    await client.waitFor(
      'claude.event',
      (m) => m.event.kind === 'assistant_text' && m.event.text === 'Tests passed',
    );
    await client.waitFor(
      'claude.session',
      (m) => m.session.state === 'idle' && m.session.totalCostUsd === 0.02,
    );
    await client.waitFor(
      'claude.task.done',
      (m) => m.source === 'agent' && m.sessionId === sessionId && m.place === 'proj',
    );

    // A bare Reject stops the turn; the SDK reports that as error_during_execution,
    // which must surface as a status line rather than an internal error message.
    client.send({ type: 'claude.prompt', sessionId, text: 'run them again' });
    const { request: second } = await client.waitFor(
      'claude.permission.request',
      (m) => m.request.requestId !== approval.requestId,
    );
    expect(second.title).toBe('Claude wants to run a command');
    client.send({
      type: 'claude.permission.respond',
      sessionId,
      requestId: second.requestId,
      decision: 'deny',
    });
    const stopped = await client.waitFor(
      'claude.event',
      (m) => m.event.kind === 'status' && m.event.message.startsWith('Stopped'),
    );
    await client.waitFor(
      'claude.session',
      (m) => m.session.state === 'idle' && m.session.totalCostUsd === 0.03,
    );
    const errors = client.messages.filter(
      (m) => m.type === 'claude.event' && m.event.kind === 'error' && m.seq > stopped.seq - 3,
    );
    expect(errors).toEqual([]);

    client.ws.close();
  });

  it('streams microphone audio to the virtual mic through an exclusive lease', async () => {
    // The lease is per connection, so one paired device can play both roles.
    const client = new Client(tunnelCookie);
    const welcome = await client.waitFor('welcome');
    expect(welcome.voiceMic).toMatchObject({ available: true, device: 'Fake Cable' });

    const frame = Buffer.alloc(3200, 7);
    client.sendBinary(frame);
    await client.waitFor('error', (m) => m.code === 'mic_not_leased');

    client.send({ type: 'voice.mic.start', sampleRate: 16000 });
    await client.waitFor('voice.mic.status', (m) => m.youHoldLease);
    micDriver.frames.length = 0;
    client.sendBinary(frame);
    client.sendBinary(Buffer.alloc(1600, 8));
    await new Promise((r) => setTimeout(r, 100));
    expect(micDriver.frames.map((f) => f.length)).toEqual([3200, 1600]);
    expect(micDriver.frames[0]![0]).toBe(7);

    // Another device cannot take over while the phone is streaming.
    const other = new Client(tunnelCookie);
    await other.waitFor('welcome');
    other.send({ type: 'voice.mic.start', sampleRate: 16000 });
    expect((await other.waitFor('error')).code).toBe('mic_lease_held');
    other.send({ type: 'voice.mic.start', sampleRate: 44100 });
    await other.waitFor('error', (m) => m.code === 'bad_request');
    other.ws.close();

    client.send({ type: 'voice.mic.stop' });
    await client.waitFor('voice.mic.status', (m) => !m.youHoldLease && !m.status.holder);
    client.ws.close();
  });

  it('rejects sessions for projects outside the allow-list', async () => {
    const client = new Client(await pairDevice('Phone'));
    await client.waitFor('welcome');
    client.send({ type: 'claude.session.start', projectId: 'not-allowed' });
    expect((await client.waitFor('error')).code).toBe('not_found');
    client.ws.close();
  });

  it('disconnects a device as soon as it is revoked', async () => {
    const cookie = await pairDevice('Old phone');
    const client = new Client(cookie);
    const welcome = await client.waitFor('welcome');
    const closed = client.closed();
    await registry.revoke(welcome.device.id);
    expect(await closed).toBe(CLOSE_REVOKED);
    expect((await request('GET', '/api/info', { cookie })).body).toMatchObject({ paired: false });
  });
});
