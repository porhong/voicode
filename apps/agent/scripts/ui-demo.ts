// Serves the built web client against a fake Claude and a fake mouse, for UI work and
// screenshots without spending money or moving the real cursor:
//
//   npm run build && npx tsx apps/agent/scripts/ui-demo.ts [port]
//
// Every prompt gets a short Markdown reply after one Bash approval. A pairing code is
// printed at start, and GET /demo/pair-code (from this machine) issues a fresh one for
// scripted runs. State lives in a temporary directory that is removed on exit.
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import { addProject, ConfigSchema } from '../src/config/config.js';
import { resolvePaths } from '../src/config/paths.js';
import { listRootFolder, resolveRootFolder } from '../src/config/workspace-roots.js';
import { InputRouter } from '../src/mouse/input-router.js';
import { DeviceRegistry } from '../src/pairing/device-registry.js';
import { AttachmentStore } from '../src/storage/attachments.js';
import { StorageJanitor } from '../src/storage/janitor.js';
import { PairingService } from '../src/pairing/pairing-service.js';
import { buildServer } from '../src/server/app.js';
import { WsGateway } from '../src/server/ws-gateway.js';
import { encodeProjectDir, PcSessionWatcher } from '../src/sessions/pc-sessions.js';
import { SessionManager } from '../src/sessions/session-manager.js';
import type { PtyHandle } from '../src/claude/pty-session.js';
import { FakeMicDriver, FakeMouseDriver } from '../src/test-utils/fakes.js';
import { ensureTls } from '../src/tls/certificates.js';
import { silentLogger } from '../src/util/logger.js';
import { packageRoot } from '../src/util/version.js';
import { MicRouter } from '../src/voice/mic-router.js';

const port = Number(process.argv[2] ?? 8450);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REPLY = `Done. Here's what I changed:

- Added \`hello.txt\` with a greeting
- Ran the test suite: **12 passed**

\`\`\`bash
npm test -- --run
\`\`\`

Anything else?`;

const demoQuery = ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
  const options = params.options!;
  async function* run(): AsyncGenerator<SDKMessage, void> {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: `demo-${Date.now()}`,
      model: 'claude-opus-5-5',
      permissionMode: 'default',
      cwd: options.cwd,
    } as unknown as SDKMessage;
    for await (const message of params.prompt) {
      // Prompts with images arrive as content blocks: the images first, then the text.
      const content = message.message.content;
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];
      const images = blocks.filter((b) => b.type === 'image').length;
      const text = blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ');
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'text',
              text: images
                ? `I can see ${images === 1 ? 'the image' : `${images} images`}. ${text.slice(0, 60)}`
                : `I'll take care of that: “${text.slice(0, 60)}”.`,
            },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'package.json' } },
          ],
        },
      } as unknown as SDKMessage;
      await sleep(400);
      const decision = await options.canUseTool!(
        'Bash',
        {
          // A prompt mentioning "lines" gets a multi-line command, for the deck's "+N lines".
          command: /lines/i.test(text)
            ? 'cd apps/web\nnpm ci\nnpm test -- --run'
            : 'npm test -- --run',
          description: 'Run the test suite',
        },
        { signal: new AbortController().signal, toolUseID: 't2', requestId: 'r1', suggestions: [] },
      );
      await sleep(600);
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'text',
              text: decision.behavior === 'allow' ? REPLY : 'Okay, I left it alone.',
            },
          ],
        },
      } as unknown as SDKMessage;
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 4200,
        total_cost_usd: 0.04,
        num_turns: 2,
      } as unknown as SDKMessage;
    }
  }
  return Object.assign(run(), {
    interrupt: async () => undefined,
    setPermissionMode: async () => undefined,
    setModel: async () => undefined,
    applyFlagSettings: async () => undefined,
    supportedModels: async () => [
      {
        value: 'default',
        displayName: 'Default (recommended)',
        description: 'Opus 5.5',
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'fable',
        displayName: 'Fable',
        description: 'Fable 5.1 · most capable',
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        value: 'sonnet',
        displayName: 'Sonnet',
        description: 'Sonnet 5.5 · fast',
        supportedEffortLevels: ['low', 'medium', 'high'],
      },
      {
        value: 'haiku',
        displayName: 'Haiku',
        description: 'Haiku 5.5 · fastest',
        supportsEffort: false,
      },
    ],
    // Every kind of limit, at every level, so the usage rings can be checked at a glance.
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: {
          utilization: 37,
          resets_at: new Date(Date.now() + 134 * 60_000).toISOString(),
        },
        seven_day: {
          utilization: 78,
          resets_at: new Date(Date.now() + 2.3 * 86_400_000).toISOString(),
        },
        seven_day_opus: {
          utilization: 93,
          resets_at: new Date(Date.now() + 2.3 * 86_400_000).toISOString(),
        },
        model_scoped: [
          {
            display_name: 'Fable',
            utilization: 12,
            resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString(),
          },
        ],
        extra_usage: { is_enabled: true, utilization: 5 },
      },
    }),
    close: () => undefined,
  }) as unknown as Query;
}) as unknown as typeof query;

