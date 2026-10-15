import type { CleanupResult, StorageInfo } from '@voicecode/protocol';
import { bundledClaudePackage } from '../claude/claude-executable.js';
import type { AgentConfig } from '../config/config.js';
import type { AgentPaths } from '../config/paths.js';
import type { Logger } from '../util/logger.js';
import { cacheDir, runtimeBuildId } from '../util/standalone.js';
import {
  removeItems,
  scanDisposable,
  summarize,
  type DisposableItem,
  type StorageLocations,
} from './disposable.js';

const MB = 1024 * 1024;
/** The first automatic check waits until start-up (and any download) has settled. */
const FIRST_RUN_MS = 2 * 60_000;
const INTERVAL_MS = 6 * 60 * 60_000;
/**
 * An automatic cleanup goes down to this share of the limit, so the next few small
 * files don't trigger another one straight away.
 */
const LOW_WATER = 0.8;

/** Where this agent's files are, and which versions of them it uses. */
export function storageLocations(paths: AgentPaths): StorageLocations {
  return {
    home: paths.home,
    cache: cacheDir(),
    log: paths.log,
    runtimeInUse: runtimeBuildId(),
    claudeVersionInUse: bundledClaudePackage()?.version,
  };
}

/**
 * Keeps the agent's disposable files in check: on demand (phone or CLI) and, when
 * enabled, automatically once they pass the configured limit. Only one cleanup runs at
 * a time; a request while one is running waits for it.
 */
export class StorageJanitor {
  private timers: NodeJS.Timeout[] = [];
  private busy: Promise<unknown> = Promise.resolve();
  private lastCleanup: CleanupResult | undefined;

  constructor(
    private readonly options: {
      locations: StorageLocations;
      settings: () => AgentConfig['cleanup'];
      logger: Logger;
    },
  ) {}

  start(): void {
    const tick = () => void this.autoCleanup().catch(() => undefined);
    this.timers = [setTimeout(tick, FIRST_RUN_MS), setInterval(tick, INTERVAL_MS)];
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  async info(): Promise<StorageInfo> {
    const items = await scanDisposable(this.options.locations);
    const { auto, maxCacheMb } = this.options.settings();
    return { ...summarize(items), auto, maxCacheMb, lastCleanup: this.lastCleanup };
  }

  /** Removes every disposable file now. */
  cleanNow(): Promise<CleanupResult> {
    return this.exclusive(() => this.clean('manual', 0));
  }

  /** Cleans up if automatic cleanup is on and the limit is passed; undefined otherwise. */
  autoCleanup(): Promise<CleanupResult | undefined> {
    return this.exclusive(async () => {
      const { auto, maxCacheMb } = this.options.settings();
      if (!auto) return undefined;
      const limit = maxCacheMb * MB;
      const items = await scanDisposable(this.options.locations);
      return summarize(items).totalBytes > limit ? this.clean('auto', limit, items) : undefined;
    });
  }

  private async clean(
    trigger: CleanupResult['trigger'],
    limit: number,
    scanned?: DisposableItem[],
  ): Promise<CleanupResult> {
    const items = scanned ?? (await scanDisposable(this.options.locations));
    const { totalBytes } = summarize(items);
    const outcome = await removeItems(items, Math.floor(limit * LOW_WATER));
    const result: CleanupResult = { at: Date.now(), trigger, ...outcome };
    this.lastCleanup = result;
    this.options.logger.info({ ...result, totalBytes, limit }, 'storage cleanup');
    return result;
  }

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.busy.then(job, job);
    this.busy = run.catch(() => undefined);
    return run;
  }
}
