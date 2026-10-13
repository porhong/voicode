#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import pc from 'picocolors';
import { Agent } from '../agent.js';
import {
  addProject,
  defaultConfig,
  loadConfig,
  saveConfig,
  type AgentConfig,
} from '../config/config.js';
import { resolvePaths, type AgentPaths } from '../config/paths.js';
import { runChecks } from '../doctor/checks.js';
import {
  AgentNotRunningError,
  controlRequest,
  ensureControlToken,
  isAgentRunning,
} from '../ipc/control.js';
import { DeviceRegistry, type PublicDevice } from '../pairing/device-registry.js';
import type { SessionSummary } from '@voicecode/protocol';
import { ensureTls } from '../tls/certificates.js';
import { ensurePrivateDir } from '../util/fs.js';
import { createLogger, silentLogger } from '../util/logger.js';
import { lanAddresses } from '../util/network.js';
import { VERSION } from '../util/version.js';
import {
  fail,
  heading,
  minutesUntil,
  ok,
  out,
  platformName,
  printChecks,
  printQr,
  row,
  timestamp,
  warn,
} from './ui.js';

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new InvalidArgumentError('Not a valid port');
  return port;
}

async function loadOrInit(paths: AgentPaths): Promise<{ config: AgentConfig; created: boolean }> {
  const existing = await loadConfig(paths.config);
  if (existing) return { config: existing, created: false };
  await ensurePrivateDir(paths.home);
  const config = defaultConfig();
  await saveConfig(paths.config, config);
  return { config, created: true };
}

const program = new Command()
  .name('voicecode-agent')
  .description(
    'Voice-controlled Claude Code and desktop mouse control from any browser on your LAN',
  )
  .version(VERSION);

program
  .command('init')
  .description('Create config, local certificate authority and server certificate')
  .option('-p, --project <dir>', 'add a project directory Claude may work in')
  .option('--port <port>', 'HTTPS port', parsePort)
  .option('--host <address>', 'bind address (default 0.0.0.0)')
  .option('--regenerate-ca', 'create a new CA (all phones must re-install it)')
  .action(
    async (opts: { project?: string; port?: number; host?: string; regenerateCa?: boolean }) => {
      const paths = resolvePaths();
      const { config, created } = await loadOrInit(paths);
      if (opts.port) config.server.port = opts.port;
      if (opts.host) config.server.host = opts.host;
      if (opts.project) await addProject(config, opts.project);
      await saveConfig(paths.config, config);
      await ensureControlToken(paths);

      const tls = await ensureTls(
        paths,
        lanAddresses().map((a) => a.address),
        silentLogger(),
        {
          forceCa: opts.regenerateCa,
        },
      );

      heading('VoiceCode Agent', VERSION);
      out(created ? ok('  Initialized') : ok('  Updated'));
      row('Config', paths.config);
      row('Projects', config.projects.map((p) => p.path).join(', ') || warn('none yet'));
      row('CA SHA-256', tls.caFingerprint);
      out();
      printChecks(await runChecks(config, paths));
      out();
      out(
        `  Next: ${pc.bold('voicecode-agent start')}${config.projects.length ? '' : pc.bold(' --project <dir>')}`,
      );
    },
  );

