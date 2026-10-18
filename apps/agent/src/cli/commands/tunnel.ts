import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { Command } from 'commander';
import pc from 'picocolors';
import { isValidHostname, saveConfig, type AgentConfig } from '../../config/config.js';
import { resolvePaths, type AgentPaths } from '../../config/paths.js';
import { isAgentRunning } from '../../ipc/control.js';
import {
  cloudflaredVersion,
  configuredTunnelId,
  decodeTunnelToken,
  defaultTunnelName,
  findCloudflared,
  findTunnelId,
  INSTALL_HINT,
  originCertPath,
  originUrl,
  runCloudflared,
  sharedTunnelWarning,
  tunnelConnectors,
  tunnelSetupProblem,
} from '../../tunnel/cloudflared.js';
import { ensurePrivateDir, readJsonFile, writeFileAtomic } from '../../util/fs.js';
import { loadOrInit } from '../shared.js';
import { clean, ok, out, row, warn } from '../ui.js';

export function registerTunnel(program: Command): void {
  const tunnel = program
    .command('tunnel')
    .description('Reach the agent through Cloudflare Tunnel (no certificate install on phones)');

  tunnel
    .command('status', { isDefault: true })
    .description('Show the tunnel configuration')
    .action(showStatus);

  tunnel
    .command('quick')
    .description('Use a free *.trycloudflare.com URL (no account; changes on every start)')
    .action(async () => {
      const { paths, config } = await load();
      config.tunnel = { ...config.tunnel, mode: 'quick' };
      await saveConfig(paths.config, config);
      out(ok('Quick tunnel enabled.'));
      publicWarning();
      out(pc.dim('  The URL changes on every start, so devices have to pair again each time.'));
      out(pc.dim('  For a stable URL on your own domain, use `voicecode-agent tunnel setup`.'));
      await applyHint(paths);
    });

  tunnel
    .command('setup <hostname>')
    .description('Create a tunnel on your own domain (the domain must be on Cloudflare)')
    .option(
      '-n, --name <name>',
      `tunnel name in your Cloudflare account, one per PC (default: ${defaultTunnelName()})`,
    )
    .option('--overwrite-dns', 'replace an existing DNS record for the host name')
    .action(setupNamed);

  tunnel
    .command('token <hostname>')
    .description('Use a tunnel created in the Cloudflare dashboard (token read from stdin)')
    .action(setupToken);

  tunnel
    .command('off')
    .description('Stop using a tunnel (credentials are kept)')
    .action(async () => {
      const { paths, config } = await load();
      config.tunnel = { ...config.tunnel, mode: 'off' };
      await saveConfig(paths.config, config);
      out(ok('Tunnel disabled; the agent is LAN-only again.'));
      await applyHint(paths);
    });
}

async function load(): Promise<{ paths: AgentPaths; config: AgentConfig }> {
  const paths = resolvePaths();
  const { config } = await loadOrInit(paths);
  return { paths, config };
}

function requireCloudflared(config: AgentConfig): string {
  const exe = findCloudflared(config.tunnel.cloudflared);
  if (!exe) throw new Error(`cloudflared was not found. ${INSTALL_HINT}.`);
  return exe;
}

function normalizeHostname(raw: string): string {
  const hostname = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!isValidHostname(hostname)) {
    throw new Error(`"${clean(raw)}" is not a host name like code.example.com`);
  }
  return hostname;
}

function publicWarning(): void {
  out(warn('  The pairing page becomes reachable from the internet. Pairing still needs a'));
  out(warn('  one-time code from this PC; only share codes with your own devices.'));
}

async function applyHint(paths: AgentPaths): Promise<void> {
  if (await isAgentRunning(paths)) {
    out(pc.dim('  Restart the agent to apply: `voicecode-agent stop`, then `start`.'));
  }
}

async function showStatus(): Promise<void> {
  const { paths, config } = await load();
  const t = config.tunnel;
  const exe = findCloudflared(t.cloudflared);
  row('Mode', t.mode === 'off' ? pc.dim('off (LAN only)') : t.mode);
  if (t.hostname) row('Host name', t.hostname);
  if (t.tunnelName) row('Tunnel', t.tunnelName);
  if (t.tunnelId) row('Tunnel ID', pc.dim(t.tunnelId));
  row(
    'cloudflared',
    exe
      ? `${exe} ${pc.dim(`(${(await cloudflaredVersion(exe)) ?? 'unknown version'})`)}`
      : warn('not found'),
  );
  if (t.mode !== 'off') {
    const problem = await tunnelSetupProblem(t, paths);
    row('Setup', problem ? warn(problem) : ok('ready'));
    const id = exe && !problem ? await configuredTunnelId(t, paths) : undefined;
    const connectors = id ? await tunnelConnectors(exe!, id) : undefined;
    if (connectors) {
      // The running agent's cloudflared is one of them; any other is a second PC.
      const others = connectors.length - ((await isAgentRunning(paths)) ? 1 : 0);
      row(
        'Running on',
        others > 0
          ? warn(sharedTunnelWarning(others))
          : connectors.length
            ? ok('this PC only')
            : pc.dim('no PC right now'),
      );
    }
  }
  out();
  out(pc.dim('  voicecode-agent tunnel quick                 random trycloudflare.com URL'));
  out(pc.dim('  voicecode-agent tunnel setup <hostname>      your own domain on Cloudflare'));
  out(pc.dim('  voicecode-agent tunnel token <hostname>      a dashboard-managed tunnel'));
  out(pc.dim('  voicecode-agent tunnel off                   LAN only'));
  if (!exe) out(warn(`\n  ${INSTALL_HINT}.`));
}

