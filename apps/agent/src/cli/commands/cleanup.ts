import type { Command } from 'commander';
import pc from 'picocolors';
import {
  STORAGE_LIMIT_MB,
  type CleanupResult,
  type StorageCategory,
  type StorageInfo,
} from '@voicecode/protocol';
import { saveConfig } from '../../config/config.js';
import { resolvePaths, type AgentPaths } from '../../config/paths.js';
import { AgentNotRunningError, controlRequest } from '../../ipc/control.js';
import { removeItems, scanDisposable, summarize } from '../../storage/disposable.js';
import { storageLocations } from '../../storage/janitor.js';
import { loadOrInit } from '../shared.js';
import { ok, out, row, warn } from '../ui.js';

const LABELS: Record<StorageCategory, string> = {
  temp: 'Temp files',
  downloads: 'Old Claude Code',
  runtime: 'Old runtimes',
  logs: 'Old log',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function printResult(result: CleanupResult): void {
  out(ok(`Freed ${formatBytes(result.freedBytes)} (${result.removed} removed).`));
  if (result.failed) out(warn(`  ${result.failed} in use and skipped; try again later.`));
}

/** Tells a running agent to pick up new cleanup settings; a no-op when none is running. */
async function applyToRunningAgent(paths: AgentPaths): Promise<void> {
  try {
    await controlRequest<StorageInfo>(paths, 'POST', '/storage/reload');
    out(pc.dim('  Applied to the running agent.'));
  } catch (err) {
    if (!(err instanceof AgentNotRunningError)) throw err;
  }
}

export function registerCleanup(program: Command): void {
  const cleanup = program
    .command('cleanup')
    .description('Remove caches, old versions and old logs the agent no longer needs');

  cleanup
    .command('run', { isDefault: true })
    .description('Remove them now (never config, pairing, certificates or versions in use)')
    .option('--dry-run', 'only list what would be removed')
    .action(async (opts: { dryRun?: boolean }) => {
      const paths = resolvePaths();
      const items = await scanDisposable(storageLocations(paths));
      const { categories, totalBytes } = summarize(items);
      for (const c of categories) {
        if (c.count) row(LABELS[c.category], `${formatBytes(c.bytes)}  ${pc.dim(`${c.count}×`)}`);
      }
      if (!totalBytes) return out(ok('Nothing to clean up.'));
      if (opts.dryRun) {
        for (const item of items) out(pc.dim(`  ${item.path}`));
        return out(`Would free ${formatBytes(totalBytes)}.`);
      }
      // A running agent does it, so its settings sheet shows the result too.
      try {
        const { result } = await controlRequest<{ result: CleanupResult }>(
          paths,
          'POST',
          '/storage/cleanup',
        );
        return printResult(result);
      } catch (err) {
        if (!(err instanceof AgentNotRunningError)) throw err;
      }
      printResult({ at: Date.now(), trigger: 'manual', ...(await removeItems(items)) });
    });

  cleanup
    .command('auto [state]')
    .description('Show or change automatic cleanup: on | off')
    .option(
      '-l, --limit <MB>',
      `clean up once the files pass this size (${STORAGE_LIMIT_MB.min}-${STORAGE_LIMIT_MB.max})`,
    )
    .action(async (state: string | undefined, opts: { limit?: string }) => {
      const paths = resolvePaths();
      const { config } = await loadOrInit(paths);
      if (state !== undefined && state !== 'on' && state !== 'off') {
        throw new Error('state must be "on" or "off"');
      }
      if (opts.limit !== undefined) {
        const limit = Number(opts.limit);
        if (
          !Number.isInteger(limit) ||
          limit < STORAGE_LIMIT_MB.min ||
          limit > STORAGE_LIMIT_MB.max
        ) {
          throw new Error(
            `--limit must be a whole number of MB from ${STORAGE_LIMIT_MB.min} to ${STORAGE_LIMIT_MB.max}`,
          );
        }
        config.cleanup.maxCacheMb = limit;
      }
      if (state) config.cleanup.auto = state === 'on';
      const changed = state !== undefined || opts.limit !== undefined;
      if (changed) await saveConfig(paths.config, config);
      out(
        config.cleanup.auto
          ? ok(`● Automatic cleanup above ${config.cleanup.maxCacheMb} MB`)
          : pc.dim('○ Automatic cleanup is off'),
      );
      if (changed) await applyToRunningAgent(paths);
    });
}
