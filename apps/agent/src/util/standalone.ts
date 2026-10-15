import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sea from 'node:sea';

/**
 * Support for the standalone executables (Node.js single executable applications).
 *
 * The npm package runs from its install directory. A standalone binary carries the web
 * client and native input helpers as embedded assets instead; they are written once to
 * a per-build cache directory so the rest of the agent (static file serving, spawning
 * helpers) works the same way in both distributions.
 */

interface RuntimeManifest {
  buildId: string;
  files: Array<{ path: string; executable?: boolean }>;
}

export const MANIFEST_ASSET = 'voicecode-manifest.json';

export function isStandalone(): boolean {
  try {
    return sea.isSea();
  } catch {
    return false;
  }
}

/**
 * Per-user cache for files that can be recreated at any time:
 *   Windows: %LOCALAPPDATA%\voicecode-agent
 *   Linux:   $XDG_CACHE_HOME/voicecode-agent (default ~/.cache/voicecode-agent)
 * Override with VOICECODE_CACHE_DIR.
 */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VOICECODE_CACHE_DIR) return path.resolve(env.VOICECODE_CACHE_DIR);
  if (process.platform === 'win32') {
    return path.join(
      env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'voicecode-agent',
    );
  }
  return path.join(env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'voicecode-agent');
}

let runtimeRoot: string | undefined;

/** The runtime directory name of this standalone build (undefined for the npm package). */
export function runtimeBuildId(): string | undefined {
  if (!isStandalone()) return undefined;
  return (JSON.parse(sea.getAsset(MANIFEST_ASSET, 'utf8')) as RuntimeManifest).buildId;
}

/**
 * Directory holding the embedded assets, laid out like the npm package (`dist/web`,
 * `native-bin/...`). Extracted on first use; later runs of the same build reuse it.
 */
export function standaloneRoot(): string {
  if (runtimeRoot) return runtimeRoot;
  const manifest = JSON.parse(sea.getAsset(MANIFEST_ASSET, 'utf8')) as RuntimeManifest;
  const base = path.join(cacheDir(), 'runtime');
  const target = path.join(base, manifest.buildId);
  if (!existsSync(path.join(target, '.complete'))) extract(manifest, base, target);
  pruneOldRuntimes(base, manifest.buildId);
  return (runtimeRoot = target);
}

function extract(manifest: RuntimeManifest, base: string, target: string): void {
  const tmp = `${target}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  for (const file of manifest.files) {
    const dest = path.join(tmp, ...file.path.split('/'));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, new Uint8Array(sea.getRawAsset(file.path)));
    if (file.executable) chmodSync(dest, 0o755);
  }
  writeFileSync(path.join(tmp, '.complete'), manifest.buildId);
  mkdirSync(base, { recursive: true });
  try {
    rmSync(target, { recursive: true, force: true });
    renameSync(tmp, target);
  } catch (err) {
    // Another instance finished extracting the same build first.
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(path.join(target, '.complete'))) throw err;
  }
}

/** Keeps the cache from growing with every upgrade; in-use files are simply skipped. */
function pruneOldRuntimes(base: string, current: string): void {
  try {
    const old = readdirSync(base)
      .filter((name) => name !== current)
      .map((name) => ({ name, mtime: statSync(path.join(base, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(2);
    for (const dir of old) rmSync(path.join(base, dir.name), { recursive: true, force: true });
  } catch {
    // Best effort only.
  }
}
