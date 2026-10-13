import type { Command } from 'commander';
import pc from 'picocolors';
import { Agent } from '../../agent.js';
import { addProject, saveConfig } from '../../config/config.js';
import { resolvePaths } from '../../config/paths.js';
import { runChecks } from '../../doctor/checks.js';
import { isAgentRunning } from '../../ipc/control.js';
import { createLogger } from '../../util/logger.js';
import { VERSION } from '../../util/version.js';
import { loadOrInit, parsePort, warnAboutAutoApprovals } from '../shared.js';
import {
  clean,
  fail,
  heading,
  minutesUntil,
  ok,
  out,
  platformName,
  printQr,
  row,
  timestamp,
  warn,
} from '../ui.js';

interface StartOptions {
  project?: string;
  port?: number;
  host?: string;
  qr: boolean;
  verbose?: boolean;
}

export function registerStart(program: Command): void {
  program
    .command('start')
    .description('Start the local HTTPS/WebSocket server')
    .option('-p, --project <dir>', 'allow (and remember) this project directory')
    .option('--port <port>', 'HTTPS port for this run', parsePort)
    .option('--host <address>', 'bind address for this run')
    .option('--no-qr', 'do not print the pairing QR code')
    .option('-v, --verbose', 'mirror the JSON log to stderr')
    .action(start);
}

async function start(opts: StartOptions): Promise<void> {
  const paths = resolvePaths();
  const { config } = await loadOrInit(paths);
  if (opts.project) {
    const project = await addProject(config, opts.project);
    await warnAboutAutoApprovals(project.path);
    await saveConfig(paths.config, config);
  }
  if (opts.port) config.server.port = opts.port;
  if (opts.host) config.server.host = opts.host;

  if (await isAgentRunning(paths)) {
    out(fail('The agent is already running. Use `voicecode-agent status` or `stop`.'));
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ file: paths.log, verbose: opts.verbose });
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
  const agent = new Agent(config, paths, logger);

  let info: Awaited<ReturnType<Agent['start']>>;
  try {
    info = await agent.start();
  } catch (err) {
    logger.error({ err }, 'agent failed to start');
    logger.flush();
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === 'EADDRINUSE'
        ? `Port ${config.server.port} is already in use. Pick another with --port <n>.`
        : code === 'EACCES'
          ? `Not allowed to listen on ${config.server.host}:${config.server.port}. Use a port above 1024.`
          : `Failed to start: ${(err as Error).message}`,
      { cause: err },
    );
  }
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

  agent.on('paired', (d) => out(`${timestamp()} ${ok('Paired')} ${clean(d.name)}`));
  agent.on('pairingFailed', (reason, addr) =>
    out(`${timestamp()} ${warn('Pairing failed')} (${reason}) from ${addr}`),
  );
  agent.on('connections', (n) => out(`${timestamp()} ${n} client${n === 1 ? '' : 's'} connected`));

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
  // Sent when the terminal goes away (Node also emits it when a Windows console closes).
  process.on('SIGHUP', shutdown);
}
