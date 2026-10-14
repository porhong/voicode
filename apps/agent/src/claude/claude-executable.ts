import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { cacheDir, isStandalone } from '../util/standalone.js';
import { extractTarEntry } from '../util/tar.js';

/**
 * Locates the Claude Code executable that the Agent SDK drives.
 *
 * The npm package lets the SDK find the binary from its platform-specific optional
 * dependency. Standalone executables would be ~250 MB larger with that binary inside,
 * so they download the exact version they were built against from the npm registry on
 * first use and verify it against the integrity hash recorded at build time.
 *
 * Resolution order: VOICECODE_CLAUDE_PATH, then the managed download, then a native
 * `claude` binary on PATH (only as a fallback, since its version may not match).
 */

export interface ClaudeCodePackage {
  name: string;
  /** npm package version (also the cache directory name). */
  version: string;
  /** The Claude Code release inside it, for messages. */
  cliVersion?: string;
  url: string;
  integrity: string;
}

declare const __CLAUDE_CODE_PACKAGE__: ClaudeCodePackage | undefined;

export type ClaudeExecutableSource = 'env' | 'managed' | 'path' | 'sdk' | 'missing';

export interface ClaudeExecutable {
  source: ClaudeExecutableSource;
  /** Absent for 'sdk' (the SDK resolves it) and 'missing'. */
  path?: string;
}

export function bundledClaudePackage(): ClaudeCodePackage | undefined {
  return typeof __CLAUDE_CODE_PACKAGE__ !== 'undefined' ? __CLAUDE_CODE_PACKAGE__ : undefined;
}

export function claudeCodeVersion(pkg: ClaudeCodePackage | undefined): string {
  return pkg ? (pkg.cliVersion ?? pkg.version) : '';
}

function binaryName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function managedDir(): string {
  return path.join(cacheDir(), 'claude-code');
}

export function managedClaudePath(pkg: ClaudeCodePackage): string {
  return path.join(managedDir(), pkg.version, binaryName());
}

export function findClaudeOnPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binaryName());
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Synchronous lookup used when a session starts; never downloads. */
export function resolveClaudeExecutable(): ClaudeExecutable {
  if (process.env.VOICECODE_CLAUDE_PATH) {
    return { source: 'env', path: path.resolve(process.env.VOICECODE_CLAUDE_PATH) };
  }
  if (!isStandalone()) return { source: 'sdk' };
  const pkg = bundledClaudePackage();
  if (pkg && existsSync(managedClaudePath(pkg))) {
    return { source: 'managed', path: managedClaudePath(pkg) };
  }
  const onPath = findClaudeOnPath();
  return onPath ? { source: 'path', path: onPath } : { source: 'missing' };
}

/** The value for the SDK's `pathToClaudeCodeExecutable` option. */
export function claudeExecutablePath(): string | undefined {
  const exe = resolveClaudeExecutable();
  if (exe.source === 'missing') {
    throw new Error(
      'Claude Code is not installed for this agent yet. Restart it with `voicecode-agent start` ' +
        'to download it, or set VOICECODE_CLAUDE_PATH to a claude executable.',
    );
  }
  return exe.path;
}

export type DownloadProgress = (received: number, total: number | undefined) => void;

/**
 * Makes sure a Claude Code executable is available, downloading the pinned version if
 * needed. Falls back to a `claude` on PATH when the download fails (e.g. offline).
 */
export async function ensureClaudeExecutable(
  onProgress?: DownloadProgress,
): Promise<ClaudeExecutable & { downloaded?: boolean; warning?: string }> {
  const current = resolveClaudeExecutable();
  if (current.source === 'env' || current.source === 'sdk' || current.source === 'managed') {
    return current;
  }
  const pkg = bundledClaudePackage();
  if (!pkg) {
    if (current.path) return current;
    throw new Error(
      'This build has no Claude Code download information; set VOICECODE_CLAUDE_PATH.',
    );
  }
  try {
    const dest = managedClaudePath(pkg);
    await downloadClaudeCode(pkg, dest, onProgress);
    await pruneOtherVersions(pkg.version);
    return { source: 'managed', path: dest, downloaded: true };
  } catch (err) {
    if (!current.path) {
      throw new Error(
        `Could not download Claude Code ${claudeCodeVersion(pkg)}: ${(err as Error).message}`,
        {
          cause: err,
        },
      );
    }
    return {
      ...current,
      warning: `Could not download Claude Code ${claudeCodeVersion(pkg)} (${(err as Error).message}); using ${current.path} instead.`,
    };
  }
}

export async function downloadClaudeCode(
  pkg: ClaudeCodePackage,
  dest: string,
  onProgress?: DownloadProgress,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const [algorithm, expected] = splitIntegrity(pkg.integrity);
  const dir = path.dirname(dest);
  await mkdir(dir, { recursive: true });
  const archive = path.join(dir, `download-${process.pid}.tgz`);
  const staged = `${dest}.tmp-${process.pid}`;
  try {
    const res = await fetchImpl(pkg.url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${new URL(pkg.url).host}`);
    const total = Number(res.headers.get('content-length')) || undefined;
    const hash = createHash(algorithm);
    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        received += chunk.length;
        onProgress?.(received, total);
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      meter,
      createWriteStream(archive),
    );
    if (hash.digest('base64') !== expected) {
      throw new Error('downloaded file failed its integrity check');
    }
    await extractTarEntry(archive, `package/${binaryName()}`, staged);
    await chmod(staged, 0o755);
    await rename(staged, dest);
  } finally {
    await rm(archive, { force: true });
    await rm(staged, { force: true });
  }
}

function splitIntegrity(integrity: string): [string, string] {
  const sep = integrity.indexOf('-');
  const algorithm = integrity.slice(0, sep);
  if (sep < 0 || !['sha512', 'sha384', 'sha256'].includes(algorithm)) {
    throw new Error(`Unsupported integrity value: ${integrity}`);
  }
  return [algorithm, integrity.slice(sep + 1)];
}

async function pruneOtherVersions(keep: string): Promise<void> {
  const dir = managedDir();
  for (const name of await readdir(dir).catch(() => [])) {
    if (name === keep) continue;
    // A running agent may still have an older binary open; that's fine to skip.
    await rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined);
  }
}
