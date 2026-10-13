import http from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { generateSecret, safeEqual } from '@voicecode/security';
import type { AgentPaths } from '../config/paths.js';
import { fileExists, writeFileAtomic } from '../util/fs.js';
import type { Logger } from '../util/logger.js';

const HEADER = 'x-voicecode-control';

export type ControlHandler = (body: unknown) => Promise<unknown> | unknown;
export type ControlRoutes = Record<string, ControlHandler>;

/**
 * The control token gates the local IPC endpoint in addition to OS permissions on the
 * pipe/socket, so other local users cannot drive the agent.
 */
export async function ensureControlToken(paths: AgentPaths): Promise<string> {
  if (await fileExists(paths.controlToken))
    return (await readFile(paths.controlToken, 'utf8')).trim();
  const token = generateSecret();
  await writeFileAtomic(paths.controlToken, token);
  return token;
}

/** Local HTTP-over-IPC server for CLI commands that talk to a running agent. */
export async function startControlServer(
  paths: AgentPaths,
  routes: ControlRoutes,
  logger: Logger,
): Promise<http.Server> {
  const token = await ensureControlToken(paths);
  if (process.platform !== 'win32') await rm(paths.ipcEndpoint, { force: true });

  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const presented = req.headers[HEADER];
    if (typeof presented !== 'string' || !safeEqual(presented, token))
      return reply(401, { error: 'unauthorized' });

    const handler = routes[`${req.method} ${req.url}`];
    if (!handler) return reply(404, { error: 'not_found' });
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      reply(200, (await handler(raw ? JSON.parse(raw) : undefined)) ?? { ok: true });
    } catch (err) {
      logger.warn({ err }, 'control request failed');
      reply(400, { error: (err as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Unix sockets are created with the process umask; keep them owner-only.
    const previous = process.platform === 'win32' ? undefined : process.umask(0o177);
    server.listen(paths.ipcEndpoint, () => {
      if (previous !== undefined) process.umask(previous);
      resolve();
    });
  });
  return server;
}

export class AgentNotRunningError extends Error {
  constructor() {
    super('The agent is not running. Start it with `voicecode-agent start`.');
  }
}

/** Calls a route on the running agent. Throws AgentNotRunningError if none is listening. */
export async function controlRequest<T>(
  paths: AgentPaths,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
): Promise<T> {
  if (!(await fileExists(paths.controlToken))) throw new AgentNotRunningError();
  const token = (await readFile(paths.controlToken, 'utf8')).trim();
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: paths.ipcEndpoint,
        path: route,
        method,
        headers: { [HEADER]: token, 'content-type': 'application/json' },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const data = text
            ? (JSON.parse(text) as T & { error?: string })
            : ({} as T & { error?: string });
          if ((res.statusCode ?? 500) >= 400)
            reject(new Error(data.error ?? `HTTP ${res.statusCode}`));
          else resolve(data);
        });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') reject(new AgentNotRunningError());
      else reject(err);
    });
    req.on('timeout', () => req.destroy(new Error('control request timed out')));
    req.end(payload);
  });
}

export async function isAgentRunning(paths: AgentPaths): Promise<boolean> {
  try {
    await controlRequest(paths, 'GET', '/status');
    return true;
  } catch {
    return false;
  }
}
