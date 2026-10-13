import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { inspectCertificate, serverSubjectAltNames } from '@voicecode/security';
import type { AgentConfig } from '../config/config.js';
import type { AgentPaths } from '../config/paths.js';
import { isAgentRunning } from '../ipc/control.js';
import { InputRouter } from '../mouse/input-router.js';
import { detectDisplayServer, driverCandidates } from '../mouse/resolve-driver.js';
import { fileExists } from '../util/fs.js';
import { silentLogger } from '../util/logger.js';
import { rankedLanAddresses } from '../util/network.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export async function runChecks(
  config: AgentConfig | undefined,
  paths: AgentPaths,
  options: { probeMouse?: boolean } = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (r: CheckResult) => results.push(r);

  // Runtime ----------------------------------------------------------------
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  add({
    name: 'Node.js',
    status: major > 22 || (major === 22 && minor >= 12) ? 'ok' : 'fail',
    detail: `v${process.versions.node}`,
    fix: 'Install Node.js 22.12 or newer',
  });
  add({
    name: 'Platform',
    status: process.platform === 'win32' || process.platform === 'linux' ? 'ok' : 'fail',
    detail: `${os.type()} ${os.release()} (${process.arch})`,
    fix: 'Only Windows and Linux are supported',
  });

  // Claude Code --------------------------------------------------------------
  add(await checkClaude());

  // Config -------------------------------------------------------------------
  if (!config) {
    add({
      name: 'Config',
      status: 'fail',
      detail: `missing ${paths.config}`,
      fix: 'Run `voicecode-agent init`',
    });
  } else {
    add({ name: 'Config', status: 'ok', detail: paths.config });
    if (config.projects.length === 0) {
      add({
        name: 'Projects',
        status: 'warn',
        detail: 'no allowed project directories',
        fix: 'Run `voicecode-agent projects add <dir>` or start with --project',
      });
    }
    for (const project of config.projects) {
      const ok = await stat(project.path).then(
        (s) => s.isDirectory(),
        () => false,
      );
      add({
        name: `Project ${project.name}`,
        status: ok ? 'ok' : 'warn',
        detail: project.path,
        fix: ok
          ? undefined
          : 'Directory no longer exists; remove it with `voicecode-agent projects remove`',
      });
    }
    if (config.claude.permissionMode !== 'default') {
      add({
        name: 'Permission mode',
        status: 'warn',
        detail: `"${config.claude.permissionMode}" — some tool calls will not ask for approval`,
      });
    }
  }

  // Desktop / mouse ------------------------------------------------------------
  const display = detectDisplayServer();
  add({
    name: 'Desktop session',
    status: display === 'none' ? 'fail' : display === 'wayland' ? 'warn' : 'ok',
    detail: display,
    fix:
      display === 'none'
        ? 'Run the agent from a terminal inside your logged-in graphical session'
        : display === 'wayland'
          ? 'Wayland support uses ydotool for now; X11 sessions use XTest'
          : undefined,
  });
  if (options.probeMouse !== false && config) add(await checkMouse(config));

  // TLS ------------------------------------------------------------------------
  add(await checkTls(paths));

  // Network ----------------------------------------------------------------------
  const addresses = await rankedLanAddresses();
  add({
    name: 'LAN address',
    status: addresses.length ? 'ok' : 'warn',
    detail: addresses.length
      ? addresses.map((a) => `${a.address} (${a.iface})`).join(', ')
      : 'none found',
    fix: addresses.length
      ? undefined
      : 'Connect to a private network (10.x, 172.16-31.x, 192.168.x)',
  });
  if (config && !(await isAgentRunning(paths))) {
    const free = await portFree(config.server.host, config.server.port);
    add({
      name: 'Port',
      status: free ? 'ok' : 'fail',
      detail: `${config.server.host}:${config.server.port} ${free ? 'is free' : 'is in use'}`,
      fix: free ? undefined : 'Choose another port with `voicecode-agent start --port <n>`',
    });
  }
  if (process.platform === 'win32' && config) {
    add({
      name: 'Firewall',
      status: 'warn',
      detail: 'Windows Defender Firewall may block inbound connections',
      fix: `Allow it once (admin PowerShell): New-NetFirewallRule -DisplayName "VoiceCode Agent" -Direction Inbound -Protocol TCP -LocalPort ${config.server.port} -Profile Private -Action Allow`,
    });
  }

  return results;
}

