import type { Command } from 'commander';
import pc from 'picocolors';
import { Agent, type AgentTunnelInfo } from '../../agent.js';
import { addProject, saveConfig } from '../../config/config.js';
import { resolvePaths } from '../../config/paths.js';
import { runChecks } from '../../doctor/checks.js';
import { isAgentRunning } from '../../ipc/control.js';
import { sharedTunnelWarning } from '../../tunnel/cloudflared.js';
import { createLogger } from '../../util/logger.js';
import { VERSION } from '../../util/version.js';
import {
  loadOrInit,
  parsePort,
  prepareClaudeCode,
  setUpWorkspace,
  warnAboutAutoApprovals,
} from '../shared.js';
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
import { LiveDashboard } from '../dashboard.js';

interface StartOptions {
  project?: string;
  root?: string;
  port?: number;
  host?: string;
  qr: boolean;
  dashboard: boolean;
  verbose?: boolean;
  tunnel?: boolean;
}

export function registerStart(program: Command): void {
  program
    // Also what a bare `voicecode-agent` runs, from any directory: everything it needs
    // lives in the per-user config folder, created on first use.
    .command('start', { isDefault: true })
    .description('Start the local HTTPS/WebSocket server (the default command)')
    .option('-p, --project <dir>', 'allow (and remember) this project directory')
    .option('-r, --root <dir>', 'allow (and remember) a workspace folder of projects')
    .option('--port <port>', 'HTTPS port for this run', parsePort)
    .option('--host <address>', 'bind address for this run')
    .option('--no-qr', 'do not print the pairing QR code')
    .option('--no-dashboard', 'print a scrolling log instead of the live dashboard')
    .option('--tunnel', 'use a Cloudflare quick tunnel for this run if none is configured')
    .option('--no-tunnel', 'do not start the configured Cloudflare Tunnel this run')
    .option('-v, --verbose', 'mirror the JSON log to stderr')
    .action(start);
}

