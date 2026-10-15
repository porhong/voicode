import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../util/logger.js';
import {
  removeItems,
  scanDisposable,
  summarize,
  TEMP_GRACE_MS,
  type StorageLocations,
} from './disposable.js';
import { StorageJanitor } from './janitor.js';

let root: string;
let loc: StorageLocations;

function file(rel: string, bytes: number, ageMs = 0): string {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, Buffer.alloc(bytes));
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(full, t, t);
  return full;
}

function age(rel: string, ageMs: number): void {
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path.join(root, rel), t, t);
}

const old = TEMP_GRACE_MS + 60_000;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vc-storage-'));
  loc = {
    home: path.join(root, 'home'),
    cache: path.join(root, 'cache'),
    log: path.join(root, 'home', 'agent.log'),
  };
  // Essential state: never reported.
  file('home/config.json', 10);
  file('home/devices.json', 10);
  file('home/tls/ca.key.pem', 10);
  file('home/tunnel/token', 10);
  file('home/wayland-restore-token', 10);
  file('home/agent.log', 500);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('scanDisposable', () => {
  it('finds only known disposable shapes and keeps the versions in use', async () => {
    file('home/agent.log.1', 300);
    file('home/config.json.0123456789ab.tmp', 7, old);
    file('home/tls/ca.key.pem.abcdefabcdef.tmp', 7, old);
    file('home/config.json.0123456789ab.tmp.fresh', 7, old); // not the temp-file pattern
    file('cache/runtime/build-a/web/index.html', 100);
    file('cache/runtime/build-b/web/index.html', 200);
    file('cache/runtime/build-b.tmp-123/x', 50, old);
    age('cache/runtime/build-b.tmp-123', old);
    file('cache/claude-code/1.0.0/claude', 1000);
    file('cache/claude-code/2.0.0/claude', 2000);
    file('cache/claude-code/2.0.0/download-42.tgz', 30, old);
    file('cache/attachments/0123456789abcdef0123456789abcdef.jpg', 4, old);
    file('cache/attachments/fedcba9876543210fedcba9876543210.png', 4);

    const items = await scanDisposable({
      ...loc,
      runtimeInUse: 'build-b',
      claudeVersionInUse: '2.0.0',
    });
    const found = items.map((i) => [i.category, path.relative(root, i.path), i.bytes]);
    expect(found.sort()).toEqual(
      [
        ['logs', path.join('home', 'agent.log.1'), 300],
        ['temp', path.join('home', 'config.json.0123456789ab.tmp'), 7],
        ['temp', path.join('home', 'tls', 'ca.key.pem.abcdefabcdef.tmp'), 7],
        ['runtime', path.join('cache', 'runtime', 'build-a'), 100],
        ['temp', path.join('cache', 'runtime', 'build-b.tmp-123'), 50],
        ['downloads', path.join('cache', 'claude-code', '1.0.0'), 1000],
        ['temp', path.join('cache', 'claude-code', '2.0.0', 'download-42.tgz'), 30],
        [
          'attachments',
          path.join('cache', 'attachments', '0123456789abcdef0123456789abcdef.jpg'),
          4,
        ],
      ].sort(),
    );
    expect(summarize(items).totalBytes).toBe(1498);
  });

  it('leaves recent temp files alone: a write or download may be in progress', async () => {
    file('home/config.json.0123456789ab.tmp', 7);
    file('cache/claude-code/2.0.0/download-42.tgz', 30);
    expect(await scanDisposable({ ...loc, claudeVersionInUse: '2.0.0' })).toEqual([]);
  });

  it('keeps the newest version when the one in use is unknown (npm package)', async () => {
    file('cache/claude-code/1.0.0/claude', 1000);
    file('cache/claude-code/2.0.0/claude', 2000);
    age('cache/claude-code/1.0.0', 60_000);
    const items = await scanDisposable(loc);
    expect(items.map((i) => path.basename(i.path))).toEqual(['1.0.0']);
  });

  it('copes with directories that do not exist yet', async () => {
    rmSync(root, { recursive: true, force: true });
    expect(await scanDisposable(loc)).toEqual([]);
  });
});

describe('removeItems', () => {
  it('removes in cleanup order, oldest first, until the target is met', async () => {
    file('home/agent.log.1', 300);
    file('cache/runtime/old/x', 100);
    file('cache/runtime/older/x', 100);
    file('cache/runtime/current/x', 100);
    age('cache/runtime/older', 120_000);
    age('cache/runtime/old', 60_000);
    const items = await scanDisposable({ ...loc, runtimeInUse: 'current' });
    expect(summarize(items).totalBytes).toBe(500);

    // Old runtimes go before the log; the older one first.
    const outcome = await removeItems(items, 350);
    expect(outcome).toEqual({ freedBytes: 200, removed: 2, failed: 0 });
    expect(existsSync(path.join(root, 'cache/runtime/older'))).toBe(false);
    expect(existsSync(path.join(root, 'cache/runtime/old'))).toBe(false);
    expect(existsSync(path.join(root, 'home/agent.log.1'))).toBe(true);
    expect(existsSync(path.join(root, 'cache/runtime/current'))).toBe(true);
    expect(existsSync(path.join(root, 'home/agent.log'))).toBe(true);
  });
});

describe('StorageJanitor', () => {
  const MB = 1024 * 1024;

  it('cleans up automatically only above the limit, and only when enabled', async () => {
    const settings = { auto: false, maxCacheMb: 1 };
    const janitor = new StorageJanitor({
      locations: { ...loc, claudeVersionInUse: '2.0.0' },
      settings: () => settings,
      logger: silentLogger(),
    });
    file('cache/claude-code/1.0.0/claude', 2 * MB);
    expect(await janitor.autoCleanup()).toBeUndefined();

    settings.auto = true;
    settings.maxCacheMb = 4;
    expect(await janitor.autoCleanup()).toBeUndefined();

    settings.maxCacheMb = 1;
    const result = await janitor.autoCleanup();
    expect(result).toMatchObject({ trigger: 'auto', freedBytes: 2 * MB, removed: 1 });
    const info = await janitor.info();
    expect(info).toMatchObject({ totalBytes: 0, auto: true, maxCacheMb: 1 });
    expect(info.lastCleanup).toEqual(result);
  });

  it('runs one cleanup at a time', async () => {
    file('home/agent.log.1', 300);
    const janitor = new StorageJanitor({
      locations: loc,
      settings: () => ({ auto: true, maxCacheMb: 50 }),
      logger: silentLogger(),
    });
    const [a, b] = await Promise.all([janitor.cleanNow(), janitor.cleanNow()]);
    expect(a.freedBytes + b.freedBytes).toBe(300);
    expect(a.removed + b.removed).toBe(1);
  });
});
