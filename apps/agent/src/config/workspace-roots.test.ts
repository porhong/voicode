import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigSchema } from './config.js';
import {
  addRoot,
  isBroadRoot,
  listRootFolder,
  placeInRoots,
  removeRoot,
  resolveRootFolder,
} from './workspace-roots.js';

let tmp: string;
let root: string;
let outside: string;

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vc-roots-')));
  root = path.join(tmp, 'code');
  outside = path.join(tmp, 'private');
  await mkdir(path.join(root, 'app', '.git'), { recursive: true });
  await mkdir(path.join(root, 'app', 'src'));
  await mkdir(path.join(root, '.hidden', 'inner'), { recursive: true });
  await mkdir(path.join(root, 'node_modules'));
  await mkdir(outside);
  // A link inside the root that points out of it (junctions need no admin on Windows).
  await symlink(outside, path.join(root, 'escape'), 'junction');
});

afterAll(() => rm(tmp, { recursive: true, force: true }));

describe('workspace roots', () => {
  it('places folders inside a root and nothing else', () => {
    expect(placeInRoots(root, [root])).toEqual({ root, segments: [] });
    expect(placeInRoots(path.join(root, 'app', 'src'), [root])?.segments).toEqual(['app', 'src']);
    expect(placeInRoots(tmp, [root])).toBeUndefined();
    expect(placeInRoots(`${root}-other`, [root])).toBeUndefined();
  });

  it('resolves folders inside a root, refusing escapes and hidden folders', async () => {
    await expect(resolveRootFolder(path.join(root, 'app'), [root])).resolves.toBe(
      path.join(root, 'app'),
    );
    await expect(resolveRootFolder(path.join(root, 'app', '..', '..'), [root])).rejects.toThrow(
      /outside/,
    );
    await expect(resolveRootFolder(path.join(root, 'escape'), [root])).rejects.toThrow(/outside/);
    await expect(resolveRootFolder(path.join(root, '.hidden', 'inner'), [root])).rejects.toThrow(
      /Hidden/,
    );
    await expect(resolveRootFolder('relative/path', [root])).rejects.toThrow(/absolute/);
    await expect(resolveRootFolder(path.join(root, 'missing'), [root])).rejects.toThrow(
      /does not exist/,
    );
  });

  it('lists visible subfolders and marks repositories', async () => {
    const config = ConfigSchema.parse({ version: 1, roots: [root] });
    const top = await listRootFolder(config);
    expect(top.entries.map((e) => e.path)).toEqual([root]);

    const listing = await listRootFolder(config, root);
    expect(listing.parent).toBeUndefined();
    // Links are left out: one pointing outside the root could not be opened anyway.
    expect(listing.entries.map((e) => [e.name, e.isRepo])).toEqual([['app', true]]);
    const app = await listRootFolder(config, path.join(root, 'app'));
    expect(app.parent).toBe(root);
    expect(app.entries.map((e) => e.name)).toEqual(['src']);
  });

  it('adds and removes roots idempotently and flags broad ones', async () => {
    const config = ConfigSchema.parse({ version: 1 });
    expect(await addRoot(config, root)).toBe(root);
    await addRoot(config, path.join(root, 'app', '..'));
    expect(config.roots).toEqual([root]);
    expect(removeRoot(config, root)).toBe(true);
    expect(config.roots).toEqual([]);
    expect(isBroadRoot(os.homedir())).toBe(true);
    expect(isBroadRoot(path.parse(root).root)).toBe(true);
    expect(isBroadRoot(root)).toBe(false);
  });
});
