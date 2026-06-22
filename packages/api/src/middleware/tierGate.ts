// packages/api/src/middleware/tierGate.ts
import type { FastifyRequest, FastifyReply } from 'fastify';
import { hasFeature } from '../services/keyService.js';

/**
 * Factory: returns a Fastify preHandler that enforces a feature flag.
 * Usage: { preHandler: [authenticate, requireFeatureHook('solana-mint')] }
 */
export function requireFeatureHook(feature: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!hasFeature(request.userFeatures ?? [], feature)) {
      return reply.code(403).send({
        error: `Feature '${feature}' is not available on your current plan.`,
        code: 'FEATURE_GATED',
        upgrade: 'https://apexmint.pro/upgrade',
      });
    }
  };
}

// packages/api/src/middleware/auditLog.ts
import { prisma } from '../plugins/db.js';

export async function writeAuditLog(opts: {
  userId?: string;
  accessKeyId?: string;
  action: string;
  resource?: string;
  resourceId?: string;
  ipAddress?: string;
  userAgent?: string;
  success?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  // Fire and forget — never block the request path
  prisma.auditLog.create({
    data: {
      userId: opts.userId ?? null,
      accessKeyId: opts.accessKeyId ?? null,
      action: opts.action,
      resource: opts.resource ?? null,
      resourceId: opts.resourceId ?? null,
      ipAddress: opts.ipAddress ?? null,
      userAgent: opts.userAgent?.slice(0, 512) ?? null,
      success: opts.success ?? true,
      metadata: (opts.metadata as object) ?? undefined,
    },
  }).catch((err: Error) => {
    console.error('[AuditLog] Write failed:', err.message);
  });
}

export function auditHook(action: string, resource?: string) {
  return async (request: FastifyRequest): Promise<void> => {
    writeAuditLog({
      userId: request.userId,
      action,
      resource,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });
  };
}
