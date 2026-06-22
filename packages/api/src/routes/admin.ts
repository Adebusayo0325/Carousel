// packages/api/src/routes/admin.ts
import type { FastifyInstance } from 'fastify';
import { authenticateAdmin } from '../middleware/authenticate.js';
import {
  generateAccessKey, listKeys, revokeKey, getKeyStats,
} from '../services/keyService.js';
import { prisma } from '../plugins/db.js';
import { getRpcScoreboard } from '@apex/core/rpc/rpcManager';
import { Tier } from '@apex/core/types';

export async function adminRoutes(app: FastifyInstance) {
  const admin = { preHandler: [authenticateAdmin] };

  // ── GET /admin/stats ────────────────────────────────────────────────────
  app.get('/admin/stats', admin, async (_req, reply) => {
    const [keyStats, userCount, mintCount, scheduleCount] = await Promise.all([
      getKeyStats(),
      prisma.user.count(),
      prisma.mintRecord.count(),
      prisma.schedule.count(),
    ]);

    const recentMints = await prisma.mintRecord.groupBy({
      by: ['status'],
      _count: true,
      where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    });

    return reply.send({
      keys: keyStats,
      users: { total: userCount },
      mints: { total: mintCount, last24h: recentMints },
      schedules: { total: scheduleCount },
      rpcHealth: getRpcScoreboard(),
    });
  });

  // ── POST /admin/keys/generate ───────────────────────────────────────────
  app.post<{
    Body: {
      tier: Tier;
      durationDays?: number;
      features?: string[];
      label?: string;
    };
  }>(
    '/admin/keys/generate', admin,
    async (req, reply) => {
      const { tier, durationDays = 30, features, label } = req.body;

      if (!Object.values(Tier).includes(tier)) {
        return reply.code(400).send({ error: `Invalid tier. Must be one of: ${Object.values(Tier).join(', ')}` });
      }

      const result = await generateAccessKey({
        tier,
        durationDays,
        features,
        label,
        adminId: 'admin',
      });

      // ⚠️  Raw key shown ONCE — never stored in DB
      return reply.code(201).send({
        keyId: result.keyId,
        rawKey: result.rawKey,
        tier: result.tier,
        features: result.features,
        durationDays: result.durationDays,
        label: result.label,
        warning: 'Store this key securely. It will NOT be shown again.',
      });
    },
  );

  // ── GET /admin/keys ─────────────────────────────────────────────────────
  app.get<{ Querystring: { tier?: Tier; status?: string; limit?: number } }>(
    '/admin/keys', admin,
    async (req, reply) => {
      const keys = await listKeys({
        tier: req.query.tier,
        status: req.query.status,
        limit: req.query.limit,
      });
      return reply.send({ keys });
    },
  );

  // ── DELETE /admin/keys/:id ──────────────────────────────────────────────
  app.delete<{ Params: { id: string }; Body: { reason?: string } }>(
    '/admin/keys/:id', admin,
    async (req, reply) => {
      await revokeKey(req.params.id, 'admin', req.body?.reason);
      return reply.send({ success: true, message: `Key ${req.params.id} revoked and user session invalidated.` });
    },
  );

  // ── GET /admin/users ────────────────────────────────────────────────────
  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    '/admin/users', admin,
    async (req, reply) => {
      const { limit = 50, offset = 0 } = req.query;
      const [users, total] = await Promise.all([
        prisma.user.findMany({
          take: Math.min(limit, 200),
          skip: offset,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, label: true, tier: true,
            lastLoginAt: true, lastLoginIp: true, createdAt: true,
            accessKey: { select: { status: true, expiresAt: true, tier: true } },
            _count: { select: { wallets: true, schedules: true, mintHistory: true } },
          },
        }),
        prisma.user.count(),
      ]);
      return reply.send({ users, total });
    },
  );

  // ── GET /admin/users/:id ────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/admin/users/:id', admin,
    async (req, reply) => {
      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        include: {
          accessKey: { select: { id: true, tier: true, status: true, expiresAt: true, features: true } },
          wallets: { select: { id: true, address: true, chain: true, label: true, isActive: true, createdAt: true } },
          _count: { select: { schedules: true, mintHistory: true } },
        },
      });
      if (!user) return reply.code(404).send({ error: 'User not found' });
      return reply.send(user);
    },
  );

  // ── GET /admin/audit-logs ───────────────────────────────────────────────
  app.get<{ Querystring: { userId?: string; action?: string; limit?: number } }>(
    '/admin/audit-logs', admin,
    async (req, reply) => {
      const logs = await prisma.auditLog.findMany({
        where: {
          ...(req.query.userId ? { userId: req.query.userId } : {}),
          ...(req.query.action ? { action: { contains: req.query.action } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(req.query.limit ?? 100, 500),
      });
      return reply.send({ logs });
    },
  );

  // ── GET /admin/rpc-health ───────────────────────────────────────────────
  app.get('/admin/rpc-health', admin, async (_req, reply) => {
    return reply.send(getRpcScoreboard());
  });
}