/**
 * A locally managed named tunnel: `cloudflared tunnel login` authorises one zone, the
 * tunnel's credentials live in the agent's state directory, and the agent writes the
 * ingress rules itself so the origin certificate is verified against the local CA.
 */
async function setupNamed(
  rawHostname: string,
  opts: { name?: string; overwriteDns?: boolean },
): Promise<void> {
  const hostname = normalizeHostname(rawHostname);
  const { paths, config } = await load();
  // A PC set up before tunnels were per PC has no tunnelName and moves off the shared
  // `voicecode` tunnel onto its own; the PCs still on the old one are not touched.
  const name = opts.name ?? config.tunnel.tunnelName ?? defaultTunnelName();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(name)) {
    throw new Error('Tunnel names may contain letters, digits, "-" and "_"');
  }
  const exe = requireCloudflared(config);
  const previous = config.tunnel.mode === 'named' ? config.tunnel : undefined;

  if (!existsSync(originCertPath())) {
    out('Log in to Cloudflare in the browser window that opens, and pick the domain');
    out(`that ${pc.bold(hostname)} belongs to.`);
    await runInteractive(exe, ['tunnel', 'login']);
    if (!existsSync(originCertPath())) throw new Error('Cloudflare login did not complete.');
  }

  await ensurePrivateDir(paths.tunnelDir);
  const tunnelId = await existingTunnelId(exe, name);
  if (tunnelId) {
    await refuseTunnelOfAnotherPc(exe, name, tunnelId, config, paths);
    out(`Using the existing tunnel ${pc.bold(name)} ${pc.dim(tunnelId)}`);
    await writeCredentialsFromToken(exe, name, paths);
  } else {
    await rm(paths.tunnelCredentials, { force: true });
    const created = await runCloudflared(exe, [
      'tunnel',
      'create',
      '--credentials-file',
      paths.tunnelCredentials,
      name,
    ]);
    if (created.code !== 0) throw cloudflaredError('Creating the tunnel failed', created.stderr);
    out(ok(`Created tunnel ${name}`));
  }
  const id = tunnelId ?? (await existingTunnelId(exe, name));
  if (!id) throw new Error('The tunnel was created but its ID could not be read.');

  // This PC's own host name moving to its new tunnel replaces the record that pointed at
  // the tunnel it used before. Any other existing record is only replaced on request.
  const movesOwnHost =
    previous?.hostname === hostname && !!previous.tunnelId && previous.tunnelId !== id;
  const routeArgs = ['tunnel', 'route', 'dns'];
  if (opts.overwriteDns || movesOwnHost) routeArgs.push('--overwrite-dns');
  const routed = await runCloudflared(exe, [...routeArgs, id, hostname]);
  if (routed.code !== 0) {
    const hint = /already exists|already configured/i.test(routed.stderr)
      ? `\nThat host name already has a DNS record, maybe another PC's tunnel. Give each PC its own host name (pc2.${parentDomain(hostname)}, …), or rerun with --overwrite-dns to point it at this PC instead.`
      : '';
    throw cloudflaredError(`Routing ${hostname} to the tunnel failed`, routed.stderr + hint);
  }
  out(ok(`${hostname} → tunnel ${name}`));

  config.tunnel = { ...config.tunnel, mode: 'named', hostname, tunnelId: id, tunnelName: name };
  await saveConfig(paths.config, config);
  out(ok(`Tunnel enabled: https://${hostname}`));
  if (previous?.tunnelId && previous.tunnelId !== id) {
    const old = previous.tunnelName ?? previous.tunnelId;
    out(pc.dim(`  This PC no longer runs the tunnel ${old}. It stays in your account for any`));
    out(pc.dim(`  other PC that uses it; once none does, \`cloudflared tunnel delete ${old}\`.`));
  }
  out(pc.dim('  For another PC, run `tunnel setup` there with a different host name: each PC'));
  out(pc.dim('  gets its own tunnel, and they all work side by side.'));
  publicWarning();
  out(pc.dim('  For a second login in front of the agent, add a Cloudflare Access application'));
  out(pc.dim('  for this host name in the Zero Trust dashboard.'));
  await applyHint(paths);
}

