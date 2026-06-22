// packages/api/src/routes/auth.ts
import type { FastifyInstance } from 'fastify';
import { prisma } from '../plugins/db.js';
import { activateKey, validateAccessKey, createSession, hasFeature } from '../services/keyService.js';
import { authenticate } from '../middleware/authenticate.js';
import { writeAuditLog } from '../middleware/tierGate.js';

export async function authRoutes(app: FastifyInstance) {
  // ── POST /auth/login ────────────────────────────────────────────────────
  // First call: activates the key (starts 30d timer). Subsequent calls: validates.
  app.post<{ Body: { accessKey: string; label?: string } }>(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['accessKey'],
          properties: {
            accessKey: { type: 'string', minLength: 10 },
            label: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (request, reply) => {
      const { accessKey, label } = request.body;
      const ip = request.ip;

      // Validate / activate
      let keyResult = await validateAccessKey(accessKey);

      if (!keyResult.valid) {
        // Try activating (first use)
        const activated = await activateKey(accessKey);
        if (!activated) {
          writeAuditLog({ action: 'AUTH_LOGIN_FAILED', ipAddress: ip, success: false, metadata: { reason: 'invalid_key' } });
          return reply.code(401).send({ error: 'Invalid or expired access key', code: 'INVALID_KEY' });
        }
        keyResult = await validateAccessKey(accessKey);
      }

      if (!keyResult.valid || !keyResult.keyId) {
        return reply.code(401).send({ error: 'Access key validation failed', code: 'INVALID_KEY' });
      }

      // Find or create user record
      let user = await prisma.user.findUnique({ where: { accessKeyId: keyResult.keyId } });
      if (!user) {
        user = await prisma.user.create({
          data: {
            accessKeyId: keyResult.keyId,
            tier: keyResult.tier!,
            label: label ?? null,
          },
        });
      }

      const sessionToken = await createSession(user.id);

      // Update login metadata
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), lastLoginIp: ip },
      });

      writeAuditLog({
        userId: user.id,
        accessKeyId: keyResult.keyId,
        action: 'AUTH_LOGIN',
        ipAddress: ip,
        userAgent: request.headers['user-agent'],
      });

      reply.setCookie('apex_session', sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 86_400,
        path: '/',
      });

      return reply.send({
        success: true,
        sessionToken,
        user: {
          id: user.id,
          label: user.label,
          tier: keyResult.tier,
          features: keyResult.features,
          expiresAt: (await prisma.accessKey.findUnique({ where: { id: keyResult.keyId }, select: { expiresAt: true } }))?.expiresAt,
        },
      });
    },
  );

  // ── POST /auth/logout ───────────────────────────────────────────────────
  app.post('/auth/logout', { preHandler: [authenticate] }, async (request, reply) => {
    await prisma.user.update({
      where: { id: request.userId },
      data: { sessionToken: null, sessionExpiresAt: null },
    });
    reply.clearCookie('apex_session');
    writeAuditLog({ userId: request.userId, action: 'AUTH_LOGOUT', ipAddress: request.ip });
    return reply.send({ success: true });
  });

  // ── GET /auth/me ────────────────────────────────────────────────────────
  app.get('/auth/me', { preHandler: [authenticate] }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.userId },
      include: { accessKey: { select: { tier: true, features: true, expiresAt: true, status: true } } },
    });
    if (!user) return reply.code(404).send({ error: 'User not found' });

    return reply.send({
      id: user.id,
      label: user.label,
      tier: user.tier,
      features: user.accessKey.features,
      keyStatus: user.accessKey.status,
      keyExpiresAt: user.accessKey.expiresAt,
      preferences: user.preferences,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    });
  });

  // ── PATCH /auth/me ──────────────────────────────────────────────────────
  app.patch<{ Body: { label?: string; preferences?: Record<string, unknown> } }>(
    '/auth/me',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { label, preferences } = request.body;
      const updated = await prisma.user.update({
        where: { id: request.userId },
        data: {
          ...(label !== undefined ? { label } : {}),
          ...(preferences !== undefined ? { preferences } : {}),
        },
        select: { id: true, label: true, preferences: true },
      });
      return reply.send(updated);
    },
  );
}