async function start(opts: StartOptions): Promise<void> {
  const paths = resolvePaths();
  if (await isAgentRunning(paths)) {
    out(fail('The agent is already running. Use `voicecode-agent status` or `stop`.'));
    process.exitCode = 1;
    return;
  }
  const { config, created } = await loadOrInit(paths);
  if (created) out(ok(`  First run: settings are kept in ${paths.home}`));
  if (opts.project) {
    const project = await addProject(config, opts.project);
    await warnAboutAutoApprovals(project.path);
    await saveConfig(paths.config, config);
  }
  if (await setUpWorkspace(config, opts.root)) await saveConfig(paths.config, config);
  if (opts.port) config.server.port = opts.port;
  if (opts.host) config.server.host = opts.host;
  if (opts.tunnel === false) config.tunnel.mode = 'off';
  if (opts.tunnel === true && config.tunnel.mode === 'off') config.tunnel.mode = 'quick';

  await prepareClaudeCode();
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
  const lanUrl = info.urls[0]!;
  const tunnelUrl = 'url' in info.tunnel ? info.tunnel.url : undefined;
  const url = tunnelUrl ?? lanUrl;

  const auth = (await runChecks(config, paths, { probeMouse: false, probeVoice: false })).find(
    (c) => c.name === 'Claude Code auth',
  );

  let shuttingDown = false;
  let dashboard: LiveDashboard | undefined;
  /** Back on the normal screen, with what happened while the dashboard was up. */
  const closeDashboard = () => {
    if (!dashboard) return;
    const events = dashboard.stop();
    dashboard = undefined;
    for (const e of events.slice(-20)) {
      out(`${pc.dim(new Date(e.at).toLocaleTimeString())} ${e.text}`);
    }
  };
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    closeDashboard();
    out(`\n${timestamp()} Stopping…`);
    await agent.stop();
  };
  agent.on('stopped', () => {
    closeDashboard();
    out(`${timestamp()} Stopped`);
    logger.flush();
    process.exit(0);
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Sent when the terminal goes away (Node also emits it when a Windows console closes).
  process.on('SIGHUP', shutdown);

  // The JSON log on stderr would scroll the dashboard away, so --verbose keeps the log view.
  if (opts.dashboard && process.stdout.isTTY && process.stdin.isTTY && !opts.verbose) {
    dashboard = new LiveDashboard(
      agent,
      {
        version: VERSION,
        platform: platformName(),
        claudeCode:
          auth?.status === 'ok'
            ? { ok: true, text: auth.detail }
            : { ok: false, text: auth?.fix ?? 'unknown' },
        workspace: config.roots,
        caFingerprint: info.caFingerprint,
        qr: opts.qr,
      },
      () => void shutdown(),
    );
    dashboard.start();
    return;
  }

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
    'Phone mic',
    info.voiceMic.available
      ? ok(`Ready (${info.voiceMic.driver} → ${info.voiceMic.device})`)
      : pc.dim(`Off — ${info.voiceMic.reason} (see \`voicecode-agent doctor\`)`),
  );
  row(
    'Projects',
    info.projects.map((p) => p.name).join(', ') ||
      (config.roots.length ? pc.dim('none yet') : warn('none — add a folder with --root <dir>')),
  );
  if (config.roots.length) row('Workspace', config.roots.join(', '));
  row('LAN URL', tunnelUrl ? lanUrl : pc.bold(lanUrl));
  for (const extra of info.urls.slice(1)) row('', extra);
  if (info.tunnel.mode !== 'off') row('Tunnel URL', describeTunnel(info.tunnel));
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
  if (tunnelUrl) {
    out(pc.dim('  The tunnel URL works on any phone without installing a certificate.'));
    out(warn('  It is reachable from the internet: only share pairing codes with your devices.'));
    if (info.tunnel.mode === 'quick') {
      out(pc.dim('  Quick tunnel URLs change on every start, so devices pair again each time.'));
    }
  } else {
    out(pc.dim(`  First time on a device? Install the CA from ${lanUrl}/voicecode-ca.crt`));
    out(pc.dim('  so the browser trusts the agent (required for the microphone).'));
  }
  out();
  out(`  Ready for browser connections ${pc.dim('(Ctrl+C to stop)')}`);

  agent.on('paired', (d) => out(`${timestamp()} ${ok('Paired')} ${clean(d.name)}`));
  agent.on('pairingFailed', (reason, addr) =>
    out(`${timestamp()} ${warn('Pairing failed')} (${reason}) from ${addr}`),
  );
  agent.on('tunnel', (t) => {
    if (t.mode === 'off' || 'error' in t || t.state === 'connecting') return;
    out(`${timestamp()} Tunnel ${describeTunnel(t)}`);
    if (t.state === 'ready' && t.mode === 'quick' && t.url !== tunnelUrl) {
      out(pc.dim('  The quick tunnel URL changed; run `voicecode-agent pair` for a new code.'));
    }
  });
  agent.on('folderAllowed', (dir, device) =>
    out(`${timestamp()} ${warn('Folder allowed')} ${clean(dir)} by ${clean(device)}`),
  );
  agent.on('connections', (n) => out(`${timestamp()} ${n} client${n === 1 ? '' : 's'} connected`));
}

function describeTunnel(t: AgentTunnelInfo): string {
  if (t.mode === 'off') return pc.dim('off');
  if ('error' in t) return warn(`Unavailable — ${t.error}`);
  switch (t.state) {
    case 'ready':
      return t.sharedWith
        ? `${pc.bold(t.url)} ${warn(`— ${sharedTunnelWarning(t.sharedWith)}`)}`
        : pc.bold(t.url);
    case 'connecting':
      return warn('Connecting… (check `voicecode-agent status` in a moment)');
    case 'down':
      return warn(`Down — ${t.reason}; retrying in ${Math.round(t.retryInMs / 1000)}s`);
  }
}