async function existingTunnelId(exe: string, name: string): Promise<string | undefined> {
  const res = await runCloudflared(exe, ['tunnel', 'list', '--output', 'json', '--name', name]);
  if (res.code !== 0) throw cloudflaredError('Listing tunnels failed', res.stderr);
  try {
    return findTunnelId(res.stdout, name);
  } catch {
    throw new Error(
      `cloudflared printed an unreadable tunnel list: ${clean(res.stdout.slice(0, 200))}`,
    );
  }
}

/**
 * Refuses to take over a tunnel another PC is running: two PCs on one tunnel receive each
 * other's requests. The tunnel this PC already runs (its config and credentials name it,
 * and the agent may have it connected right now) is always fine.
 */
async function refuseTunnelOfAnotherPc(
  exe: string,
  name: string,
  id: string,
  config: AgentConfig,
  paths: AgentPaths,
): Promise<void> {
  const credentials = await readJsonFile<{ TunnelID?: unknown }>(paths.tunnelCredentials).catch(
    () => undefined,
  );
  if (config.tunnel.tunnelId === id && credentials?.TunnelID === id) return;
  const connectors = await tunnelConnectors(exe, id);
  if (!connectors?.length) return;
  const other = name === defaultTunnelName() ? `${name}-2` : defaultTunnelName();
  throw new Error(
    `The tunnel "${clean(name)}" is running on another PC right now. Each PC needs a tunnel ` +
      `of its own, or they get each other's requests. Rerun with another name: --name ${other}`,
  );
}

/** `example.com` for `code.example.com`, to suggest a sibling host name. */
function parentDomain(hostname: string): string {
  const labels = hostname.split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : hostname;
}

/** Credentials of a tunnel created elsewhere, rebuilt from its token. */
async function writeCredentialsFromToken(
  exe: string,
  name: string,
  paths: AgentPaths,
): Promise<void> {
  const res = await runCloudflared(exe, ['tunnel', 'token', name]);
  if (res.code !== 0) throw cloudflaredError('Fetching the tunnel credentials failed', res.stderr);
  const decoded = decodeTunnelToken(res.stdout.trim());
  if (!decoded) throw new Error('cloudflared returned an unreadable tunnel token.');
  await writeFileAtomic(
    paths.tunnelCredentials,
    JSON.stringify({ AccountTag: decoded.a, TunnelID: decoded.t, TunnelSecret: decoded.s }),
  );
}

/** A dashboard-managed tunnel: ingress is configured on Cloudflare, we only keep the token. */
async function setupToken(rawHostname: string): Promise<void> {
  const hostname = normalizeHostname(rawHostname);
  const { paths, config } = await load();
  requireCloudflared(config);

  const token = (await readSecret('Paste the tunnel token (input hidden): ')).trim();
  if (!decodeTunnelToken(token)) {
    throw new Error(
      'That is not a tunnel token. Copy it from Zero Trust → Networks → Tunnels → your tunnel.',
    );
  }
  await writeFileAtomic(paths.tunnelToken, `${token}\n`);
  config.tunnel = {
    ...config.tunnel,
    mode: 'token',
    hostname,
    tunnelId: undefined,
    tunnelName: undefined,
  };
  await saveConfig(paths.config, config);
  out(ok(`Tunnel enabled: https://${hostname}`));
  out();
  out(`In the dashboard, give the public hostname ${pc.bold(hostname)} these settings:`);
  row('Service', originUrl(config.server));
  row('CA Pool', paths.caCert);
  out(pc.dim('  (Additional application settings → TLS. Keep "No TLS Verify" off.)'));
  out(pc.dim('  Use a separate tunnel and token for each PC: a token used on two PCs makes them'));
  out(pc.dim("  replicas of one tunnel, and each would get the other's requests."));
  out();
  publicWarning();
  await applyHint(paths);
}

function cloudflaredError(what: string, stderr: string): Error {
  const detail = stderr
    .split(/\r?\n/)
    .map((l) => l.replace(/^\S+\s+(ERR|FTL|INF|WRN)\s+/, '').trim())
    .filter(Boolean)
    .slice(-3)
    .join('\n  ');
  return new Error(`${what}${detail ? `:\n  ${clean(detail)}` : ''}`);
}

function runInteractive(exe: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', () => resolve());
  });
}

/** Reads a secret from piped stdin, or from the terminal without echoing it. */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (err?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (data: string) => {
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('Cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
