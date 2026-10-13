import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentConfig } from '../config/config.js';
import type { Logger } from '../util/logger.js';
import { packageRoot } from '../util/version.js';
import { CommandDriver, xdotoolDialect, ydotoolDialect } from './command-driver.js';
import type { MouseDriver } from './driver.js';
import { HelperProcessDriver } from './helper-process-driver.js';

export type DisplayServer = 'windows' | 'x11' | 'wayland' | 'none';

export function detectDisplayServer(env: NodeJS.ProcessEnv = process.env): DisplayServer {
  if (process.platform === 'win32') return 'windows';
  if (process.platform !== 'linux') return 'none';
  const sessionType = env.XDG_SESSION_TYPE?.toLowerCase();
  if (sessionType === 'wayland' || (env.WAYLAND_DISPLAY && sessionType !== 'x11')) return 'wayland';
  if (env.DISPLAY) return 'x11';
  return 'none';
}

/**
 * Native helpers ship prebuilt in `native-bin/<platform>-<arch>/`. During development
 * they are picked up from `native/<target>/build/` after `npm run build:native`.
 */
export function nativeHelperCandidates(fileName: string, devTarget: string): string[] {
  const root = packageRoot();
  return [
    path.join(root, 'native-bin', `${process.platform}-${process.arch}`, fileName),
    path.join(root, '..', '..', 'native', devTarget, 'build', fileName),
  ];
}

export function windowsPowerShellScript(): string | undefined {
  const root = packageRoot();
  return [
    path.join(root, 'native-bin', 'win32', 'voicecode-input.ps1'),
    path.join(root, '..', '..', 'native', 'windows', 'voicecode-input.ps1'),
  ].find((p) => existsSync(p));
}

export interface DriverCandidate {
  name: string;
  create(): MouseDriver;
}

/**
 * Ordered list of backends to try for this platform. The first one whose `start()`
 * succeeds wins, so a missing native helper silently falls back to the next option.
 */
export function driverCandidates(
  config: AgentConfig,
  logger: Logger,
): {
  candidates: DriverCandidate[];
  unavailableReason?: string;
} {
  const pref = config.mouse.driver;
  if (pref === 'none') return { candidates: [], unavailableReason: 'disabled in config' };

  const display = detectDisplayServer();
  const want = (name: string) => pref === 'auto' || pref === name;
  const candidates: DriverCandidate[] = [];

  if (display === 'windows') {
    const exe = nativeHelperCandidates('voicecode-input.exe', 'windows').find((p) => existsSync(p));
    if (exe && want('native')) {
      candidates.push({
        name: 'win32-sendinput',
        create: () => new HelperProcessDriver('win32-sendinput', exe, [], logger),
      });
    }
    const script = windowsPowerShellScript();
    if (script && want('powershell')) {
      candidates.push({
        name: 'powershell-sendinput',
        create: () =>
          new HelperProcessDriver(
            'powershell-sendinput',
            'powershell.exe',
            [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              script,
            ],
            logger,
          ),
      });
    }
  } else if (display === 'x11') {
    const bin = nativeHelperCandidates('voicecode-input-x11', 'linux-x11').find((p) =>
      existsSync(p),
    );
    if (bin && want('native')) {
      candidates.push({
        name: 'x11-xtest',
        create: () => new HelperProcessDriver('x11-xtest', bin, [], logger),
      });
    }
    if (want('xdotool')) {
      candidates.push({ name: 'xdotool', create: () => new CommandDriver(xdotoolDialect, logger) });
    }
  } else if (display === 'wayland') {
    // The RemoteDesktop portal + libei adapter is not implemented yet (see
    // native/linux-wayland/README.md); ydotool works on any compositor via uinput.
    if (want('ydotool')) {
      candidates.push({ name: 'ydotool', create: () => new CommandDriver(ydotoolDialect, logger) });
    }
  }

  const unavailableReason =
    candidates.length > 0
      ? undefined
      : display === 'none'
        ? 'no graphical session detected (run the agent inside your desktop session)'
        : display === 'wayland'
          ? 'Wayland needs ydotool (with ydotoold running) until the RemoteDesktop portal adapter ships'
          : `no mouse backend found for ${display} (driver preference: ${pref})`;
  return { candidates, unavailableReason };
}
