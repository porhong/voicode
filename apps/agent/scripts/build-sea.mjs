// Builds a standalone executable (Node.js single executable application) for the
// platform this runs on: apps/agent/build/sea/voicecode-agent[.exe].
//
// The CLI is bundled into one CommonJS file and injected into a copy of the running
// node binary together with the web client and the native input helpers. Claude Code
// itself is not embedded (it is ~250 MB); the binary downloads the version pinned here
// on first use and checks it against the integrity hash from package-lock.json.
//
// Usage (after `npm run build` and, for release builds, the native helpers):
//   node apps/agent/scripts/build-sea.mjs [--require-native]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { inject } from 'postject';

const SUPPORTED = ['win32-x64', 'linux-x64', 'linux-arm64'];
const HELPERS = {
  'win32-x64': ['voicecode-input.exe', 'voicecode-audio-out.exe', 'voicecode-console.exe'],
  'linux-x64': ['voicecode-input-x11', 'voicecode-input-wayland'],
  'linux-arm64': ['voicecode-input-x11', 'voicecode-input-wayland'],
};
const MANIFEST_ASSET = 'voicecode-manifest.json';

const agentDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = path.join(agentDir, '..', '..');
const outDir = path.join(agentDir, 'build', 'sea');
const target = `${process.platform}-${process.arch}`;
const requireNative = process.argv.includes('--require-native');
const exeName = process.platform === 'win32' ? 'voicecode-agent.exe' : 'voicecode-agent';

function fail(message) {
  console.error(`[build-sea] ${message}`);
  process.exit(1);
}
const log = (message) => console.log(`[build-sea] ${message}`);

if (!SUPPORTED.includes(target)) fail(`Unsupported platform ${target}`);
const pkg = JSON.parse(readFileSync(path.join(agentDir, 'package.json'), 'utf8'));
if (!existsSync(path.join(agentDir, 'dist', 'web', 'index.html'))) {
  fail('dist/web is missing. Run `npm run build` at the repository root first.');
}

