// packages/worker/src/processors/mintProcessor.ts
import type { Job } from 'bullmq';
import { prisma } from '../../../api/src/plugins/db.js';
import { executeMint } from '../../../api/src/services/mintService.js';
import type { MintConfig } from '@apex/core/types';

interface MintJobData {
  type: 'immediate' | 'scheduled' | 'scheduled-phase';
  userId: string;
  scheduleId?: string;
  mintConfig: MintConfig;
  walletIds: string[];
}

export async function processMintJob(job: Job<MintJobData>): Promise<void> {
  const { userId, scheduleId, mintConfig, walletIds } = job.data;

  console.info(`[MintProcessor] Starting job ${job.id} | user=${userId.slice(0, 8)} | contract=${mintConfig.contractAddress}`);

  // Mark schedule as RUNNING
  if (scheduleId) {
    await prisma.schedule.update({
      where: { id: scheduleId },
      data: { status: 'RUNNING' },
    }).catch(() => {});
  }

  try {
    const result = await executeMint(userId, mintConfig, walletIds, scheduleId);

    console.info(`[MintProcessor] Done ${job.id} | success=${result.summary.success}/${result.summary.total}`);

    // If antibot was detected, mark as FAILED with clear message
    if (result.antibotNotification) {
      if (scheduleId) {
        await prisma.schedule.update({
          where: { id: scheduleId },
          data: {
            status: 'FAILED',
            errorMsg: 'ANTIBOT_BLOCKED — ' + result.antibotNotification.slice(0, 500),
            completedAt: new Date(),
            results: result as unknown as object,
          },
        }).catch(() => {});
      }
      return;
    }

    if (scheduleId) {
      const allFailed = result.summary.success === 0 && result.summary.failed > 0;
      await prisma.schedule.update({
        where: { id: scheduleId },
        data: {
          status: allFailed ? 'FAILED' : 'COMPLETED',
          completedAt: new Date(),
          results: result as unknown as object,
          errorMsg: allFailed ? `All ${result.summary.failed} wallet(s) failed` : null,
        },
      }).catch(() => {});
    }
  } catch (err) {
    const msg = (err as Error).message ?? 'Unknown error';
    console.error(`[MintProcessor] Job ${job.id} error:`, msg);

    if (scheduleId) {
      await prisma.schedule.update({
        where: { id: scheduleId },
        data: { status: 'FAILED', errorMsg: msg.slice(0, 500), completedAt: new Date() },
      }).catch(() => {});
    }

    throw err; // Re-throw so BullMQ can retry
  }
}
