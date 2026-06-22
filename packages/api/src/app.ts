// packages/api/src/app.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';

import { connectDB, disconnectDB } from './plugins/db.js';
import { getRedis, disconnectRedis } from './plugins/redis.js';
import { startHealthMonitor } from '@apex/core/rpc/rpcManager';

import { authRoutes } from './routes/auth.js';
import { walletRoutes } from './routes/wallets.js';
import { mintRoutes } from './routes/mint.js';
import { scheduleRoutes } from './routes/schedule.js';
import { portfolioRoutes } from './routes/portfolio.js';
import { adminRoutes } from './routes/admin.js';

// ─────────────────────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────────────────────

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(process.env.NODE_ENV === 'development' ? {
        transport: { target: 'pino-pretty', options: { colorize: true } },
      } : {}),
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            // Never log auth headers
            headers: { 'user-agent': request.headers['user-agent'] },
          };
        },
      },
    },
    trustProxy: true,
    maxParamLength: 200,
  });

  // ── Security headers ─────────────────────────────────────────────────────
  await app.register(helmet, {
    contentSecurityPolicy: false, // handled by reverse proxy
    crossOriginEmbedderPolicy: false,
  });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:5173'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie, {
    secret: process.env.SESSION_SECRET ?? 'change-me-in-production',
  });

  await app.register(rateLimit, {
    max: Number(process.env.API_RATE_LIMIT_MAX ?? 100),
    timeWindow: Number(process.env.API_RATE_LIMIT_WINDOW_MS ?? 60_000),
    redis: getRedis(),
    keyGenerator: (req) => {
      // Rate limit by user ID if authenticated, else by IP
      return (req as { userId?: string }).userId ?? req.ip;
    },
    errorResponseBuilder: (_, context) => ({
      error: 'Too many requests',
      resetAt: new Date(Date.now() + context.after).toISOString(),
    }),
  });

  // ── Input sanitization ───────────────────────────────────────────────────
  app.addHook('preValidation', async (request) => {
    // Block requests with suspiciously large bodies
    const len = parseInt(request.headers['content-length'] ?? '0');
    if (len > 1_048_576) { // 1 MB max
      throw { statusCode: 413, message: 'Request body too large' };
    }
  });

  // ── Global error handler ─────────────────────────────────────────────────
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? error.statusCode ?? 500;
    const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR';

    if (statusCode >= 500) {
      app.log.error({ err: error, code }, 'Unhandled error');
    }

    // Never leak internal error details in production
    const message = statusCode >= 500 && process.env.NODE_ENV === 'production'
      ? 'An internal error occurred'
      : error.message;

    return reply.code(statusCode).send({ error: message, code });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'Route not found' });
  });

  // ── Health check (no auth) ───────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    version: process.env.npm_package_version ?? '1.0.0',
    timestamp: new Date().toISOString(),
  }));

  // ── Routes ───────────────────────────────────────────────────────────────
  await app.register(authRoutes,      { prefix: '/api/v1' });
  await app.register(walletRoutes,    { prefix: '/api/v1' });
  await app.register(mintRoutes,      { prefix: '/api/v1' });
  await app.register(scheduleRoutes,  { prefix: '/api/v1' });
  await app.register(portfolioRoutes, { prefix: '/api/v1' });
  await app.register(adminRoutes,     { prefix: '/api/v1' });

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

export async function start() {
  await connectDB();

  const app = await buildApp();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  // Start RPC health monitor
  const healthMonitor = startHealthMonitor();

  await app.listen({ port, host });
  app.log.info(`🚀 ApexMint Pro API running on ${host}:${port}`);

  // ── Graceful shutdown ────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — shutting down gracefully`);
    clearInterval(healthMonitor);
    await app.close();
    await disconnectDB();
    await disconnectRedis();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'Uncaught exception');
    shutdown('uncaughtException').catch(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'Unhandled rejection');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