async function checkClaude(): Promise<CheckResult> {
  try {
    import.meta.resolve('@anthropic-ai/claude-agent-sdk');
  } catch {
    return {
      name: 'Claude Agent SDK',
      status: 'fail',
      detail: 'not installed',
      fix: 'Reinstall voicecode-agent',
    };
  }

  const env = process.env;
  const configDir = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const sources: string[] = [];
  if (env.ANTHROPIC_API_KEY) sources.push('ANTHROPIC_API_KEY');
  if (env.ANTHROPIC_AUTH_TOKEN) sources.push('ANTHROPIC_AUTH_TOKEN');
  if (env.CLAUDE_CODE_OAUTH_TOKEN) sources.push('CLAUDE_CODE_OAUTH_TOKEN');
  if (env.CLAUDE_CODE_USE_BEDROCK) sources.push('Amazon Bedrock');
  if (env.CLAUDE_CODE_USE_VERTEX) sources.push('Google Vertex AI');
  if (env.CLAUDE_CODE_USE_FOUNDRY) sources.push('Microsoft Foundry');
  if (existsSync(path.join(configDir, '.credentials.json'))) sources.push('Claude login');

  return sources.length
    ? { name: 'Claude Code auth', status: 'ok', detail: sources.join(', ') }
    : {
        name: 'Claude Code auth',
        status: 'warn',
        detail: 'no credentials detected',
        fix: 'Run `claude` once and log in, or set ANTHROPIC_API_KEY',
      };
}

async function checkMouse(config: AgentConfig): Promise<CheckResult> {
  const logger = silentLogger();
  const router = new InputRouter(logger, { leaseIdleMs: config.mouse.leaseIdleMs });
  const { candidates, unavailableReason } = driverCandidates(config, logger);
  await router.start(candidates, unavailableReason);
  const status = router.status();
  const details = router.info?.details ?? {};
  await router.stop();

  if (!status.available) {
    return {
      name: 'Mouse driver',
      status: 'fail',
      detail: status.reason ?? 'unavailable',
      fix: mouseFix(),
    };
  }
  const extras = Object.entries(details)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  if (details.session === '0') {
    return {
      name: 'Mouse driver',
      status: 'fail',
      detail: `${status.driver} is running in Session 0 (services) — it cannot reach your desktop`,
      fix: 'Start the agent from a terminal in your logged-in desktop session, not as a service',
    };
  }
  // Windows UIPI: a medium-integrity process cannot inject input into elevated windows.
  const elevatedNote =
    process.platform === 'win32' && details.integrity && details.integrity !== 'high'
      ? ' (input is ignored by apps running as Administrator)'
      : '';
  return {
    name: 'Mouse driver',
    status: 'ok',
    detail: `${status.driver} ${extras}${elevatedNote}`.trim(),
    fix: status.driver.startsWith('powershell')
      ? 'Optional: build the native helper for lower latency (`npm run build:native`)'
      : undefined,
  };
}

function mouseFix(): string {
  switch (detectDisplayServer()) {
    case 'x11':
      return 'Install xdotool, or build the XTest helper (needs libx11-dev libxtst-dev)';
    case 'wayland':
      return 'Install ydotool and run ydotoold with access to /dev/uinput';
    case 'windows':
      return 'Ensure powershell.exe is on PATH, or build the native helper';
    default:
      return 'Run the agent inside a graphical desktop session';
  }
}

async function checkTls(paths: AgentPaths): Promise<CheckResult> {
  if (!(await fileExists(paths.caCert)) || !(await fileExists(paths.serverCert))) {
    return {
      name: 'TLS certificates',
      status: 'warn',
      detail: 'not created yet',
      fix: 'Run `voicecode-agent init`',
    };
  }
  const ca = inspectCertificate(await readFile(paths.caCert, 'utf8'));
  const leaf = inspectCertificate(await readFile(paths.serverCert, 'utf8'));
  const wanted = serverSubjectAltNames({
    hostname: os.hostname(),
    ips: (await rankedLanAddresses()).map((a) => a.address),
  });
  const missing = wanted.ips.filter((ip) => !leaf.ips.includes(ip));
  const days = Math.floor((leaf.notAfter.getTime() - Date.now()) / 86_400_000);
  return {
    name: 'TLS certificates',
    status: 'ok',
    detail:
      `CA ${(await ca.fingerprintPromise).slice(0, 23)}…, server cert valid ${days} more days` +
      (missing.length ? `; will be reissued on start to add ${missing.join(', ')}` : ''),
  };
}

function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}
