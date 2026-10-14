import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { inspectCertificate, serverSubjectAltNames } from '@voicecode/security';
import {
  bundledClaudePackage,
  claudeCodeVersion,
  resolveClaudeExecutable,
} from '../claude/claude-executable.js';
import type { AgentConfig } from '../config/config.js';
import {
  describeAutoApprovals,
  hasAutoApprovals,
  inspectProjectSettings,
} from '../config/project-settings.js';
import type { AgentPaths } from '../config/paths.js';
import { isAgentRunning } from '../ipc/control.js';
import { InputRouter } from '../mouse/input-router.js';
import { detectDisplayServer, driverCandidates } from '../mouse/resolve-driver.js';
import { fileExists } from '../util/fs.js';
import { isStandalone } from '../util/standalone.js';
import { silentLogger } from '../util/logger.js';
import { rankedLanAddresses } from '../util/network.js';
import { autostartStatus } from '../system/autostart.js';
import { inspectWindowsFirewall } from '../system/firewall.js';
import {
  cloudflaredVersion,
  findCloudflared,
  INSTALL_HINT,
  tunnelSetupProblem,
} from '../tunnel/cloudflared.js';

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
    detail: `v${process.versions.node}${isStandalone() ? ' (built in)' : ''}`,
    fix: 'Install Node.js 22.12 or newer',
  });
  add({
    name: 'Platform',
    status: process.platform === 'win32' || process.platform === 'linux' ? 'ok' : 'fail',
    detail: `${os.type()} ${os.release()} (${process.arch})`,
    fix: 'Only Windows and Linux are supported',
  });

  // Claude Code --------------------------------------------------------------
  for (const result of await checkClaude()) add(result);

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
      const approvals = ok ? await inspectProjectSettings(project.path) : undefined;
      if (approvals && hasAutoApprovals(approvals)) {
        add({
          name: `  auto-approvals`,
          status: 'warn',
          detail: describeAutoApprovals(approvals),
          fix: `Only allow projects you trust; review ${approvals.files.join(' and ')}`,
        });
      }
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
  if (process.platform === 'win32' && config) add(await checkFirewall(config.server.port));
  if (config && config.tunnel.mode !== 'off') add(await checkTunnel(config, paths));
  if (config) add(await checkAutostart());

  return results;
}

async function checkTunnel(config: AgentConfig, paths: AgentPaths): Promise<CheckResult> {
  const name = 'Cloudflare Tunnel';
  const exe = findCloudflared(config.tunnel.cloudflared);
  if (!exe) {
    return { name, status: 'fail', detail: 'cloudflared not found', fix: INSTALL_HINT };
  }
  const problem = await tunnelSetupProblem(config.tunnel, paths);
  if (problem) {
    return { name, status: 'fail', detail: problem, fix: 'Run `voicecode-agent tunnel` for setup' };
  }
  const version = (await cloudflaredVersion(exe)) ?? 'unknown version';
  const where =
    config.tunnel.mode === 'quick'
      ? 'random trycloudflare.com URL'
      : `https://${config.tunnel.hostname}`;
  return {
    name,
    status: 'warn',
    detail: `${config.tunnel.mode}: ${where} (cloudflared ${version})`,
    fix: 'Reachable from the internet; only share pairing codes with your own devices',
  };
}

function checkClaudeExecutable(): CheckResult | undefined {
  const exe = resolveClaudeExecutable();
  const version = claudeCodeVersion(bundledClaudePackage());
  switch (exe.source) {
    case 'sdk':
      return undefined;
    case 'env':
      return existsSync(exe.path!)
        ? { name: 'Claude Code', status: 'ok', detail: `${exe.path} (VOICECODE_CLAUDE_PATH)` }
        : {
            name: 'Claude Code',
            status: 'fail',
            detail: `VOICECODE_CLAUDE_PATH points to a missing file: ${exe.path}`,
            fix: 'Fix or unset VOICECODE_CLAUDE_PATH',
          };
    case 'managed':
      return { name: 'Claude Code', status: 'ok', detail: `${version} (managed)` };
    case 'path':
      return {
        name: 'Claude Code',
        status: 'warn',
        detail: `using ${exe.path}; its version may not match ${version || 'this build'}`,
        fix: 'Run `voicecode-agent start` with internet access to download the matching version',
      };
    case 'missing':
      return {
        name: 'Claude Code',
        status: 'warn',
        detail: 'not downloaded yet',
        fix: 'It is downloaded the first time you run `voicecode-agent start`',
      };
  }
}

async function checkClaude(): Promise<CheckResult[]> {
  const executable = checkClaudeExecutable();

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

  const auth: CheckResult = sources.length
    ? { name: 'Claude Code auth', status: 'ok', detail: sources.join(', ') }
    : {
        name: 'Claude Code auth',
        status: 'warn',
        detail: 'no credentials detected',
        fix: 'Run `claude` once and log in, or set ANTHROPIC_API_KEY',
      };
  return executable ? [executable, auth] : [auth];
}

async function checkMouse(config: AgentConfig): Promise<CheckResult> {
  const logger = silentLogger();
  const router = new InputRouter(logger, { leaseIdleMs: config.mouse.leaseIdleMs });
  const all = driverCandidates(config, logger);
  // Never pop up a compositor consent dialog from a diagnostic run.
  const interactive = all.candidates.filter((c) => c.interactive);
  const candidates = all.candidates.filter((c) => !c.interactive);
  const unavailableReason = all.unavailableReason;
  if (interactive.length && !candidates.length) {
    return {
      name: 'Mouse driver',
      status: 'ok',
      detail: `${interactive[0]!.name} (asks for permission on the desktop the first time the agent starts)`,
    };
  }
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

async function checkFirewall(port: number): Promise<CheckResult> {
  try {
    const state = await inspectWindowsFirewall(port);
    if (!state.ruleOk) {
      return {
        name: 'Firewall',
        status: 'warn',
        detail: `no inbound rule for TCP ${port}; phones may not be able to connect`,
        fix: 'Run `voicecode-agent firewall` (asks for admin once)',
      };
    }
    if (state.networkCategories.includes('Public')) {
      return {
        name: 'Firewall',
        status: 'warn',
        detail: `TCP ${port} allowed, but the active network is marked Public (rule does not apply)`,
        fix: 'Set your home/office network to Private in Settings → Network & internet',
      };
    }
    return { name: 'Firewall', status: 'ok', detail: `inbound TCP ${port} allowed` };
  } catch (err) {
    return {
      name: 'Firewall',
      status: 'warn',
      detail: `could not inspect Windows Firewall: ${(err as Error).message.split('\n')[0]}`,
    };
  }
}

async function checkAutostart(): Promise<CheckResult> {
  const status = await autostartStatus();
  return status.enabled
    ? { name: 'Start at login', status: 'ok', detail: status.file }
    : {
        name: 'Start at login',
        status: 'ok',
        detail: 'off (optional: `voicecode-agent autostart enable`)',
      };
}
