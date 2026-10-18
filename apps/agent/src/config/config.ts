import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { STORAGE_LIMIT_MB } from '@voicecode/protocol';
import { z } from 'zod';
import { readJsonFile, writeFileAtomic } from '../util/fs.js';

/** A public DNS name such as `code.example.com` (lower case, at least one dot). */
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
});

/**
 * Persisted agent configuration. Permission modes that would skip approvals
 * (`bypassPermissions`, `auto`, `dontAsk`) are deliberately not representable.
 */
export const ConfigSchema = z.object({
  version: z.literal(1),
  server: z
    .object({
      host: z.string().default('0.0.0.0'),
      port: z.number().int().min(1).max(65535).default(8443),
    })
    .prefault({}),
  projects: z.array(ProjectSchema).default([]),
  /**
   * Workspace roots: parent folders (canonical paths) whose subfolders a paired device
   * may open as projects without adding each one here first. Every tool call still
   * needs approval on the phone.
   */
  roots: z.array(z.string().min(1)).default([]),
  mouse: z
    .object({
      driver: z
        .enum(['auto', 'native', 'powershell', 'xdotool', 'ydotool', 'none'])
        .default('auto'),
      /** A lease with no input for this long may be taken over by another device. */
      leaseIdleMs: z.number().int().min(5_000).default(120_000),
    })
    .prefault({}),
  claude: z
    .object({
      model: z.string().optional(),
      permissionMode: z.enum(['default', 'acceptEdits', 'plan']).default('default'),
      /**
       * Lets phones switch sessions to the modes that skip approvals (bypass permissions,
       * auto, don't ask). Set only by `voicecode-agent modes allow-unsafe` on the PC.
       */
      allowUnsafeModes: z.boolean().default(false),
      /** Pending approvals are denied after this long without an answer. */
      approvalTimeoutMs: z
        .number()
        .int()
        .min(10_000)
        .default(15 * 60_000),
      maxBudgetUsd: z.number().positive().optional(),
      maxConcurrentSessions: z.number().int().min(1).max(16).default(4),
    })
    .prefault({}),
  /**
   * The phone's microphone, played into a virtual audio device on the PC so Claude
   * Code's own dictation (`/voice`) can record it. Windows needs VB-CABLE; Linux uses a
   * PipeWire null sink.
   */
  voice: z
    .object({
      mode: z.enum(['auto', 'off']).default('auto'),
      /** Windows: part of the name of the playback device to play into. */
      outputDevice: z.string().min(1).max(100).default('CABLE Input'),
      /** Windows: part of the name of the cable's recording side (what Claude Code records). */
      captureDevice: z.string().min(1).max(100).default('CABLE Output'),
      /**
       * Windows: make `captureDevice` the default input while a phone streams and put
       * the previous device back afterwards. Off: set the default input yourself.
       */
      switchDefaultInput: z.boolean().default(true),
      /** Linux: name of the null sink created for the phone's audio. */
      sink: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,64}$/, 'letters, digits, _ . - only')
        .default('voicecode_mic'),
      /** A microphone lease with no audio for this long is released. */
      leaseIdleMs: z.number().int().min(5_000).default(60_000),
    })
    .prefault({}),
  /**
   * Disposable files (old Claude Code downloads and runtimes, the rotated log, leftovers
   * of interrupted writes) are removed automatically once together they pass
   * `maxCacheMb`. Config, pairing, certificates and the versions in use are never touched.
   */
  cleanup: z
    .object({
      auto: z.boolean().default(true),
      maxCacheMb: z
        .number()
        .int()
        .min(STORAGE_LIMIT_MB.min)
        .max(STORAGE_LIMIT_MB.max)
        .default(STORAGE_LIMIT_MB.default),
    })
    .prefault({}),
  pairing: z
    .object({
      codeTtlMs: z
        .number()
        .int()
        .min(30_000)
        .default(10 * 60_000),
      maxAttempts: z.number().int().min(1).max(20).default(5),
    })
    .prefault({}),
  /**
   * Optional Cloudflare Tunnel, which gives phones a publicly trusted HTTPS URL so they
   * need no certificate install. Off by default: it makes the pairing page reachable
   * from the internet. Secrets never live here — named-tunnel credentials and the
   * dashboard token are separate `0600` files under `<home>/tunnel/`.
   */
  tunnel: z
    .object({
      /**
       * - `off`: LAN only.
       * - `quick`: an account-less `*.trycloudflare.com` URL that changes every run.
       * - `named`: a tunnel on your own domain, created by `voicecode-agent tunnel setup`.
       * - `token`: a tunnel managed in the Cloudflare dashboard (`tunnel token`).
       */
      mode: z.enum(['off', 'quick', 'named', 'token']).default('off'),
      /** Public host name for `named` and `token` mode. */
      hostname: z.string().regex(HOSTNAME_RE, 'not a valid host name').optional(),
      /** Tunnel UUID for `named` mode. */
      tunnelId: z.uuid().optional(),
      /** Name of that tunnel in the Cloudflare account; one tunnel per PC. */
      tunnelName: z.string().min(1).optional(),
      /** Path to `cloudflared`; found on PATH or in its default install location if unset. */
      cloudflared: z.string().min(1).optional(),
    })
    .prefault({}),
});

export function isValidHostname(name: string): boolean {
  return HOSTNAME_RE.test(name);
}

export type AgentConfig = z.infer<typeof ConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectSchema>;
export type TunnelConfig = AgentConfig['tunnel'];

export function defaultConfig(): AgentConfig {
  return ConfigSchema.parse({ version: 1 });
}

export async function loadConfig(file: string): Promise<AgentConfig | undefined> {
  const raw = await readJsonFile<unknown>(file);
  if (raw === undefined) return undefined;
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config at ${file}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export async function saveConfig(file: string, config: AgentConfig): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(ConfigSchema.parse(config), null, 2)}\n`);
}

/**
 * Resolves a user-supplied directory to its canonical absolute path (following
 * symlinks), so the allow-list cannot be bypassed with `..` or link tricks.
 */
export async function canonicalProjectPath(dir: string): Promise<string> {
  const resolved = await realpath(path.resolve(dir));
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`${dir} is not a directory`);
  return resolved;
}

export function projectIdFor(canonicalPath: string): string {
  const normalized = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/** Adds a project to the allow-list (idempotent). Returns the project entry. */
export async function addProject(
  config: AgentConfig,
  dir: string,
  name?: string,
): Promise<ProjectConfig> {
  const canonical = await canonicalProjectPath(dir);
  const id = projectIdFor(canonical);
  const existing = config.projects.find((p) => p.id === id);
  if (existing) return existing;
  const project = { id, name: name ?? path.basename(canonical), path: canonical };
  config.projects.push(project);
  return project;
}
