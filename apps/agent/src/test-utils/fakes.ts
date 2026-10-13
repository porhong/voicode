import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import type { MouseButton } from '@voicecode/protocol';
import type { DriverInfo, MouseDriver } from '../mouse/driver.js';

/** Records every call so tests can assert on what reached the OS layer. */
export class FakeMouseDriver implements MouseDriver {
  readonly name = 'fake';
  readonly calls: string[] = [];
  private exitListener: ((e: Error) => void) | undefined;

  async start(): Promise<DriverInfo> {
    return { details: { session: '1' } };
  }
  move(dx: number, dy: number): void {
    this.calls.push(`move ${dx} ${dy}`);
  }
  button(button: MouseButton, down: boolean): void {
    this.calls.push(`${down ? 'down' : 'up'} ${button}`);
  }
  scroll(dx: number, dy: number): void {
    this.calls.push(`scroll ${dx} ${dy}`);
  }
  async position(): Promise<{ x: number; y: number }> {
    return { x: 10, y: 20 };
  }
  async stop(): Promise<void> {
    this.calls.push('stop');
  }
  onExit(listener: (error: Error) => void): void {
    this.exitListener = listener;
  }
  crash(): void {
    this.exitListener?.(new Error('crashed'));
  }
}

export interface FakeQueryControl {
  options?: Options;
  permissionModeSets: string[];
  interrupted: number;
  closed: boolean;
}

/**
 * Minimal stand-in for the Agent SDK `query()`: for every prompt it asks permission
 * to run `npm test` via `canUseTool`, then reports the outcome as an assistant
 * message and a result.
 */
export function createFakeQuery(init: { permissionMode?: string } = {}): {
  queryFn: typeof query;
  control: FakeQueryControl;
} {
  const control: FakeQueryControl = { permissionModeSets: [], interrupted: 0, closed: false };

  const queryFn = ((params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
  }) => {
    control.options = params.options;
    const options = params.options!;

    async function* run(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'claude-session-1',
        model: 'claude-opus-5-5',
        permissionMode: init.permissionMode ?? 'default',
        cwd: options.cwd,
      } as unknown as SDKMessage;

      for await (const message of params.prompt as AsyncIterable<SDKUserMessage>) {
        const text = String(message.message.content);
        const decision = await options.canUseTool!(
          'Bash',
          { command: 'npm test', description: text },
          {
            signal: new AbortController().signal,
            toolUseID: 'tool-1',
            requestId: 'req-1',
            suggestions: [
              {
                type: 'addRules',
                rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
                behavior: 'allow',
                destination: 'localSettings',
              },
              { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
            ],
          },
        );
        if (decision?.behavior === 'deny' && decision.interrupt) {
          // What the real SDK emits when a denial interrupts the turn.
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            duration_ms: 900,
            total_cost_usd: 0.03,
            num_turns: 1,
            errors: [
              '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use',
            ],
          } as unknown as SDKMessage;
          continue;
        }
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: 'text',
                text: decision?.behavior === 'allow' ? 'Tests passed' : 'Not running tests',
              },
            ],
          },
        } as unknown as SDKMessage;
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 1200,
          total_cost_usd: 0.02,
          num_turns: 1,
        } as unknown as SDKMessage;
      }
    }

    const generator = run();
    return Object.assign(generator, {
      interrupt: async () => {
        control.interrupted++;
        return undefined;
      },
      setPermissionMode: async (mode: string) => {
        control.permissionModeSets.push(mode);
      },
      close: () => {
        control.closed = true;
      },
    }) as unknown as Query;
  }) as unknown as typeof query;

  return { queryFn, control };
}
