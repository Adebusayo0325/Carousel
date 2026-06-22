// packages/api/src/routes/schedule.ts
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/authenticate.js';
import { writeAuditLog } from '../middleware/tierGate.js';
import { createSchedule, cancelSchedule, listSchedules } from '../services/scheduleService.js';
import type { MintConfig } from '@apex/core/types';

export async function scheduleRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  // ── GET /schedules ──────────────────────────────────────────────────────
  app.get<{ Querystring: { status?: string } }>(
    '/schedules', auth,
    async (req, reply) => {
      const schedules = await listSchedules(req.userId, req.query.status);
      return reply.send({ schedules });
    },
  );

  // ── POST /schedules ─────────────────────────────────────────────────────
  app.post<{
    Body: {
      contractAddress: string;
      chainId: number;
      mintConfig: MintConfig;
      walletIds: string[];
      mintTime?: string;
      waitForPhase?: boolean;
      phaseCheckIntervalMs?: number;
      phaseMaxWaitMs?: number;
    };
  }>(
    '/schedules', auth,
    async (req, reply) => {
      const { contractAddress, chainId, mintConfig, walletIds, mintTime, waitForPhase, phaseCheckIntervalMs, phaseMaxWaitMs } = req.body;

      const schedule = await createSchedule({
        userId: req.userId,
        userTier: req.userTier,
        contractAddress,
        chainId,
        mintConfig: { ...mintConfig, contractAddress, chainId },
        walletIds,
        mintTime,
        waitForPhase,
        phaseCheckIntervalMs,
        phaseMaxWaitMs,
      });

      writeAuditLog({
        userId: req.userId,
        action: 'SCHEDULE_CREATE',
        resourceId: schedule.id,
        metadata: { contractAddress, chainId, mintTime, waitForPhase },
      });

      return reply.code(201).send({
        id: schedule.id,
        jobId: schedule.jobId,
        status: schedule.status,
        mintTime: schedule.mintTime,
        waitForPhase: schedule.waitForPhase,
        createdAt: schedule.createdAt,
      });
    },
  );

  // ── DELETE /schedules/:id ───────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>(
    '/schedules/:id', auth,
    async (req, reply) => {
      await cancelSchedule(req.params.id, req.userId);
      writeAuditLog({ userId: req.userId, action: 'SCHEDULE_CANCEL', resourceId: req.params.id });
      return reply.send({ success: true });
    },
  );
}