// --- Claude Code download pin ---------------------------------------------------------
const lock = JSON.parse(readFileSync(path.join(repoDir, 'package-lock.json'), 'utf8'));
const sdk = lock.packages['node_modules/@anthropic-ai/claude-agent-sdk'];
const claudeName = `@anthropic-ai/claude-agent-sdk-${target}`;
const claude = lock.packages[`node_modules/${claudeName}`];
if (!sdk || !claude?.resolved || !claude.integrity) {
  fail(`package-lock.json has no resolved entry for ${claudeName}`);
}
if (claude.version !== sdk.version) {
  fail(`${claudeName}@${claude.version} does not match the SDK (${sdk.version})`);
}
const sdkManifest = JSON.parse(
  readFileSync(
    path.join(repoDir, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
    'utf8',
  ),
);
const claudePackage = {
  name: claudeName,
  version: claude.version,
  cliVersion: sdkManifest.claudeCodeVersion,
  url: claude.resolved,
  integrity: claude.integrity,
};

// --- Bundle ---------------------------------------------------------------------------
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const bundle = path.join(outDir, 'cli.cjs');
const result = await build({
  entryPoints: [path.join(agentDir, 'src', 'cli', 'index.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${process.versions.node.split('.')[0]}`,
  metafile: true,
  logLevel: 'warning',
  legalComments: 'none',
  define: {
    __AGENT_VERSION__: JSON.stringify(pkg.version),
    __CLAUDE_CODE_PACKAGE__: JSON.stringify(claudePackage),
    'import.meta.url': '__importMetaUrl',
  },
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
});

// --- Third-party notices for everything bundled into the binary -----------------------
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = /^(.*node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(input);
  if (match) packages.set(path.resolve(repoDir, match[1]), true);
}
const notices = [];
for (const dir of [...packages.keys()].sort()) {
  const meta = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const licenseFile = readdirSync(dir).find((f) => /^(licen[sc]e|copying)/i.test(f));
  const text = licenseFile ? readFileSync(path.join(dir, licenseFile), 'utf8').trim() : '';
  notices.push(
    `${meta.name}@${meta.version} (${meta.license ?? 'see package'})\n${'-'.repeat(72)}\n${text}`,
  );
}
writeFileSync(
  path.join(outDir, 'THIRD_PARTY_NOTICES.txt'),
  `VoiceCode Agent ${pkg.version} bundles the following packages and Node.js ${process.version}.\n\n` +
    `${notices.join('\n\n\n')}\n`,
);

// --- Embedded assets ------------------------------------------------------------------
function walk(dir, prefix) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(path.join(dir, e.name), `${prefix}/${e.name}`)
      : [{ key: `${prefix}/${e.name}`, file: path.join(dir, e.name) }],
  );
}
const assets = walk(path.join(agentDir, 'dist', 'web'), 'dist/web');
for (const helper of HELPERS[target]) {
  const file = path.join(agentDir, 'native-bin', target, helper);
  if (existsSync(file)) {
    assets.push({ key: `native-bin/${target}/${helper}`, file, executable: true });
  } else if (requireNative) {
    fail(`Missing native helper ${path.relative(repoDir, file)}`);
  } else {
    log(`warning: ${helper} not found; that backend will be unavailable`);
  }
}
if (process.platform === 'win32') {
  const ps1 = path.join(agentDir, 'native-bin', 'win32', 'voicecode-input.ps1');
  assets.push({ key: 'native-bin/win32/voicecode-input.ps1', file: ps1 });
}
// node-pty (Claude Code voice sessions) is a native addon the bundle cannot contain;
// its platform package is embedded as files and loaded from the extracted runtime.
const ptyDir = path.join(repoDir, 'node_modules', `@lydell/node-pty-${target}`);
if (!existsSync(ptyDir)) fail(`node_modules has no @lydell/node-pty-${target} (run npm ci)`);
for (const entry of walk(ptyDir, 'node-pty')) {
  if (/\.(pdb|map|md)$/i.test(entry.key)) continue; // debug symbols and docs
  const executable = entry.key.startsWith('node-pty/prebuilds/');
  assets.push({ ...entry, ...(executable ? { executable: true } : {}) });
}

const hash = createHash('sha256').update(pkg.version);
for (const a of assets) hash.update(a.key).update(readFileSync(a.file));
const manifest = {
  buildId: `${pkg.version}-${hash.digest('hex').slice(0, 12)}`,
  files: assets.map((a) => ({ path: a.key, ...(a.executable ? { executable: true } : {}) })),
};
const manifestFile = path.join(outDir, MANIFEST_ASSET);
writeFileSync(manifestFile, JSON.stringify(manifest));

// --- Blob + injection -----------------------------------------------------------------
const blob = path.join(outDir, 'sea-prep.blob');
const seaConfig = path.join(outDir, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: bundle,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
      assets: Object.fromEntries([
        [MANIFEST_ASSET, manifestFile],
        ...assets.map((a) => [a.key, a.file]),
      ]),
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

const exe = path.join(outDir, exeName);
copyFileSync(process.execPath, exe);
chmodSync(exe, 0o755);
if (process.platform === 'win32') removeSignature(exe);
await inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
});
for (const f of [blob, seaConfig, manifestFile]) rmSync(f);

// --- Smoke test -----------------------------------------------------------------------
const reported = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
if (reported !== pkg.version) fail(`${exeName} --version printed "${reported}"`);
const size = (statSync(exe).size / 1048576).toFixed(1);
log(`${path.relative(repoDir, exe)} (${size} MB, ${assets.length} embedded files) OK`);

/**
 * node.exe is Authenticode-signed; injecting the blob invalidates that signature, so
 * strip it when signtool is available rather than shipping a broken one.
 */
function removeSignature(file) {
  const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  let signtool;
  try {
    signtool = readdirSync(kits)
      .filter((v) => /^\d/.test(v))
      .sort()
      .reverse()
      .map((v) => path.join(kits, v, 'x64', 'signtool.exe'))
      .find((p) => existsSync(p));
  } catch {
    // Windows SDK not installed.
  }
  if (!signtool) {
    log('signtool not found; leaving the original (now invalid) node.exe signature in place');
    return;
  }
  execFileSync(signtool, ['remove', '/s', file], { stdio: 'ignore' });
}
