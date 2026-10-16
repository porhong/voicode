import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forwardPermissionRequest, forwardPreToolUse } from '../cli/commands/hook.js';
import { silentLogger } from '../util/logger.js';
import { HookServer, type HookHandler, type PreToolUseEvent } from './hook-server.js';

let server: HookServer;
const seen: PreToolUseEvent[] = [];

const decide: HookHandler = async (event) => {
  seen.push(event);
  if (event.tool_name === 'Read') return undefined;
  if (event.tool_name === 'Bash') return { decision: 'allow' };
  if (event.tool_name === 'Edit') return { decision: 'deny', reason: 'use a branch' };
  return { decision: 'deny', reason: 'nope', interrupt: true };
};

beforeAll(async () => {
  server = new HookServer({ preToolUse: decide, permissionRequest: decide }, silentLogger());
  await server.start();
});

afterAll(() => server.stop());

const event = (tool_name: string, hook_event_name = 'PreToolUse') =>
  JSON.stringify({
    session_id: 's-1',
    tool_name,
    tool_input: { command: 'npm test' },
    tool_use_id: 't1',
    hook_event_name,
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

  it('answers PermissionRequest hooks (Claude Desktop) in their own format', async () => {
    const ask = (tool: string) =>
      forwardPermissionRequest(server.url, server.token, event(tool, 'PermissionRequest'));
    expect(await ask('Bash')).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    // Feedback lets Claude adjust; a bare rejection stops it.
    expect(await ask('Edit')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'use a branch' },
      },
    });
    expect(await ask('Write')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'nope', interrupt: true },
      },
    });
    expect(await ask('Read')).toBeUndefined();
  });

  it('prints nothing when the agent has no opinion, or the request is not authorised', async () => {
    expect(await forwardPreToolUse(server.url, server.token, event('Read'))).toBeUndefined();
    expect(await forwardPreToolUse(server.url, 'wrong-token', event('Bash'))).toBeUndefined();
    expect(await forwardPreToolUse(server.url, server.token, '{"nope":1}')).toBeUndefined();
    expect(
      await forwardPermissionRequest(server.url, 'wrong-token', event('Bash', 'PermissionRequest')),
    ).toBeUndefined();
  });

  it('only listens on the loopback address', () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
