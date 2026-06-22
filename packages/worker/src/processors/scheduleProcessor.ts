// packages/worker/src/processors/scheduleProcessor.ts
// Phase-polling: polls detectPhase() every N ms until public opens, then fires mint.
// Always runs antibot check before firing — if project added protection after scheduling,
// we notify the user rather than blindly firing.

import type { Job } from 'bullmq';
import { prisma } from '../../../api/src/plugins/db.js';
import { executeMint } from '../../../api/src/services/mintService.js';
import { detectPhase } from '@apex/core/contract/intelligence';
import { detectAntibot } from '@apex/core/contract/antibotDetector';
import { fetchABI } from '@apex/core/contract/intelligence';
import type { MintConfig } from '@apex/core/types';

interface ScheduleJobData {
  type: 'scheduled-phase';
  userId: string;
  scheduleId: string;
  mintConfig: MintConfig;
  walletIds: string[];
}

export async function processScheduleJob(job: Job<ScheduleJobData>): Promise<void> {
  const { userId, scheduleId, mintConfig, walletIds } = job.data;
  const { contractAddress, chainId = 1 } = mintConfig;

  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } });
  if (!schedule || schedule.status === 'CANCELLED') {
    console.info(`[ScheduleProcessor] Job ${job.id} cancelled/not-found — skipping`);
    return;
  }

  await prisma.schedule.update({ where: { id: scheduleId }, data: { status: 'RUNNING' } });

  const phaseCheckMs = schedule.phaseCheckIntervalMs ?? 5_000;
  const maxWaitMs = schedule.phaseMaxWaitMs ?? 3_600_000;
  const deadline = Date.now() + maxWaitMs;

  console.info(`[ScheduleProcessor] Polling phase for ${contractAddress} (max ${maxWaitMs / 1000}s)`);

  while (Date.now() < deadline) {
    // Check if cancelled while polling
    const current = await prisma.schedule.findUnique({ where: { id: scheduleId }, select: { status: true } });
    if (current?.status === 'CANCELLED') {
      console.info(`[ScheduleProcessor] Schedule ${scheduleId} cancelled during polling`);
      return;
    }

    try {
      const phase = await detectPhase(contractAddress, chainId);

      if (phase.isPaused) {
        await job.updateProgress({ phase: 'paused', message: 'Contract paused — continuing to poll' });
        await sleep(phaseCheckMs * 2);
        continue;
      }

      if (phase.isSoldOut) {
        await prisma.schedule.update({
          where: { id: scheduleId },
          data: { status: 'FAILED', errorMsg: 'Sold out before phase opened', completedAt: new Date() },
        });
        return;
      }

      if (phase.isPublic) {
        console.info(`[ScheduleProcessor] Public phase detected! Firing mint for ${scheduleId}`);

        // Final antibot check — project may have added protection since we scheduled
        const abiJson = await fetchABI(contractAddress, chainId).catch(() => null);
        const antibotResult = await detectAntibot(contractAddress, chainId, abiJson);

        if (!antibotResult.canAutomate) {
          await prisma.schedule.update({
            where: { id: scheduleId },
            data: {
              status: 'FAILED',
              errorMsg: 'ANTIBOT_BLOCKED — ' + antibotResult.notifications[0]?.slice(0, 400),
              completedAt: new Date(),
            },
          });
          console.info(`[ScheduleProcessor] Antibot detected for ${scheduleId} — notified user, not firing`);
          return;
        }

        // Fire!
        const result = await executeMint(userId, mintConfig, walletIds, scheduleId);

        await prisma.schedule.update({
          where: { id: scheduleId },
          data: {
            status: result.summary.success > 0 ? 'COMPLETED' : 'FAILED',
            completedAt: new Date(),
            results: result as unknown as object,
            errorMsg: result.summary.success === 0 ? `All ${result.summary.total} wallets failed` : null,
          },
        });
        return;
      }

      // Not public yet — update progress and keep polling
      await job.updateProgress({
        phase: phase.phase,
        confidence: phase.confidence,
        message: `Waiting for public phase (current: ${phase.phase})`,
        nextCheckIn: phaseCheckMs,
      });

    } catch (err) {
      // Phase check failed — RPC issue, keep trying
      console.warn(`[ScheduleProcessor] Phase check failed for ${scheduleId}:`, (err as Error).message);
    }

    await sleep(phaseCheckMs);
  }

  // Timed out
  await prisma.schedule.update({
    where: { id: scheduleId },
    data: {
      status: 'FAILED',
      errorMsg: `Phase never opened within ${maxWaitMs / 1000}s wait window`,
      completedAt: new Date(),
    },
  });
  console.warn(`[ScheduleProcessor] Timeout waiting for phase on ${contractAddress}`);
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// packages/worker/src/processors/portfolioProcessor.ts
// ─────────────────────────────────────────────────────────────────────────────
