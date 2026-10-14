import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  DEVICE_COOKIE,
  LIMITS,
  PROTOCOL_VERSION,
  PairRequestSchema,
  WS_PATH,
  type AgentInfoResponse,
  type PairResponse,
} from '@voicecode/protocol';
import type { DeviceRegistry, PublicDevice } from '../pairing/device-registry.js';
import type { PairingService } from '../pairing/pairing-service.js';
import type { TlsMaterial } from '../tls/certificates.js';
import type { Logger } from '../util/logger.js';
import { VERSION } from '../util/version.js';
import {
  clearDeviceCookie,
  clientAddress,
  createOriginGuard,
  readCookie,
  setDeviceCookie,
} from './http-security.js';
import type { WsGateway } from './ws-gateway.js';

declare module 'fastify' {
  interface FastifyRequest {
    device: PublicDevice | null;
  }
}

export interface ServerDeps {
  tls: TlsMaterial;
  logger: Logger;
  registry: DeviceRegistry;
  pairing: PairingService;
  gateway: WsGateway;
  /** Directory with the built web client; omitted in API-only setups. */
  webRoot?: string;
  /** Extra origins allowed to connect (e.g. the Vite dev server). */
  extraOrigins?: string[];
  /** Public host names of the Cloudflare Tunnel, if any (kept up to date by the agent). */
  tunnelHosts?: ReadonlySet<string>;
}

export async function buildServer(deps: ServerDeps) {
  const { tls, registry, pairing, gateway } = deps;
  const guard = createOriginGuard(tls.names, deps.extraOrigins ?? [], deps.tunnelHosts);
  const behindTunnel = deps.tunnelHosts !== undefined;
  const clientIp = (request: FastifyRequest) => clientAddress(request, behindTunnel);

  const app = Fastify({
    loggerInstance: deps.logger,
    https: { key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' },
    bodyLimit: 16 * 1024,
    trustProxy: false,
    forceCloseConnections: true,
    // Per-request access logs would fill agent.log with asset fetches; errors are
    // still logged, and security-relevant events are logged explicitly.
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.decorateRequest('device', null);

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        // xterm.js (the terminal view) injects its theme as a <style> element.
        styleSrcElem: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('permissions-policy', 'microphone=(self), camera=(), geolocation=()');
  });

  await app.register(fastifyRateLimit, {
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: clientIp,
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: LIMITS.maxFrameBytes } });

  // Reject requests addressed to a host name that is not in our certificate.
  app.addHook('onRequest', async (request, reply) => {
    if (!guard.hostAllowed(request)) return reply.code(421).send({ error: 'misdirected_request' });
    request.device = registry.authenticate(readCookie(request, DEVICE_COOKIE)) ?? null;
  });

  app.get('/api/info', async (request): Promise<AgentInfoResponse> => ({
    name: 'voicecode-agent',
    version: VERSION,
    hostname: request.device || !guard.viaTunnel(request) ? os.hostname() : undefined,
    protocolVersion: PROTOCOL_VERSION,
    paired: request.device !== null,
    device: request.device ? { id: request.device.id, name: request.device.name } : undefined,
  }));

  app.post(
    '/api/pair',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!guard.originAllowed(request)) return reply.code(403).send({ error: 'bad_origin' });
      const body = PairRequestSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_request' });

      const outcome = await pairing.pair(body.data.code, body.data.deviceName, {
        userAgent: request.headers['user-agent'],
        remoteAddress: clientIp(request),
      });
      if (!outcome.ok) {
        const status = outcome.reason === 'malformed' ? 400 : 401;
        return reply.code(status).send({ error: 'pairing_failed', reason: outcome.reason });
      }
      setDeviceCookie(reply, outcome.credential);
      const response: PairResponse = {
        deviceId: outcome.device.id,
        deviceName: outcome.device.name,
      };
      return response;
    },
  );

  app.post('/api/unpair', async (request, reply) => {
    if (!guard.originAllowed(request)) return reply.code(403).send({ error: 'bad_origin' });
    if (!request.device) return reply.code(401).send({ error: 'unauthorized' });
    await registry.revoke(request.device.id);
    clearDeviceCookie(reply);
    return { ok: true };
  });

  // The CA certificate is public; phones download it once to trust the agent.
  app.get('/voicecode-ca.crt', async (_request, reply) => {
    return reply
      .type('application/x-x509-ca-cert')
      .header('content-disposition', 'attachment; filename="voicecode-ca.crt"')
      .send(tls.caCert);
  });

  app.get(
    WS_PATH,
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!guard.originAllowed(request)) return reply.code(403).send({ error: 'bad_origin' });
        if (!request.device) return reply.code(401).send({ error: 'unauthorized' });
      },
    },
    (socket, request) => gateway.handle(socket, request.device!),
  );

  if (deps.webRoot && existsSync(path.join(deps.webRoot, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: deps.webRoot,
      wildcard: false,
      setHeaders(reply, filePath) {
        // Vite emits content-hashed assets; everything else must revalidate.
        const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
        reply.header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((request, reply) => {
      // Only page navigations fall back to the app shell; a missing asset or API route
      // must 404 rather than return HTML a browser would try to run as a script.
      const pathname = request.url.split('?')[0]!;
      const isNavigation = !pathname.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(pathname);
      if (request.method === 'GET' && isNavigation) {
        return reply.header('cache-control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return app;
}
