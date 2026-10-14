import type { Command } from 'commander';

/**
 * `voicecode-agent hook pre-tool-use`: the command the agent registers as a Claude Code
 * PreToolUse hook for the interactive sessions it hosts. Claude Code pipes the tool call
 * in as JSON; this forwards it to the agent (loopback URL and token from the
 * environment the agent gave that Claude Code process) and prints the phone's decision
 * in the hook output format. Anything going wrong prints nothing and exits 0, which
 * leaves the decision to Claude Code's own permission prompt: a failure never allows.
 */
export function registerHook(program: Command): void {
  const hook = program.command('hook', { hidden: true }).description('Internal: Claude Code hooks');
  hook.command('pre-tool-use').action(async () => {
    const url = process.env.VOICECODE_HOOK_URL;
    const token = process.env.VOICECODE_HOOK_TOKEN;
    if (!url || !token) return;
    const output = await forwardPreToolUse(url, token, await readStdin()).catch(() => undefined);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  });
}

export async function forwardPreToolUse(
  url: string,
  token: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(`${url}/pre-tool-use`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
  });
  if (res.status !== 200) return undefined;
  const decision = (await res.json()) as { decision?: string; reason?: string };
  if (decision.decision !== 'allow' && decision.decision !== 'deny') return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.decision,
      ...(decision.reason ? { permissionDecisionReason: decision.reason } : {}),
    },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
