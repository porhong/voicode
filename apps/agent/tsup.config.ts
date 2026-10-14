import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  splitting: false,
  // Workspace packages are TypeScript sources; inline them so the published package
  // depends only on what is listed in package.json.
  noExternal: ['@voicecode/protocol', '@voicecode/security'],
  // Keep `node:` specifiers: prefix-only builtins such as `node:sea` have no bare name.
  removeNodeProtocol: false,
  define: { __AGENT_VERSION__: JSON.stringify(pkg.version) },
});
