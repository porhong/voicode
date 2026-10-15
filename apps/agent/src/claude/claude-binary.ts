import path from 'node:path';
import {
  bundledClaudePackage,
  findClaudeOnPath,
  managedClaudePath,
  sdkPlatformBinary,
} from './claude-executable.js';
import { existsSync } from 'node:fs';

/**
 * The Claude Code executable to run interactively (in a pseudo-terminal). The user's own
 * `claude` comes first: it is the one they keep signed in and up to date. The copies the
 * agent depends on (the SDK's platform package, the standalone build's managed download)
 * come last, and the session is started with auto-update off so Claude Code cannot
 * rename them away (see `sdkPlatformBinary`).
 */
export function interactiveClaudePath(): string | undefined {
  if (process.env.VOICECODE_CLAUDE_PATH) return path.resolve(process.env.VOICECODE_CLAUDE_PATH);
  const onPath = findClaudeOnPath();
  if (onPath) return onPath;
  const pkg = bundledClaudePackage();
  if (pkg && existsSync(managedClaudePath(pkg))) return managedClaudePath(pkg);
  return sdkPlatformBinary();
}
