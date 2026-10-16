import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { Logger } from '../util/logger.js';

/** What Claude Code pipes into a PreToolUse hook (only the fields used here). */
export interface PreToolUseEvent {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  cwd?: string;
  /** Claude Code's permission mode at the time of the call. */
  permission_mode?: string;
}

export interface HookDecision {
  decision: 'allow' | 'deny';
  reason?: string;
  /** PermissionRequest only: a denial stops Claude instead of letting it adjust. */
  interrupt?: boolean;
}

/** Answers a hook; `undefined` leaves the decision to Claude Code's normal permission flow. */
export type HookHandler = (event: PreToolUseEvent) => Promise<HookDecision | undefined>;

/**
 * The hooks the server answers: PreToolUse (sessions the agent hosts) and
 * PermissionRequest (Claude Desktop sessions taken over from the phone).
 */
export interface HookHandlers {
  preToolUse: HookHandler;
  permissionRequest: HookHandler;
}

const MAX_BODY = 1024 * 1024;

/**
 * Loopback HTTP endpoint that the `voicecode-agent hook` subcommand calls from inside a
 * Claude Code PreToolUse hook, so tool calls of an interactive Claude Code session can be
 * approved on the phone. It listens on 127.0.0.1 only and requires a bearer token that
 * exists for this agent run alone (handed to the Claude Code process in its environment).
 * A request may stay open as long as an approval may take.
 */
export class HookServer {
  private server: http.Server | undefined;
  readonly token = randomBytes(24).toString('hex');
  private port = 0;

  constructor(
    private readonly handlers: HookHandlers,
    private readonly logger: Logger,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    // Approvals can take minutes; never cut a waiting hook off.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.port = (server.address() as { port: number }).port;
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.authorized(req)) return end(res, 401, { error: 'unauthorized' });
    const handler =
      req.url === '/pre-tool-use'
        ? this.handlers.preToolUse
        : req.url === '/permission-request'
          ? this.handlers.permissionRequest
          : undefined;
    if (req.method !== 'POST' || !handler) return end(res, 404, { error: 'not found' });
    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      return end(res, 413, { error: (err as Error).message });
    }
    let event: PreToolUseEvent;
    try {
      event = parseEvent(JSON.parse(body));
    } catch (err) {
      return end(res, 400, { error: (err as Error).message });
    }
    try {
      const decision = await handler(event);
      if (!decision) return end(res, 204);
      end(res, 200, decision);
    } catch (err) {
      this.logger.warn({ err, tool: event.tool_name }, 'hook decision failed');
      end(res, 500, { error: 'internal' });
    }
  }
}

function parseEvent(raw: unknown): PreToolUseEvent {
  const e = raw as Partial<PreToolUseEvent> | null;
  if (!e || typeof e !== 'object') throw new Error('not an object');
  if (typeof e.session_id !== 'string' || typeof e.tool_name !== 'string') {
    throw new Error('session_id and tool_name are required');
  }
  const input = e.tool_input;
  return {
    session_id: e.session_id,
    tool_name: e.tool_name,
    tool_input: input && typeof input === 'object' ? (input as Record<string, unknown>) : {},
    tool_use_id: typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined,
    cwd: typeof e.cwd === 'string' ? e.cwd : undefined,
    permission_mode: typeof e.permission_mode === 'string' ? e.permission_mode : undefined,
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function end(res: http.ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}
