// End-to-end smoke test for a standalone executable built by build-sea.mjs: runs
// `init`, starts the server, fetches the web client over HTTPS, checks `status`, and
// stops it. Everything happens in a throwaway home and cache directory.
//
//   node apps/agent/scripts/smoke-sea.mjs [path-to-binary] [--with-claude]
//
// --with-claude also exercises the real Claude Code download and runs `claude --version`.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const agentDir = fileURLToPath(new URL('..', import.meta.url));
const exe = path.resolve(
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
    path.join(
      agentDir,
      'build',
      'sea',
      process.platform === 'win32' ? 'voicecode-agent.exe' : 'voicecode-agent',
    ),
);
const withClaude = process.argv.includes('--with-claude');
const port = String(40_000 + Math.floor(Math.random() * 20_000));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'vc-smoke-'));
const env = {
  ...process.env,
  VOICECODE_HOME: path.join(tmp, 'home'),
  VOICECODE_CACHE_DIR: path.join(tmp, 'cache'),
  NO_COLOR: '1',
};
// Any existing file will do when Claude Code itself is not under test.
if (withClaude) delete env.VOICECODE_CLAUDE_PATH;
else env.VOICECODE_CLAUDE_PATH = exe;

const log = (message) => console.log(`[smoke] ${message}`);
function run(...args) {
  return execFileSync(exe, args, { env, encoding: 'utf8', timeout: 10 * 60_000 });
}
function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { rejectUnauthorized: false, headers: { accept: 'text/html' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

let server;
try {
  log(`binary ${exe}`);
  const init = run('init', '--port', port, '--project', tmp);
  if (withClaude && !/Claude Code \S+ installed/.test(init)) {
    throw new Error(`init did not install Claude Code:\n${init}`);
  }
  log('init ok');

  if (withClaude) {
    const managed = path.join(env.VOICECODE_CACHE_DIR, 'claude-code');
    const [version] = readdirSync(managed);
    const claude = path.join(
      managed,
      version,
      process.platform === 'win32' ? 'claude.exe' : 'claude',
    );
    const reported = execFileSync(claude, ['--version'], { encoding: 'utf8' }).trim();
    log(`downloaded Claude Code runs: ${reported}`);
  }

  server = spawn(exe, ['start', '--no-qr'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', (c) => (output += c));
  server.stderr.on('data', (c) => (output += c));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`start timed out:\n${output}`)), 60_000);
    const poll = setInterval(() => {
      if (output.includes('Ready for browser connections')) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    }, 200);
    server.once('exit', (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error(`start exited with ${code}:\n${output}`));
    });
  });
  if (/warning/i.test(output)) throw new Error(`start printed a warning:\n${output}`);
  log('server started');

  const page = await get(`https://127.0.0.1:${port}/`);
  if (page.status !== 200 || !page.body.includes('<div id="root">')) {
    throw new Error(`GET / returned ${page.status}`);
  }
  const ca = await get(`https://127.0.0.1:${port}/voicecode-ca.crt`);
  if (ca.status !== 200 || !ca.body.includes('BEGIN CERTIFICATE')) {
    throw new Error(`GET /voicecode-ca.crt returned ${ca.status}`);
  }
  log('web client and CA served from embedded assets');

  const status = run('status');
  if (!status.includes('Running')) throw new Error(`unexpected status:\n${status}`);
  log('status ok');

  const runtime = path.join(env.VOICECODE_CACHE_DIR, 'runtime');
  const [build] = readdirSync(runtime);
  if (!existsSync(path.join(runtime, build, '.complete'))) throw new Error('runtime incomplete');
  const helpers = path.join(runtime, build, 'native-bin', `${process.platform}-${process.arch}`);
  log(`extracted helpers: ${existsSync(helpers) ? readdirSync(helpers).join(', ') : 'none'}`);
  if (!existsSync(path.join(runtime, build, 'node-pty', 'lib', 'index.js'))) {
    throw new Error('node-pty was not extracted with the runtime');
  }
  log('node-pty extracted');

  // The hook subcommand (Claude Code PreToolUse hook) must stay silent without its env.
  const hook = execFileSync(exe, ['hook', 'pre-tool-use'], {
    env,
    encoding: 'utf8',
    input: '{"session_id":"x","tool_name":"Bash","tool_input":{}}',
  });
  if (hook.trim() !== '') throw new Error(`hook printed something:\n${hook}`);
  log('hook subcommand ok');

  // doctor exits 1 on a headless runner (no desktop session); its output is what matters.
  let doctor;
  try {
    doctor = execFileSync(exe, ['doctor'], { env, encoding: 'utf8' });
  } catch (err) {
    doctor = err.stdout ?? '';
  }
  if (!doctor.includes('Phone microphone')) throw new Error(`doctor is missing checks:\n${doctor}`);
  if (!/Claude Code terminal\s+node-pty loaded/.test(doctor)) {
    throw new Error(`node-pty did not load from the extracted runtime:\n${doctor}`);
  }
  log('doctor ran the microphone checks; node-pty loads from the runtime');

  run('stop');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('agent did not stop')), 15_000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  server = undefined;
  log('stopped cleanly');
} finally {
  server?.kill();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
