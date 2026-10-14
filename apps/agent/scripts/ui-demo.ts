// Serves the built web client against a fake Claude and a fake mouse, for UI work and
// screenshots without spending money or moving the real cursor:
//
//   npm run build && npx tsx apps/agent/scripts/ui-demo.ts [port]
//
// Every prompt gets a short Markdown reply after one Bash approval. A pairing code is
// printed at start, and GET /demo/pair-code (from this machine) issues a fresh one for
// scripted runs. State lives in a temporary directory that is removed on exit.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import { ConfigSchema } from '../src/config/config.js';
import { resolvePaths } from '../src/config/paths.js';
import { InputRouter } from '../src/mouse/input-router.js';
import { DeviceRegistry } from '../src/pairing/device-registry.js';
import { PairingService } from '../src/pairing/pairing-service.js';
import { buildServer } from '../src/server/app.js';
import { WsGateway } from '../src/server/ws-gateway.js';
import { SessionManager } from '../src/sessions/session-manager.js';
import { FakeMouseDriver } from '../src/test-utils/fakes.js';
import { ensureTls } from '../src/tls/certificates.js';
import { silentLogger } from '../src/util/logger.js';
import { packageRoot } from '../src/util/version.js';

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
      const text = String(message.message.content);
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'text', text: `I'll take care of that: “${text.slice(0, 60)}”.` },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'package.json' } },
          ],
        },
      } as unknown as SDKMessage;
      await sleep(400);
      const decision = await options.canUseTool!(
        'Bash',
        { command: 'npm test -- --run', description: 'Run the test suite' },
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
const config = ConfigSchema.parse({
  version: 1,
  projects: [
    { id: 'demo1', name: 'my-app', path: home },
    { id: 'demo2', name: 'website', path: home },
  ],
});
const sessions = new SessionManager(config, logger, demoQuery);
const gateway = new WsGateway({ router, sessions, registry, logger });
const app = await buildServer({
  tls,
  logger,
  registry,
  pairing,
  gateway,
  webRoot: path.join(packageRoot(), 'dist', 'web'),
});
app.get('/demo/pair-code', async () => ({ code: pairing.issueCode().code }));
await app.listen({ host: '127.0.0.1', port });
const code = pairing.issueCode();
console.log(`UI demo on https://127.0.0.1:${port}  pairing code ${code.display}`);

const shutdown = async () => {
  sessions.closeAll();
  await app.close();
  await registry.close();
  await rm(home, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