const home = await mkdtemp(path.join(os.tmpdir(), 'voicecode-ui-demo-'));
const paths = resolvePaths(home);
const logger = silentLogger();
const tls = await ensureTls(paths, ['127.0.0.1'], logger);
const registry = await DeviceRegistry.open(paths.devices);
const pairing = new PairingService(registry, { ttlMs: 60 * 60_000, maxAttempts: 20 });
const router = new InputRouter(logger, { leaseIdleMs: 60_000 });
router.attach(new FakeMouseDriver(), { details: {} });
const mic = new MicRouter(logger, { leaseIdleMs: 60_000 });
mic.attach(new FakeMicDriver(), { device: 'Demo Cable' });
const config = ConfigSchema.parse({
  version: 1,
  projects: [
    { id: 'demo1', name: 'my-app', path: home },
    { id: 'demo2', name: 'website', path: home },
  ],
});
// A workspace folder with a few projects for the "Open a folder" browser.
const workspace = path.join(home, 'code');
for (const dir of ['api-server/.git', 'mobile-app/.git', 'scratch', 'website/.git']) {
  await mkdir(path.join(workspace, dir), { recursive: true });
}
config.roots = [await realpath(workspace)];
/**
 * Stands in for an interactive Claude Code in a pty (voice sessions): draws a prompt
 * with the dictation footer, toggles "REC" on Space and echoes what is typed.
 */