program
  .command('start')
  .description('Start the local HTTPS/WebSocket server')
  .option('-p, --project <dir>', 'allow (and remember) this project directory')
  .option('--port <port>', 'HTTPS port for this run', parsePort)
  .option('--host <address>', 'bind address for this run')
  .option('--no-qr', 'do not print the pairing QR code')
  .option('-v, --verbose', 'mirror the JSON log to stderr')
  .action(
    async (opts: {
      project?: string;
      port?: number;
      host?: string;
      qr: boolean;
      verbose?: boolean;
    }) => {
      const paths = resolvePaths();
      const { config } = await loadOrInit(paths);
      if (opts.project) {
        await addProject(config, opts.project);
        await saveConfig(paths.config, config);
      }
      if (opts.port) config.server.port = opts.port;
      if (opts.host) config.server.host = opts.host;

      if (await isAgentRunning(paths)) {
        out(fail('The agent is already running. Use `voicecode-agent stop` first.'));
        process.exitCode = 1;
        return;
      }

      const logger = createLogger({ file: paths.log, verbose: opts.verbose });
      const agent = new Agent(config, paths, logger);
      const info = await agent.start();
      const url = info.urls[0]!;

      const auth = (await runChecks(config, paths, { probeMouse: false })).find(
        (c) => c.name === 'Claude Code auth',
      );
      heading('VoiceCode Agent', VERSION);
      out(`  ${ok('●')} Running`);
      out();
      row('Platform', platformName());
      row('Claude Code', auth?.status === 'ok' ? ok(auth.detail) : warn(auth?.fix ?? 'unknown'));
      row(
        'Mouse driver',
        info.mouse.available
          ? ok(`Ready (${info.mouse.driver})`)
          : warn(`Unavailable — ${info.mouse.reason}`),
      );
      row(
        'Projects',
        info.projects.map((p) => p.name).join(', ') || warn('none — add one with --project'),
      );
      row('LAN URL', pc.bold(url));
      for (const extra of info.urls.slice(1)) row('', extra);
      row(
        'Pairing code',
        `${pc.bold(info.pairingCode.display)}  ${pc.dim(`expires in ${minutesUntil(info.pairingCode.expiresAt)} min`)}`,
      );
      row('CA SHA-256', pc.dim(info.caFingerprint));
      out();
      if (opts.qr) {
        out(pc.dim('  Scan with your phone to open and pair:'));
        await printQr(`${url}/#pair=${info.pairingCode.code}`);
      }
      out(pc.dim(`  First time on a device? Install the CA from ${url}/voicecode-ca.crt`));
      out(pc.dim('  so the browser trusts the agent (required for the microphone).'));
      out();
      out(`  Ready for browser connections ${pc.dim('(Ctrl+C to stop)')}`);

      agent.on('paired', (d) => out(`${timestamp()} ${ok('Paired')} ${d.name}`));
      agent.on('pairingFailed', (reason, addr) =>
        out(`${timestamp()} ${warn('Pairing failed')} (${reason}) from ${addr}`),
      );
      agent.on('connections', (n) =>
        out(`${timestamp()} ${n} client${n === 1 ? '' : 's'} connected`),
      );

      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        out(`\n${timestamp()} Stopping…`);
        await agent.stop();
      };
      agent.on('stopped', () => {
        out(`${timestamp()} Stopped`);
        logger.flush();
        process.exit(0);
      });
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
    },
  );

program
  .command('pair')
  .description('Generate a new device pairing code on the running agent')
  .action(async () => {
    const paths = resolvePaths();
    const res = await controlRequest<{ code: string; raw: string; expiresAt: number; url: string }>(
      paths,
      'POST',
      '/pair',
    );
    out(
      `Pairing code ${pc.bold(res.code)} ${pc.dim(`(expires in ${minutesUntil(res.expiresAt)} min)`)}`,
    );
    await printQr(`${res.url}/#pair=${res.raw}`);
    out(pc.dim(`  ${res.url}`));
  });

const devices = program.command('devices').description('Show or revoke paired devices');
devices
  .command('list', { isDefault: true })
  .description('List paired devices')
  .action(async () => {
    const paths = resolvePaths();
    let list: PublicDevice[];
    let online = new Set<string>();
    try {
      const res = await controlRequest<{ devices: PublicDevice[]; online: string[] }>(
        paths,
        'GET',
        '/devices',
      );
      list = res.devices;
      online = new Set(res.online);
    } catch (err) {
      if (!(err instanceof AgentNotRunningError)) throw err;
      list = (await DeviceRegistry.open(paths.devices)).list();
    }
    if (!list.length)
      return out('No paired devices. Pair one with the code shown by `voicecode-agent start`.');
    for (const d of list) {
      const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'never';
      out(
        `${online.has(d.id) ? ok('●') : pc.dim('○')} ${pc.bold(d.name)}  ${pc.dim(d.id.slice(0, 8))}  last seen ${seen}`,
      );
    }
  });
devices
  .command('revoke <id>')
  .description('Revoke a device by id prefix, or "all"')
  .action(async (id: string) => {
    const paths = resolvePaths();
    try {
      const res = await controlRequest<{ revoked: number }>(paths, 'POST', '/devices/revoke', {
        id,
      });
      out(ok(`Revoked ${res.revoked} device(s)`));
    } catch (err) {
      if (!(err instanceof AgentNotRunningError)) throw err;
      await revokeOffline(paths, id);
    }
  });

