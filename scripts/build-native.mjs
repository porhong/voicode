// Builds the native helpers (mouse input, Windows audio output) and copies them into
// apps/agent/native-bin/<platform>-<arch>/ where the agent looks for them at runtime.
//
//   node scripts/build-native.mjs [--helper windows|audio|console|x11|wayland]
//
// Without --helper, builds every helper the current platform supports and skips the
// Wayland helper when its libraries (libei, gio) are not installed.
//
//   Windows: MinGW gcc or MSVC cl on PATH.
//   X11:     gcc + libx11-dev libxtst-dev.
//   Wayland: gcc + pkg-config + libglib2.0-dev libei-dev (Ubuntu 24.04+ / Fedora 39+).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(
  root,
  'apps',
  'agent',
  'native-bin',
  `${process.platform}-${process.arch}`,
);
const requested = process.argv.includes('--helper')
  ? process.argv[process.argv.indexOf('--helper') + 1]
  : undefined;

function has(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function pkgConfig(args) {
  try {
    return execFileSync('pkg-config', args, { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function install(dir, output) {
  mkdirSync(outDir, { recursive: true });
  copyFileSync(path.join(dir, 'build', output), path.join(outDir, output));
  console.log(`Installed ${path.relative(root, path.join(outDir, output))}`);
}

function build(target, source, output, compilers) {
  const dir = path.join(root, 'native', target);
  mkdirSync(path.join(dir, 'build'), { recursive: true });
  const compiler = compilers.find(([cmd]) => has(cmd));
  if (!compiler) {
    console.error(
      `No supported compiler found for ${target} (tried ${compilers.map(([c]) => c).join(', ')}).`,
    );
    process.exit(1);
  }
  const [cmd, args] = compiler;
  run(cmd, args(source, path.join('build', output)), dir);
  install(dir, output);
}

const helpers = {
  windows: () =>
    build('windows', 'voicecode-input.c', 'voicecode-input.exe', [
      [
        'gcc',
        (src, out) => [
          '-O2',
          '-Wall',
          '-municode',
          '-static',
          '-o',
          out,
          src,
          '-luser32',
          '-ladvapi32',
        ],
      ],
      [
        'cl',
        (src, out) => ['/nologo', '/O2', '/W3', `/Fe:${out}`, src, 'user32.lib', 'advapi32.lib'],
      ],
    ]),
  // Plays phone audio into a virtual cable for Claude Code's dictation (waveOut + MMDevice).
  audio: () =>
    build('windows', 'voicecode-audio-out.c', 'voicecode-audio-out.exe', [
      [
        'gcc',
        (src, out) => [
          '-O2',
          '-Wall',
          '-municode',
          '-static',
          '-o',
          out,
          src,
          '-lwinmm',
          '-lole32',
        ],
      ],
      ['cl', (src, out) => ['/nologo', '/O2', '/W3', `/Fe:${out}`, src, 'winmm.lib', 'ole32.lib']],
    ]),
  // Attaches to the console of a Claude Code in the user's terminal (keys in, screen out).
  console: () =>
    build('windows', 'voicecode-console.c', 'voicecode-console.exe', [
      ['gcc', (src, out) => ['-O2', '-Wall', '-municode', '-static', '-o', out, src]],
      ['cl', (src, out) => ['/nologo', '/O2', '/W3', `/Fe:${out}`, src]],
    ]),
  x11: () =>
    build('linux-x11', 'voicecode-input-x11.c', 'voicecode-input-x11', [
      ['gcc', (src, out) => ['-O2', '-Wall', '-Wextra', '-o', out, src, '-lX11', '-lXtst']],
      ['cc', (src, out) => ['-O2', '-o', out, src, '-lX11', '-lXtst']],
    ]),
  wayland: () => {
    const flags = pkgConfig(['--cflags', '--libs', 'gio-2.0', 'gio-unix-2.0', 'libei-1.0']);
    if (!flags) {
      console.error(
        'Wayland helper needs pkg-config, gio-2.0 and libei-1.0 (apt install libei-dev).',
      );
      process.exit(1);
    }
    build('linux-wayland', 'voicecode-input-wayland.c', 'voicecode-input-wayland', [
      ['gcc', (src, out) => ['-O2', '-Wall', '-Wextra', '-o', out, src, ...flags]],
    ]);
  },
};

if (requested) {
  if (!helpers[requested]) {
    console.error(`Unknown helper "${requested}" (expected ${Object.keys(helpers).join(', ')}).`);
    process.exit(1);
  }
  helpers[requested]();
} else if (process.platform === 'win32') {
  helpers.windows();
  helpers.audio();
  helpers.console();
} else if (process.platform === 'linux') {
  helpers.x11();
  if (pkgConfig(['--exists', 'libei-1.0', 'gio-unix-2.0'])) helpers.wayland();
  else console.log('Skipping the Wayland helper (libei-dev / libglib2.0-dev not installed).');
} else {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}
