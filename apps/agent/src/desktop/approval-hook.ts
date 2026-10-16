import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { claudeConfigDir } from '../sessions/pc-sessions.js';
import { writeFileAtomic } from '../util/fs.js';

/**
 * Phone approvals for Claude Desktop sessions go through Claude Code's own
 * `PermissionRequest` hook rather than through Desktop's window: Desktop runs Claude
 * Code, Claude Code runs the hooks from the user's settings (`~/.claude/settings.json`)
 * wherever it runs, and when it is about to ask for a permission, the hook "runs
 * alongside" Desktop's dialog and whichever decides first applies. So an approval from
 * the phone works whether Desktop's window is in front, covered or minimized, and an
 * answer given on the PC first still wins.
 *
 * The hook is added only by `voicecode-agent desktop enable` and removed by `desktop
 * disable`. For every session the phone does not control it decides nothing (exits
 * without output), which leaves Claude Code's own dialog as it is.
 */

/** How the agent's hook entry is recognised in the settings (its command line). */
export const HOOK_SUBCOMMAND = 'hook permission-request';

export function claudeSettingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(claudeConfigDir(env), 'settings.json');
}

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}
interface MatcherGroup {
  matcher?: string;
  hooks?: HookEntry[];
}
type Settings = Record<string, unknown> & {
  hooks?: Record<string, MatcherGroup[] | undefined>;
};

const isOurs = (h: HookEntry) =>
  typeof h.command === 'string' && h.command.includes(HOOK_SUBCOMMAND);

function parseSettings(text: string, file: string): Settings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never rewrite a settings file that can't be read: it would lose the user's settings.
    throw new Error(`${file} is not valid JSON; fix it first`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} does not hold a settings object`);
  }
  return parsed as Settings;
}

/** Whether the agent's hook is in the user's Claude Code settings. */
export function desktopHookInstalled(file = claudeSettingsFile()): boolean {
  let settings: Settings;
  try {
    settings = parseSettings(readFileSync(file, 'utf8'), file);
  } catch {
    return false;
  }
  const groups = settings.hooks?.PermissionRequest;
  return Array.isArray(groups) && groups.some((g) => (g.hooks ?? []).some(isOurs));
}

async function readSettings(file: string): Promise<Settings> {
  try {
    return parseSettings(await readFile(file, 'utf8'), file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

/** Removes the agent's entries; groups and keys left empty go too. */
function withoutOurs(settings: Settings): Settings {
  const hooks = settings.hooks;
  const groups = hooks?.PermissionRequest;
  if (!hooks || !Array.isArray(groups)) return settings;
  const kept = groups
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0);
  const nextHooks = { ...hooks, PermissionRequest: kept.length ? kept : undefined };
  if (!kept.length) delete nextHooks.PermissionRequest;
  const next: Settings = { ...settings, hooks: nextHooks };
  if (!Object.keys(nextHooks).length) delete next.hooks;
  return next;
}

/**
 * Adds the hook (replacing an earlier entry of the agent's, e.g. from another install
 * path). Every other setting is kept as it is; the file is replaced atomically.
 */
export async function installDesktopHook(
  command: string,
  timeoutSeconds: number,
  file = claudeSettingsFile(),
): Promise<void> {
  const settings = withoutOurs(await readSettings(file));
  const hooks = { ...(settings.hooks ?? {}) };
  hooks.PermissionRequest = [
    ...(hooks.PermissionRequest ?? []),
    { hooks: [{ type: 'command', command, timeout: timeoutSeconds }] },
  ];
  await writeFileAtomic(file, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
}

/** Removes the hook; returns whether there was one. */
export async function removeDesktopHook(file = claudeSettingsFile()): Promise<boolean> {
  if (!desktopHookInstalled(file)) return false;
  const settings = withoutOurs(await readSettings(file));
  await writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

/**
 * Where a running agent's hook server listens, for hook processes Claude Desktop starts
 * (they don't get the agent's environment, unlike the sessions the agent hosts). The
 * file is private to the user and holds a token that exists for one agent run.
 */
export interface HookEndpoint {
  url: string;
  token: string;
}

export async function writeHookEndpoint(file: string, endpoint: HookEndpoint): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(endpoint));
}

export async function readHookEndpoint(file: string): Promise<HookEndpoint | undefined> {
  try {
    const e = JSON.parse(await readFile(file, 'utf8')) as Partial<HookEndpoint>;
    if (typeof e.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(e.url)) return undefined;
    if (typeof e.token !== 'string' || !e.token) return undefined;
    return { url: e.url, token: e.token };
  } catch {
    return undefined;
  }
}

export async function removeHookEndpoint(file: string): Promise<void> {
  await rm(file, { force: true });
}
