import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forwardPreToolUse } from '../cli/commands/hook.js';
import { silentLogger } from '../util/logger.js';
import { HookServer, type PreToolUseEvent } from './hook-server.js';

let server: HookServer;
const seen: PreToolUseEvent[] = [];

beforeAll(async () => {
  server = new HookServer(async (event) => {
    seen.push(event);
    if (event.tool_name === 'Read') return undefined;
    if (event.tool_name === 'Bash') return { decision: 'allow' };
    return { decision: 'deny', reason: 'nope' };
  }, silentLogger());
  await server.start();
});

afterAll(() => server.stop());

const event = (tool_name: string) =>
  JSON.stringify({
    session_id: 's-1',
    tool_name,
    tool_input: { command: 'npm test' },
    tool_use_id: 't1',
    hook_event_name: 'PreToolUse',
  });

describe('hook server + hook subcommand', () => {
  it('turns phone decisions into Claude Code hook output', async () => {
    expect(await forwardPreToolUse(server.url, server.token, event('Bash'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
    expect(await forwardPreToolUse(server.url, server.token, event('Write'))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'nope',
      },
    });
    expect(seen.at(-1)).toMatchObject({ session_id: 's-1', tool_name: 'Write' });
  });

  it('prints nothing when the agent has no opinion, or the request is not authorised', async () => {
    expect(await forwardPreToolUse(server.url, server.token, event('Read'))).toBeUndefined();
    expect(await forwardPreToolUse(server.url, 'wrong-token', event('Bash'))).toBeUndefined();
    expect(await forwardPreToolUse(server.url, server.token, '{"nope":1}')).toBeUndefined();
  });

  it('only listens on the loopback address', () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