class DemoPty implements PtyHandle {
  pid = process.pid + 1000;
  private dataListener: ((data: string) => void) | undefined;
  private exitListener: ((e: { exitCode: number }) => void) | undefined;
  private recording = false;
  private typed = '';
  private lines: string[] = ['▐ Welcome back! This is the UI demo, not a real Claude Code.'];
  /** A permission menu like Claude Code's own (a prompt mentioning "deploy" opens it). */
  private menu: { options: string[]; selected: number } | undefined;
  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
    setTimeout(() => this.render(), 100);
  }
  onExit(listener: (e: { exitCode: number }) => void): void {
    this.exitListener = listener;
  }
  write(data: string): void {
    // Typed text and its Enter can arrive in one write (`/voice tap\r`).
    if (!this.menu && data.length > 1 && data.endsWith('\r')) {
      this.write(data.slice(0, -1));
      this.write('\r');
      return;
    }
    if (this.menu) {
      const menu = this.menu;
      // eslint-disable-next-line no-control-regex -- terminal key sequences
      for (const key of data.match(/\x1b\[[AB]|\r|\x1b/g) ?? []) {
        if (key === '\x1b[A') menu.selected = Math.max(0, menu.selected - 1);
        else if (key === '\x1b[B')
          menu.selected = Math.min(menu.options.length - 1, menu.selected + 1);
        else if (key === '\r') {
          this.lines.push(`  ⎿  You chose: ${menu.options[menu.selected]}`);
          this.menu = undefined;
          break;
        } else {
          this.lines.push('  ⎿  Cancelled');
          this.menu = undefined;
          break;
        }
      }
      this.render();
      return;
    }
    if (data === ' ') {
      this.recording = !this.recording;
      if (!this.recording) this.typed += 'refactor the auth middleware ';
    } else if (data.includes('/exit')) {
      setTimeout(() => this.exitListener?.({ exitCode: 0 }), 50);
      return;
    } else if (data === '\r') {
      const typed = this.typed.trim();
      const model = /^\/model (\S+)$/.exec(typed)?.[1];
      if (model) {
        this.lines.push(`> ${typed}`, `  ⎿  Set model to ${model} and saved as your default`);
      } else if (/deploy/i.test(typed)) {
        this.lines.push(`> ${typed}`);
        this.menu = {
          options: ['Yes', "Yes, and don't ask again for npm run deploy commands", 'No'],
          selected: 0,
        };
      } else if (typed) {
        this.lines.push(`> ${typed}`, '  (demo: nothing happens)');
      }
      this.typed = '';
    } else if (data === '\x1b' || data === '\x03') {
      this.typed = '';
    } else {
      // Bracketed-paste markers and cursor keys are not text.
      // eslint-disable-next-line no-control-regex
      this.typed += data.replace(/\x1b\[200~|\x1b\[201~|\x1b\[[A-Z]/g, '');
    }
    this.render();
  }
  resize(): void {}
  kill(): void {
    this.exitListener?.({ exitCode: 137 });
  }
  private render(): void {
    const footer = this.recording ? '● REC · tap to send' : 'hold space to speak';
    const body = this.lines.slice(-12).join('\r\n');
    if (this.menu) {
      const { options, selected } = this.menu;
      const menu = [
        '─'.repeat(60),
        ' Bash command',
        ' Deploy the app to production',
        '╌'.repeat(60),
        ' npm run deploy -- --prod',
        '╌'.repeat(60),
        ' Do you want to proceed?',
        ...options.map((o, i) => `${i === selected ? ' ❯ ' : '   '}${i + 1}. ${o}`),
        '',
        ' Esc to cancel · Tab to amend',
      ];
      this.dataListener?.(
        `\x1b[2J\x1b[H\x1b[1m Claude Code\x1b[0m  demo\r\n\r\n${body}\r\n\r\n${menu.join('\r\n')}\r\n`,
      );
      return;
    }
    this.dataListener?.(
      `\x1b[2J\x1b[H\x1b[1m Claude Code\x1b[0m  demo\r\n\r\n${body}\r\n\r\n╭──────────────────────────────╮\r\n│ > ${this.typed}\r\n╰──────────────────────────────╯\r\n  ${footer}\r\n`,
    );
  }
}

const attachments = new AttachmentStore(path.join(home, 'attachments'), logger);
await attachments.start();
const sessions = new SessionManager(
  config,
  logger,
  demoQuery,
  {
    claudeDir: path.join(home, 'claude'),
    claudePath: 'demo-claude',
    spawn: () => new DemoPty(),
  },
  attachments.dir,
);

// A pretend Claude session in a terminal, in a folder that is not allow-listed. It
// alternates between working and idle so the PC list and "done" toasts can be seen.
const claudeDir = path.join(home, 'claude');
const terminalCwd = path.join(home, 'api-server');
const transcriptDir = path.join(claudeDir, 'projects', encodeProjectDir(terminalCwd));
await mkdir(path.join(claudeDir, 'sessions'), { recursive: true });
await mkdir(terminalCwd, { recursive: true });
await mkdir(transcriptDir, { recursive: true });
const transcript = path.join(transcriptDir, 'terminal-1.jsonl');
const line = (entry: unknown) =>
  appendFile(
    transcript,
    `${JSON.stringify(entry)}
`,
  );
const setStatus = (status: string) =>
  writeFile(
    path.join(claudeDir, 'sessions', `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: 'terminal-1',
      cwd: terminalCwd,
      name: 'api-server',
      status,
      startedAt: Date.now(),
    }),
  );
await line({ type: 'user', message: { content: 'Add rate limiting to the login route' } });
await line({ type: 'last-prompt', lastPrompt: 'Add rate limiting to the login route' });
await line({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: "I'll add a token bucket in front of `/login`." },
      { type: 'tool_use', id: 'x1', name: 'Edit', input: { file_path: 'src/routes/login.ts' } },
    ],
  },
});
await setStatus('busy');
let busy = true;
setInterval(
  () => {
    busy = !busy;
    void setStatus(busy ? 'busy' : 'idle');
    if (!busy)
      void line({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Done: login is limited to 10 attempts a minute.' }],
        },
      });
  },
  Number(process.env.DEMO_PC_TOGGLE_MS ?? 15_000),
).unref();

const pcSessions = new PcSessionWatcher({
  logger,
  claudeDir,
  isOwnSession: (id) => sessions.owns(id),
  projectFor: (cwd) => sessions.projectForFolder(cwd)?.id,
  intervalMs: 1_000,
});
pcSessions.start();
// Disposable files for Settings → Storage: an old Claude Code download and a rotated log.
const cache = path.join(home, 'cache');
await mkdir(path.join(cache, 'claude-code', '1.0.0'), { recursive: true });
await writeFile(
  path.join(cache, 'claude-code', '1.0.0', 'claude'),
  Buffer.alloc(240 * 1024 * 1024),
);
await writeFile(`${paths.log}.1`, Buffer.alloc(9 * 1024 * 1024));
const cleanup = { auto: true, maxCacheMb: 250 };
const janitor = new StorageJanitor({
  locations: { home, cache, log: paths.log, claudeVersionInUse: '2.0.0' },
  settings: () => cleanup,
  logger,
});

const gateway = new WsGateway({
  attachments,
  storage: {
    info: () => janitor.info(),
    cleanNow: () => janitor.cleanNow(),
    configure: async (settings) => void Object.assign(cleanup, settings),
  },
  router,
  mic,
  sessions,
  registry,
  logger,
  pcSessions,
  allowFolder: async (dir) => {
    const project = await addProject(config, dir);
    gateway.broadcastProjects(config.projects);
    return project;
  },
  folders: {
    roots: () => config.roots,
    list: (dir) => listRootFolder(config, dir),
    open: async (dir) => {
      const project = await addProject(config, await resolveRootFolder(dir, config.roots));
      gateway.broadcastProjects(config.projects);
      return project;
    },
  },
});
const app = await buildServer({
  tls,
  logger,
  registry,
  pairing,
  gateway,
  attachments,
  webRoot: path.join(packageRoot(), 'dist', 'web'),
});
app.get('/demo/pair-code', async () => ({ code: pairing.issueCode().code }));
await app.listen({ host: '127.0.0.1', port });
const code = pairing.issueCode();
console.log(`UI demo on https://127.0.0.1:${port}  pairing code ${code.display}`);

const shutdown = async () => {
  await pcSessions.stop();
  attachments.stop();
  sessions.closeAll();
  await app.close();
  await registry.close();
  await rm(home, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
