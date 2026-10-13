import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readJsonFile, writeFileAtomic } from '../util/fs.js';

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
});

export type AgentConfig = z.infer<typeof ConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectSchema>;

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
