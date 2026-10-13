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

const ps1 = fileURLToPath(new URL('../../native/windows/voicecode-input.ps1', root));
const ps1Target = fileURLToPath(new URL('native-bin/win32/', root));
await mkdir(ps1Target, { recursive: true });
await cp(ps1, `${ps1Target}voicecode-input.ps1`);
