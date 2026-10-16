import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  desktopHookInstalled,
  installDesktopHook,
  readHookEndpoint,
  removeDesktopHook,
  writeHookEndpoint,
} from './approval-hook.js';

let dir: string;
let file: string;
const COMMAND = '"C:\\node.exe" "C:\\agent\\cli.js" hook permission-request';
const read = async () => JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'voicecode-settings-'));
  file = path.join(dir, 'settings.json');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('the Claude Desktop approval hook', () => {
  it('is added next to the user’s own settings and hooks, and removed without a trace', async () => {
    const own = {
      model: 'opus',
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
        PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }],
      },
    };
    await writeFile(file, JSON.stringify(own));
    expect(desktopHookInstalled(file)).toBe(false);

    await installDesktopHook(COMMAND, 930, file);
    expect(desktopHookInstalled(file)).toBe(true);
    const settings = await read();
    expect(settings.model).toBe('opus');
    expect(settings.hooks).toEqual({
      Stop: own.hooks.Stop,
      PermissionRequest: [
        own.hooks.PermissionRequest[0],
        { hooks: [{ type: 'command', command: COMMAND, timeout: 930 }] },
      ],
    });

    // Enabling again (say from another install path) replaces the entry, never doubles it.
    await installDesktopHook(COMMAND.replace('agent', 'agent2'), 930, file);
    const groups = ((await read()).hooks as { PermissionRequest: unknown[] }).PermissionRequest;
    expect(groups).toHaveLength(2);

    expect(await removeDesktopHook(file)).toBe(true);
    expect(await read()).toEqual(own);
    expect(await removeDesktopHook(file)).toBe(false);
  });

  it('creates the settings file when there is none, and drops empty keys on removal', async () => {
    await installDesktopHook(COMMAND, 60, file);
    expect(desktopHookInstalled(file)).toBe(true);
    await removeDesktopHook(file);
    expect(await read()).toEqual({});
  });

  it('never rewrites a settings file it cannot read', async () => {
    await writeFile(file, '{ "model": "opus", oops }');
    await expect(installDesktopHook(COMMAND, 60, file)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(file, 'utf8')).toBe('{ "model": "opus", oops }');
  });

  it('keeps the agent’s endpoint for hooks, and only a loopback one', async () => {
    const endpoint = path.join(dir, 'hook-endpoint.json');
    await writeHookEndpoint(endpoint, { url: 'http://127.0.0.1:5123', token: 'secret' });
    expect(await readHookEndpoint(endpoint)).toEqual({
      url: 'http://127.0.0.1:5123',
      token: 'secret',
    });
    await writeFile(endpoint, JSON.stringify({ url: 'http://evil.example:80', token: 'x' }));
    expect(await readHookEndpoint(endpoint)).toBeUndefined();
    expect(await readHookEndpoint(path.join(dir, 'missing.json'))).toBeUndefined();
  });
});