/** Edits the device store directly when no agent is running. */
async function revokeOffline(paths: AgentPaths, id: string): Promise<void> {
  const registry = await DeviceRegistry.open(paths.devices);
  if (id === 'all') return out(ok(`Revoked ${await registry.revokeAll()} device(s)`));
  const match = registry.list().filter((d) => d.id.startsWith(id));
  if (match.length !== 1) throw new Error(match.length ? 'Ambiguous device id' : 'No such device');
  await registry.revoke(match[0]!.id);
  out(ok(`Revoked ${match[0]!.name}`));
}

program
  .command('sessions')
  .description('List live Claude sessions on the running agent and recent sessions per project')
  .action(async () => {
    const paths = resolvePaths();
    const config = await loadConfig(paths.config);
    try {
      const { sessions } = await controlRequest<{ sessions: SessionSummary[] }>(
        paths,
        'GET',
        '/sessions',
      );
      out(pc.bold('Live sessions'));
      if (!sessions.length) out(pc.dim('  none'));
      for (const s of sessions) {
        const project = config?.projects.find((p) => p.id === s.projectId)?.name ?? s.projectId;
        out(`  ${s.state.padEnd(20)} ${project}  ${s.title ?? pc.dim('(no prompt yet)')}`);
      }
    } catch (err) {
      if (!(err instanceof AgentNotRunningError)) throw err;
      out(pc.dim('Agent is not running; showing saved sessions only.'));
    }
    const { listSessions } = await import('@anthropic-ai/claude-agent-sdk');
    for (const project of config?.projects ?? []) {
      out();
      out(`${pc.bold(project.name)} ${pc.dim(project.path)}`);
      const recent = await listSessions({ dir: project.path, limit: 10 });
      if (!recent.length) out(pc.dim('  no saved sessions'));
      for (const s of recent) {
        out(
          `  ${pc.dim(new Date(s.lastModified).toLocaleString().padEnd(22))} ${s.customTitle ?? s.summary}`,
        );
      }
    }
  });

const projects = program
  .command('projects')
  .description('Manage the directories Claude may work in');
projects.command('list', { isDefault: true }).action(async () => {
  const config = await loadConfig(resolvePaths().config);
  if (!config?.projects.length)
    return out('No projects. Add one with `voicecode-agent projects add <dir>`.');
  for (const p of config.projects) out(`${pc.bold(p.name)}  ${p.path}  ${pc.dim(p.id)}`);
});
projects
  .command('add <dir>')
  .option('-n, --name <name>', 'display name')
  .action(async (dir: string, opts: { name?: string }) => {
    const paths = resolvePaths();
    const { config } = await loadOrInit(paths);
    const project = await addProject(config, dir, opts.name);
    await saveConfig(paths.config, config);
    out(ok(`Allowed ${project.path}`));
    if (await isAgentRunning(paths)) out(warn('Restart the agent to pick up the change.'));
  });
projects.command('remove <nameOrId>').action(async (key: string) => {
  const paths = resolvePaths();
  const { config } = await loadOrInit(paths);
  const before = config.projects.length;
  config.projects = config.projects.filter((p) => p.id !== key && p.name !== key);
  if (config.projects.length === before) throw new Error(`No project named ${key}`);
  await saveConfig(paths.config, config);
  out(ok(`Removed ${key}`));
});

program
  .command('doctor')
  .description('Diagnose OS integrations, Claude Code and network setup')
  .action(async () => {
    const paths = resolvePaths();
    const config = await loadConfig(paths.config);
    heading('VoiceCode Doctor', VERSION);
    out();
    const results = await runChecks(config, paths);
    printChecks(results);
    if (results.some((r) => r.status === 'fail')) process.exitCode = 1;
  });

program
  .command('stop')
  .description('Stop the running agent')
  .action(async () => {
    await controlRequest(resolvePaths(), 'POST', '/stop');
    out(ok('Agent is stopping'));
  });

program.parseAsync().catch((err: unknown) => {
  out(fail((err as Error).message));
  if (process.env.VOICECODE_DEBUG) console.error(err);
  process.exitCode = 1;
});
