import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isStandalone } from '../util/standalone.js';
import { packageRoot } from '../util/version.js';

/**
 * Starts the agent at login, inside the user's graphical session — the only place it
 * can reach the desktop for mouse input. Uses per-user mechanisms that need no admin
 * rights:
 *   Windows: a hidden launcher script in the Startup folder
 *   Linux:   an XDG autostart entry (~/.config/autostart), honoured by GNOME, KDE,
 *            Xfce, Cinnamon, MATE and most other desktops
 */
export interface AutostartStatus {
  enabled: boolean;
  file: string;
  command?: string;
}

export function autostartFile(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    const appData = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'VoiceCode Agent.vbs',
    );
  }
  const config = env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(config, 'autostart', 'voicecode-agent.desktop');
}

/**
 * The program (and script, for the npm package) to launch at login: the standalone
 * executable itself, or node with the installed CLI.
 */
export function launchTarget(): string[] {
  if (isStandalone()) return [process.execPath];
  const cli = path.join(packageRoot(), 'dist', 'cli.js');
  if (!existsSync(cli)) {
    throw new Error(`Cannot find the built CLI at ${cli}. Build or install voicecode-agent first.`);
  }
  return [process.execPath, cli];
}

export function windowsLauncher(target: string[], home?: string): string {
  // VBScript strings escape " by doubling it (Windows paths cannot contain quotes).
  // Window style 0 = hidden.
  const q = (s: string) => `""${s}""`;
  let command = `${target.map(q).join(' ')} start --no-qr`;
  if (home) command = `cmd.exe /c set ""VOICECODE_HOME=${home}"" && ${command}`;
  return [
    "' Created by `voicecode-agent autostart enable`. Starts the agent hidden at login.",
    "' Remove with `voicecode-agent autostart disable`.",
    `CreateObject("WScript.Shell").Run "${command}", 0, False`,
    '',
  ].join('\r\n');
}

export function desktopEntry(target: string[], home?: string): string {
  // Desktop Entry spec: quote arguments and escape ", `, $ and \ inside quotes.
  const q = (s: string) => `"${s.replace(/(["`$\\])/g, '\\$1')}"`;
  const env = home ? `env ${q(`VOICECODE_HOME=${home}`)} ` : '';
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=VoiceCode Agent',
    'Comment=Voice-controlled Claude Code and trackpad server for your LAN',
    `Exec=${env}${target.map(q).join(' ')} start --no-qr`,
    'Terminal=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    'X-GNOME-Autostart-Delay=5',
    '',
  ].join('\n');
}

export async function enableAutostart(): Promise<AutostartStatus> {
  const file = autostartFile();
  const target = launchTarget();
  const home = process.env.VOICECODE_HOME ? path.resolve(process.env.VOICECODE_HOME) : undefined;
  const content =
    process.platform === 'win32' ? windowsLauncher(target, home) : desktopEntry(target, home);
  await mkdir(path.dirname(file), { recursive: true });
  // Windows Script Host reads files as ANSI unless they start with a UTF-16LE BOM,
  // which would garble non-ASCII paths such as C:\Users\José.
  const data = process.platform === 'win32' ? Buffer.from(`\ufeff${content}`, 'utf16le') : content;
  await writeFile(file, data, { mode: 0o644 });
  return { enabled: true, file, command: `${target.join(' ')} start --no-qr` };
}

export async function disableAutostart(): Promise<AutostartStatus> {
  const file = autostartFile();
  await rm(file, { force: true });
  return { enabled: false, file };
}

export async function autostartStatus(): Promise<AutostartStatus> {
  const file = autostartFile();
  if (!existsSync(file)) return { enabled: false, file };
  const bytes = await readFile(file);
  const content =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? bytes.subarray(2).toString('utf16le')
      : bytes.toString('utf8');
  const command =
    process.platform === 'win32'
      ? /Run "(.*)", 0/.exec(content)?.[1]?.replace(/""/g, '"')
      : /^Exec=(.*)$/m.exec(content)?.[1];
  return { enabled: true, file, command };
}
