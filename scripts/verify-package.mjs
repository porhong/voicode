// Checks what `npm pack` would publish for voicecode-agent, so a release can never
// ship without the web client, the CLI bundle or (with --require-native) the native
// mouse helpers for every supported target.
//
//   node scripts/verify-package.mjs [--require-native]
import { execSync } from 'node:child_process';

const requireNative = process.argv.includes('--require-native');

// A fixed command string (no user input), so running it through the shell is safe and
// works for npm's .cmd shim on Windows.
const output = execSync('npm pack --dry-run --json -w @anantbot/voicecode-agent', {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
const [pack] = JSON.parse(output);
const files = new Map(pack.files.map((f) => [f.path, f]));

const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/cli.js',
  'dist/web/index.html',
  'dist/web/manifest.webmanifest',
  'native-bin/win32/voicecode-input.ps1',
];
const native = [
  'native-bin/win32-x64/voicecode-input.exe',
  'native-bin/win32-x64/voicecode-audio-out.exe',
  'native-bin/win32-x64/voicecode-console.exe',
  'native-bin/linux-x64/voicecode-input-x11',
  'native-bin/linux-arm64/voicecode-input-x11',
  'native-bin/linux-x64/voicecode-input-wayland',
  'native-bin/linux-arm64/voicecode-input-wayland',
];
const forbidden = [/^src\//, /\.test\.[jt]s$/, /(^|\/)\.env/, /\.pem$/, /tsconfig/];

const problems = [];
for (const path of [...required, ...(requireNative ? native : [])]) {
  if (!files.has(path)) problems.push(`missing ${path}`);
}
if (![...files.keys()].some((p) => p.startsWith('dist/web/assets/') && p.endsWith('.js'))) {
  problems.push('missing web client JavaScript in dist/web/assets');
}
for (const path of files.keys()) {
  if (forbidden.some((re) => re.test(path))) problems.push(`unexpected file ${path}`);
}
// npm preserves the executable bit; the Linux helpers must be spawnable after install.
for (const path of native.filter((p) => p.includes('linux') && files.has(p))) {
  if ((files.get(path).mode & 0o111) === 0) problems.push(`${path} is not executable`);
}

const sizeMb = (pack.unpackedSize / 1024 / 1024).toFixed(2);
console.log(`${pack.name}@${pack.version}: ${pack.entryCount} files, ${sizeMb} MB unpacked`);
for (const path of native) console.log(`  ${files.has(path) ? '✔' : '·'} ${path}`);

if (problems.length) {
  console.error(`\nPackage verification failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Package contents OK');
