import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FolderEntry, FolderListing } from '@voicecode/protocol';
import { canonicalProjectPath, projectIdFor, type AgentConfig } from './config.js';

/** Most subfolders returned for one folder; the rest are left out (and flagged). */
export const MAX_FOLDER_ENTRIES = 400;

const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * Where `dir` sits inside the roots: the containing root and the path segments below
 * it, or undefined when it is outside every root. Both paths must already be canonical
 * (symlinks resolved), so `..` and links cannot escape.
 */
export function placeInRoots(
  dir: string,
  roots: string[],
): { root: string; segments: string[] } | undefined {
  for (const root of roots) {
    const rel = path.relative(fold(root), fold(dir));
    if (rel === '') return { root, segments: [] };
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    return { root, segments: rel.split(path.sep) };
  }
  return undefined;
}

/**
 * Resolves a folder a device asked for and checks it is inside a workspace root.
 * Hidden folders (`.ssh`, `.config`, …) are refused even inside a root: they hold
 * credentials and tool state rather than projects.
 */
export async function resolveRootFolder(dir: string, roots: string[]): Promise<string> {
  if (!path.isAbsolute(dir)) throw new Error('Folder path must be absolute');
  let canonical: string;
  try {
    canonical = await canonicalProjectPath(dir);
  } catch {
    throw new Error('That folder does not exist');
  }
  const place = placeInRoots(canonical, roots);
  if (!place) throw new Error('That folder is outside your workspace folders');
  if (place.segments.some((s) => s.startsWith('.'))) {
    throw new Error('Hidden folders cannot be opened from a device');
  }
  return canonical;
}

const isDir = (p: string) =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );

/**
 * One level of the folder browser. Without `dir` it lists the roots themselves.
 * Only visible directories are listed, never files.
 */
export async function listRootFolder(config: AgentConfig, dir?: string): Promise<FolderListing> {
  const allowed = new Set(config.projects.map((p) => p.id));
  const entry = async (full: string, name: string): Promise<FolderEntry> => ({
    name,
    path: full,
    isProject: allowed.has(projectIdFor(full)),
    isRepo: await isDir(path.join(full, '.git')),
  });

  if (dir === undefined) {
    const entries: FolderEntry[] = [];
    for (const root of config.roots) {
      if (await isDir(root)) entries.push(await entry(root, root));
    }
    return { entries, truncated: false };
  }

  const canonical = await resolveRootFolder(dir, config.roots);
  const place = placeInRoots(canonical, config.roots)!;
  const items = await readdir(canonical, { withFileTypes: true }).catch(() => []);
  const names = items
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  const shown = names.slice(0, MAX_FOLDER_ENTRIES);
  return {
    path: canonical,
    parent: place.segments.length ? path.dirname(canonical) : undefined,
    entries: await Promise.all(shown.map((name) => entry(path.join(canonical, name), name))),
    truncated: names.length > shown.length,
  };
}

/** Adds a workspace root to the config (idempotent). Returns its canonical path. */
export async function addRoot(config: AgentConfig, dir: string): Promise<string> {
  const canonical = await canonicalProjectPath(dir);
  if (!config.roots.some((r) => fold(r) === fold(canonical))) config.roots.push(canonical);
  return canonical;
}

export function removeRoot(config: AgentConfig, dir: string): boolean {
  const wanted = fold(path.resolve(dir));
  const before = config.roots.length;
  config.roots = config.roots.filter((r) => fold(r) !== wanted);
  return config.roots.length !== before;
}

/** A root this broad exposes far more than projects; worth a warning when it is added. */
export function isBroadRoot(dir: string): boolean {
  const resolved = fold(path.resolve(dir));
  return resolved === fold(os.homedir()) || path.dirname(resolved) === resolved;
}

/** Common places people keep their code, for the first-run suggestion. */
const CANDIDATES = [
  'code',
  'Code',
  'projects',
  'Projects',
  'dev',
  'Dev',
  'src',
  'repos',
  'source/repos',
  'Documents/GitHub',
  'GitHub',
  'workspace',
  'work',
];

export async function suggestRoot(): Promise<string | undefined> {
  for (const name of CANDIDATES) {
    const dir = path.join(os.homedir(), name);
    if (await isDir(dir)) return dir;
  }
  return undefined;
}
