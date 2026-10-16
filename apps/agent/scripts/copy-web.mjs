// Copies the built web client into dist/web and the PowerShell input helper into
// native-bin/win32 so both ship with the published package.
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const webDist = fileURLToPath(new URL('../web/dist', root));
const target = fileURLToPath(new URL('dist/web', root));

if (!existsSync(webDist)) {
  console.warn('[copy-web] apps/web/dist not found; run `npm run build -w @voicecode/web` first');
} else {
  await rm(target, { recursive: true, force: true });
  await cp(webDist, target, { recursive: true });
  console.log('[copy-web] web client copied to dist/web');
}

// PowerShell helpers: the mouse fallback and the Claude Desktop (UI Automation) helper.
const ps1Target = fileURLToPath(new URL('native-bin/win32/', root));
await mkdir(ps1Target, { recursive: true });
for (const name of ['voicecode-input.ps1', 'voicecode-desktop.ps1']) {
  await cp(fileURLToPath(new URL(`../../native/windows/${name}`, root)), `${ps1Target}${name}`);
}
