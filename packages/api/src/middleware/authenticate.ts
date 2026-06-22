// packages/api/src/middleware/authenticate.ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import { validateSession } from '../services/keyService.js';
import { checkRateLimit } from '../plugins/redis.js';
import { Tier } from '@apex/core/types';

// ─────────────────────────────────────────────────────────────────────────────
// Extend FastifyRequest with user context
// ─────────────────────────────────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    userTier: Tier;
    userFeatures: string[];
  }
}

const RATE_LIMITS: Record<Tier, { max: number; windowSec: number }> = {
  [Tier.BASIC]:      { max: 30,  windowSec: 60 },
  [Tier.PREMIUM]:    { max: 120, windowSec: 60 },
  [Tier.ENTERPRISE]: { max: 600, windowSec: 60 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Main auth hook — attach to all protected routes
// ─────────────────────────────────────────────────────────────────────────────

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token =
    (request.headers['x-session-token'] as string) ??
    (request.cookies?.['apex_session']) ??
    extractBearerToken(request.headers.authorization);

  if (!token) {
    return reply.code(401).send({ error: 'Authentication required', code: 'NO_TOKEN' });
  }

  const session = await validateSession(token);
  if (!session.valid || !session.userId) {
    return reply.code(401).send({ error: 'Session expired or invalid', code: 'INVALID_SESSION' });
  }

  request.userId = session.userId;
  request.userTier = session.tier ?? Tier.BASIC;
  request.userFeatures = session.features ?? [];

  // Per-tier rate limiting
  const limits = RATE_LIMITS[request.userTier];
  const rl = await checkRateLimit(request.userId, 'api', limits.max, limits.windowSec);
  if (!rl.allowed) {
    reply.header('X-RateLimit-Remaining', '0');
    reply.header('X-RateLimit-Reset', String(rl.resetAt));
    return reply.code(429).send({ error: 'Rate limit exceeded', resetAt: rl.resetAt });
  }

  reply.header('X-RateLimit-Remaining', String(rl.remaining));
}

function extractBearerToken(header?: string): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice(7);
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin auth — separate from user sessions
// ─────────────────────────────────────────────────────────────────────────────

export async function authenticateAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = request.headers['x-admin-token'] as string;
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return reply.code(403).send({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  }
}
