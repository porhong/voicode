import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * What a project's own Claude Code settings let run *without* an approval prompt.
 *
 * Sessions load project settings (needed for CLAUDE.md and the project's own
 * configuration, exactly like the interactive CLI). Those files can pre-approve tools
 * (`permissions.allow`) and define hooks that run commands automatically, so a cloned
 * repository could otherwise act without anyone seeing an approval on the phone. The
 * agent surfaces them when a project is added, in `doctor`, and in every session.
 */
export interface ProjectAutoApprovals {
  allow: string[];
  hooks: string[];
  defaultMode?: string;
  files: string[];
}

const FILES = [path.join('.claude', 'settings.json'), path.join('.claude', 'settings.local.json')];

export async function inspectProjectSettings(projectDir: string): Promise<ProjectAutoApprovals> {
  const result: ProjectAutoApprovals = { allow: [], hooks: [], files: [] };
  for (const rel of FILES) {
    let raw: string;
    try {
      raw = await readFile(path.join(projectDir, rel), 'utf8');
    } catch {
      continue;
    }
    let settings: { permissions?: { allow?: unknown; defaultMode?: unknown }; hooks?: unknown };
    try {
      settings = JSON.parse(raw) as typeof settings;
    } catch {
      continue; // Claude Code reports malformed settings itself.
    }
    result.files.push(rel);
    const allow = settings.permissions?.allow;
    if (Array.isArray(allow)) result.allow.push(...allow.filter((a) => typeof a === 'string'));
    if (typeof settings.permissions?.defaultMode === 'string') {
      result.defaultMode = settings.permissions.defaultMode;
    }
    if (settings.hooks && typeof settings.hooks === 'object') {
      result.hooks.push(...Object.keys(settings.hooks));
    }
  }
  result.allow = [...new Set(result.allow)];
  result.hooks = [...new Set(result.hooks)];
  return result;
}

export function hasAutoApprovals(a: ProjectAutoApprovals): boolean {
  return a.allow.length > 0 || a.hooks.length > 0;
}

/** One-paragraph, human-readable description for terminals and the phone. */
export function describeAutoApprovals(a: ProjectAutoApprovals): string {
  const parts: string[] = [];
  if (a.allow.length) {
    parts.push(`pre-approve ${a.allow.join(', ')} (these run without asking)`);
  }
  if (a.hooks.length) {
    parts.push(`define hooks (${a.hooks.join(', ')}) that run commands automatically`);
  }
  return `This project's .claude settings ${parts.join(' and ')}.`;
}
