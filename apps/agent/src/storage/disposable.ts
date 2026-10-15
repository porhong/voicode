import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { STORAGE_CATEGORIES, type StorageCategory } from '@voicecode/protocol';

/**
 * Finds and removes the files the agent can recreate or does without: never config,
 * pairing, certificates, tunnel credentials, the live log or the versions in use.
 *
 * Everything here is an allow-list of known file shapes in the agent's own directories,
 * so a cleanup can't reach anything the agent didn't write.
 */

export interface StorageLocations {
  /** VOICECODE_HOME (config, devices, certificates, log). */
  home: string;
  /** The agent's cache directory (standalone runtimes, Claude Code downloads). */
  cache: string;
  /** The live log file; only its rotated `.1` copy is disposable. */
  log: string;
  /** Runtime directory of this standalone build; unknown → the newest one is kept. */
  runtimeInUse?: string;
  /** Claude Code version this build downloads; unknown → the newest one is kept. */
  claudeVersionInUse?: string;
}

export interface DisposableItem {
  category: StorageCategory;
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface CleanupOutcome {
  freedBytes: number;
  removed: number;
  failed: number;
}

/**
 * Temporary files younger than this may belong to a write or download in progress
 * (in this agent or another process), so they are left alone.
 */
export const TEMP_GRACE_MS = 60 * 60_000;

/** `writeFileAtomic` temp files: `<file>.<12 hex>.tmp`. */
const ATOMIC_TMP_RE = /\.[0-9a-f]{12}\.tmp$/;
/** Interrupted extractions and downloads: `<name>.tmp-<pid>`, `download-<pid>.tgz`. */
const PID_TMP_RE = /(\.tmp-\d+|^download-\d+\.tgz)$/;

export async function scanDisposable(
  loc: StorageLocations,
  now = Date.now(),
): Promise<DisposableItem[]> {
  const items: DisposableItem[] = [];
  const add = async (category: StorageCategory, file: string) => {
    const size = await sizeOf(file);
    if (size) items.push({ category, path: file, ...size });
  };
  const addTemp = async (file: string) => {
    const size = await sizeOf(file);
    if (size && now - size.mtimeMs > TEMP_GRACE_MS) {
      items.push({ category: 'temp', path: file, ...size });
    }
  };

  for (const dir of [loc.home, path.join(loc.home, 'tls'), path.join(loc.home, 'tunnel')]) {
    for (const name of await list(dir)) {
      if (ATOMIC_TMP_RE.test(name)) await addTemp(path.join(dir, name));
    }
  }
  await add('logs', `${loc.log}.1`);

  // Standalone runtimes: one directory per build.
  await versioned(path.join(loc.cache, 'runtime'), loc.runtimeInUse, 'runtime', add, addTemp);
  // Claude Code downloads: one directory per version, holding the binary.
  const claudeDir = path.join(loc.cache, 'claude-code');
  const kept = await versioned(claudeDir, loc.claudeVersionInUse, 'downloads', add, addTemp);
  if (kept) {
    for (const name of await list(path.join(claudeDir, kept))) {
      if (PID_TMP_RE.test(name)) await addTemp(path.join(claudeDir, kept, name));
    }
  }
  return items;
}

/**
 * Directories of `parent` other than the one in use are disposable; when the one in use
 * is unknown (the npm package, or another tool asking), the newest is kept so a
 * standalone agent sharing the cache keeps working. Returns the kept name.
 */
async function versioned(
  parent: string,
  inUse: string | undefined,
  category: StorageCategory,
  add: (category: StorageCategory, file: string) => Promise<void>,
  addTemp: (file: string) => Promise<void>,
): Promise<string | undefined> {
  const dirs: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of await list(parent)) {
    const file = path.join(parent, name);
    if (PID_TMP_RE.test(name)) {
      await addTemp(file);
      continue;
    }
    const st = await lstat(file).catch(() => undefined);
    if (st?.isDirectory()) dirs.push({ name, mtimeMs: st.mtimeMs });
  }
  const keep = inUse ?? dirs.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name;
  for (const dir of dirs) {
    if (dir.name !== keep) await add(category, path.join(parent, dir.name));
  }
  return keep;
}

export function summarize(items: DisposableItem[]) {
  const categories = STORAGE_CATEGORIES.map((category) => {
    const own = items.filter((i) => i.category === category);
    return { category, bytes: sum(own), count: own.length };
  });
  return { categories, totalBytes: sum(items) };
}

/**
 * Removes items in cleanup order (category, then oldest first). With `targetBytes`, stops
 * as soon as what is left fits; files that can't be removed (in use) are skipped.
 */
export async function removeItems(
  items: DisposableItem[],
  targetBytes = 0,
): Promise<CleanupOutcome> {
  const order = (c: StorageCategory) => STORAGE_CATEGORIES.indexOf(c);
  const queue = [...items].sort(
    (a, b) => order(a.category) - order(b.category) || a.mtimeMs - b.mtimeMs,
  );
  let remaining = sum(items);
  const outcome: CleanupOutcome = { freedBytes: 0, removed: 0, failed: 0 };
  for (const item of queue) {
    if (remaining <= targetBytes) break;
    try {
      await rm(item.path, { recursive: true, force: true, maxRetries: 2 });
      outcome.freedBytes += item.bytes;
      outcome.removed++;
      remaining -= item.bytes;
    } catch {
      // Typically EBUSY/EPERM on Windows: a binary another agent is still running.
      outcome.failed++;
    }
  }
  return outcome;
}

function sum(items: Array<{ bytes: number }>): number {
  return items.reduce((n, i) => n + i.bytes, 0);
}

async function list(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

/** Total size of a file or directory tree; symbolic links are counted, never followed. */
async function sizeOf(file: string): Promise<{ bytes: number; mtimeMs: number } | undefined> {
  const st = await lstat(file).catch(() => undefined);
  if (!st) return undefined;
  if (!st.isDirectory()) return { bytes: st.size, mtimeMs: st.mtimeMs };
  let bytes = 0;
  for (const name of await list(file)) bytes += (await sizeOf(path.join(file, name)))?.bytes ?? 0;
  return { bytes, mtimeMs: st.mtimeMs };
}
