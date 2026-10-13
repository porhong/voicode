import { InvalidArgumentError } from 'commander';
import { defaultConfig, loadConfig, saveConfig, type AgentConfig } from '../config/config.js';
import type { AgentPaths } from '../config/paths.js';
import { ensurePrivateDir } from '../util/fs.js';

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
