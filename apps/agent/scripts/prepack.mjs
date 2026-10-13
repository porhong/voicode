// Runs before `npm pack`/`npm publish`: makes sure the bundle has been built and copies
// the repository README and LICENSE into the package directory (npm only includes
// files from the package's own folder).
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = new URL('..', import.meta.url);
const repo = new URL('../../', pkg);

if (!existsSync(new URL('dist/web/index.html', pkg)) || !existsSync(new URL('dist/cli.js', pkg))) {
  console.error('[prepack] dist/ is incomplete. Run `npm run build` at the repository root first.');
  process.exit(1);
}
for (const file of ['README.md', 'LICENSE']) {
  copyFileSync(fileURLToPath(new URL(file, repo)), fileURLToPath(new URL(file, pkg)));
}
