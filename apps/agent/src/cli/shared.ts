import { InvalidArgumentError } from 'commander';
import { defaultConfig, loadConfig, saveConfig, type AgentConfig } from '../config/config.js';
import type { AgentPaths } from '../config/paths.js';
import { ensurePrivateDir } from '../util/fs.js';
import {
  describeAutoApprovals,
  hasAutoApprovals,
  inspectProjectSettings,
} from '../config/project-settings.js';
import {
  bundledClaudePackage,
  claudeCodeVersion,
  ensureClaudeExecutable,
} from '../claude/claude-executable.js';
import { ok, out, warn } from './ui.js';

export function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError('Not a valid port');
  }
  return port;
}

/** Loads the config, creating a default one on first use. */
export async function loadOrInit(
  paths: AgentPaths,
): Promise<{ config: AgentConfig; created: boolean }> {
  const existing = await loadConfig(paths.config);
  if (existing) return { config: existing, created: false };
  await ensurePrivateDir(paths.home);
  const config = defaultConfig();
  await saveConfig(paths.config, config);
  return { config, created: true };
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Shown whenever a project is allowed: the equivalent of Claude Code's folder-trust
 * prompt, since the project's settings can approve tools without the phone.
 */
export async function warnAboutAutoApprovals(projectDir: string): Promise<void> {
  const approvals = await inspectProjectSettings(projectDir);
  if (!hasAutoApprovals(approvals)) return;
  out(warn(`  ! ${describeAutoApprovals(approvals)}`));
  out(warn(`    Only allow projects you trust. Review ${approvals.files.join(' and ')}.`));
}

/**
 * Standalone executables download Claude Code on first use (see claude-executable.ts).
 * Returns false when it is unavailable; the agent still starts for mouse control.
 */
export async function prepareClaudeCode(): Promise<boolean> {
  const version = claudeCodeVersion(bundledClaudePackage());
  const tty = process.stdout.isTTY;
  let lastPercent = -1;
  try {
    const result = await ensureClaudeExecutable((received, total) => {
      if (lastPercent === -1) out(`  Downloading Claude Code ${version} (one-time)…`);
      const percent = total ? Math.floor((received / total) * 100) : 0;
      if (tty && total && percent !== lastPercent) {
        process.stdout.write(`\r  ${percent}% of ${Math.round(total / 1048576)} MB`);
      }
      lastPercent = Math.max(percent, 0);
    });
    if (tty && lastPercent >= 0) process.stdout.write('\n');
    if (result.downloaded) out(ok(`  Claude Code ${version} installed`));
    if (result.warning) out(warn(`  ! ${result.warning}`));
    return true;
  } catch (err) {
    if (tty && lastPercent >= 0) process.stdout.write('\n');
    out(warn(`  ! ${(err as Error).message}`));
    out(warn('    Claude sessions will not work until this is fixed; mouse control still will.'));
    return false;
  }
}
