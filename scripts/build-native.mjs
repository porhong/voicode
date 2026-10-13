// Builds the native mouse helper for the current platform and copies it into
// apps/agent/native-bin/<platform>-<arch>/ where the agent looks for it at runtime.
//
//   Windows: MinGW gcc or MSVC cl must be on PATH.
//   Linux:   gcc plus libx11-dev and libxtst-dev.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(
  root,
  'apps',
  'agent',
  'native-bin',
  `${process.platform}-${process.arch}`,
);

function has(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
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
  mkdirSync(outDir, { recursive: true });
  copyFileSync(path.join(dir, 'build', output), path.join(outDir, output));
  console.log(`Installed ${path.relative(root, path.join(outDir, output))}`);
}

if (process.platform === 'win32') {
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
  ]);
} else if (process.platform === 'linux') {
  build('linux-x11', 'voicecode-input-x11.c', 'voicecode-input-x11', [
    ['gcc', (src, out) => ['-O2', '-Wall', '-Wextra', '-o', out, src, '-lX11', '-lXtst']],
    ['cc', (src, out) => ['-O2', '-o', out, src, '-lX11', '-lXtst']],
  ]);
} else {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}
