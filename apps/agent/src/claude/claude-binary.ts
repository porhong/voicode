import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { findClaudeOnPath, resolveClaudeExecutable } from './claude-executable.js';

/**
 * The Claude Code executable to run interactively (in a pseudo-terminal). The SDK path
 * leaves resolution to the SDK, which is no help here, so the SDK's platform package is
 * looked up directly; the order otherwise matches `resolveClaudeExecutable`.
 */
export function interactiveClaudePath(): string | undefined {
  const resolved = resolveClaudeExecutable();
  if (resolved.path && resolved.source !== 'path') return resolved.path;
  const fromSdk = sdkPlatformBinary();
  if (fromSdk) return fromSdk;
  return resolved.path ?? findClaudeOnPath();
}

function sdkPlatformBinary(): string | undefined {
  const name = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  try {
    const require = createRequire(import.meta.url);
    const dir = path.dirname(require.resolve(`${name}/package.json`));
    const exe = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    return existsSync(exe) ? exe : undefined;
  } catch {
    return undefined;
  }
}
