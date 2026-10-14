import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface AgentPaths {
  home: string;
  config: string;
  devices: string;
  controlToken: string;
  log: string;
  tlsDir: string;
  caCert: string;
  caKey: string;
  serverCert: string;
  serverKey: string;
  tunnelDir: string;
  /** Generated cloudflared config (rewritten on every start). */
  tunnelConfig: string;
  /** Named-tunnel credentials written by `cloudflared tunnel create/token`. */
  tunnelCredentials: string;
  /** Dashboard tunnel token (`tunnel token`); passed to cloudflared by path, never argv. */
  tunnelToken: string;
  /** Named pipe (Windows) or Unix domain socket (Linux) for the local control channel. */
  ipcEndpoint: string;
}

/**
 * Per-user state directory:
 *   Windows: %APPDATA%\voicecode-agent
 *   Linux:   $XDG_CONFIG_HOME/voicecode-agent (default ~/.config/voicecode-agent)
 * Override with VOICECODE_HOME (useful for tests and running several agents).
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VOICECODE_HOME) return path.resolve(env.VOICECODE_HOME);
  if (process.platform === 'win32') {
    return path.join(
      env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      'voicecode-agent',
    );
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'voicecode-agent');
}

export function resolvePaths(home = resolveHome()): AgentPaths {
  const tlsDir = path.join(home, 'tls');
  const tunnelDir = path.join(home, 'tunnel');
  const id = createHash('sha256').update(home).digest('hex').slice(0, 12);
  const ipcEndpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\voicecode-agent-${id}`
      : path.join(process.env.XDG_RUNTIME_DIR ?? home, `voicecode-agent-${id}.sock`);

  return {
    home,
    config: path.join(home, 'config.json'),
    devices: path.join(home, 'devices.json'),
    controlToken: path.join(home, 'control.token'),
    log: path.join(home, 'agent.log'),
    tlsDir,
    caCert: path.join(tlsDir, 'ca.crt.pem'),
    caKey: path.join(tlsDir, 'ca.key.pem'),
    serverCert: path.join(tlsDir, 'server.crt.pem'),
    serverKey: path.join(tlsDir, 'server.key.pem'),
    tunnelDir,
    tunnelConfig: path.join(tunnelDir, 'cloudflared.yml'),
    tunnelCredentials: path.join(tunnelDir, 'credentials.json'),
    tunnelToken: path.join(tunnelDir, 'token'),
    ipcEndpoint,
  };
}
