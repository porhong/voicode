import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStandalone, standaloneRoot } from './standalone.js';

declare const __AGENT_VERSION__: string | undefined;

export const VERSION: string =
  typeof __AGENT_VERSION__ !== 'undefined' ? __AGENT_VERSION__ : '0.0.0-dev';

let cachedRoot: string | undefined;

/**
 * Directory containing the agent's package.json. Works both from the bundled `dist/`
 * output and when running sources with tsx, so bundled assets (web UI, native helpers,
 * scripts) can be located relative to it. Standalone executables use the directory their
 * embedded assets were extracted to, which has the same layout.
 */
export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  if (isStandalone()) return (cachedRoot = standaloneRoot());
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
      if (pkg.name === 'voicecode-agent') return (cachedRoot = dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not locate the voicecode-agent package root');
    dir = parent;
  }
}
